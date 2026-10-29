import type { Credential, Plugin, WebSearch } from "@opencode/plugin"

export type { Credential, Plugin, WebSearch }

interface ProviderSettingsResponse {
  readonly data?: {
    readonly settings?: unknown
  }
}

interface ProviderSettingsLookup {
  get(input: { readonly providerID: string }): Promise<ProviderSettingsResponse | undefined>
}

export interface ProviderSettingsContext {
  readonly catalog?: {
    readonly provider: ProviderSettingsLookup
  }
  readonly provider?: ProviderSettingsLookup
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { readonly [key: string]: JsonValue | undefined }

export function isJSONString(value: JsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]"
}

export function isJSONNumber(value: JsonValue | undefined): value is number {
  return Object.prototype.toString.call(value) === "[object Number]"
}

export async function awaitLookup<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()

  if (!signal) return operation()

  let onAbort: (() => void) | undefined

  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
  })

  try {
    return await Promise.race([operation(), aborted])
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort)
  }
}

export async function providerBaseURL(
  ctx: ProviderSettingsContext,
  providerID: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const lookup = ctx.provider ?? ctx.catalog?.provider

  if (!lookup) return undefined

  try {
    const result = await awaitLookup(() => lookup.get({ providerID }), signal)
    const settings = result?.data?.settings
    const baseURL = settings !== undefined && isRecord(settings) ? settings["baseURL"] : undefined

    if (baseURL === undefined || !isJSONString(baseURL)) return undefined
    const trimmed = baseURL.trim().replace(/\/+$/, "")

    return trimmed.length > 0 ? trimmed : undefined
  } catch {
    signal?.throwIfAborted()
    throw new Error(`Unable to read ${providerID} provider settings. Try again.`)
  }
}

export function isRecord(value: unknown): value is Record<string, JsonValue> {
  return value instanceof Object && !Array.isArray(value)
}

export interface InternalSource {
  url: string
  title?: string
  content?: string
  published?: number
}

function finiteNumber(value: JsonValue | undefined): number | undefined {
  // SAFETY: Number.isFinite returns true only for numeric values.
  return Number.isFinite(value) ? (value as number) : undefined
}

export function parsedTimestamp(value: JsonValue | undefined): number | undefined {
  const direct = finiteNumber(value)

  if (direct !== undefined) return direct

  if (!isJSONString(value) || value.length === 0) return undefined
  const parsed = Date.parse(value)

  return Number.isFinite(parsed) ? parsed : undefined
}

export function sliceSpan(text: string, rawStart: JsonValue | undefined, rawEnd: JsonValue | undefined): string {
  if (!isJSONNumber(rawStart) || !isJSONNumber(rawEnd)) return ""
  const start = Math.max(0, Math.min(rawStart, text.length))
  const end = Math.max(start, Math.min(rawEnd, text.length))

  return text.slice(start, end)
}

export async function readJSON(response: Response): Promise<JsonValue> {
  const text = await response.text()

  try {
    // SAFETY: JSON.parse output is plain JSON data by definition.
    return JSON.parse(text) as JsonValue
  } catch {
    throw new Error(`Invalid provider response: body is not valid JSON`)
  }
}

export function sanitizeProviderMessage(message: string, credentials: readonly string[] = []): string {
  let sanitized = message
    .replace(
      /(["']?)(\b(?:api[ _-]?key|x-goog-api-key|authorization|access[ _-]?token|refresh[ _-]?token|key)\b)\1(\s*[:=]\s*)(?:Bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1$2$1$3[REDACTED]",
    )
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")

  for (const credential of credentials) {
    if (credential.length > 0) sanitized = sanitized.split(credential).join("[REDACTED]")
  }

  return sanitized.replace(/\b(?:sk|pk)-[A-Za-z0-9._-]{6,}\b/gi, "[REDACTED]")
}

export async function providerError(
  response: Response,
  provider: string,
  credentials: readonly string[] = [],
): Promise<never> {
  let detail: string | undefined

  try {
    const body = await readJSON(response)

    if (isRecord(body) && isRecord(body.error) && isJSONString(body.error.message)) {
      detail = body.error.message
    } else if (isRecord(body) && isJSONString(body.error)) {
      detail = body.error
    }
  } catch {
    // Keep the status-only message when the body is not parseable.
  }

  const sanitizedDetail = detail ? sanitizeProviderMessage(detail, credentials) : undefined
  throw new Error(`${provider} web search failed (HTTP ${response.status})${sanitizedDetail ? `: ${sanitizedDetail}` : ""}`)
}

export async function* parseSSE(
  response: Response,
  provider: string,
  skipDone = false,
): AsyncGenerator<JsonValue> {
  if (!response.body) throw new Error(`${provider} web search response has no body`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let data: string[] = []
  let complete = false

  // A CR at the end of the buffer may be the first half of a CRLF split across chunks.
  const nextLine = (final: boolean): string | undefined => {
    const match = /\r\n|\r|\n/.exec(buffer)

    if (!match || (!final && match[0] === "\r" && match.index === buffer.length - 1)) return undefined
    const line = buffer.slice(0, match.index)
    buffer = buffer.slice(match.index + match[0].length)

    return line
  }

  const addField = (line: string): void => {
    if (line.startsWith(":")) return
    const colon = line.indexOf(":")

    if ((colon === -1 ? line : line.slice(0, colon)) !== "data") return
    const value = colon === -1 ? "" : line.slice(colon + 1)
    data.push(value.startsWith(" ") ? value.slice(1) : value)
  }

  const takeEvent = (): string | undefined => {
    const payload = data.join("\n").trim()
    data = []

    if (payload.length === 0 || (skipDone && payload === "[DONE]")) return undefined

    return payload
  }

  function* completeEvents(final: boolean): Generator<string> {
    let line: string | undefined

    while ((line = nextLine(final)) !== undefined) {
      if (line.length > 0) {
        addField(line)
        continue
      }

      const payload = takeEvent()

      if (payload !== undefined) yield payload
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()

      if (done) {
        buffer += decoder.decode()
        complete = true
        break
      }

      buffer += decoder.decode(value, { stream: true })

      for (const payload of completeEvents(false)) yield parseSSEEvent(payload, provider)
    }

    for (const payload of completeEvents(true)) yield parseSSEEvent(payload, provider)

    // Accept a final event without its trailing blank line, as earlier releases did.
    if (buffer.length > 0) addField(buffer)
    const payload = takeEvent()

    if (payload !== undefined) yield parseSSEEvent(payload, provider)
  } finally {
    if (!complete) {
      try {
        await reader.cancel()
      } catch {
        // Preserve the provider or parsing error that stopped consumption.
      }
    }

    reader.releaseLock()
  }
}

function parseSSEEvent(payload: string, provider: string): JsonValue {
  try {
    // SAFETY: JSON.parse output is plain JSON data by definition.
    return JSON.parse(payload) as JsonValue
  } catch {
    throw new Error(`Invalid ${provider} web search response: malformed stream event`)
  }
}

export function toResult(source: InternalSource): WebSearch.Result {
  const title = source.title ? { title: source.title } : {}
  const content = source.content ? { content: source.content } : {}

  return {
    url: source.url,
    ...title,
    ...content,
    time: source.published !== undefined ? { published: source.published } : {},
  }
}
