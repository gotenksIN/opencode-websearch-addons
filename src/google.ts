import type { Plugin, WebSearch } from "@opencode-ai/plugin"
import { resolveCredential } from "./auth.js"
import type { GoogleOptions, SearchTimeRange } from "./config.js"
import { isRecord, parsedTimestamp, providerError, readJSON, toResult } from "./types.js"
import type { CatalogContext, InternalSource } from "./types.js"
import { providerBaseURL } from "./types.js"

const apiBase = "https://generativelanguage.googleapis.com/v1beta"

const thinkingLevelWire: Record<GoogleOptions["thinkingLevel"], string> = {
  minimal: "MINIMAL",
  low: "LOW",
  medium: "MEDIUM",
  high: "HIGH",
}

export async function searchGoogle(
  ctx: CatalogContext & Pick<Plugin.Context, "integration">,
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
      await providerError(response, "Gemini")
    }
    const merged = await collectGenerateContent(response)
    return normalizeGenerateContent(merged)
  } finally {
    clearTimeout(timer)
    contextSignal.removeEventListener("abort", onAbort)
  }
}

function buildGenerateContentBody(config: GoogleOptions, query: string): Record<string, unknown> {
  const tool: Record<string, unknown> = {
    googleSearch:
      config.searchTimeRange === "any"
        ? {}
        : { timeRangeFilter: timeRangeFilterFor(config.searchTimeRange) },
  }
  return {
    contents: [
      {
        role: "user",
        parts: [{ text: query }],
      },
    ],
    tools: [tool],
    generationConfig: {
      thinkingConfig: {
        thinkingLevel: thinkingLevelWire[config.thinkingLevel],
      },
    },
  }
}

export function timeRangeFilterFor(range: SearchTimeRange, now: Date = new Date()): {
  startTime: string
  endTime: string
} {
  const start = new Date(now)
  switch (range) {
    case "lastDay":
      start.setDate(start.getDate() - 1)
      break
    case "lastWeek":
      start.setDate(start.getDate() - 7)
      break
    case "lastMonth":
      start.setMonth(start.getMonth() - 1)
      break
    case "lastYear":
      start.setFullYear(start.getFullYear() - 1)
      break
    default:
      throw new Error(`Invalid searchTimeRange ${range} for a time range filter`)
  }
  return {
    startTime: stripMilliseconds(start),
    endTime: stripMilliseconds(now),
  }
}

function stripMilliseconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z")
}

interface MergedCandidate {
  readonly parts: string[]
  grounding?: Record<string, unknown>
  finishReason?: string
}

async function collectGenerateContent(response: Response): Promise<MergedCandidate> {
  const contentType = response.headers.get("content-type") ?? ""
  if (!contentType.includes("text/event-stream")) {
    const body = await readJSON(response)
    return mergeChunk({ parts: [] }, body)
  }
  const merged: MergedCandidate = { parts: [] }
  for await (const payload of ssePayloads(response)) {
    mergeChunk(merged, payload)
  }
  return merged
}

function mergeChunk(merged: MergedCandidate, payload: unknown): MergedCandidate {
  if (!isRecord(payload)) return merged
  if (isRecord(payload.error)) {
    const message = typeof payload.error.message === "string" ? payload.error.message : "unknown error"
    throw new Error(`Gemini web search failed: ${message}`)
  }
  if (!Array.isArray(payload.candidates) || payload.candidates.length === 0) return merged
  const candidate = payload.candidates[0]
  if (!isRecord(candidate)) return merged
  const content = isRecord(candidate.content) ? candidate.content : {}
  if (Array.isArray(content.parts)) {
    for (const part of content.parts) {
      if (isRecord(part) && typeof part.text === "string") {
        merged.parts.push(part.text)
      }
    }
  }
  if (isRecord(candidate.groundingMetadata)) {
    const metadata = candidate.groundingMetadata
    const hasGrounding =
      Array.isArray(metadata.groundingChunks) || Array.isArray(metadata.groundingSupports)
    if (hasGrounding) {
      merged.grounding = {
        ...merged.grounding,
        ...metadata,
      }
    }
  }
  if (typeof candidate.finishReason === "string") {
    merged.finishReason = candidate.finishReason
  }
  return merged
}

export function normalizeGenerateContent(merged: MergedCandidate): readonly WebSearch.Result[] {
  const finishReason = merged.finishReason
  if (finishReason === "BLOCKED" || finishReason === "SAFETY") {
    throw new Error(`Gemini web search blocked by the provider (finish reason ${finishReason})`)
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
    const url = typeof web.uri === "string" ? web.uri : undefined
    if (!url || url.length === 0) return
    const title = typeof web.title === "string" ? web.title : undefined
    const published = parsedTimestamp(web.published_date ?? web.published)
    let source = sourcesByURL.get(url)
    if (!source) {
      source = {
        url,
        spans: [],
        seenSpans: new Set(),
        ...(title ? { title } : {}),
        ...(published !== undefined ? { published } : {}),
      }
      sourcesByURL.set(url, source)
      order.push(url)
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
      const span = sliceSpan(text, segment.startIndex, segment.endIndex)
      if (!span) continue
      if (!Array.isArray(rawSupport.groundingChunkIndices)) continue
      for (const rawIndex of rawSupport.groundingChunkIndices) {
        if (typeof rawIndex !== "number") continue
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
    const result: InternalSource = {
      url: source.url,
      ...(source.title ? { title: source.title } : {}),
      ...(source.published !== undefined ? { published: source.published } : {}),
      ...(source.spans.length > 0 ? { content: source.spans.join(" ") } : {}),
    }
    return [toResult(result)]
  })
}

interface ChunkSource extends InternalSource {
  title?: string
  published?: number
  readonly spans: string[]
  readonly seenSpans: Set<string>
}

function sliceSpan(text: string, rawStart: unknown, rawEnd: unknown): string {
  if (typeof rawStart !== "number" || typeof rawEnd !== "number") return ""
  const start = Math.max(0, Math.min(rawStart, text.length))
  const end = Math.max(start, Math.min(rawEnd, text.length))
  return text.slice(start, end)
}

export async function* ssePayloads(response: Response): AsyncGenerator<unknown> {
  if (!response.body) throw new Error("Gemini web search response has no body")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const trimmed = line.trimEnd()
        if (!trimmed.startsWith("data:")) continue
        const payload = trimmed.slice(5).trim()
        if (payload.length === 0) continue
        try {
          yield JSON.parse(payload) as unknown
        } catch {
          throw new Error("Invalid Gemini web search response: malformed stream event")
        }
      }
    }
    const remainder = buffer.trim()
    if (remainder.length > 0 && remainder.startsWith("data:")) {
      const payload = remainder.slice(5).trim()
      if (payload.length > 0) {
        try {
          yield JSON.parse(payload) as unknown
        } catch {
          throw new Error("Invalid Gemini web search response: malformed stream event")
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
