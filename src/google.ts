import { DateTime, Effect, Redacted, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { HttpClientResponse } from "effect/http";

import { resolveCredential } from "./auth.js";
import type { IntegrationContext } from "./auth.js";
import type { GoogleOptions, SearchTimeRange } from "./config.js";
import {
  isJSONNumber,
  isJSONString,
  isRecord,
  isSourceURL,
  parsedTimestamp,
  providerBaseURL,
  providerError,
  readJSON,
  sanitizeEncodeError,
  sanitizeProviderMessage,
  sanitizeTransportError,
  sseEvents,
  toResult,
  withRequestOptions,
  withSearchTimeout,
} from "./types.js";
import type { InternalSource, JsonValue, WebSearch } from "./types.js";

const apiBase = "https://generativelanguage.googleapis.com/v1beta";
const thinkingLevelWire = { minimal: "MINIMAL", low: "LOW", medium: "MEDIUM" };

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
  "ESCALATION",
  "PUP_LIMITED_DISABLED",
]);

const errorFinishReasons = new Set([
  "MAX_TOKENS",
  "CONTINUATION",
  "OTHER",
  "IMAGE_OTHER",
  "MALFORMED_FUNCTION_CALL",
  "UNEXPECTED_TOOL_CALL",
  "NO_IMAGE",
  "TOO_MANY_TOOL_CALLS",
  "MISSING_THOUGHT_SIGNATURE",
  "MALFORMED_RESPONSE",
]);

const rangeOffsets = {
  lastDay: { days: 1 },
  lastWeek: { weeks: 1 },
  lastMonth: { months: 1 },
  lastYear: { years: 1 },
} as const;

const stripMilliseconds = (value: DateTime.Utc) =>
  DateTime.formatIso(value).replace(/\.\d{3}Z$/u, "Z");

const timeRangeFilterFor = (
  range: Exclude<SearchTimeRange, "any">,
  now: DateTime.Utc
) => ({
  startTime: stripMilliseconds(DateTime.subtract(now, rangeOffsets[range])),
  endTime: stripMilliseconds(now),
});

const buildGenerateContentBody = Effect.fnUntraced(
  function* buildGenerateContentBody(config: GoogleOptions, query: string) {
    const tool: Record<string, JsonValue> = {};

    if (config.searchTimeRange === "any") {
      tool.googleSearch = {};
    } else {
      const now = yield* DateTime.now;
      tool.googleSearch = {
        timeRangeFilter: timeRangeFilterFor(config.searchTimeRange, now),
      };
    }

    const body: Record<string, JsonValue> = {};
    body.contents = [{ role: "user", parts: [{ text: query }] }];
    body.tools = [tool];
    body.generationConfig = {
      thinkingConfig: {
        thinkingLevel: thinkingLevelWire[config.thinkingLevel],
      },
    };

    return body;
  }
);

interface MergedCandidate {
  readonly parts: (string | undefined)[];
  grounding?: Record<string, JsonValue>;
  finishReason?: string;
  blockReason?: string;
}

const validGenerateContentEnvelope = (body: Record<string, JsonValue>) => {
  if (body.promptFeedback !== undefined && !isRecord(body.promptFeedback)) {
    return false;
  }

  if (body.usageMetadata !== undefined && !isRecord(body.usageMetadata)) {
    return false;
  }

  if (body.candidates !== undefined && !Array.isArray(body.candidates)) {
    return false;
  }

  if (Array.isArray(body.candidates)) {
    return body.candidates.every((candidate) => {
      if (!isRecord(candidate)) {
        return false;
      }

      if (
        candidate.finishReason !== undefined &&
        !isJSONString(candidate.finishReason)
      ) {
        return false;
      }

      if (
        candidate.groundingMetadata !== undefined &&
        !isRecord(candidate.groundingMetadata)
      ) {
        return false;
      }

      if (isRecord(candidate.groundingMetadata)) {
        const { groundingChunks, groundingSupports } =
          candidate.groundingMetadata;

        if (groundingChunks !== undefined && !Array.isArray(groundingChunks)) {
          return false;
        }

        if (
          groundingSupports !== undefined &&
          !Array.isArray(groundingSupports)
        ) {
          return false;
        }
      }

      if (candidate.content === undefined) {
        return true;
      }

      return (
        isRecord(candidate.content) &&
        (candidate.content.parts === undefined ||
          (Array.isArray(candidate.content.parts) &&
            candidate.content.parts.every(
              (part) =>
                isRecord(part) &&
                (part.text === undefined || isJSONString(part.text)) &&
                (part.thought === undefined ||
                  part.thought === true ||
                  part.thought === false)
            )))
      );
    });
  }

  return isRecord(body.promptFeedback) || isRecord(body.usageMetadata);
};

