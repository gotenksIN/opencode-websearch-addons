# Architecture specification

This document provides the architectural specification for `opencode-websearch-addons`.
Use this specification to recreate or maintain the plugin from first principles.

## Project purpose and scope

`opencode-websearch-addons` is an OpenCode V2 plugin package written in TypeScript for Bun.
The package adds OpenAI and Gemini native search capabilities to OpenCode's built-in `websearch` tool.

The plugin registers two search providers:

- `openai`: OpenAI Web Search
- `google`: Gemini Google Search

The plugin registers no custom tools.
The plugin performs no authentication management.
Selection of the default search provider remains in standard OpenCode configuration under `websearch.provider`.

## Package metadata and layout

The package directory structure consists of these files:

```text
package.json
tsconfig.json
index.ts
src/config.ts
src/auth.ts
src/openai.ts
src/google.ts
src/types.ts
oxlint.config.ts
tools/oxlint/anti-slop/
websearch.test.ts
tests/live.test.ts
README.md
CHANGELOG.md
AGENTS.md
CONTEXT.md
LICENSE
```

### Package manifest

`package.json` contains:

```json
{
  "name": "opencode-websearch-addons",
  "version": "1.0.6",
  "description": "OpenCode V2 plugin that adds OpenAI and Gemini native web search providers to the built-in websearch tool.",
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.js",
  "exports": {
    ".": "./dist/index.js",
    "./source": "./index.ts"
  },
  "files": ["dist", "index.ts", "src"],
  "scripts": {
    "lint": "oxlint .",
    "test": "bun test",
    "test:agent": "AGENT=1 bun test --bail",
    "test:live": "LIVE=1 bun test",
    "typecheck": "tsc --noEmit",
    "check": "tsc --noEmit && bun test",
    "prepack": "bun run build",
    "build": "bun build index.ts --outdir dist --target bun --format esm --external @opencode/plugin"
  },
  "dependencies": {
    "@opencode/plugin": "2.0.3"
  },
  "devDependencies": {
    "@oxlint/plugins": "1.83.0",
    "@types/bun": "latest",
    "oxlint": "1.83.0",
    "typescript": "latest"
  },
  "engines": {
    "bun": ">=1.2.0"
  },
  "author": {
    "name": "Omkar Chandorkar",
    "email": "gotenksIN@aospa.co"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/gotenksIN/opencode-websearch-addons.git"
  },
  "homepage": "https://github.com/gotenksIN/opencode-websearch-addons"
}
```

### Packaging and runtime dependencies

The package manifest and build must follow strict rules to maintain compatibility with OpenCode V2:

#### Dependency declaration

- Declare `@opencode/plugin` under `dependencies`.
- Pin exact versions (such as `"2.0.3"`).
- Do not mark `@opencode/plugin` as an optional peer dependency. OpenCode V2's Bun runtime loads server plugins via standard dynamic import without synthetic module interception.

#### Entrypoints and package contents

- Set `"main": "./dist/index.js"`.
- Set `"exports"`:
  ```json
  "exports": {
    ".": "./dist/index.js",
    "./source": "./index.ts"
  }
  ```
- Build the standalone ESM bundle with `bun build index.ts --outdir dist --target bun --format esm --external @opencode/plugin`.
- Restrict `"files"` in `package.json` to `["dist", "index.ts", "src"]`.
- Package managers automatically bundle `package.json`, `README.md`, and `LICENSE`. Internal agent specifications (`AGENTS.md`, `CONTEXT.md`) and tests remain excluded from the registry tarball.

### TypeScript configuration

