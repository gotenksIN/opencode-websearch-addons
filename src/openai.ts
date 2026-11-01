import { resolveCredential } from "./auth.js"
import type { IntegrationContext } from "./auth.js"
import type { OpenAIOptions } from "./config.js"
import { isJSONNumber, isJSONString, isRecord, parseSSE, parsedTimestamp, providerBaseURL, providerError, readJSON, sanitizeProviderMessage, sliceSpan, toResult } from "./types.js"
import type { Credential, InternalSource, JsonValue, WebSearch } from "./types.js"

const publicEndpoint = "https://api.openai.com/v1/responses"

const codexEndpoint = "https://chatgpt.com/backend-api/codex/responses"

export async function searchOpenAI(
  ctx: IntegrationContext,
  config: OpenAIOptions,
  timeoutMs: number,
  query: string,
  contextSignal: AbortSignal,
): Promise<readonly WebSearch.Result[]> {
  contextSignal.throwIfAborted()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), timeoutMs)
  const onAbort = () => controller.abort(contextSignal.reason)

  if (contextSignal.aborted) {
    controller.abort(contextSignal.reason)
  } else {
    contextSignal.addEventListener("abort", onAbort, { once: true })
  }

  try {
    const credential = await resolveCredential(ctx, "openai", controller.signal)
    controller.signal.throwIfAborted()

    if (credential.type === "key") {
      const baseURL = await providerBaseURL(ctx, "openai", controller.signal)
      controller.signal.throwIfAborted()

      return await runOpenAIRequest(
        baseURL ? `${baseURL}/responses` : publicEndpoint,
        { authorization: `Bearer ${credential.key}` },
        config,
        query,
        controller.signal,
        [credential.key],
      )
    }

    if (credential.type === "oauth") {
      const account = accountID(credential)

      const auth = {
        authorization: `Bearer ${credential.access}`,
        originator: "opencode",
      }

      return await runOpenAIRequest(
        codexEndpoint,
        account ? { ...auth, accountID: account } : auth,
        config,
        query,
        controller.signal,
        [credential.access, credential.refresh],
      )
    }

    throw new Error("Unsupported OpenAI credential type")
  } finally {
    clearTimeout(timer)
    contextSignal.removeEventListener("abort", onAbort)
  }
}

async function runOpenAIRequest(
  endpoint: string,
  auth: {
    readonly authorization: string
    readonly originator?: string
    readonly accountID?: string
  },
  config: OpenAIOptions,
  query: string,
  signal: AbortSignal,
  credentials: readonly string[],
): Promise<readonly WebSearch.Result[]> {
  const headers: Record<string, string> = {}
  headers.Authorization = auth.authorization
  headers["Content-Type"] = "application/json"

  if (auth.originator) headers.originator = auth.originator

  if (auth.accountID) headers["chatgpt-account-id"] = auth.accountID

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(buildResponsesBody(config, query)),
    redirect: "error",
    signal,
  })

  if (!response.ok) {
    await providerError(response, "OpenAI", credentials)
  }

  const items = await collectOutputItems(response, credentials)

  return normalizeOutput(items)
}

function buildResponsesBody(config: OpenAIOptions, query: string) {
  const tool: Record<string, JsonValue> = {}
  tool.type = "web_search"
  tool.search_context_size = config.searchContextSize
  tool.external_web_access = true

  if (config.userLocation) {
    tool.user_location = { type: "approximate", ...config.userLocation }
  }

  const body: Record<string, JsonValue> = {}
  body.model = config.model
  body.input = [{ role: "user", content: [{ type: "input_text", text: query }] }]
  body.tools = [tool]
  body.reasoning = { effort: config.reasoningEffort }
  body.include = ["web_search_call.action.sources"]
  body.store = false
  body.stream = true

  return body
}

