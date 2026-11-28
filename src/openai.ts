import { Effect, Stream } from "effect";
import type { Redacted } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { HttpClientResponse } from "effect/http";

import { resolveCredential } from "./auth.js";
import type { IntegrationContext } from "./auth.js";
import type { OpenAIOptions } from "./config.js";
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
  sliceSpan,
  sseEvents,
  toResult,
  withRequestOptions,
  withSearchTimeout,
} from "./types.js";
import type { InternalSource, JsonValue, WebSearch } from "./types.js";

const publicEndpoint = "https://api.openai.com/v1/responses";
const codexEndpoint = "https://chatgpt.com/backend-api/codex/responses";

const buildResponsesBody = (config: OpenAIOptions, query: string) => {
  const tool: Record<string, JsonValue> = {};
  tool.type = "web_search";
  tool.search_context_size = config.searchContextSize;
  tool.external_web_access = true;

  if (config.userLocation) {
    tool.user_location = { type: "approximate", ...config.userLocation };
  }

  const body: Record<string, JsonValue> = {};
  body.model = config.model;
  body.input = [
    { role: "user", content: [{ type: "input_text", text: query }] },
  ];
  body.tools = [tool];
  body.reasoning = { effort: config.reasoningEffort };
  body.include = ["web_search_call.action.sources"];
  body.store = false;
  body.stream = true;

  return body;
};

const incompleteError = (
  response: Record<string, JsonValue>,
  credentials: readonly Redacted.Redacted[]
) => {
  const details = isRecord(response.incomplete_details)
    ? response.incomplete_details
    : {};

  const reason = isJSONString(details.reason)
    ? sanitizeProviderMessage(details.reason, credentials)
    : "unknown reason";

  return new Error(`OpenAI web search incomplete: ${reason}`);
};

const streamErrorMessage = (payload: Record<string, JsonValue>) => {
  const response = isRecord(payload.response) ? payload.response : {};
  const responseError = isRecord(response.error) ? response.error : {};
  const error = isRecord(payload.error) ? payload.error : {};
  let message: string | undefined;
  let code: string | undefined;

  for (const value of [payload.message, error.message, responseError.message]) {
    if (isJSONString(value) && value.length > 0) {
      message = value;
      break;
    }
  }

  for (const value of [payload.code, error.code, responseError.code]) {
    if (isJSONString(value) && value.length > 0) {
      code = value;
      break;
    }
  }

  if (message !== undefined && code !== undefined) {
    return `${code}: ${message}`;
  }

  return message ?? code ?? "unknown error";
};

const readOutputItems = Effect.fnUntraced(function* readOutputItems(
  response: HttpClientResponse.HttpClientResponse,
  credentials: readonly Redacted.Redacted[]
) {
  const body = yield* readJSON(response, "OpenAI");

  if (!isRecord(body)) {
    return yield* Effect.fail(
      new Error("Invalid OpenAI web search response: body is not an object")
    );
  }

  if (body.status === "incomplete") {
    return yield* Effect.fail(incompleteError(body, credentials));
  }

  if (body.status === "failed" || isRecord(body.error)) {
    const message = streamErrorMessage(body);

    return yield* Effect.fail(
      new Error(
        `OpenAI web search failed: ${sanitizeProviderMessage(message, credentials)}`
      )
    );
  }

  if (body.error !== undefined && body.error !== null) {
    return yield* Effect.fail(
      new Error("Invalid OpenAI web search response: malformed error")
    );
  }

  if (!Array.isArray(body.output)) {
    return yield* Effect.fail(
      new TypeError("Invalid OpenAI web search response: missing output")
    );
  }

  return body.output;
});

