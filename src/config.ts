import { isRecord } from "./types.js"

export const reasoningEfforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const
export type ReasoningEffort = (typeof reasoningEfforts)[number]

export const thinkingLevels = ["minimal", "low", "medium", "high"] as const
export type ThinkingLevel = (typeof thinkingLevels)[number]

export const searchContextSizes = ["low", "medium", "high"] as const
export type SearchContextSize = (typeof searchContextSizes)[number]

export const searchTimeRanges = ["any", "lastDay", "lastWeek", "lastMonth", "lastYear"] as const
export type SearchTimeRange = (typeof searchTimeRanges)[number]

const userLocationKeys = ["city", "country", "region", "timezone"] as const

export interface UserLocation {
  readonly city?: string
  readonly country?: string
  readonly region?: string
  readonly timezone?: string
}

export interface OpenAIOptions {
  readonly model: string
  readonly reasoningEffort: ReasoningEffort
  readonly searchContextSize: SearchContextSize
  readonly userLocation?: UserLocation
}

export interface GoogleOptions {
  readonly model: string
  readonly thinkingLevel: ThinkingLevel
  readonly searchTimeRange: SearchTimeRange
}

export interface PluginConfig {
  readonly openai: OpenAIOptions
  readonly google: GoogleOptions
  readonly timeoutMs: number
}

export const defaultConfig: PluginConfig = {
  openai: {
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    searchContextSize: "medium",
  },
  google: {
    model: "gemini-3.5-flash-lite",
    thinkingLevel: "medium",
    searchTimeRange: "any",
  },
  timeoutMs: 120_000,
}

export function parseConfig(options: Record<string, unknown> = {}): PluginConfig {
  const opts = isRecord(options) ? options : {}
  if (opts.openai !== undefined && !isRecord(opts.openai)) {
    throw invalidOption("openai", "an object")
  }
  if (opts.google !== undefined && !isRecord(opts.google)) {
    throw invalidOption("google", "an object")
  }
  const openai = opts.openai === undefined ? {} : opts.openai
  const google = opts.google === undefined ? {} : opts.google

  const model = openai.model ?? defaultConfig.openai.model
  if (typeof model !== "string" || model.length === 0 || model.length > 100) {
    throw invalidOption("openai.model", "a non-empty string of at most 100 characters")
  }
  const reasoningEffort = openai.reasoningEffort ?? defaultConfig.openai.reasoningEffort
  if (typeof reasoningEffort !== "string" || !isOneOf(reasoningEffort, reasoningEfforts)) {
    throw invalidOption("openai.reasoningEffort", 'one of "none", "minimal", "low", "medium", "high", "xhigh", or "max"')
  }
  const searchContextSize = openai.searchContextSize ?? defaultConfig.openai.searchContextSize
  if (typeof searchContextSize !== "string" || !isOneOf(searchContextSize, searchContextSizes)) {
    throw invalidOption("openai.searchContextSize", 'one of "low", "medium", or "high"')
  }
  const userLocation = parseUserLocation(openai.userLocation)

  const googleModel = google.model ?? defaultConfig.google.model
  if (typeof googleModel !== "string" || googleModel.length === 0 || googleModel.length > 100) {
    throw invalidOption("google.model", "a non-empty string of at most 100 characters")
  }
  const thinkingLevel = google.thinkingLevel ?? defaultConfig.google.thinkingLevel
  if (typeof thinkingLevel !== "string" || !isOneOf(thinkingLevel, thinkingLevels)) {
    throw invalidOption("google.thinkingLevel", 'one of "minimal", "low", "medium", or "high"')
  }
  const searchTimeRange = google.searchTimeRange ?? defaultConfig.google.searchTimeRange
  if (typeof searchTimeRange !== "string" || !isOneOf(searchTimeRange, searchTimeRanges)) {
    throw invalidOption("google.searchTimeRange", 'one of "any", "lastDay", "lastWeek", "lastMonth", or "lastYear"')
  }

  const timeoutMs = options.timeoutMs ?? defaultConfig.timeoutMs
  if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 100 || (timeoutMs as number) > 120_000) {
    throw invalidOption("timeoutMs", "an integer from 100 through 120000")
  }

  return {
    openai: {
      model,
      reasoningEffort: reasoningEffort as ReasoningEffort,
      searchContextSize: searchContextSize as SearchContextSize,
      ...(userLocation ? { userLocation } : {}),
    },
    google: {
      model: googleModel,
      thinkingLevel: thinkingLevel as ThinkingLevel,
      searchTimeRange: searchTimeRange as SearchTimeRange,
    },
    timeoutMs: timeoutMs as number,
  }
}

function parseUserLocation(value: unknown): UserLocation | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    throw invalidOption("openai.userLocation", "an object with optional string fields city, country, region, or timezone")
  }
  const location: UserLocation = {}
  for (const key of Object.keys(value)) {
    if (!isOneOf(key, userLocationKeys)) {
      throw invalidOption(`openai.userLocation.${key}`, `a key from ${userLocationKeys.join(", ")}`)
    }
    const field = value[key]
    if (typeof field !== "string") {
      throw invalidOption(`openai.userLocation.${key}`, "a string")
    }
    if (field.length > 0) {
      ;(location as Record<string, string>)[key] = field
    }
  }
  return Object.keys(location).length > 0 ? location : undefined
}

function isOneOf<const Values extends readonly string[]>(value: unknown, values: Values): value is Values[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value)
}

function invalidOption(name: string, expected: string): Error {
  return new Error(`Invalid plugin option ${name}; expected ${expected}.`)
}
