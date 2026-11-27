import type { Plugin, WebSearch } from "@opencode/plugin";
import {
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

export type { Credential, Plugin, WebSearch } from "@opencode/plugin";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { readonly [key: string]: JsonValue | undefined };

export const isJSONString = <T>(value: T): value is T & string =>
  Object.prototype.toString.call(value) === "[object String]";

export const isJSONNumber = <T>(value: T): value is T & number =>
  Object.prototype.toString.call(value) === "[object Number]";

export const isRecord = (value: unknown): value is Record<string, JsonValue> =>
  value instanceof Object && !Array.isArray(value);

const isJSONArray = (value: unknown): value is JsonValue[] =>
  Array.isArray(value);

export const awaitLookup = async <T>(
  operation: () => Promise<T>,
  signal?: AbortSignal
) => {
  signal?.throwIfAborted();

  if (!signal) {
    return await operation();
  }

  const { promise, reject } = Promise.withResolvers<never>();

  const onAbort = () => {
    reject(signal.reason);
  };

  signal.addEventListener("abort", onAbort, { once: true });

  try {
    return await Promise.race([operation(), promise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};

export const providerBaseURL = async (
  ctx: Pick<Plugin.Context, "provider">,
  providerID: string,
  signal?: AbortSignal
) => {
  try {
    const result = await awaitLookup(
      async () => await ctx.provider.get({ providerID }),
      signal
    );

    const settings: unknown = result?.data?.settings;
    const baseURL = isRecord(settings) ? settings.baseURL : undefined;

    const trimmed = isJSONString(baseURL)
      ? baseURL.trim().replace(/\/+$/u, "")
      : "";

    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    signal?.throwIfAborted();
    throw new Error(
      `Unable to read ${providerID} provider settings. Try again.`
    );
  }
};

export interface InternalSource {
  readonly url: string;
  title?: string;
  published?: number;
  readonly spans: string[];
  readonly seenSpans: Set<string>;
}

export const parsedTimestamp = (value: JsonValue | undefined) => {
  if (isJSONNumber(value) && Number.isFinite(value)) {
    return Math.abs(value) <= 8.64e15 ? value : undefined;
  }

  const parsed =
    isJSONString(value) && value.length > 0 ? Date.parse(value) : Number.NaN;

  return Number.isFinite(parsed) ? parsed : undefined;
};

export const isSourceURL = (value: string) => {
  if (!URL.canParse(value)) {
    return false;
  }

  const { protocol } = new URL(value);

  return protocol === "http:" || protocol === "https:";
};

export const sliceSpan = (
  text: string,
  rawStart: JsonValue | undefined,
  rawEnd: JsonValue | undefined
) => {
  if (!isJSONNumber(rawStart) || !isJSONNumber(rawEnd)) {
    return "";
  }

  const start = Math.max(0, Math.min(rawStart, text.length));
  const end = Math.max(start, Math.min(rawEnd, text.length));

  return text.slice(start, end);
};

const parseJSON = (text: string) => {
  const value: unknown = JSON.parse(text);

  if (
    value === null ||
    value === true ||
    value === false ||
    isJSONString(value) ||
    isJSONNumber(value) ||
    isJSONArray(value) ||
    isRecord(value)
  ) {
    return value satisfies JsonValue;
  }

  throw new TypeError("Invalid JSON value");
};

export const readJSON = async (response: Response) => {
  const text = await response.text();

  try {
    return parseJSON(text);
  } catch {
    throw new Error("Invalid provider response: body is not valid JSON");
  }
};

export const sanitizeProviderMessage = (
  message: string,
  credentials: readonly string[] = []
) => {
  let sanitized = message
    .replaceAll(
      /(?<quote>["']?)(?<key>\b(?:api[ _-]?key|x-goog-api-key|authorization|access[ _-]?token|refresh[ _-]?token|key)\b)\k<quote>(?<separator>\s*[:=]\s*)(?:Bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      "$<quote>$<key>$<quote>$<separator>[REDACTED]"
    )
    .replaceAll(/\bBearer\s+[^\s,;]+/giu, "Bearer [REDACTED]");

  for (const credential of credentials) {
    if (credential.length > 0) {
      sanitized = sanitized.replaceAll(credential, "[REDACTED]");
    }
  }

  return sanitized.replaceAll(
    /\b(?:sk|pk)-[A-Za-z0-9._-]{6,}\b/giu,
    "[REDACTED]"
  );
};

export const providerError = async (
  response: Response,
  provider: string,
  credentials: readonly string[] = []
) => {
  let detail: string | undefined;

  try {
    const body = await readJSON(response);

    if (
      isRecord(body) &&
      isRecord(body.error) &&
      isJSONString(body.error.message)
    ) {
      detail = body.error.message;
    } else if (isRecord(body) && isJSONString(body.error)) {
      detail = body.error;
    }
  } catch {
    detail = undefined;
  }

  const sanitizedDetail =
    detail === undefined || detail.length === 0
      ? undefined
      : sanitizeProviderMessage(detail, credentials);

  const description = `${provider} web search failed (HTTP ${response.status})${sanitizedDetail === undefined || sanitizedDetail.length === 0 ? "" : `: ${sanitizedDetail}`}`;
  const request = HttpClientRequest.post("https://provider.invalid/");
  const headers = new Headers();
  const retryAfter = response.headers.get("retry-after");

  if (retryAfter !== null && retryAfter.length > 0) {
    headers.set(
      "retry-after",
      sanitizeProviderMessage(retryAfter, credentials)
    );
  }

  const safeResponse = HttpClientResponse.fromWeb(
    request,
    new Response(null, { status: response.status, headers })
  );

  throw new HttpClientError.HttpClientError({
    reason: new HttpClientError.StatusCodeError({
      request,
      response: safeResponse,
      description,
    }),
  });
};

const parseSSEEvent = (payload: string, provider: string) => {
  try {
    return parseJSON(payload);
  } catch {
    throw new Error(
      `Invalid ${provider} web search response: malformed stream event`
    );
  }
};

export const parseSSE = async function* parseSSE(
  response: Response,
  provider: string,
  skipDone = false
) {
  if (!response.body) {
    throw new Error(`${provider} web search response has no body`);
  }

  const body: ReadableStream<Uint8Array> = response.body;
  const reader = body.getReader();

  const chunks = {
    [Symbol.asyncIterator]: () => ({
      next: async () => await reader.read(),
    }),
  };

  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let complete = false;

  const nextLine = (final: boolean) => {
    const match = /\r\n|\r|\n/u.exec(buffer);

    if (
      !match ||
      (!final && match[0] === "\r" && match.index === buffer.length - 1)
    ) {
      return null;
    }

    const line = buffer.slice(0, match.index);
    buffer = buffer.slice(match.index + match[0].length);

    return line;
  };

  const addField = (line: string) => {
    if (line.startsWith(":")) {
      return;
    }

    const colon = line.indexOf(":");

    if ((colon === -1 ? line : line.slice(0, colon)) !== "data") {
      return;
    }

    const value = colon === -1 ? "" : line.slice(colon + 1);
    data.push(value.startsWith(" ") ? value.slice(1) : value);
  };

  const takeEvent = () => {
    const payload = data.join("\n").trim();
    data = [];

    if (payload.length === 0 || (skipDone && payload === "[DONE]")) {
      return null;
    }

    return payload;
  };

  const completeEvents = function* completeEvents(final: boolean) {
    let line: string | null;

    while ((line = nextLine(final)) !== null) {
      if (line.length > 0) {
        addField(line);
        continue;
      }

      const payload = takeEvent();

      if (payload !== null) {
        yield payload;
      }
    }
  };

  try {
    for await (const value of chunks) {
      buffer += decoder.decode(value, { stream: true });

      for (const payload of completeEvents(false)) {
        yield parseSSEEvent(payload, provider);
      }
    }

    complete = true;
    buffer += decoder.decode();

    for (const payload of completeEvents(true)) {
      yield parseSSEEvent(payload, provider);
    }

    if (buffer.length > 0) {
      addField(buffer);
    }

    const payload = takeEvent();

    if (payload !== null) {
      yield parseSSEEvent(payload, provider);
    }
  } finally {
    if (!complete) {
      try {
        await reader.cancel();
      } catch {
        complete = false;
      }
    }

    reader.releaseLock();
  }
};

export const toResult = (source: InternalSource) => {
  const title =
    source.title === undefined || source.title.length === 0
      ? {}
      : { title: source.title };

  const content =
    source.spans.length === 0 ? {} : { content: source.spans.join(" ") };

  return {
    url: source.url,
    ...title,
    ...content,
    time: source.published === undefined ? {} : { published: source.published },
  } satisfies WebSearch.Result;
};
