import { resolveCredential } from "./auth.js"
import type { IntegrationContext } from "./auth.js"
import type { GoogleOptions, SearchTimeRange } from "./config.js"
import { isJSONNumber, isJSONString, isRecord, parseSSE, parsedTimestamp, providerBaseURL, providerError, readJSON, sanitizeProviderMessage, sliceSpan, toResult } from "./types.js"
import type { InternalSource, JsonValue, WebSearch } from "./types.js"

const apiBase = "https://generativelanguage.googleapis.com/v1beta"

const thinkingLevelWire = {
  minimal: "MINIMAL",
  low: "LOW",
  medium: "MEDIUM",
  high: "HIGH",
}

const blockedFinishReasons = new Set([
  "BLOCKED",
  "SAFETY",
  "IMAGE_SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "MODEL_ARMOR",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_RECITATION",
  "LANGUAGE",
])

const errorFinishReasons = new Set([
  "MALFORMED_FUNCTION_CALL",
  "UNEXPECTED_TOOL_CALL",
  "NO_IMAGE",
  "TOO_MANY_TOOL_CALLS",
  "MISSING_THOUGHT_SIGNATURE",
  "MALFORMED_RESPONSE",
])

export async function searchGoogle(
  ctx: IntegrationContext,
  config: GoogleOptions,
  timeoutMs: number,
  query: string,
  contextSignal: AbortSignal,
): Promise<readonly WebSearch.Result[]> {
  const credential = await resolveCredential(ctx, "google")

  if (credential.type !== "key") {
    throw new Error("Unsupported Google credential type; expected a key credential")
  }

  const baseURL = await providerBaseURL(ctx, "google")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), timeoutMs)
  const onAbort = () => controller.abort(contextSignal.reason)

  if (contextSignal.aborted) {
    controller.abort(contextSignal.reason)
  } else {
    contextSignal.addEventListener("abort", onAbort, { once: true })
  }

  try {
    const endpoint = `${baseURL ?? apiBase}/models/${encodeURIComponent(config.model)}:streamGenerateContent?alt=sse`

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": credential.key,
      },
      body: JSON.stringify(buildGenerateContentBody(config, query)),
      signal: controller.signal,
    })

    if (!response.ok) {
      await providerError(response, "Gemini", [credential.key])
    }

    const merged = await collectGenerateContent(response, [credential.key])

    return normalizeGenerateContent(merged)
  } finally {
    clearTimeout(timer)
    contextSignal.removeEventListener("abort", onAbort)
  }
}

function buildGenerateContentBody(config: GoogleOptions, query: string) {
  const tool: Record<string, JsonValue> = {}
  tool.googleSearch =
    config.searchTimeRange === "any"
      ? {}
      : { timeRangeFilter: timeRangeFilterFor(config.searchTimeRange) }
  const body: Record<string, JsonValue> = {}
  body.contents = [{ role: "user", parts: [{ text: query }] }]
  body.tools = [tool]
  body.generationConfig = { thinkingConfig: { thinkingLevel: thinkingLevelWire[config.thinkingLevel] } }

  return body
}

export function timeRangeFilterFor(range: SearchTimeRange, now: Date = new Date()) {
  const start = new Date(now)

  switch (range) {
    case "lastDay":
      start.setUTCDate(start.getUTCDate() - 1)
      break
    case "lastWeek":
      start.setUTCDate(start.getUTCDate() - 7)
      break
    case "lastMonth": {
      const day = start.getUTCDate()
      start.setUTCDate(1)
      start.setUTCMonth(start.getUTCMonth() - 1)
      start.setUTCDate(Math.min(day, daysInUTCMonth(start)))
      break
    }

    case "lastYear": {
      const day = start.getUTCDate()
      start.setUTCDate(1)
      start.setUTCFullYear(start.getUTCFullYear() - 1)
      start.setUTCDate(Math.min(day, daysInUTCMonth(start)))
      break
    }

    default:
      throw new Error(`Invalid searchTimeRange ${range} for a time range filter`)
  }

  return {
    startTime: stripMilliseconds(start),
    endTime: stripMilliseconds(now),
  } satisfies { startTime: string; endTime: string }
}

function daysInUTCMonth(date: Date): number {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
}

function stripMilliseconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z")
}

interface MergedCandidate {
  readonly parts: string[]
  grounding?: Record<string, JsonValue>
  finishReason?: string
  blockReason?: string
}

async function collectGenerateContent(response: Response, credentials: readonly string[]): Promise<MergedCandidate> {
  const contentType = response.headers.get("content-type") ?? ""

  if (!contentType.includes("text/event-stream")) {
    const body = await readJSON(response)

    return mergeChunk({ parts: [] }, body, credentials)
  }

  const merged: MergedCandidate = { parts: [] }
  let terminal = false

  for await (const payload of parseSSE(response, "Gemini")) {
    mergeChunk(merged, payload, credentials)
    terminal ||= merged.finishReason !== undefined || merged.blockReason !== undefined || (isRecord(payload) && isRecord(payload.usageMetadata))
  }

  if (!terminal) {
    throw new Error("Invalid Gemini web search response: stream ended without a terminal event")
  }

  return merged
}

