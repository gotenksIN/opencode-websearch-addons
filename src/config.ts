import { Result, Schema } from "effect";

import { isRecord } from "./types.js";
import type { JsonValue } from "./types.js";

const reasoningEffortSchema = Schema.Literals([
  "none",
  "minimal",
  "low",
  "medium",
]);

export type ReasoningEffort = typeof reasoningEffortSchema.Type;

const thinkingLevelSchema = Schema.Literals(["minimal", "low", "medium"]);

export type ThinkingLevel = typeof thinkingLevelSchema.Type;

const searchContextSizeSchema = Schema.Literals(["low", "medium", "high"]);

export type SearchContextSize = typeof searchContextSizeSchema.Type;

const searchTimeRangeSchema = Schema.Literals([
  "any",
  "lastDay",
  "lastWeek",
  "lastMonth",
  "lastYear",
]);

export type SearchTimeRange = typeof searchTimeRangeSchema.Type;

const userLocationKeys = ["city", "country", "region", "timezone"] as const;
const userLocationKeySchema = Schema.Literals(userLocationKeys);
const modelSchema = Schema.String.check(Schema.isBetweenLength(1, 100));

const timeoutMsSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 100, maximum: 120_000 })
);

export interface UserLocation {
  readonly city?: string;
  readonly country?: string;
  readonly region?: string;
  readonly timezone?: string;
}

export interface OpenAIOptions {
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly searchContextSize: SearchContextSize;
  readonly userLocation?: UserLocation;
}

export interface GoogleOptions {
  readonly model: string;
  readonly thinkingLevel: ThinkingLevel;
  readonly searchTimeRange: SearchTimeRange;
}

export interface PluginConfig {
  readonly openai: OpenAIOptions;
  readonly google: GoogleOptions;
  readonly timeoutMs: number;
}

const defaultConfig: PluginConfig = {
  openai: {
    model: "gpt-6-luna",
    reasoningEffort: "medium",
    searchContextSize: "medium",
  },
  google: {
    model: "gemini-3.5-flash-lite",
    thinkingLevel: "medium",
    searchTimeRange: "any",
  },
  timeoutMs: 120_000,
};

const invalidOption = (name: string, expected: string) =>
  new Error(`Invalid plugin option ${name}; expected ${expected}.`);

const decodeOption = <S extends Schema.Decoder<unknown>>(
  schema: S,
  value: JsonValue | undefined,
  name: string,
  expected: string
) =>
  Result.getOrThrowWith(Schema.decodeUnknownResult(schema)(value), () =>
    invalidOption(name, expected)
  );

const parseUserLocation = (value: JsonValue | undefined) => {
  if (value === undefined) {
    return value;
  }

  if (!isRecord(value)) {
    throw invalidOption(
      "openai.userLocation",
      "an object with optional string fields city, country, region, or timezone"
    );
  }

  const fields: { -readonly [Key in keyof UserLocation]: UserLocation[Key] } =
    {};

  for (const key of Object.keys(value)) {
    const validKey = decodeOption(
      userLocationKeySchema,
      key,
      `openai.userLocation.${key}`,
      `a key from ${userLocationKeys.join(", ")}`
    );

    const field = decodeOption(
      Schema.String,
      value[key],
      `openai.userLocation.${validKey}`,
      "a string"
    );

    if (field.length > 0) {
      fields[validKey] = field;
    }
  }

  const location: UserLocation = { ...fields };

  return Object.keys(fields).length > 0 ? location : undefined;
};

const parseOpenAI = (openai: Record<string, JsonValue>) => {
  const model = decodeOption(
    modelSchema,
    openai.model ?? defaultConfig.openai.model,
    "openai.model",
    "a non-empty string of at most 100 characters"
  );

  const reasoningEffort = decodeOption(
    reasoningEffortSchema,
    openai.reasoningEffort ?? defaultConfig.openai.reasoningEffort,
    "openai.reasoningEffort",
    'one of "none", "minimal", "low", or "medium"'
  );

  const searchContextSize = decodeOption(
    searchContextSizeSchema,
    openai.searchContextSize ?? defaultConfig.openai.searchContextSize,
    "openai.searchContextSize",
    'one of "low", "medium", or "high"'
  );

  const userLocation = parseUserLocation(openai.userLocation);

  const options: OpenAIOptions = userLocation
    ? { model, reasoningEffort, searchContextSize, userLocation }
    : { model, reasoningEffort, searchContextSize };

  return options;
};

const parseGoogle = (google: Record<string, JsonValue>) => {
  const model = decodeOption(
    modelSchema,
    google.model ?? defaultConfig.google.model,
    "google.model",
    "a non-empty string of at most 100 characters"
  );

  const thinkingLevel = decodeOption(
    thinkingLevelSchema,
    google.thinkingLevel ?? defaultConfig.google.thinkingLevel,
    "google.thinkingLevel",
    'one of "minimal", "low", or "medium"'
  );

  const searchTimeRange = decodeOption(
    searchTimeRangeSchema,
    google.searchTimeRange ?? defaultConfig.google.searchTimeRange,
    "google.searchTimeRange",
    'one of "any", "lastDay", "lastWeek", "lastMonth", or "lastYear"'
  );

  const options: GoogleOptions = { model, thinkingLevel, searchTimeRange };

  return options;
};

export const parseConfig = (options: JsonValue = {}) => {
  const opts = isRecord(options) ? options : {};
  const openaiValue = opts.openai;

  if (openaiValue !== undefined && !isRecord(openaiValue)) {
    throw invalidOption("openai", "an object");
  }

  const googleValue = opts.google;

  if (googleValue !== undefined && !isRecord(googleValue)) {
    throw invalidOption("google", "an object");
  }

  const openai = parseOpenAI(openaiValue ?? {});
  const google = parseGoogle(googleValue ?? {});

  const timeoutMs = decodeOption(
    timeoutMsSchema,
    opts.timeoutMs ?? defaultConfig.timeoutMs,
    "timeoutMs",
    "an integer from 100 through 120000"
  );

  const config: PluginConfig = { openai, google, timeoutMs };

  return config;
};