async function collectOutputItems(response: Response, credentials: readonly string[]): Promise<JsonValue[]> {
  const contentType = response.headers.get("content-type") ?? ""

  if (!contentType.includes("text/event-stream")) {
    const body = await readJSON(response)

    if (!isRecord(body)) throw new Error("Invalid OpenAI web search response: body is not an object")

    if (body.status === "failed" || isRecord(body.error)) {
      const message = streamErrorMessage(body)
      throw new Error(`OpenAI web search failed: ${sanitizeProviderMessage(message, credentials)}`)
    }

    if (body.error !== undefined && body.error !== null) {
      throw new Error("Invalid OpenAI web search response: malformed error")
    }

    if (!Array.isArray(body.output)) {
      throw new Error("Invalid OpenAI web search response: missing output")
    }

    return body.output
  }

  const items: JsonValue[] = []
  let completed: JsonValue[] | undefined
  let terminal = false

  for await (const payload of parseSSE(response, "OpenAI", true)) {
    if (!isRecord(payload)) continue

    if (payload.type === "response.output_item.done" && isRecord(payload.item)) {
      items.push(payload.item)
    } else if (payload.type === "response.completed" || payload.type === "response.incomplete") {
      terminal = true
      const output = isRecord(payload.response) ? payload.response.output : undefined

      if (Array.isArray(output)) completed = output
      break
    } else if (payload.type === "response.failed" || payload.type === "error") {
      const message = streamErrorMessage(payload)
      throw new Error(`OpenAI web search failed: ${sanitizeProviderMessage(message, credentials)}`)
    }
  }

  if (!terminal) {
    throw new Error("Invalid OpenAI web search response: stream ended without a terminal event")
  }

  return completed && completed.length > 0 ? completed : items
}

function streamErrorMessage(payload: Record<string, JsonValue>): string {
  const response = isRecord(payload.response) ? payload.response : {}
  const responseError = isRecord(response.error) ? response.error : {}
  const error = isRecord(payload.error) ? payload.error : {}
  let message: string | undefined
  let code: string | undefined

  for (const value of [payload.message, error.message, responseError.message]) {
    if (isJSONString(value) && value.length > 0) {
      message = value
      break
    }
  }

  for (const value of [payload.code, error.code, responseError.code]) {
    if (isJSONString(value) && value.length > 0) {
      code = value
      break
    }
  }

  if (message && code) return `${code}: ${message}`

  return message ?? code ?? "unknown error"
}

interface AccumulatedSource {
  readonly url: string
  title?: string
  published?: number
  readonly spans: string[]
  readonly seenSpans: Set<string>
}

export function normalizeOutput(output: JsonValue): readonly WebSearch.Result[] {
  if (!Array.isArray(output)) throw new Error("Invalid OpenAI web search response: missing output")
  const sourcesByURL = new Map<string, AccumulatedSource>()
  const order: string[] = []

  for (const rawItem of output) {
    if (!isRecord(rawItem)) continue

    if (rawItem.type === "message") {
      collectMessage(rawItem, sourcesByURL, order)
    } else if (rawItem.type === "web_search_call") {
      collectActionSources(rawItem, sourcesByURL, order)
    }
  }

  return order.flatMap((url) => {
    const source = sourcesByURL.get(url)

    if (!source) return []
    const result: InternalSource = { url }

    if (source.title) result.title = source.title

    if (source.published !== undefined) result.published = source.published

    if (source.spans.length > 0) result.content = source.spans.join(" ")

    return [toResult(result)]
  })
}

function collectMessage(
  item: Record<string, JsonValue>,
  sourcesByURL: Map<string, AccumulatedSource>,
  order: string[],
): void {
  if (!Array.isArray(item.content)) return

  for (const part of item.content) {
    if (!isRecord(part) || part.type !== "output_text") continue

    if (!isJSONString(part.text)) continue

    if (!Array.isArray(part.annotations)) continue
    const text = part.text

    const markers = part.annotations.flatMap((annotation) => {
      if (!isRecord(annotation) || annotation.type !== "url_citation" || !isJSONString(annotation.url) || !annotation.url) return []
      const range = citationMarkerRange(text, annotation.start_index, annotation.end_index)

      return range ? [range] : []
    }).sort((left, right) => left.start - right.start || left.end - right.end)

    for (const annotation of part.annotations) {
      if (!isRecord(annotation) || annotation.type !== "url_citation") continue
      const url = isJSONString(annotation.url) ? annotation.url : undefined

      if (!url || url.length === 0) continue
      const marker = citationMarkerRange(part.text, annotation.start_index, annotation.end_index)

      const span = marker
        ? citedPassage(part.text, marker, markers)
        : sliceSpan(part.text, annotation.start_index, annotation.end_index)

      const title = isJSONString(annotation.title) ? annotation.title : undefined
      const published = parsedTimestamp(annotation.published_date ?? annotation.published)

      addSource(sourcesByURL, order, url, { title, published, span })
    }
  }
}