const mergeGrounding = (
  merged: MergedCandidate,
  metadata: Record<string, JsonValue>
) => {
  if (
    !Array.isArray(metadata.groundingChunks) &&
    !Array.isArray(metadata.groundingSupports)
  ) {
    return;
  }

  merged.grounding ??= {};
  const { grounding } = merged;

  for (const key of ["groundingChunks", "groundingSupports"]) {
    const incoming = metadata[key];

    if (!Array.isArray(incoming)) {
      continue;
    }

    const previous = grounding[key];
    grounding[key] = Array.isArray(previous)
      ? [...previous, ...incoming]
      : [...incoming];
  }
};

const mergeChunk = Effect.fnUntraced(function* mergeChunk(
  merged: MergedCandidate,
  payload: JsonValue,
  credentials: readonly Redacted.Redacted[]
) {
  if (!isRecord(payload)) {
    return merged;
  }

  if (payload.error !== undefined) {
    if (!isRecord(payload.error)) {
      return yield* Effect.fail(
        new Error("Invalid Gemini web search response: malformed stream error")
      );
    }

    const message = isJSONString(payload.error.message)
      ? payload.error.message
      : "unknown error";

    return yield* Effect.fail(
      new Error(
        `Gemini web search failed: ${sanitizeProviderMessage(message, credentials)}`
      )
    );
  }

  if (
    isRecord(payload.promptFeedback) &&
    isJSONString(payload.promptFeedback.blockReason)
  ) {
    merged.blockReason = sanitizeProviderMessage(
      payload.promptFeedback.blockReason,
      credentials
    );
  }

  if (!Array.isArray(payload.candidates) || payload.candidates.length === 0) {
    return merged;
  }

  const [candidate] = payload.candidates;

  if (!isRecord(candidate)) {
    return merged;
  }

  const content = isRecord(candidate.content) ? candidate.content : {};

  if (Array.isArray(content.parts)) {
    for (const [index, part] of content.parts.entries()) {
      if (isRecord(part) && part.thought !== true && isJSONString(part.text)) {
        merged.parts[index] = (merged.parts[index] ?? "") + part.text;
      }
    }
  }

  if (isRecord(candidate.groundingMetadata)) {
    mergeGrounding(merged, candidate.groundingMetadata);
  }

  if (isJSONString(candidate.finishReason)) {
    merged.finishReason = sanitizeProviderMessage(
      candidate.finishReason,
      credentials
    );
  }

  return merged;
});

const collectGenerateContent = Effect.fnUntraced(
  function* collectGenerateContent(
    response: HttpClientResponse.HttpClientResponse,
    credentials: readonly Redacted.Redacted[]
  ) {
    const contentType = response.headers["content-type"] ?? "";

    if (!contentType.includes("text/event-stream")) {
      const body = yield* readJSON(response, "Gemini");

      if (
        !isRecord(body) ||
        (body.error === undefined && !validGenerateContentEnvelope(body))
      ) {
        return yield* Effect.fail(
          new Error(
            "Invalid Gemini web search response: malformed response envelope"
          )
        );
      }

      return yield* mergeChunk({ parts: [] }, body, credentials);
    }

    const merged: MergedCandidate = { parts: [] };
    let terminal = false;

    yield* Stream.runForEach(sseEvents(response, "Gemini"), (payload) =>
      mergeChunk(merged, payload, credentials).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            terminal ||=
              merged.finishReason !== undefined ||
              merged.blockReason !== undefined ||
              (isRecord(payload) && isRecord(payload.usageMetadata));
          })
        )
      )
    );

    if (!terminal) {
      return yield* Effect.fail(
        new Error(
          "Invalid Gemini web search response: stream ended without a terminal event"
        )
      );
    }

    return merged;
  }
);

const collectChunks = (
  chunks: JsonValue[],
  sourcesByURL: Map<string, InternalSource>
) => {
  const chunkIndexToSource = new Map<number, InternalSource>();

  for (const [index, rawChunk] of chunks.entries()) {
    if (!isRecord(rawChunk)) {
      continue;
    }

    const web = isRecord(rawChunk.web) ? rawChunk.web : {};
    const url = isJSONString(web.uri) ? web.uri : undefined;

    if (url === undefined || url.length === 0 || !isSourceURL(url)) {
      continue;
    }

    const title = isJSONString(web.title) ? web.title : undefined;
    const published = parsedTimestamp(web.published_date ?? web.published);
    let source = sourcesByURL.get(url);

    if (!source) {
      source = { url, spans: [], seenSpans: new Set() };
      sourcesByURL.set(url, source);
    }

    if (
      (source.title === undefined || source.title.length === 0) &&
      title !== undefined &&
      title.length > 0
    ) {
      source.title = title;
    }

    if (source.published === undefined && published !== undefined) {
      source.published = published;
    }

    chunkIndexToSource.set(index, source);
  }

  return chunkIndexToSource;
};

