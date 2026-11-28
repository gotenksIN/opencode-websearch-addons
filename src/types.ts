import { Provider } from "@opencode/plugin/effect";
import type { Plugin, WebSearch } from "@opencode/plugin/effect";
import {
  Cause,
  Channel,
  Duration,
  Effect,
  Option,
  Pull,
  Redacted,
  Stream,
} from "effect";
import { Sse } from "effect/encoding";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

export type { Credential, Plugin, WebSearch } from "@opencode/plugin/effect";

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

const safeRequest = HttpClientRequest.post("https://provider.invalid/");

export const sanitizeEncodeError = (provider: string) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.EncodeError({
      request: safeRequest,
      description: `${provider} web search request could not be encoded`,
    }),
  });

export const sanitizeTransportError = (provider: string) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({
      request: safeRequest,
      description: `${provider} web search request failed`,
    }),
  });

export const sanitizeReadError = (provider: string) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({
      request: safeRequest,
      description: `${provider} web search response stream failed`,
    }),
  });

export const withRequestOptions = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
  );

export const withSearchTimeout =
  (timeoutMs: number) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(timeoutMs),
        orElse: () =>
          Effect.fail(
            new DOMException("The operation timed out.", "TimeoutError")
          ),
      })
    );

export const providerBaseURL = Effect.fnUntraced(function* providerBaseURL(
  ctx: Pick<Plugin.Context, "provider">,
  providerID: string
) {
  const result = yield* ctx.provider
    .get({ providerID: Provider.ID.make(providerID) })
    .pipe(
      Effect.mapError(
        () =>
          new Error(
            `Unable to read ${providerID} provider settings. Try again.`
          )
      )
    );

  const settings: unknown = result?.data?.settings;
  const baseURL = isRecord(settings) ? settings.baseURL : undefined;

  const trimmed = isJSONString(baseURL)
    ? baseURL.trim().replace(/\/+$/u, "")
    : "";

  return trimmed.length > 0 ? trimmed : undefined;
});

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

const decodeJSONText = (text: string) =>
  Effect.try({
    try: () => parseJSON(text),
    catch: () => new Error("Invalid provider response: body is not valid JSON"),
  });

export const readJSON = Effect.fnUntraced(function* readJSON(
  response: HttpClientResponse.HttpClientResponse,
  provider: string
) {
  const text = yield* response.text.pipe(
    Effect.mapError(() => sanitizeReadError(provider))
  );

  return yield* decodeJSONText(text);
});