const collectOutputItems = Effect.fnUntraced(function* collectOutputItems(
  response: HttpClientResponse.HttpClientResponse,
  credentials: readonly Redacted.Redacted[]
) {
  const contentType = (response.headers["content-type"] ?? "")
    .trim()
    .toLowerCase();

  if (contentType.length > 0 && !contentType.includes("text/event-stream")) {
    return yield* readOutputItems(response, credentials);
  }

  const items: JsonValue[] = [];
  let completed: JsonValue[] | undefined;
  let terminal = false;

  yield* Stream.runForEachWhile(
    sseEvents(response, "OpenAI", true),
    (payload) => {
      if (!isRecord(payload)) {
        return Effect.succeed(true);
      }

      if (
        payload.type === "response.output_item.done" &&
        isRecord(payload.item)
      ) {
        items.push(payload.item);

        return Effect.succeed(true);
      }

      if (payload.type === "response.incomplete") {
        return Effect.fail(
          incompleteError(
            isRecord(payload.response) ? payload.response : {},
            credentials
          )
        );
      }

      if (payload.type === "response.completed") {
        terminal = true;

        const output = isRecord(payload.response)
          ? payload.response.output
          : undefined;

        if (Array.isArray(output)) {
          completed = output;
        }

        return Effect.succeed(false);
      }

      if (payload.type === "response.failed" || payload.type === "error") {
        const message = streamErrorMessage(payload);

        return Effect.fail(
          new Error(
            `OpenAI web search failed: ${sanitizeProviderMessage(message, credentials)}`
          )
        );
      }

      return Effect.succeed(true);
    }
  );

  if (!terminal) {
    return yield* Effect.fail(
      new Error(
        "Invalid OpenAI web search response: stream ended without a terminal event"
      )
    );
  }

  return completed !== undefined && completed.length > 0 ? completed : items;
});

const addSource = (
  sourcesByURL: Map<string, InternalSource>,
  url: string,
  fields: {
    readonly title?: string;
    readonly published?: number;
    readonly span?: string;
  }
) => {
  let source = sourcesByURL.get(url);

  if (!source) {
    source = { url, spans: [], seenSpans: new Set() };
    sourcesByURL.set(url, source);
  }

  if (
    (source.title === undefined || source.title.length === 0) &&
    fields.title !== undefined &&
    fields.title.length > 0
  ) {
    source.title = fields.title;
  }

  if (source.published === undefined && fields.published !== undefined) {
    source.published = fields.published;
  }

  const { span } = fields;

  if (span !== undefined && span.length > 0 && !source.seenSpans.has(span)) {
    source.seenSpans.add(span);
    source.spans.push(span);
  }
};

interface TextRange {
  readonly start: number;
  readonly end: number;
}

const citationMarker =
  /^(?:\(?\[[^\]\r\n]*\]\(https?:\/\/[^\s)\r\n]+\)\)?|\[\d+(?:[ ,–-]+\d+)*\]|\uE200cite\uE202[^\uE201]+\uE201)$/u;

const markerSeparator = /^[\s.,;:!?]*$/u;
const blankLine = /\r?\n[\t ]*\r?\n/u;
const paragraphBreaks = /\r?\n[\t ]*\r?\n/gu;
const listItemBreaks = /\r?\n(?=[\t ]*(?:[-*+]|\d+[.)])\s)/gu;
const leadingPunctuation = /^[.,;:!?]+\s*/u;

const trimmedMarkerRange = (text: string, start: number, end: number) => {
  const raw = text.slice(start, end);
  const trimmed = raw.trim();

  if (!citationMarker.test(trimmed)) {
    return null;
  }

  const offset = raw.indexOf(trimmed);

  return { start: start + offset, end: start + offset + trimmed.length };
};

const utf16Offset = (text: string, points: number) => {
  let offset = 0;

  for (let count = 0; count < points; count += 1) {
    const point = text.codePointAt(offset);

    if (point === undefined) {
      return null;
    }

    offset += point > 0xff_ff ? 2 : 1;
  }

  return offset;
};

const markerRange = (
  text: string,
  rawStart: JsonValue | undefined,
  rawEnd: JsonValue | undefined
) => {
  if (
    !isJSONNumber(rawStart) ||
    !isJSONNumber(rawEnd) ||
    !Number.isSafeInteger(rawStart) ||
    !Number.isSafeInteger(rawEnd) ||
    rawStart < 0 ||
    rawEnd <= rawStart
  ) {
    return null;
  }

  if (rawEnd <= text.length) {
    const direct = trimmedMarkerRange(text, rawStart, rawEnd);

    if (direct !== null) {
      return direct;
    }
  }

  const start = utf16Offset(text, rawStart);
  const end = utf16Offset(text, rawEnd);

  if (
    start === null ||
    end === null ||
    (start === rawStart && end === rawEnd)
  ) {
    return null;
  }

  return trimmedMarkerRange(text, start, end);
};

