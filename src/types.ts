import type { Plugin, WebSearch } from "@opencode-ai/plugin"

export type CatalogContext = Pick<Plugin.Context, "catalog">

export type JsonValue = string | number | boolean | null | JsonValue[] | { readonly [key: string]: JsonValue | undefined }

export function isJSONString(value: JsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]"
}

export function isJSONNumber(value: JsonValue | undefined): value is number {
  return Object.prototype.toString.call(value) === "[object Number]"
}

export async function providerBaseURL(
  ctx: CatalogContext,
  providerID: string,
): Promise<string | undefined> {
  try {
    const result = await ctx.catalog.provider.get({ providerID })
    const settings = result?.data?.settings
    const baseURL = settings !== undefined && isRecord(settings) ? settings["baseURL"] : undefined
    if (baseURL === undefined || !isJSONString(baseURL)) return undefined
    const trimmed = baseURL.trim().replace(/\/+$/, "")
    return trimmed.length > 0 ? trimmed : undefined
  } catch {
    return undefined
  }
}

export function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return value instanceof Object && !Array.isArray(value)
}

export interface InternalSource {
  url: string
  title?: string
  content?: string
  published?: number
}

export function finiteNumber(value: JsonValue | undefined): number | undefined {
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

export async function readJSON(response: Response): Promise<JsonValue> {
  const text = await response.text()
  try {
    // SAFETY: JSON.parse output is plain JSON data by definition.
    return JSON.parse(text) as JsonValue
  } catch {
    throw new Error(`Invalid provider response: body is not valid JSON`)
  }
}

export async function providerError(response: Response, provider: string): Promise<never> {
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
  throw new Error(`${provider} web search failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`)
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