export const sanitizeProviderMessage = (
  message: string,
  credentials: readonly Redacted.Redacted[] = []
) => {
  let sanitized = message
    .replaceAll(
      /(?<quote>["']?)(?<key>\b(?:api[ _-]?key|x-goog-api-key|authorization|access[ _-]?token|refresh[ _-]?token|key)\b)\k<quote>(?<separator>\s*[:=]\s*)(?:Bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      "$<quote>$<key>$<quote>$<separator>[REDACTED]"
    )
    .replaceAll(/\bBearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
    .replaceAll(/\bhttps?:\/\/[^\s"'<>]+/giu, "[REDACTED]");

  for (const credential of credentials) {
    const secret = Redacted.value(credential);

    if (secret.length > 0) {
      sanitized = sanitized.replaceAll(secret, "[REDACTED]");
    }
  }

  return sanitized.replaceAll(
    /\b(?:sk|pk)-[A-Za-z0-9._-]{6,}\b/giu,
    "[REDACTED]"
  );
};

const imfFixdate =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u;

const rfc850Date =
  /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} \d{2}:\d{2}:\d{2} GMT$/u;

const asctimeDate =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?: \d|\d{2}) \d{2}:\d{2}:\d{2} \d{4}$/u;

const containsCredential = (
  value: string,
  credentials: readonly Redacted.Redacted[]
) =>
  credentials.some((credential) => {
    const secret = Redacted.value(credential);

    return secret.length > 0 && value.includes(secret);
  });

const parseHttpDate = (value: string) => {
  if (imfFixdate.test(value) || rfc850Date.test(value)) {
    return Date.parse(value);
  }

  if (asctimeDate.test(value)) {
    return Date.parse(`${value} GMT`);
  }

  return Number.NaN;
};

const safeRetryAfter = (
  value: string | undefined,
  credentials: readonly Redacted.Redacted[]
) => {
  if (value === undefined) {
    return null;
  }

  const trimmed = value.trim();

  if (trimmed.length === 0 || containsCredential(trimmed, credentials)) {
    return null;
  }

  let normalized: string | null = null;

  if (/^\d+(?:\.\d+)?$/u.test(trimmed)) {
    const seconds = Number(trimmed);
    normalized = Number.isFinite(seconds) ? String(seconds) : null;
  } else {
    const timestamp = parseHttpDate(trimmed);
    normalized = Number.isFinite(timestamp)
      ? new Date(timestamp).toUTCString()
      : null;
  }

  if (normalized === null || containsCredential(normalized, credentials)) {
    return null;
  }

  return normalized;
};

export const providerError = Effect.fnUntraced(function* providerError(
  response: HttpClientResponse.HttpClientResponse,
  provider: string,
  credentials: readonly Redacted.Redacted[] = []
) {
  let detail: string | undefined;

  const text = yield* response.text.pipe(
    Effect.catch(() => Effect.succeed(""))
  );

  if (text.length > 0) {
    const body = yield* decodeJSONText(text).pipe(
      Effect.catch(() => Effect.succeed(undefined))
    );

    if (
      body !== undefined &&
      isRecord(body) &&
      isRecord(body.error) &&
      isJSONString(body.error.message)
    ) {
      detail = body.error.message;
    } else if (
      body !== undefined &&
      isRecord(body) &&
      isJSONString(body.error)
    ) {
      detail = body.error;
    }
  }

  const sanitizedDetail =
    detail === undefined || detail.length === 0
      ? undefined
      : sanitizeProviderMessage(detail, credentials);

  const description = `${provider} web search failed (HTTP ${response.status})${sanitizedDetail === undefined || sanitizedDetail.length === 0 ? "" : `: ${sanitizedDetail}`}`;
  const headers = new Headers();

  const retryAfter = safeRetryAfter(
    response.headers["retry-after"],
    credentials
  );

  if (retryAfter !== null) {
    headers.set("retry-after", retryAfter);
  }

  const safeResponse = HttpClientResponse.fromWeb(
    safeRequest,
    new Response(null, { status: response.status, headers })
  );

  return yield* Effect.fail(
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.StatusCodeError({
        request: safeRequest,
        response: safeResponse,
        description,
      }),
    })
  );
});

const parseSSEPayload = (payload: string, provider: string) =>
  Effect.try({
    try: () => parseJSON(payload),
    catch: () =>
      new Error(
        `Invalid ${provider} web search response: malformed stream event`
      ),
  });

const makeSseDataChannel = (skipDone: boolean) =>
  Channel.fromTransform<
    readonly [string, ...string[]],
    HttpClientError.HttpClientError | Sse.SseError,
    unknown,
    readonly [string, ...string[]],
    HttpClientError.HttpClientError,
    unknown,
    never,
    never,
    never
  >((upstream) =>
    Effect.sync(() => {
      const queue: string[] = [];
      let pendingError: Sse.SseError | undefined;
      let doneState: Option.Option<unknown> = Option.none();

      const parser = Sse.makeParser(
        (event) => {
          if (event._tag !== "Event") {
            return;
          }

          const payload = event.data.trim();

          if (payload.length === 0 || (skipDone && payload === "[DONE]")) {
            return;
          }

          queue.push(payload);
        },
        { maxEventSize: Number.POSITIVE_INFINITY }
      );

      const nextQueued = () => {
        const next = queue.shift();

        if (next !== undefined) {
          const chunk: readonly [string, ...string[]] = [next];

          return Effect.succeed(chunk);
        }

        if (pendingError !== undefined) {
          const error = pendingError;
          pendingError = undefined;
          parser.reset();

          return Effect.fail(error);
        }

        if (Option.isSome(doneState)) {
          return Cause.done(doneState.value);
        }

        return null;
      };

      const pull: Pull.Pull<
        readonly [string, ...string[]],
        HttpClientError.HttpClientError | Sse.SseError,
        unknown
      > = Effect.suspend(() => {
        const immediate = nextQueued();

        if (immediate !== null) {
          return immediate;
        }

        return upstream.pipe(
          Effect.map((chunks) => ({ _tag: "Chunk" as const, chunks })),
          Pull.catchDone((leftover) =>
            Effect.succeed({ _tag: "Done" as const, leftover })
          ),
          Effect.flatMap((step) => {
            if (step._tag === "Done") {
              doneState = Option.some(step.leftover);
              const error = parser.feed("\n\n");

              if (error !== undefined) {
                pendingError = error;
              }

              return pull;
            }

            for (const text of step.chunks) {
              const error = parser.feed(text);

              if (error !== undefined) {
                pendingError = error;
                break;
              }
            }

            return pull;
          })
        );
      });

      return pull;
    })
  );

export const sseEvents = (
  response: HttpClientResponse.HttpClientResponse,
  provider: string,
  skipDone = false
) =>
  Stream.unwrap(
    Effect.suspend(() => {
      const webResponse = HttpClientResponse.toWeb(response);

      if (Option.isNone(webResponse) || webResponse.value.body === null) {
        return Effect.fail(
          new Error(`${provider} web search response has no body`)
        );
      }

      const { body } = webResponse.value;

      return Effect.succeed(
        Stream.fromReadableStream({
          evaluate: () => body,
          onError: () => sanitizeReadError(provider),
          releaseLockOnEnd: true,
        }).pipe(
          Stream.decodeText(),
          Stream.pipeThroughChannel(makeSseDataChannel(skipDone)),
          Stream.mapError((failure) =>
            failure instanceof Sse.SseError
              ? new Error(
                  `Invalid ${provider} web search response: malformed stream event`
                )
              : failure
          ),
          Stream.mapEffect((payload) => parseSSEPayload(payload, provider))
        )
      );
    })
  );

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
