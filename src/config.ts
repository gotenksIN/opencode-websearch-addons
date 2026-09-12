import { isJSONString, isRecord } from "./types.js"
import type { JsonValue } from "./types.js"

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

export function parseConfig(options: JsonValue = {}): PluginConfig {
  const opts = isRecord(options) ? options : {}
  const openaiValue = opts.openai

  if (openaiValue !== undefined && !isRecord(openaiValue)) {
    throw invalidOption("openai", "an object")
  }

  const googleValue = opts.google

  if (googleValue !== undefined && !isRecord(googleValue)) {
    throw invalidOption("google", "an object")
  }

  const openai = openaiValue === undefined ? {} : openaiValue
  const google = googleValue === undefined ? {} : googleValue

  const model = openai.model ?? defaultConfig.openai.model

  if (!isJSONString(model) || model.length === 0 || model.length > 100) {
    throw invalidOption("openai.model", "a non-empty string of at most 100 characters")
  }

  const reasoningEffort = openai.reasoningEffort ?? defaultConfig.openai.reasoningEffort

  if (!isOneOf(reasoningEffort, reasoningEfforts)) {
    throw invalidOption("openai.reasoningEffort", 'one of "none", "minimal", "low", "medium", "high", "xhigh", or "max"')
  }

  const searchContextSize = openai.searchContextSize ?? defaultConfig.openai.searchContextSize

  if (!isOneOf(searchContextSize, searchContextSizes)) {
    throw invalidOption("openai.searchContextSize", 'one of "low", "medium", or "high"')
  }

  const userLocation = parseUserLocation(openai.userLocation)

  const googleModel = google.model ?? defaultConfig.google.model

  if (!isJSONString(googleModel) || googleModel.length === 0 || googleModel.length > 100) {
    throw invalidOption("google.model", "a non-empty string of at most 100 characters")
  }

  const thinkingLevel = google.thinkingLevel ?? defaultConfig.google.thinkingLevel

  if (!isOneOf(thinkingLevel, thinkingLevels)) {
    throw invalidOption("google.thinkingLevel", 'one of "minimal", "low", "medium", or "high"')
  }

  const searchTimeRange = google.searchTimeRange ?? defaultConfig.google.searchTimeRange

  if (!isOneOf(searchTimeRange, searchTimeRanges)) {
    throw invalidOption("google.searchTimeRange", 'one of "any", "lastDay", "lastWeek", "lastMonth", or "lastYear"')
  }

  const timeoutMs = safeInteger(opts.timeoutMs ?? defaultConfig.timeoutMs)

  if (timeoutMs === undefined || timeoutMs < 100 || timeoutMs > 120_000) {
    throw invalidOption("timeoutMs", "an integer from 100 through 120000")
  }

  return {
    openai: userLocation
      ? { model, reasoningEffort, searchContextSize, userLocation }
      : { model, reasoningEffort, searchContextSize },
    google: { model: googleModel, thinkingLevel, searchTimeRange },
    timeoutMs,
  }
}

function parseUserLocation(value: JsonValue | undefined): UserLocation | undefined {
  if (value === undefined) return undefined

  if (!isRecord(value)) {
    throw invalidOption("openai.userLocation", "an object with optional string fields city, country, region, or timezone")
  }

  const fields: Record<string, string> = {}

  for (const key of Object.keys(value)) {
    if (!isOneOf(key, userLocationKeys)) {
      throw invalidOption(`openai.userLocation.${key}`, `a key from ${userLocationKeys.join(", ")}`)
    }

    const field = value[key]

    if (!isJSONString(field)) {
      throw invalidOption(`openai.userLocation.${key}`, "a string")
    }

    if (field.length > 0) fields[key] = field
  }

  return Object.keys(fields).length > 0 ? { ...fields } : undefined
}

function safeInteger(value: JsonValue): number | undefined {
  // SAFETY: Number.isSafeInteger returns true only for integers, which are numbers.
  return Number.isSafeInteger(value) ? (value as number) : undefined
}

function isOneOf<const Values extends readonly string[]>(value: JsonValue, values: Values): value is Values[number] {
  if (!isJSONString(value)) return false

  return values.some((entry) => entry === value)
}

function invalidOption(name: string, expected: string): Error {
  return new Error(`Invalid plugin option ${name}; expected ${expected}.`)
}