const segmentSpan = (part: string, segment: Record<string, JsonValue>) => {
  const supplied =
    isJSONString(segment.text) && part.includes(segment.text)
      ? segment.text
      : "";

  const start = segment.startIndex ?? 0;
  const end = segment.endIndex;

  if (
    !isJSONNumber(start) ||
    !isJSONNumber(end) ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start
  ) {
    return supplied;
  }

  const bytes = new TextEncoder().encode(part);

  if (end > bytes.length) {
    return supplied;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.slice(start, end)
    );
  } catch {
    return supplied;
  }
};

const collectSupports = (
  merged: MergedCandidate,
  chunkIndexToSource: Map<number, InternalSource>
) => {
  const supports = merged.grounding?.groundingSupports;

  if (!Array.isArray(supports)) {
    return;
  }

  for (const rawSupport of supports) {
    if (!isRecord(rawSupport)) {
      continue;
    }

    const segment = isRecord(rawSupport.segment) ? rawSupport.segment : {};
    const partIndex = segment.partIndex ?? 0;

    if (
      !isJSONNumber(partIndex) ||
      !Number.isSafeInteger(partIndex) ||
      partIndex < 0
    ) {
      continue;
    }

    const part = merged.parts[partIndex];

    if (part === undefined) {
      continue;
    }

    const span = segmentSpan(part, segment);

    if (span.length === 0 || !Array.isArray(rawSupport.groundingChunkIndices)) {
      continue;
    }

    for (const rawIndex of rawSupport.groundingChunkIndices) {
      if (!isJSONNumber(rawIndex)) {
        continue;
      }

      const source = chunkIndexToSource.get(rawIndex);

      if (!source || source.seenSpans.has(span)) {
        continue;
      }

      source.seenSpans.add(span);
      source.spans.push(span);
    }
  }
};

const normalizeGenerateContent = Effect.fnUntraced(
  function* normalizeGenerateContent(merged: MergedCandidate) {
    const { finishReason, blockReason } = merged;

    if (blockReason !== undefined && blockReason.length > 0) {
      return yield* Effect.fail(
        new Error(
          `Gemini web search blocked by the provider (prompt block reason ${blockReason})`
        )
      );
    }

    if (finishReason !== undefined && blockedFinishReasons.has(finishReason)) {
      return yield* Effect.fail(
        new Error(
          `Gemini web search blocked by the provider (finish reason ${finishReason})`
        )
      );
    }

    if (finishReason !== undefined && errorFinishReasons.has(finishReason)) {
      return yield* Effect.fail(
        new Error(`Gemini web search failed (finish reason ${finishReason})`)
      );
    }

    const chunks = merged.grounding?.groundingChunks;

    if (!Array.isArray(chunks)) {
      const empty: readonly WebSearch.Result[] = [];

      return empty;
    }

    const sourcesByURL = new Map<string, InternalSource>();
    const chunkIndexToSource = collectChunks(chunks, sourcesByURL);
    collectSupports(merged, chunkIndexToSource);

    const results: readonly WebSearch.Result[] = [...sourcesByURL.values()].map(
      toResult
    );

    return results;
  }
);

const executeGoogle = Effect.fnUntraced(function* executeGoogle(
  ctx: IntegrationContext,
  client: HttpClient.HttpClient,
  config: GoogleOptions,
  query: string
) {
  yield* Effect.yieldNow;
  const credential = yield* resolveCredential(ctx, "google");

  if (credential.type !== "key") {
    return yield* Effect.fail(
      new Error("Unsupported Google credential type; expected a key credential")
    );
  }

  const baseURL = yield* providerBaseURL(ctx, "google");

  const encodedModel = yield* Effect.try({
    try: () => encodeURIComponent(config.model),
    catch: () => sanitizeEncodeError("Gemini"),
  });

  const endpoint = `${baseURL ?? apiBase}/models/${encodedModel}:streamGenerateContent?alt=sse`;
  const payload = yield* buildGenerateContentBody(config, query);

  const baseRequest = HttpClientRequest.post(endpoint).pipe(
    HttpClientRequest.accept("text/event-stream"),
    HttpClientRequest.setHeader(
      "x-goog-api-key",
      Redacted.value(credential.key)
    )
  );

  const request = yield* HttpClientRequest.bodyJson(payload)(baseRequest).pipe(
    Effect.mapError(() => sanitizeEncodeError("Gemini"))
  );

  const credentials = [credential.key];

  return yield* Effect.scoped(
    Effect.gen(function* googleRequest() {
      const response = yield* HttpClient.withScope(client)
        .execute(request)
        .pipe(
          Effect.mapError(() => sanitizeTransportError("Gemini")),
          withRequestOptions
        );

      if (response.status < 200 || response.status >= 300) {
        return yield* providerError(response, "Gemini", credentials);
      }

      const merged = yield* collectGenerateContent(response, credentials);

      return yield* normalizeGenerateContent(merged);
    })
  );
});

export const searchGoogle = (
  ctx: IntegrationContext,
  client: HttpClient.HttpClient,
  config: GoogleOptions,
  timeoutMs: number,
  query: string
) =>
  executeGoogle(ctx, client, config, query).pipe(withSearchTimeout(timeoutMs));