TypeScript uses NodeNext module resolution.
All relative imports in TypeScript source files require `.js` file extensions.

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "moduleDetection": "force",
    "verbatimModuleSyntax": true,
    "types": ["bun"],
    "strict": true,
    "skipLibCheck": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noEmit": true
  },
  "include": ["index.ts", "src/**/*.ts", "websearch.test.ts", "tests/**/*.ts"]
}
```

### Lint setup

`oxlint.config.ts` registers the local anti-slop jsPlugin from `tools/oxlint/anti-slop/index.ts`, enables its rules as errors, and ignores `dist/**`.
Run `bun run lint` for a zero-warning, zero-error gate.

## Runtime contract

### Plugin entry point (`index.ts`)

The plugin default export registers both providers inside `ctx.websearch.transform`:

```ts
import { Plugin } from "@opencode/plugin"
import { parseConfig } from "./src/config.js"
import { searchGoogle } from "./src/google.js"
import { searchOpenAI } from "./src/openai.js"

export default Plugin.define({
  id: "opencode-websearch-addons",
  async setup(ctx) {
    const config = parseConfig(ctx.options)
    const registration = await ctx.websearch.transform((draft) => {
      draft.add({
        id: "openai",
        name: "OpenAI Web Search",
        execute: ({ query }, { signal }) => searchOpenAI(ctx, config.openai, config.timeoutMs, query, signal),
      })
      draft.add({
        id: "google",
        name: "Gemini Google Search",
        execute: ({ query }, { signal }) => searchGoogle(ctx, config.google, config.timeoutMs, query, signal),
      })
    })
    return () => registration.dispose()
  },
})
```

### Provider registration and provider selection

OpenCode V2 loads plugins listed in the user configuration `plugins` array.
The setup function receives `ctx` containing `ctx.options`, `ctx.integration`, `ctx.websearch`, and provider metadata access.
Draft methods inside `ctx.websearch.transform` add providers to OpenCode's provider registry.
The setup function returns a disposal callback `() => registration.dispose()`.

Provider selection is managed by OpenCode configuration:

```jsonc
{
  "websearch": {
    "provider": "google"
  }
}
```

The plugin does not set `draft.default.set`.
Both providers register regardless of which provider is currently active.

### Provider execute signature

Every search provider implements this signature:

```ts
execute(
  input: { query: string },
  context: { signal: AbortSignal },
): Promise<readonly WebSearch.Result[]>
```

### Normalized result schema

Every returned result object must satisfy OpenCode's exact `WebSearch.Result` contract:

```ts
type Result = {
  url: string;
  title?: string;
  content?: string;
  time: {
    published?: number;
  };
};
```

Field rules:

- `url`: Required non-empty string.
- `title`: Optional non-empty title string.
- `content`: Optional string containing model-generated text segments attributed to this source URL.
  `content` must not contain verbatim source excerpts.
- `time`: Required object containing an optional numeric `published` Unix timestamp in milliseconds.
  When no valid timestamp exists, `time` must be `{}`.

Valid search responses with no grounded web sources must return an empty array `[]`.

## Authentication contract (`src/auth.ts`)

The plugin performs no authentication management.
It does not store API keys, manage OAuth tokens, or read environment variables directly.
OpenCode manages integration connections for `openai` and `google`.

The plugin resolves integration credentials on every execution using `resolveCredential`:

```ts
import type { Credential, Plugin } from "@opencode/plugin"
import { isJSONString, isRecord } from "./types.js"
import type { CatalogContext } from "./types.js"

export type IntegrationContext = Pick<Plugin.Context, "integration"> & Partial<CatalogContext>

export async function resolveCredential(
  ctx: IntegrationContext,
  integrationID: string,
): Promise<Credential.Value> {
  const connection = await ctx.integration.connection.active(integrationID)
  if (!connection) {
    if (ctx.catalog) {
      try {
        const provider = await ctx.catalog.provider.get({ providerID: integrationID })
        const settings = provider?.data?.settings
        const apiKey = settings !== undefined && isRecord(settings) ? settings["apiKey"] : undefined
        if (apiKey !== undefined && isJSONString(apiKey) && apiKey.trim().length > 0) {
          return { type: "key", key: apiKey.trim() }
        }
      } catch {
        // Fall back to standard connection error
      }
    }
    throw new Error(`No active ${integrationID} connection. Connect the ${integrationID} integration in OpenCode first.`)
  }
  let credential: Credential.Value | undefined
  try {
    credential = await ctx.integration.connection.resolve(connection)
  } catch {
    throw new Error(
      `Unable to resolve ${integrationID} credentials. Reconnect the ${integrationID} integration and try again.`,
    )
  }
  if (!credential) {
    throw new Error(`Unable to resolve ${integrationID} credentials. Reconnect the ${integrationID} integration and try again.`)
  }
  return credential
}
```

### Credential types

`ctx.integration.connection.resolve` returns `Credential.Value`:

```ts
type CredentialValue =
  | { type: "oauth"; methodID: string; refresh: string; access: string; expires: number; metadata?: Record<string, unknown> }
  | { type: "key"; key: string; metadata?: Record<string, unknown> };
```

Active connections can be stored credentials or environment variable references:

- `{ type: "credential", id: string, label?: string }`
- `{ type: "env", name: string }`

`resolveCredential` resolves both connection types without branching on connection type.

When no active connection exists, the resolver falls back to reading `data.settings.apiKey` from the provider metadata API.
The current V2 source exposes this API as `ctx.provider.get({ providerID })`.
The published 2.0.3 package exposes it as `ctx.catalog.provider.get({ providerID })`.
The plugin prefers `ctx.provider` and retains the 2.0.3 fallback until the published package catches up with the V2 source.
A non-empty string `apiKey` produces a key credential.
Any failure reading provider settings falls back to the standard connection error.

### Security rules

- Never log credential values or tokens.
- Never include credentials or secret tokens in error messages or exception details.
- Never store credentials in local plugin state across requests.

## Configuration engine (`src/config.ts`)

Plugin options are passed in `ctx.options`.
Options are parsed and validated at plugin setup using `parseConfig`.

### Options validation table

| Option name | Type | Default value | Validation rule | Error message format |
| --- | --- | --- | --- | --- |
| `openai` | object | `{}` | Must be a plain record if defined | `Invalid plugin option openai; expected an object.` |
| `openai.model` | string | `"gpt-5.6-luna"` | Non-empty string up to 100 characters | `Invalid plugin option openai.model; expected a non-empty string of at most 100 characters.` |
| `openai.reasoningEffort` | string | `"medium"` | One of `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` | `Invalid plugin option openai.reasoningEffort; expected one of "none", "minimal", "low", "medium", "high", "xhigh", or "max".` |
| `openai.searchContextSize` | string | `"medium"` | One of `"low"`, `"medium"`, `"high"` | `Invalid plugin option openai.searchContextSize; expected one of "low", "medium", or "high".` |
| `openai.userLocation` | object | `undefined` | Optional object with optional string keys `city`, `country`, `region`, `timezone` | `Invalid plugin option openai.userLocation; expected an object with optional string fields city, country, region, or timezone.` |
| `openai.userLocation.<unknown key>` | - | - | Key outside `city`, `country`, `region`, `timezone` | `Invalid plugin option openai.userLocation.<key>; expected a key from city, country, region, timezone.` |
| `openai.userLocation.<field>` | string | - | Value is not a string | `Invalid plugin option openai.userLocation.<field>; expected a string.` |
| `google` | object | `{}` | Must be a plain record if defined | `Invalid plugin option google; expected an object.` |
| `google.model` | string | `"gemini-3.5-flash-lite"` | Non-empty string up to 100 characters | `Invalid plugin option google.model; expected a non-empty string of at most 100 characters.` |
| `google.thinkingLevel` | string | `"medium"` | One of `"minimal"`, `"low"`, `"medium"`, `"high"` | `Invalid plugin option google.thinkingLevel; expected one of "minimal", "low", "medium", or "high".` |
| `google.searchTimeRange` | string | `"any"` | One of `"any"`, `"lastDay"`, `"lastWeek"`, `"lastMonth"`, `"lastYear"` | `Invalid plugin option google.searchTimeRange; expected one of "any", "lastDay", "lastWeek", "lastMonth", or "lastYear".` |
| `timeoutMs` | number | `120000` | Safe integer from 100 through 120000 | `Invalid plugin option timeoutMs; expected an integer from 100 through 120000.` |

Invalid options throw an `Error` with the exact message formatted as `Invalid plugin option <name>; expected <description>.`

`openai.userLocation` accepts only the keys `city`, `country`, `region`, and `timezone`.
Unknown keys throw `Invalid plugin option openai.userLocation.<key>; expected a key from city, country, region, timezone.`
Non-string field values throw `Invalid plugin option openai.userLocation.<field>; expected a string.`
Empty field strings are dropped; an object with only empty fields is treated as unset.

## OpenAI provider implementation (`src/openai.ts`)

Integration ID: `"openai"`.

### Routing and endpoints

OpenAI credentials route to different endpoints based on credential type:

- Key credentials (`type: "key"`):
  - Endpoint: `POST https://api.openai.com/v1/responses`
  - Headers:
    - `Authorization: Bearer <credential.key>`
    - `Content-Type: application/json`
- OAuth credentials (`type: "oauth"`):
  - Endpoint: `POST https://chatgpt.com/backend-api/codex/responses`
  - Headers:
    - `Authorization: Bearer <credential.access>`
    - `Content-Type: application/json`
    - `originator: opencode`
    - `chatgpt-account-id: <accountID>` (included when `credential.metadata.accountID` or `credential.metadata.accountId` is a non-empty string)

No `instructions` field is sent in the body on either path.

### Base URL override

The key credential path honors a custom `baseURL` from OpenCode provider settings.
At execution time the plugin reads the OpenAI provider metadata and uses `data.settings.baseURL` when it is a non-empty string.
The request endpoint becomes `<baseURL>/responses`.
Trailing slashes are stripped.
When no `baseURL` is configured, the request goes to the public endpoint `https://api.openai.com/v1/responses`.
The OAuth path always uses the Codex endpoint `https://chatgpt.com/backend-api/codex/responses`.
This mirrors the OpenCode built-in provider, which forces the Codex base URL for OAuth regardless of configured settings.
If the provider metadata API fails, the search fails before it sends the credential to an endpoint.

### Request body format

```json
{
  "model": "<openai.model>",
  "input": [
    {
      "role": "user",
      "content": [
        {
          "type": "input_text",
          "text": "<query>"
        }
      ]
    }
  ],
  "tools": [
    {
      "type": "web_search",
      "search_context_size": "<openai.searchContextSize>",
      "external_web_access": true,
      "user_location": {
        "type": "approximate",
        "city": "...",
        "country": "...",
        "region": "...",
        "timezone": "..."
      }
    }
  ],
  "reasoning": {
    "effort": "<openai.reasoningEffort>"
  },
  "include": [
    "web_search_call.action.sources"
  ],
  "store": false,
  "stream": true
}
```

The `user_location` property is omitted unless `openai.userLocation` is explicitly configured.

### Stream parsing and output extraction

OpenAI responses return a Server-Sent Events (SSE) stream.
Each event payload arrives as `data: <json>`.

1. Collect items from `response.output_item.done` events where `payload.type === "response.output_item.done"`.
2. If no done events arrive, fallback to output items in `response.completed` event (`payload.response.output`).
3. Stop consuming and cancel the response body after `response.completed` or `response.incomplete`.
4. If `payload.type` is `response.failed` or `error`, throw an error with the provider code and message.
5. If `content-type` does not include `text/event-stream`, reject error envelopes and require a `body.output` array.

### Normalization (`normalizeOutput`)

The output array contains items of type `message` and `web_search_call`.

For `message` items:

- Inspect `content` parts with `type === "output_text"`.
- Inspect `annotations` array for items with `type === "url_citation"`.
- Extract `url`, `title`, and `published_date` or `published`.
- Slice attributed text span from `text` using `[start_index, end_index]` bounds clamped to text length `[0, text.length]`.

For `web_search_call` items:

- Inspect `action.sources` array for items with `type === "url"`.
- Extract `url`, `title`, and `published_date` or `published`.

Aggregation rules:

- Maintain URL discovery order in a tracking array.
- Deduplicate sources by exact URL string.
- Keep the first non-empty title string for each URL.
- Parse publication dates using `Date.parse`.
- Deduplicate text spans per URL using a `Set`.
- Join distinct non-empty text spans with a single space to produce `content`.
- Return uncited action sources with `url`, `title`, and `time: {}`.

## Gemini Google Search provider implementation (`src/google.ts`)

Integration ID: `"google"`.

### Credentials and endpoint

Google supports key credentials only (`type: "key"`).
OAuth or non-key credentials throw `new Error("Unsupported Google credential type; expected a key credential")`.

- Endpoint: `POST https://generativelanguage.googleapis.com/v1beta/models/<model>:streamGenerateContent?alt=sse`
- Headers:
  - `x-goog-api-key: <credential.key>`
  - `Content-Type: application/json`

### Base URL override

The endpoint honors a custom `baseURL` from OpenCode provider settings.
At execution time the plugin reads the Google provider metadata and uses `data.settings.baseURL` when it is a non-empty string.
The request endpoint becomes `<baseURL>/models/<model>:streamGenerateContent?alt=sse`.
Trailing slashes are stripped.
When no `baseURL` is configured, the request goes to the official endpoint.
If the provider metadata API fails, the search fails before it sends the credential to an endpoint.

### Request body format

```json
{
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "text": "<query>"
        }
      ]
    }
  ],
  "tools": [
    {
      "googleSearch": {
        "timeRangeFilter": {
          "startTime": "2026-08-08T12:34:56Z",
          "endTime": "2026-08-09T12:34:56Z"
        }
      }
    }
  ],
  "generationConfig": {
    "thinkingConfig": {
      "thinkingLevel": "<UPPERCASE_ENUM>"
    }
  }
}
```

When `searchTimeRange` is `"any"`, `googleSearch` is `{}`.
When `searchTimeRange` is `"lastDay"`, `"lastWeek"`, `"lastMonth"`, or `"lastYear"`, `timeRangeFilterFor` computes start and end timestamps.
Start time subtracts 1 day, 7 days, 1 month, or 1 year from execution time using UTC calendar arithmetic.
Month and year ranges clamp month-end and leap-day dates to the last valid day in the target month.
Both ISO strings strip milliseconds using `.replace(/\.\d{3}Z$/, "Z")`.

The `thinkingLevel` option maps to uppercase wire values:

- `"minimal"` -> `"MINIMAL"`
- `"low"` -> `"LOW"`
- `"medium"` -> `"MEDIUM"`
- `"high"` -> `"HIGH"`

### Stream processing and grounding normalization

Gemini stream chunks arrive as `data: <json>`.

Chunk processing:

- Concatenate visible text parts from `candidate.content.parts[].text` and exclude parts marked with `thought: true`.
- Merge `candidate.groundingMetadata` records across chunks when they contain `groundingChunks` or `groundingSupports` arrays, so metadata split across chunks combines.
- Record the latest `candidate.finishReason`.
- Throw on stream payload containing `{ error: { message } }`.
- Reject a stream that ends without a finish reason, prompt block, or usage payload.

Normalization (`normalizeGenerateContent`):

1. Reject provider blocks reported through `promptFeedback.blockReason` or a content-filter finish reason.
   Reject finish reasons that report malformed provider output or tool calls.
2. Extract web sources from `groundingMetadata.groundingChunks` where `chunk.web.uri` exists.
3. Index sources by chunk array position.
4. Extract grounding supports from `groundingMetadata.groundingSupports`.
5. Slice segment text from concatenated candidate text using `[startIndex, endIndex]` bounds clamped to `[0, text.length]`.
   Treat an omitted `startIndex` as the protobuf default value `0`.
6. Map segment text to source URLs using `groundingChunkIndices`.
7. Deduplicate text spans per URL using a `Set`.
8. Deduplicate sources by exact URL string while preserving chunk order.
9. Ignore provider rendering metadata such as `searchEntryPoint`.
10. Return `[]` when no grounded web sources exist.

## Cancellation and timeout pattern

Every search function accepts `contextSignal: AbortSignal` from OpenCode and `timeoutMs: number`.

```ts
contextSignal.throwIfAborted()
const controller = new AbortController()
const timer = setTimeout(
  () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
  timeoutMs,
)
const onAbort = () => controller.abort(contextSignal.reason)

if (contextSignal.aborted) {
  controller.abort(contextSignal.reason)
} else {
  contextSignal.addEventListener("abort", onAbort, { once: true })
}

try {
  // Resolve credentials and provider settings.
  controller.signal.throwIfAborted()
  // Fetch call using controller.signal
} finally {
  clearTimeout(timer)
  contextSignal.removeEventListener("abort", onAbort)
}
```

This pattern ensures:

- OpenCode cancellation aborts in-flight fetch requests immediately.
- Timeout errors trigger after `timeoutMs` milliseconds.
- Timer handles and signal event listeners are cleaned up in the `finally` block.

## Testing strategy

The test suite consists of unit tests in `websearch.test.ts` and opt-in live smoke tests in `tests/live.test.ts`.

### Unit tests (`websearch.test.ts`)

Unit tests mock HTTP requests using `vi.spyOn(globalThis, "fetch")`.
Mock provider contexts simulate `ctx.integration.connection.active` and `ctx.integration.connection.resolve`.

Test suite coverage:

- Configuration parsing and defaults.
- Configuration validation errors and precise error message formatting.
- `timeRangeFilter` timestamp calculation and millisecond stripping.
- Connection resolution for `openai` and `google` integrations.
- Support for `credential` and `env` connection types.
- Missing connection errors and resolution failure errors.
- Credential secrecy checks.
- Dynamic connection switching across executions.
- OpenAI key and OAuth routing headers.
- OpenAI payload structure (`model`, `tools`, `reasoning`, `include`, `store`, `stream`).
- OpenAI annotation parsing, span slicing, and action sources normalization.
- OpenAI SSE stream parsing and fallback behavior.
- Gemini request payload structure (`googleSearch`, `thinkingLevel`, `timeRangeFilter`).
- Gemini thinking level uppercase mapping (`MINIMAL`, `LOW`, `MEDIUM`, `HIGH`).
- Gemini grounding chunk extraction and grounding support span mapping.
- Gemini blocked response handling (`BLOCKED` and `SAFETY`).
- Compliance with `WebSearch.Result` contract.
- AbortSignal cancellation propagation and timeout cancellation.

### Live smoke tests (`tests/live.test.ts`)

Live smoke tests execute against real provider endpoints when `LIVE=1` is set.

Environment variables:

- `OPENAI_API_KEY`: OpenAI API key for key path testing.
- `CHATGPT_ACCESS_TOKEN`: ChatGPT access token for OAuth path testing.
- `CHATGPT_ACCOUNT_ID`: Optional ChatGPT account ID metadata.
- `GEMINI_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY`: Gemini API key for Google search testing.

Run live tests:

```sh
LIVE=1 OPENAI_API_KEY=... GEMINI_API_KEY=... bun test:live
```

## Verification against a real OpenCode V2 binary

Verification against a real OpenCode V2 binary requires executing API commands against the binary socket.

Step 1: Check registered websearch providers:

```sh
opencode2 api get /api/websearch/provider
```

Expected output:

```json
[
  { "id": "google", "name": "Gemini Google Search" },
  { "id": "openai", "name": "OpenAI Web Search" }
]
```

Step 2: Execute search requests via the OpenCode API:

```sh
opencode2 api post /api/websearch '{"providerID":"openai","query":"OpenCode CLI release"}'
opencode2 api post /api/websearch '{"providerID":"google","query":"OpenCode CLI release"}'
```

Verify that results return normalized `WebSearch.Result[]` arrays containing valid URLs and timestamps.

### Operational notes from real-binary verification

Register the plugin through exactly one mechanism.
Registering the same plugin ID through both the config `plugins` array and an auto-discovered local `plugins/*.js` file causes `Duplicate plugin ID: opencode-websearch-addons`.
The duplicate-ID failure aborts the whole plugin reload pipeline.
A failed reload makes models and providers unavailable until the duplicate source is removed and the service restarts.

Websearch provider registries are location-scoped.
Each project directory has its own registry state.
A location that activates while the plugin package is missing from the cache keeps only the built-in providers.
Delete the plugin cache entry only together with a service restart, or the new install will not reach already-activated locations.
After installing or updating the plugin package, restart the service so every location re-activates with the plugin registered.

Live searches require credentials that are valid for the request target.
When a provider `baseURL` is configured in OpenCode settings, the request goes to that base URL and the integration credential must be valid there.
Proxy or gateway setups use this mechanism: the base URL points at the gateway and the stored key is the gateway key.
When no `baseURL` is configured, the request targets the official provider endpoints and the credential must be a real provider key or OAuth session.
Store the matching credential through the OpenCode integration connection for live verification.

## Verified wire evidence sources

Wire formats and API contracts were verified against these primary source code references:

- big-AGI repository (`src/modules/aix/server/dispatch/chatGenerate/adapters/openai.responsesCreate.ts` and `gemini.generateContent.ts`):
  - Verified `web_search` tool parameters (`search_context_size`, `external_web_access`, `user_location`).
  - Verified `web_search_call.action.sources` include field.
  - Verified `googleSearch` tool structure and `timeRangeFilter` timestamp formatting.
  - Verified `thinkingConfig.thinkingLevel` uppercase wire enum mapping.
- OpenCode V2 repository (`packages/plugin/src/promise/{plugin,provider,websearch,integration}.ts`, `packages/schema/src/{credential,websearch}.ts`, `packages/core/src/plugin/provider/openai.ts`, `packages/core/src/plugin/models-dev.ts`):
  - Verified `ctx.integration.connection.active` and `resolve` API.
  - Verified OAuth endpoint path rewrite `/backend-api/codex/responses`.
  - Verified `originator: opencode` and `chatgpt-account-id` headers.
  - Verified Google key and environment variable authentication methods.
- Verified `opencode-chatgpt-websearch` plugin option validation patterns.
