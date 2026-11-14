import { resolveCredential } from "./auth.js";
import type { IntegrationContext } from "./auth.js";
import type { OpenAIOptions } from "./config.js";
import {
  isJSONString,
  isRecord,
  isSourceURL,
  parseSSE,
  parsedTimestamp,
  providerBaseURL,
  providerError,
  readJSON,
  sanitizeProviderMessage,
  sliceSpan,
  toResult,
} from "./types.js";
import type {
  Credential,
  InternalSource,
  JsonValue,
  WebSearch,
} from "./types.js";

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
  credentials: readonly string[]
): Error => {
  const details = isRecord(response.incomplete_details)
    ? response.incomplete_details
    : {};

  const reason = isJSONString(details.reason)
    ? sanitizeProviderMessage(details.reason, credentials)
    : "unknown reason";

  return new Error(`OpenAI web search incomplete: ${reason}`);
};

const streamErrorMessage = (payload: Record<string, JsonValue>): string => {
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

const readOutputItems = async (
  response: Response,
  credentials: readonly string[]
): Promise<JsonValue[]> => {
  const body = await readJSON(response);

  if (!isRecord(body)) {
    throw new Error(
      "Invalid OpenAI web search response: body is not an object"
    );
  }

  if (body.status === "incomplete") {
    throw incompleteError(body, credentials);
  }

  if (body.status === "failed" || isRecord(body.error)) {
    const message = streamErrorMessage(body);
    throw new Error(
      `OpenAI web search failed: ${sanitizeProviderMessage(message, credentials)}`
    );
  }

  if (body.error !== undefined && body.error !== null) {
    throw new Error("Invalid OpenAI web search response: malformed error");
  }

  if (!Array.isArray(body.output)) {
    throw new TypeError("Invalid OpenAI web search response: missing output");
  }

  return body.output;
};

const collectOutputItems = async (
  response: Response,
  credentials: readonly string[]
): Promise<JsonValue[]> => {
  const contentType = response.headers.get("content-type") ?? "";

  if (!contentType.includes("text/event-stream")) {
    return await readOutputItems(response, credentials);
  }

  const items: JsonValue[] = [];
  let completed: JsonValue[] | undefined;
  let terminal = false;

  for await (const payload of parseSSE(response, "OpenAI", true)) {
    if (!isRecord(payload)) {
      continue;
    }

    if (
      payload.type === "response.output_item.done" &&
      isRecord(payload.item)
    ) {
      items.push(payload.item);
    } else if (payload.type === "response.incomplete") {
      throw incompleteError(
        isRecord(payload.response) ? payload.response : {},
        credentials
      );
    } else if (payload.type === "response.completed") {
      terminal = true;

      const output = isRecord(payload.response)
        ? payload.response.output
        : undefined;

      if (Array.isArray(output)) {
        completed = output;
      }

      break;
    } else if (payload.type === "response.failed" || payload.type === "error") {
      const message = streamErrorMessage(payload);
      throw new Error(
        `OpenAI web search failed: ${sanitizeProviderMessage(message, credentials)}`
      );
    }
  }

  if (!terminal) {
    throw new Error(
      "Invalid OpenAI web search response: stream ended without a terminal event"
    );
  }

  return items.length > 0 ? items : (completed ?? []);
};

const addSource = (
  sourcesByURL: Map<string, InternalSource>,
  url: string,
  fields: {
    readonly title?: string;
    readonly published?: number;
    readonly span?: string;
  }
): void => {
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

const collectMessage = (
  item: Record<string, JsonValue>,
  sourcesByURL: Map<string, InternalSource>
): void => {
  if (!Array.isArray(item.content)) {
    return;
  }

  for (const part of item.content) {
    if (
      !isRecord(part) ||
      part.type !== "output_text" ||
      !isJSONString(part.text) ||
      !Array.isArray(part.annotations)
    ) {
      continue;
    }

    for (const annotation of part.annotations) {
      if (!isRecord(annotation) || annotation.type !== "url_citation") {
        continue;
      }

      const url = isJSONString(annotation.url) ? annotation.url : undefined;

      if (url === undefined || url.length === 0 || !isSourceURL(url)) {
        continue;
      }

      const span = sliceSpan(
        part.text,
        annotation.start_index,
        annotation.end_index
      );

      const title = isJSONString(annotation.title)
        ? annotation.title
        : undefined;

      const published = parsedTimestamp(
        annotation.published_date ?? annotation.published
      );

      addSource(sourcesByURL, url, { title, published, span });
    }
  }
};

const collectActionSources = (
  item: Record<string, JsonValue>,
  sourcesByURL: Map<string, InternalSource>
): void => {
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

const normalizeOutput = (output: JsonValue[]): readonly WebSearch.Result[] => {
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

  return [...sourcesByURL.values()].map(toResult);
};

const runOpenAIRequest = async (
  endpoint: string,
  auth: {
    readonly authorization: string;
    readonly originator?: string;
    readonly accountID?: string;
  },
  config: OpenAIOptions,
  query: string,
  signal: AbortSignal,
  credentials: readonly string[]
): Promise<readonly WebSearch.Result[]> => {
  const headers: Record<string, string> = {};
  headers.Authorization = auth.authorization;
  headers["Content-Type"] = "application/json";
  headers.Accept = "text/event-stream";

  if (auth.originator !== undefined && auth.originator.length > 0) {
    headers.originator = auth.originator;
  }

  if (auth.accountID !== undefined && auth.accountID.length > 0) {
    headers["chatgpt-account-id"] = auth.accountID;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(buildResponsesBody(config, query)),
    redirect: "error",
    signal,
  });

  if (!response.ok) {
    await providerError(response, "OpenAI", credentials);
  }

  const items = await collectOutputItems(response, credentials);

  return normalizeOutput(items);
};

const accountID = (credential: Credential.OAuth): string | undefined => {
  const meta = credential.metadata;

  if (!isRecord(meta)) {
    return undefined;
  }

  const account = meta.accountID ?? meta.accountId;

  return isJSONString(account) && account.length > 0 ? account : undefined;
};

export const searchOpenAI = async (
  ctx: IntegrationContext,
  config: OpenAIOptions,
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
      "openai",
      controller.signal
    );

    controller.signal.throwIfAborted();

    if (credential.type === "key") {
      const baseURL = await providerBaseURL(ctx, "openai", controller.signal);
      controller.signal.throwIfAborted();

      return await runOpenAIRequest(
        baseURL === undefined ? publicEndpoint : `${baseURL}/responses`,
        { authorization: `Bearer ${credential.key}` },
        config,
        query,
        controller.signal,
        [credential.key]
      );
    }

    if (credential.type === "oauth") {
      if (credential.methodID === "chatgpt-token-sharing") {
        const baseURL = await providerBaseURL(ctx, "openai", controller.signal);
        controller.signal.throwIfAborted();

        return await runOpenAIRequest(
          baseURL === undefined ? publicEndpoint : `${baseURL}/responses`,
          { authorization: `Bearer ${credential.access}` },
          config,
          query,
          controller.signal,
          [credential.access, credential.refresh]
        );
      }

      if (
        credential.methodID !== "chatgpt-browser" &&
        credential.methodID !== "chatgpt-headless"
      ) {
        throw new Error(
          "Unsupported OpenAI OAuth method; expected chatgpt-token-sharing, chatgpt-browser, or chatgpt-headless"
        );
      }

      const account = accountID(credential);

      const auth = {
        authorization: `Bearer ${credential.access}`,
        originator: "opencode",
      };

      return await runOpenAIRequest(
        codexEndpoint,
        account === undefined ? auth : { ...auth, accountID: account },
        config,
        query,
        controller.signal,
        [credential.access, credential.refresh]
      );
    }

    throw new Error("Unsupported OpenAI credential type");
  } finally {
    clearTimeout(timer);
    contextSignal.removeEventListener("abort", onAbort);
  }
};
