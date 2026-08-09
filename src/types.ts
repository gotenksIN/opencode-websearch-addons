import type { Plugin } from "@opencode-ai/plugin"

export type CatalogContext = Pick<Plugin.Context, "catalog">

export async function providerBaseURL(
  ctx: CatalogContext,
  providerID: string,
): Promise<string | undefined> {
  try {
    const result = await ctx.catalog.provider.get({ providerID })
    const settings = result?.data?.settings
    const baseURL = settings && typeof settings === "object" ? settings["baseURL"] : undefined
    if (typeof baseURL !== "string") return undefined
    const trimmed = baseURL.trim().replace(/\/+$/, "")
    return trimmed.length > 0 ? trimmed : undefined
  } catch {
    return undefined
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export interface InternalSource {
  readonly url: string
  readonly title?: string
  readonly content?: string
  readonly published?: number
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function parsedTimestamp(value: unknown): number | undefined {
  const direct = finiteNumber(value)
  if (direct !== undefined) return direct
  if (typeof value !== "string" || value.length === 0) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export async function readJSON(response: Response): Promise<unknown> {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Invalid provider response: body is not valid JSON`)
  }
}

export async function providerError(response: Response, provider: string): Promise<never> {
  let detail: string | undefined
  try {
    const body = (await readJSON(response)) as unknown
    if (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string") {
      detail = body.error.message
    } else if (isRecord(body) && typeof body.error === "string") {
      detail = body.error
    }
  } catch {
    // Keep the status-only message when the body is not parseable.
  }
  throw new Error(`${provider} web search failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`)
}

export function toResult(source: InternalSource) {
  return {
    url: source.url,
    ...(source.title ? { title: source.title } : {}),
    ...(source.content ? { content: source.content } : {}),
    time: source.published !== undefined ? { published: source.published } : {},
  }
}