const isAdjacent = (text: string, before: TextRange, start: number) => {
  const gap = text.slice(Math.min(before.end, start), start);

  return markerSeparator.test(gap) && !blankLine.test(gap);
};

const groupStart = (
  text: string,
  marker: TextRange,
  markers: readonly TextRange[]
) => {
  let { start } = marker;

  for (let index = markers.length - 1; index >= 0; index -= 1) {
    const other = markers[index];

    if (
      other !== undefined &&
      other.start < start &&
      isAdjacent(text, other, start)
    ) {
      ({ start } = other);
    }
  }

  return start;
};

const lastMatchEnd = (pattern: RegExp, text: string) => {
  let end = 0;

  for (const match of text.matchAll(pattern)) {
    end = match.index + match[0].length;
  }

  return end;
};

const passageBefore = (
  text: string,
  marker: TextRange,
  markers: readonly TextRange[]
) => {
  const start = groupStart(text, marker, markers);
  const before = text.slice(0, start);

  const boundary = Math.max(
    lastMatchEnd(paragraphBreaks, before),
    lastMatchEnd(listItemBreaks, before),
    ...markers.flatMap((other) => (other.end <= start ? [other.end] : []))
  );

  return text.slice(boundary, start).trim().replace(leadingPunctuation, "");
};

const collectPart = (
  text: string,
  annotations: readonly JsonValue[],
  sourcesByURL: Map<string, InternalSource>
) => {
  const citations = annotations
    .filter(isRecord)
    .filter((annotation) => annotation.type === "url_citation");

  const ranges = citations.map((annotation) =>
    markerRange(text, annotation.start_index, annotation.end_index)
  );

  const markers = ranges
    .filter((range) => range !== null)
    .toSorted((left, right) => left.start - right.start);

  for (const [index, annotation] of citations.entries()) {
    const url = isJSONString(annotation.url) ? annotation.url : undefined;

    if (url === undefined || url.length === 0 || !isSourceURL(url)) {
      continue;
    }

    const marker = ranges[index];

    const span =
      marker === undefined || marker === null
        ? sliceSpan(text, annotation.start_index, annotation.end_index)
        : passageBefore(text, marker, markers);

    const title = isJSONString(annotation.title) ? annotation.title : undefined;

    const published = parsedTimestamp(
      annotation.published_date ?? annotation.published
    );

    addSource(sourcesByURL, url, { title, published, span });
  }
};

const collectMessage = (
  item: Record<string, JsonValue>,
  sourcesByURL: Map<string, InternalSource>
) => {
  if (!Array.isArray(item.content)) {
    return;
  }

  for (const part of item.content) {
    if (
      isRecord(part) &&
      part.type === "output_text" &&
      isJSONString(part.text) &&
      Array.isArray(part.annotations)
    ) {
      collectPart(part.text, part.annotations, sourcesByURL);
    }
  }
};

const collectActionSources = (
  item: Record<string, JsonValue>,
  sourcesByURL: Map<string, InternalSource>
) => {
  const action = isRecord(item.action) ? item.action : {};

  if (!Array.isArray(action.sources)) {
    return;
  }

  for (const rawSource of action.sources) {
    if (!isRecord(rawSource) || rawSource.type !== "url") {
      continue;
    }

    const url = isJSONString(rawSource.url) ? rawSource.url : undefined;

    if (url === undefined || url.length === 0 || !isSourceURL(url)) {
      continue;
    }

    const title = isJSONString(rawSource.title) ? rawSource.title : undefined;

    const published = parsedTimestamp(
      rawSource.published_date ?? rawSource.published
    );

    addSource(sourcesByURL, url, { title, published });
  }
};