function mergeChunk(merged: MergedCandidate, payload: JsonValue, credentials: readonly string[]): MergedCandidate {
  if (!isRecord(payload)) return merged

  if (payload.error !== undefined) {
    if (!isRecord(payload.error)) {
      throw new Error("Invalid Gemini web search response: malformed stream error")
    }

    const message = isJSONString(payload.error.message) ? payload.error.message : "unknown error"
    throw new Error(`Gemini web search failed: ${sanitizeProviderMessage(message, credentials)}`)
  }

  if (isRecord(payload.promptFeedback) && isJSONString(payload.promptFeedback.blockReason)) {
    merged.blockReason = payload.promptFeedback.blockReason
  }

  if (!Array.isArray(payload.candidates) || payload.candidates.length === 0) return merged
  const candidate = payload.candidates[0]

  if (candidate === undefined || !isRecord(candidate)) return merged
  const content = isRecord(candidate.content) ? candidate.content : {}

  if (Array.isArray(content.parts)) {
    for (const part of content.parts) {
      if (isRecord(part) && part.thought !== true && isJSONString(part.text)) {
        merged.parts.push(part.text)
      }
    }
  }

  if (isRecord(candidate.groundingMetadata)) {
    const metadata = candidate.groundingMetadata

    const hasGrounding =
      Array.isArray(metadata.groundingChunks) || Array.isArray(metadata.groundingSupports)

    if (hasGrounding) {
      const previous: Record<string, JsonValue> = merged.grounding ?? {}
      merged.grounding = { ...previous, ...metadata }
    }
  }

  if (isJSONString(candidate.finishReason)) {
    merged.finishReason = candidate.finishReason
  }

  return merged
}

export function normalizeGenerateContent(merged: MergedCandidate): readonly WebSearch.Result[] {
  const finishReason = merged.finishReason
  const blockReason = merged.blockReason

  if (blockReason) {
    throw new Error(`Gemini web search blocked by the provider (prompt block reason ${blockReason})`)
  }

  if (finishReason && blockedFinishReasons.has(finishReason)) {
    throw new Error(`Gemini web search blocked by the provider (finish reason ${finishReason})`)
  }

  if (finishReason && errorFinishReasons.has(finishReason)) {
    throw new Error(`Gemini web search failed (finish reason ${finishReason})`)
  }

  if (!merged.grounding) return []
  const chunks = merged.grounding.groundingChunks

  if (!Array.isArray(chunks)) return []
  const text = merged.parts.join("")
  const sourcesByURL = new Map<string, ChunkSource>()
  const chunkIndexToSource = new Map<number, ChunkSource>()
  const order: string[] = []
  chunks.forEach((rawChunk, index) => {
    if (!isRecord(rawChunk)) return
    const web = isRecord(rawChunk.web) ? rawChunk.web : {}
    const url = isJSONString(web.uri) ? web.uri : undefined

    if (!url || url.length === 0) return
    const title = isJSONString(web.title) ? web.title : undefined
    const published = parsedTimestamp(web.published_date ?? web.published)
    let source = sourcesByURL.get(url)

    if (!source) {
      source = { url, spans: [], seenSpans: new Set() }
      sourcesByURL.set(url, source)
      order.push(url)

      if (title) source.title = title

      if (published !== undefined) source.published = published
    } else {
      if (!source.title && title) source.title = title

      if (source.published === undefined && published !== undefined) source.published = published
    }

    chunkIndexToSource.set(index, source)
  })
  const supports = merged.grounding.groundingSupports

  if (Array.isArray(supports)) {
    for (const rawSupport of supports) {
      if (!isRecord(rawSupport)) continue
      const segment = isRecord(rawSupport.segment) ? rawSupport.segment : {}
      const span = sliceSpan(text, segment.startIndex ?? 0, segment.endIndex)

      if (!span) continue

      if (!Array.isArray(rawSupport.groundingChunkIndices)) continue

      for (const rawIndex of rawSupport.groundingChunkIndices) {
        if (!isJSONNumber(rawIndex)) continue
        const source = chunkIndexToSource.get(rawIndex)

        if (!source || source.seenSpans.has(span)) continue
        source.seenSpans.add(span)
        source.spans.push(span)
      }
    }
  }

  return order.flatMap((url) => {
    const source = sourcesByURL.get(url)

    if (!source) return []
    const result: InternalSource = { url: source.url }

    if (source.title) result.title = source.title

    if (source.published !== undefined) result.published = source.published

    if (source.spans.length > 0) result.content = source.spans.join(" ")

    return [toResult(result)]
  })
}

interface ChunkSource extends InternalSource {
  readonly spans: string[]
  readonly seenSpans: Set<string>
}