interface CitationRange {
  readonly start: number
  readonly end: number
}

function citationMarkerRange(text: string, start: JsonValue | undefined, end: JsonValue | undefined): CitationRange | undefined {
  if (!isJSONNumber(start) || !isJSONNumber(end) || !Number.isInteger(start) || !Number.isInteger(end)) return undefined

  if (start < 0 || end <= start || end > text.length) return undefined

  if (isCitationMarker(text.slice(start, end))) return { start, end }

  if (!/[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(text)) return undefined
  // Some Responses-compatible providers count Unicode code points, not UTF-16 units.
  const points = Array.from(text)

  if (end > points.length || !isCitationMarker(points.slice(start, end).join(""))) return undefined

  return { start: points.slice(0, start).join("").length, end: points.slice(0, end).join("").length }
}

function isCitationMarker(text: string): boolean {
  return /^(?:\(?\[[^\]\r\n]*\]\(https?:\/\/[^\r\n]+\)\)?|\[\d+(?:[ ,–-]+\d+)*\]|cite[^]+)$/.test(text.trim())
}

function citedPassage(text: string, marker: CitationRange, markers: readonly CitationRange[]): string {
  // Adjacent/overlapping citations attribute the same passage to every cited URL.
  let start = marker.start
  let boundary = 0

  for (const previous of markers.toReversed()) {
    if (previous.start >= start) continue
    const gap = text.slice(previous.end, start)

    if (previous.end >= start || (/^[\s.,;:!?]*$/.test(gap) && !/\r?\n[\t ]*\r?\n/.test(gap))) {
      start = previous.start
    } else {
      boundary = previous.end
      break
    }
  }

  // Do not borrow unrelated paragraphs or earlier list items for an isolated marker.
  const prefix = text.slice(boundary, start)
  let blockStart = 0

  for (const match of prefix.matchAll(/\r?\n[\t ]*\r?\n|\r?\n(?=[\t ]*(?:[-*+]|\d+[.)])\s)/g)) {
    blockStart = match.index + match[0].length
  }

  return prefix.slice(blockStart).trim().replace(/^[.,;:!?]+\s*/, "")
}

function collectActionSources(
  item: Record<string, JsonValue>,
  sourcesByURL: Map<string, AccumulatedSource>,
  order: string[],
): void {
  const action = isRecord(item.action) ? item.action : {}

  if (!Array.isArray(action.sources)) return

  for (const rawSource of action.sources) {
    if (!isRecord(rawSource) || rawSource.type !== "url") continue
    const url = isJSONString(rawSource.url) ? rawSource.url : undefined

    if (!url || url.length === 0) continue
    const title = isJSONString(rawSource.title) ? rawSource.title : undefined
    const published = parsedTimestamp(rawSource.published_date ?? rawSource.published)
    addSource(sourcesByURL, order, url, { title, published })
  }
}

function addSource(
  sourcesByURL: Map<string, AccumulatedSource>,
  order: string[],
  url: string,
  fields: {
    readonly title?: string
    readonly published?: number
    readonly span?: string
  },
): void {
  let source = sourcesByURL.get(url)

  if (!source) {
    source = { url, spans: [], seenSpans: new Set() }
    sourcesByURL.set(url, source)
    order.push(url)
  }

  if (!source.title && fields.title) source.title = fields.title

  if (source.published === undefined && fields.published !== undefined) source.published = fields.published
  const span = fields.span

  if (span && span.length > 0 && !source.seenSpans.has(span)) {
    source.seenSpans.add(span)
    source.spans.push(span)
  }
}

function accountID(credential: Credential.OAuth): string | undefined {
  // SAFETY: OAuth credential metadata is arbitrary JSON data attached to the credential.
  const meta = credential.metadata as Record<string, JsonValue>

  if (!isRecord(meta)) return undefined
  const accountID = meta.accountID ?? meta.accountId

  return accountID !== undefined && isJSONString(accountID) && accountID.length > 0 ? accountID : undefined
}
