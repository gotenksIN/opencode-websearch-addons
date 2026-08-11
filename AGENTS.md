# AGENTS.md

This document contains complete architecture specifications and implementation details for `opencode-websearch-addons`.
An agent can recreate this entire package from first principles using this guide.

## Project Purpose and Scope

`opencode-websearch-addons` is an OpenCode V2 plugin package written in TypeScript for Bun and Node.js.
The package adds OpenAI and Gemini native search capabilities to OpenCode's built-in `websearch` tool.

The plugin registers two search providers:

- `openai`: OpenAI Web Search
- `google`: Gemini Google Search

The plugin registers no custom tools.
The plugin performs no authentication management.
Selection of the default search provider remains in standard OpenCode configuration under `websearch.provider`.

## Package Metadata and Layout

The package directory structure consists of these files:

```text
package.json
tsconfig.json
tsconfig.build.json
index.ts
src/config.ts
src/auth.ts
src/openai.ts
src/google.ts
src/types.ts
websearch.test.ts
tests/live.test.ts
```

### Dependency and Version Pinning

`package.json` contains:

```json
{
  "name": "opencode-websearch-addons",
  "version": "1.0.0",
  "description": "OpenCode V2 plugin that adds OpenAI and Gemini native web search providers to the built-in websearch tool.",
  "type": "module",
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": [
    "dist",
    "README.md"
  ],
  "scripts": {
    "check": "tsc --noEmit && bun test",
    "test:agent": "AGENT=1 bun test --bail",
    "test:live": "LIVE=1 bun test",
    "build": "tsc -p tsconfig.build.json"
  },
  "engines": {
    "node": ">=20"
  },
  "dependencies": {
    "@opencode-ai/plugin": "^0.0.0-next-17132"
  },
  "devDependencies": {
    "@types/bun": "1.3.14",
    "typescript": "^5.9.2"
  }
}
```

The `@opencode-ai/plugin` dependency comes from the OpenCode `next` release channel (`0.0.0-next-*`) to match the OpenCode V2 binary version.
The plugin must ship `@opencode-ai/plugin` as a real runtime dependency.
The OpenCode V2 binary does not inject or virtualize the module for plugin loads.
The plugin loader resolves `@opencode-ai/plugin` from the plugin package's own `node_modules`.
Arborist installs production dependencies when the package is installed through the config `plugins` array.
A plugin loaded from an auto-discovered local `plugins/*.js` file cannot resolve the bare specifier, even with a `node_modules` tree beside it.
Use the config `plugins` array with an installable package spec for local testing.
The package dependency also supplies compile-time types for plugin development.

### TypeScript Configuration

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

`tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["index.ts", "src/**/*.ts"]
}
```

## Runtime Contract

### Plugin Entry Point (`index.ts`)

The plugin default export registers both providers inside `ctx.websearch.transform`:

```ts
import { Plugin } from "@opencode-ai/plugin"
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

### Provider Registration and Provider Selection

OpenCode V2 loads plugins listed in the user configuration `plugins` array.
Plugin packages reside in `~/.cache/opencode/packages/<pkg>/node_modules`.
The setup function receives `ctx` containing `ctx.options`, `ctx.integration`, and `ctx.websearch`.
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

### Provider Execute Signature

Every search provider implements this signature:

```ts
execute(
  input: { query: string },
  context: { signal: AbortSignal },
): Promise<readonly WebSearch.Result[]>
```

### Normalized Result Schema

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

## Authentication Contract (`src/auth.ts`)

The plugin performs no authentication management.
It does not store API keys, manage OAuth tokens, or read environment variables directly.
OpenCode manages integration connections for `openai` and `google`.

The plugin resolves integration credentials on every execution using `resolveCredential`:

```ts
import type { Credential, Plugin } from "@opencode-ai/plugin"
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
        const apiKey = settings && typeof settings === "object" ? settings["apiKey"] : undefined
        if (typeof apiKey === "string" && apiKey.trim().length > 0) {
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

### Credential Types

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

### Security Rules

- Never log credential values or tokens.
- Never include credentials or secret tokens in error messages or exception details.
- Never store credentials in local plugin state across requests.

## Configuration Engine (`src/config.ts`)

Plugin options are passed in `ctx.options`.
Options are parsed and validated at plugin setup using `parseConfig`.

### Options Validation Table

| Option Name | Type | Default Value | Validation Rule | Error Message Format |
| --- | --- | --- | --- | --- |
| `openai` | object | `{}` | Must be a plain record if defined | `Invalid plugin option openai; expected an object.` |
| `openai.model` | string | `"gpt-5.6-luna"` | Non-empty string up to 100 characters | `Invalid plugin option openai.model; expected a non-empty string of at most 100 characters.` |
| `openai.reasoningEffort` | string | `"medium"` | One of `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` | `Invalid plugin option openai.reasoningEffort; expected one of "none", "minimal", "low", "medium", "high", "xhigh", or "max".` |
| `openai.searchContextSize` | string | `"medium"` | One of `"low"`, `"medium"`, `"high"` | `Invalid plugin option openai.searchContextSize; expected one of "low", "medium", or "high".` |
| `openai.userLocation` | object | `undefined` | Optional object with optional string keys `city`, `country`, `region`, `timezone` | `Invalid plugin option openai.userLocation; expected an object with optional string fields city, country, region, or timezone.` |
| `google` | object | `{}` | Must be a plain record if defined | `Invalid plugin option google; expected an object.` |
| `google.model` | string | `"gemini-3.5-flash-lite"` | Non-empty string up to 100 characters | `Invalid plugin option google.model; expected a non-empty string of at most 100 characters.` |
| `google.thinkingLevel` | string | `"medium"` | One of `"minimal"`, `"low"`, `"medium"`, `"high"` | `Invalid plugin option google.thinkingLevel; expected one of "minimal", "low", "medium", or "high".` |
| `google.searchTimeRange` | string | `"any"` | One of `"any"`, `"lastDay"`, `"lastWeek"`, `"lastMonth"`, `"lastYear"` | `Invalid plugin option google.searchTimeRange; expected one of "any", "lastDay", "lastWeek", "lastMonth", or "lastYear".` |
| `timeoutMs` | number | `120000` | Safe integer from 100 through 120000 | `Invalid plugin option timeoutMs; expected an integer from 100 through 120000.` |

Invalid options throw an `Error` with the exact message formatted as `Invalid plugin option <name>; expected <description>.`

## OpenAI Provider Implementation (`src/openai.ts`)

Integration ID: `"openai"`.

### Routing and Endpoints

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

### Base URL Override

The key credential path honors a custom `baseURL` from OpenCode provider settings.
At execution time the plugin reads `ctx.catalog.provider.get({ providerID: "openai" })` and uses `data.settings.baseURL` when it is a non-empty string.
The request endpoint becomes `<baseURL>/responses`.
Trailing slashes are stripped.
When no `baseURL` is configured, the request goes to the public endpoint `https://api.openai.com/v1/responses`.
The OAuth path always uses the Codex endpoint `https://chatgpt.com/backend-api/codex/responses`.
This mirrors the OpenCode built-in provider, which forces the Codex base URL for OAuth regardless of configured settings.
Any failure reading provider settings falls back to the official endpoint.

### Request Body Format

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

### Stream Parsing and Output Extraction

OpenAI responses return a Server-Sent Events (SSE) stream.
Each event payload arrives as `data: <json>`.

1. Collect items from `response.output_item.done` events where `payload.type === "response.output_item.done"`.
2. If no done events arrive, fallback to output items in `response.completed` event (`payload.response.output`).
3. If `payload.type === "response.failed"`, throw an error with the provider message.
4. If `content-type` does not include `text/event-stream`, parse the body directly as JSON and extract `body.output`.

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

## Gemini Google Search Provider Implementation (`src/google.ts`)

Integration ID: `"google"`.

### Credentials and Endpoint

Google supports key credentials only (`type: "key"`).
OAuth or non-key credentials throw `new Error("Unsupported Google credential type; expected a key credential")`.

- Endpoint: `POST https://generativelanguage.googleapis.com/v1beta/models/<model>:streamGenerateContent?alt=sse`
- Headers:
  - `x-goog-api-key: <credential.key>`
  - `Content-Type: application/json`

### Base URL Override

The endpoint honors a custom `baseURL` from OpenCode provider settings.
At execution time the plugin reads `ctx.catalog.provider.get({ providerID: "google" })` and uses `data.settings.baseURL` when it is a non-empty string.
The request endpoint becomes `<baseURL>/models/<model>:streamGenerateContent?alt=sse`.
Trailing slashes are stripped.
When no `baseURL` is configured, the request goes to the official endpoint.
Any failure reading provider settings falls back to the official endpoint.

### Request Body Format

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
Start time subtracts 1 day, 7 days, 1 month, or 1 year from execution time.
Both ISO strings strip milliseconds using `.replace(/\.\d{3}Z$/, "Z")`.

The `thinkingLevel` option maps to uppercase wire values:

- `"minimal"` -> `"MINIMAL"`
- `"low"` -> `"LOW"`
- `"medium"` -> `"MEDIUM"`
- `"high"` -> `"HIGH"`

### Stream Processing and Grounding Normalization

Gemini stream chunks arrive as `data: <json>`.

Chunk processing:

- Concatenate text parts from `candidate.content.parts[].text`.
- Save the latest non-empty `candidate.groundingMetadata`.
- Record the latest `candidate.finishReason`.
- Throw on stream payload containing `{ error: { message } }`.

Normalization (`normalizeGenerateContent`):

1. If `finishReason` is `"BLOCKED"` or `"SAFETY"`, throw `new Error("Gemini web search blocked by the provider (finish reason <finishReason>)")`.
2. Extract web sources from `groundingMetadata.groundingChunks` where `chunk.web.uri` exists.
3. Index sources by chunk array position.
4. Extract grounding supports from `groundingMetadata.groundingSupports`.
5. Slice segment text from concatenated candidate text using `[startIndex, endIndex]` bounds clamped to `[0, text.length]`.
6. Map segment text to source URLs using `groundingChunkIndices`.
7. Deduplicate text spans per URL using a `Set`.
8. Deduplicate sources by exact URL string while preserving chunk order.
9. Ignore provider rendering metadata such as `searchEntryPoint`.
10. Return `[]` when no grounded web sources exist.

## Cancellation and Timeout Pattern

Every search function accepts `contextSignal: AbortSignal` from OpenCode and `timeoutMs: number`.

```ts
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

## Testing Strategy

The test suite consists of unit tests in `websearch.test.ts` and opt-in live smoke tests in `tests/live.test.ts`.

### Unit Tests (`websearch.test.ts`)

Unit tests mock HTTP requests using `vi.spyOn(globalThis, "fetch")`.
Mock provider contexts simulate `ctx.integration.connection.active` and `ctx.integration.connection.resolve`.

Test suite coverage:

- Provider registration (registers `openai` and `google`, checks display names, verifies no custom tools).
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

### Live Smoke Tests (`tests/live.test.ts`)

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

## Verification Against Real OpenCode V2 Binary

Verification against a real OpenCode V2 binary requires executing API commands against the binary socket.

Step 1: Check registered websearch providers:

```sh
XDG_CONFIG_HOME="$HOME/.config/opencode2" opencode2 api get /api/websearch/provider
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
opencode2 api post /api/websearch '{"provider":"openai","query":"OpenCode CLI release"}'
opencode2 api post /api/websearch '{"provider":"google","query":"OpenCode CLI release"}'
```

Verify that results return normalized `WebSearch.Result[]` arrays containing valid URLs and timestamps.

### Operational Notes from Real-Binary Verification

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

## Verified Wire Evidence Sources

Wire formats and API contracts were verified against these primary source code references:

- big-AGI repository (`src/modules/aix/server/dispatch/chatGenerate/adapters/openai.responsesCreate.ts` and `gemini.generateContent.ts`):
  - Verified `web_search` tool parameters (`search_context_size`, `external_web_access`, `user_location`).
  - Verified `web_search_call.action.sources` include field.
  - Verified `googleSearch` tool structure and `timeRangeFilter` timestamp formatting.
  - Verified `thinkingConfig.thinkingLevel` uppercase wire enum mapping.
- OpenCode V2 repository (`packages/plugin/src/promise/{plugin,websearch,integration}.ts`, `packages/schema/src/{credential,websearch}.ts`, `packages/core/src/plugin/provider/openai.ts`, `packages/core/src/plugin/models-dev.ts`):
  - Verified `ctx.integration.connection.active` and `resolve` API.
  - Verified OAuth endpoint path rewrite `/backend-api/codex/responses`.
  - Verified `originator: opencode` and `chatgpt-account-id` headers.
  - Verified Google key and environment variable authentication methods.
- Verified `opencode-chatgpt-websearch` plugin option validation patterns.

## Open Follow-Up Items

1. Live ChatGPT OAuth Instruction Test:
   Perform a live smoke test using active ChatGPT OAuth credentials to confirm private endpoint instruction requirements.
2. Publishing Readiness:
   Prepare repository metadata for npm publication once OpenCode V2 plugin registry guidelines are finalized.