const normalizeOutput = (output: JsonValue[]) => {
  const sourcesByURL = new Map<string, InternalSource>();

  for (const rawItem of output) {
    if (!isRecord(rawItem)) {
      continue;
    }

    if (rawItem.type === "message") {
      collectMessage(rawItem, sourcesByURL);
    } else if (rawItem.type === "web_search_call") {
      collectActionSources(rawItem, sourcesByURL);
    }
  }

  const results: readonly WebSearch.Result[] = [...sourcesByURL.values()].map(
    toResult
  );

  return results;
};

const runOpenAIRequest = Effect.fnUntraced(function* runOpenAIRequest(
  client: HttpClient.HttpClient,
  endpoint: string,
  auth: {
    readonly token: Redacted.Redacted;
    readonly originator?: string;
    readonly accountID?: string;
  },
  config: OpenAIOptions,
  query: string,
  credentials: readonly Redacted.Redacted[]
) {
  let baseRequest = HttpClientRequest.post(endpoint).pipe(
    HttpClientRequest.bearerToken(auth.token),
    HttpClientRequest.accept("text/event-stream")
  );

  if (auth.originator !== undefined && auth.originator.length > 0) {
    baseRequest = HttpClientRequest.setHeader(
      baseRequest,
      "originator",
      auth.originator
    );
  }

  if (auth.accountID !== undefined && auth.accountID.length > 0) {
    baseRequest = HttpClientRequest.setHeader(
      baseRequest,
      "chatgpt-account-id",
      auth.accountID
    );
  }

  const request = yield* HttpClientRequest.bodyJson(
    buildResponsesBody(config, query)
  )(baseRequest).pipe(Effect.mapError(() => sanitizeEncodeError("OpenAI")));

  return yield* Effect.scoped(
    Effect.gen(function* openAIRequest() {
      const response = yield* HttpClient.withScope(client)
        .execute(request)
        .pipe(
          Effect.mapError(() => sanitizeTransportError("OpenAI")),
          withRequestOptions
        );

      if (response.status < 200 || response.status >= 300) {
        return yield* providerError(response, "OpenAI", credentials);
      }

      const items = yield* collectOutputItems(response, credentials);

      return normalizeOutput(items);
    })
  );
});

const executeOpenAI = Effect.fnUntraced(function* executeOpenAI(
  ctx: IntegrationContext,
  client: HttpClient.HttpClient,
  config: OpenAIOptions,
  query: string
) {
  yield* Effect.yieldNow;
  const credential = yield* resolveCredential(ctx, "openai");

  if (credential.type === "key") {
    const baseURL = yield* providerBaseURL(ctx, "openai");

    return yield* runOpenAIRequest(
      client,
      baseURL === undefined ? publicEndpoint : `${baseURL}/responses`,
      { token: credential.key },
      config,
      query,
      [credential.key]
    );
  }

  if (credential.type === "oauth") {
    if (credential.methodID === "chatgpt-token-sharing") {
      const baseURL = yield* providerBaseURL(ctx, "openai");

      return yield* runOpenAIRequest(
        client,
        baseURL === undefined ? publicEndpoint : `${baseURL}/responses`,
        { token: credential.access },
        config,
        query,
        [credential.access, credential.refresh]
      );
    }

    if (
      credential.methodID !== "chatgpt-browser" &&
      credential.methodID !== "chatgpt-headless"
    ) {
      return yield* Effect.fail(
        new Error(
          "Unsupported OpenAI OAuth method; expected chatgpt-token-sharing, chatgpt-browser, or chatgpt-headless"
        )
      );
    }

    const auth = {
      token: credential.access,
      originator: "opencode",
    };

    return yield* runOpenAIRequest(
      client,
      codexEndpoint,
      credential.accountID === undefined
        ? auth
        : { ...auth, accountID: credential.accountID },
      config,
      query,
      [credential.access, credential.refresh]
    );
  }

  return yield* Effect.fail(new Error("Unsupported OpenAI credential type"));
});

export const searchOpenAI = (
  ctx: IntegrationContext,
  client: HttpClient.HttpClient,
  config: OpenAIOptions,
  timeoutMs: number,
  query: string
) =>
  executeOpenAI(ctx, client, config, query).pipe(withSearchTimeout(timeoutMs));
