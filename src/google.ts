import { resolveCredential } from "./auth.js";
import type { IntegrationContext } from "./auth.js";
import type { GoogleOptions, SearchTimeRange } from "./config.js";
import {
  isJSONNumber,
  isJSONString,
  isRecord,
  isSourceURL,
  parseSSE,
  parsedTimestamp,
  providerBaseURL,
  providerError,
  readJSON,
  sanitizeProviderMessage,
  toResult,
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

const daysInUTCMonth = (date: Date): number =>
  new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)
  ).getUTCDate();

const stripMilliseconds = (date: Date): string =>
  date.toISOString().replace(/\.\d{3}Z$/u, "Z");

const timeRangeFilterFor = (range: SearchTimeRange, now: Date = new Date()) => {
  const start = new Date(now);

  switch (range) {
    case "lastDay": {
      start.setUTCDate(start.getUTCDate() - 1);
      break;
    }

    case "lastWeek": {
      start.setUTCDate(start.getUTCDate() - 7);
      break;
    }

    case "lastMonth": {
      const day = start.getUTCDate();
      start.setUTCDate(1);
      start.setUTCMonth(start.getUTCMonth() - 1);
      start.setUTCDate(Math.min(day, daysInUTCMonth(start)));
      break;
    }

    case "lastYear": {
      const day = start.getUTCDate();
      start.setUTCDate(1);
      start.setUTCFullYear(start.getUTCFullYear() - 1);
      start.setUTCDate(Math.min(day, daysInUTCMonth(start)));
      break;
    }

    case "any": {
      throw new Error(
        `Invalid searchTimeRange ${range} for a time range filter`
      );
    }

    default: {
      throw new Error(
        `Invalid searchTimeRange ${String(range)} for a time range filter`
      );
    }
  }

  return {
    startTime: stripMilliseconds(start),
    endTime: stripMilliseconds(now),
  };
};

const buildGenerateContentBody = (config: GoogleOptions, query: string) => {
  const tool: Record<string, JsonValue> = {};
  tool.googleSearch =
    config.searchTimeRange === "any"
      ? {}
      : { timeRangeFilter: timeRangeFilterFor(config.searchTimeRange) };
  const body: Record<string, JsonValue> = {};
  body.contents = [{ role: "user", parts: [{ text: query }] }];
  body.tools = [tool];
  body.generationConfig = {
    thinkingConfig: { thinkingLevel: thinkingLevelWire[config.thinkingLevel] },
  };

  return body;
};

interface MergedCandidate {
  readonly parts: (string | undefined)[];
  grounding?: Record<string, JsonValue>;
  finishReason?: string;
  blockReason?: string;
}

const validGenerateContentEnvelope = (
  body: Record<string, JsonValue>
): boolean => {
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
): void => {
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

const mergeChunk = (
  merged: MergedCandidate,
  payload: JsonValue,
  credentials: readonly string[]
): MergedCandidate => {
  if (!isRecord(payload)) {
    return merged;
  }

  if (payload.error !== undefined) {
    if (!isRecord(payload.error)) {
      throw new Error(
        "Invalid Gemini web search response: malformed stream error"
      );
    }

    const message = isJSONString(payload.error.message)
      ? payload.error.message
      : "unknown error";

    throw new Error(
      `Gemini web search failed: ${sanitizeProviderMessage(message, credentials)}`
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
};

const collectGenerateContent = async (
  response: Response,
  credentials: readonly string[]
): Promise<MergedCandidate> => {
  const contentType = response.headers.get("content-type") ?? "";

  if (!contentType.includes("text/event-stream")) {
    const body = await readJSON(response);

    if (
      !isRecord(body) ||
      (body.error === undefined && !validGenerateContentEnvelope(body))
    ) {
      throw new Error(
        "Invalid Gemini web search response: malformed response envelope"
      );
    }

    return mergeChunk({ parts: [] }, body, credentials);
  }

  const merged: MergedCandidate = { parts: [] };
  let terminal = false;

  for await (const payload of parseSSE(response, "Gemini")) {
    mergeChunk(merged, payload, credentials);
    terminal ||=
      merged.finishReason !== undefined ||
      merged.blockReason !== undefined ||
      (isRecord(payload) && isRecord(payload.usageMetadata));
  }

  if (!terminal) {
    throw new Error(
      "Invalid Gemini web search response: stream ended without a terminal event"
    );
  }

  return merged;
};

const collectChunks = (
  chunks: JsonValue[],
  sourcesByURL: Map<string, InternalSource>
): Map<number, InternalSource> => {
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

const segmentSpan = (
  part: string,
  segment: Record<string, JsonValue>
): string => {
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
): void => {
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

const normalizeGenerateContent = (
  merged: MergedCandidate
): readonly WebSearch.Result[] => {
  const { finishReason, blockReason } = merged;

  if (blockReason !== undefined && blockReason.length > 0) {
    throw new Error(
      `Gemini web search blocked by the provider (prompt block reason ${blockReason})`
    );
  }

  if (finishReason !== undefined && blockedFinishReasons.has(finishReason)) {
    throw new Error(
      `Gemini web search blocked by the provider (finish reason ${finishReason})`
    );
  }

  if (finishReason !== undefined && errorFinishReasons.has(finishReason)) {
    throw new Error(`Gemini web search failed (finish reason ${finishReason})`);
  }

  const chunks = merged.grounding?.groundingChunks;

  if (!Array.isArray(chunks)) {
    return [];
  }

  const sourcesByURL = new Map<string, InternalSource>();
  const chunkIndexToSource = collectChunks(chunks, sourcesByURL);
  collectSupports(merged, chunkIndexToSource);

  return [...sourcesByURL.values()].map(toResult);
};

export const searchGoogle = async (
  ctx: IntegrationContext,
  config: GoogleOptions,
  timeoutMs: number,
  query: string,
  contextSignal: AbortSignal
): Promise<readonly WebSearch.Result[]> => {
  contextSignal.throwIfAborted();
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort(
      new DOMException("The operation timed out.", "TimeoutError")
    );
  }, timeoutMs);

  const onAbort = () => {
    controller.abort(contextSignal.reason);
  };

  if (contextSignal.aborted) {
    controller.abort(contextSignal.reason);
  } else {
    contextSignal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const credential = await resolveCredential(
      ctx,
      "google",
      controller.signal
    );

    controller.signal.throwIfAborted();

    if (credential.type !== "key") {
      throw new Error(
        "Unsupported Google credential type; expected a key credential"
      );
    }

    const baseURL = await providerBaseURL(ctx, "google", controller.signal);
    controller.signal.throwIfAborted();
    const endpoint = `${baseURL ?? apiBase}/models/${encodeURIComponent(config.model)}:streamGenerateContent?alt=sse`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "x-goog-api-key": credential.key,
      },
      body: JSON.stringify(buildGenerateContentBody(config, query)),
      redirect: "error",
      signal: controller.signal,
    });

    if (!response.ok) {
      await providerError(response, "Gemini", [credential.key]);
    }

    const merged = await collectGenerateContent(response, [credential.key]);

    return normalizeGenerateContent(merged);
  } finally {
    clearTimeout(timer);
    contextSignal.removeEventListener("abort", onAbort);
  }
};
