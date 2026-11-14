# opencode-websearch-addons

`opencode-websearch-addons` targets the latest available OpenCode V2 plugin API.
The minimum runtime peer floor is `@opencode/plugin ^2.3.0`.
Development and host tests use `latest`, resolved to 2.3.0 for this verification.
This plugin attaches OpenAI and Gemini native search providers to the built-in OpenCode `websearch` tool.

## Features

- Registers two native search providers: OpenAI Web Search and Gemini Google Search.
- Adds no custom tools; providers plug into the built-in `websearch` tool.
- Supports key and OAuth credentials through OpenCode integration connections.
- Reads provider `settings.baseURL` and fallback `settings.apiKey` for gateways.
- Parses Server-Sent Events streams with citation span extraction and grounding normalization.
- Supports configurable options for model, reasoning effort, search context size, user location, thinking level, and search time range.
- Handles cancellation and timeout requests for in-flight search operations.
- Tests the real in-process host with loopback HTTP/SSE and default live E2E searches.

## Installation

Add the plugin package to your `opencode.json` or `opencode.jsonc` configuration file.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-websearch-addons"
    }
  ]
}
```

Connect the `openai` or `google` integration in OpenCode before you run a search.
The plugin resolves credentials from the active integration connection on every search.
As a fallback, it reads an `apiKey` from the provider settings in your OpenCode configuration.
OpenCode reloads plugin configuration and installs or reapplies pending packages automatically.
Register the package once; do not also load it from `.opencode/plugins/`.

## Scope and providers

The plugin registers two web search providers:

- `openai`: OpenAI Web Search
- `google`: Gemini Google Search

The plugin registers no custom tools.
Provider selection remains in standard OpenCode configuration.

## Provider selection

Select your web search provider in your OpenCode configuration file.

```jsonc
{
  "websearch": {
    "provider": "google"
  }
}
```

Both providers remain registered in OpenCode when you select one provider.
Missing credentials cause errors only when the selected provider executes.

## Authentication

The plugin performs no authentication management.
It does not store API keys or manage OAuth workflows.
It resolves active connections from OpenCode at execution time.
When no active connection exists, it falls back to the `apiKey` field in the provider settings of your OpenCode configuration.

### OpenAI authentication

OpenAI supports API key credentials and ChatGPT OAuth credentials.
Key credentials send requests to `https://api.openai.com/v1/responses`.
`chatgpt-token-sharing` OAuth credentials use the same route as key credentials.
Both paths honor provider `settings.baseURL` and send only the Bearer credential as authentication.
Legacy `chatgpt-browser` and `chatgpt-headless` credentials use `https://chatgpt.com/backend-api/codex/responses`.
Only these legacy requests include `originator: opencode` and an optional `chatgpt-account-id`.
Unknown OAuth methods and external credentials are rejected.

### Google authentication

This plugin's Google provider supports key credentials, including environment connections resolved by OpenCode.
Requests send the key in the `x-goog-api-key` HTTP header.
This plugin rejects Google OAuth credentials.

### Provider settings scope

Native search uses direct HTTP requests rather than OpenCode's model-request pipeline.
Only `settings.baseURL` and fallback `settings.apiKey` are read.
Active integration credentials take precedence over the fallback key.
Settings lookup failures stop the request before credentials are sent.
Provider/model headers, body overlays, organization/project headers, TLS, encoding, transport, model eligibility, session/model hooks, and model-resolver `${ENV}` URL expansion are not inherited.
Use a gateway that accepts the documented request and authentication headers.

## Configuration options

Configure plugin options in your OpenCode configuration file under `plugins`.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-websearch-addons",
      "options": {
        "timeoutMs": 120000,
        "openai": {
          "model": "gpt-6-luna",
          "reasoningEffort": "medium",
          "searchContextSize": "medium"
        },
        "google": {
          "model": "gemini-3.5-flash-lite",
          "thinkingLevel": "medium",
          "searchTimeRange": "any"
        }
      }
    }
  ]
}
```

### Options reference

| Option | Type | Default | Validation rules |
| --- | --- | --- | --- |
| `openai.model` | string | `"gpt-6-luna"` | Non-empty string up to 100 characters |
| `openai.reasoningEffort` | string | `"medium"` | `"none"`, `"minimal"`, `"low"`, or `"medium"` |
| `openai.searchContextSize` | string | `"medium"` | `"low"`, `"medium"`, or `"high"` |
| `openai.userLocation` | object | `undefined` | Optional object with string fields `city`, `country`, `region`, or `timezone` |
| `google.model` | string | `"gemini-3.5-flash-lite"` | Non-empty string up to 100 characters |
| `google.thinkingLevel` | string | `"medium"` | `"minimal"`, `"low"`, or `"medium"` |
| `google.searchTimeRange` | string | `"any"` | `"any"`, `"lastDay"`, `"lastWeek"`, `"lastMonth"`, or `"lastYear"` |
| `timeoutMs` | number | `120000` | Integer from 100 through 120000 |

### Search features and wire mappings

- `openai.searchContextSize` maps to `tools[].search_context_size`.
- `openai.reasoningEffort` maps to `reasoning.effort`.
- `openai.userLocation` maps to `tools[].user_location` with type `approximate`.
  Do not set `userLocation` unless location-biased search results are required.
- `google.thinkingLevel` maps to `generationConfig.thinkingConfig.thinkingLevel` using uppercase enum values (`MINIMAL`, `LOW`, `MEDIUM`).
- `google.searchTimeRange` computes `tools[].googleSearch.timeRangeFilter` ISO timestamp bounds for options other than `"any"`.

## Output format

The plugin returns normalized results satisfying OpenCode's `WebSearch.Result` schema:

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

The `content` field contains model-generated text segments attributed to the source URL.
`content` does not contain verbatim text excerpts from external web pages.
The plugin returns an empty array `[]` when a request succeeds with no grounded web sources.
Invalid and non-HTTP(S) source URLs are skipped.
Publication timestamps outside JavaScript's valid Date range are omitted.
OpenAI incomplete responses are errors, including filtering and output-token truncation.

### Google Grounding Display Terms

Google grounding responses can include `searchEntryPoint` search suggestions.
OpenCode's `WebSearch.Result` has no slot for this widget, so the plugin cannot display it.
Schema-compatible results do not establish full compliance with Google's [Grounding with Google Search terms](https://ai.google.dev/gemini-api/terms#grounding-with-google-search).
Resolve the required display and retention obligations before using this integration in a product.
The plugin preserves returned URLs, including Google redirect URLs.
Do not rewrite or bypass those links.
Do not retain live grounding data as reusable fixtures without a permitted purpose and retention policy.

## Development workflow

This package uses Bun 1.2.0 or newer for scripts and testing.

Install dependencies:

```sh
bun install
```

Run type checking:

```sh
bun run typecheck
```

Run the linter:

```sh
bun run lint
```

Run the full suite, including live E2E searches:

```sh
bun test
```

The legacy-route scenario requires OpenSSL to create a temporary test certificate.
It uses a trusted loopback CONNECT proxy in isolated subprocesses.
It does not disable TLS verification, change production endpoints, or send real credentials.

Run type checking and the full suite together:

```sh
bun run check
```

Run the full suite with fail-fast behavior:

```sh
bun test:agent
```

Live tests read OpenCode's resolved configuration without changing your global configuration or active connections.
Configure both `openai` and `google` with non-empty `settings.baseURL` and `settings.apiKey`.
Missing prerequisites fail rather than skip.
No ChatGPT OAuth credential is required for live E2E.
Each provider makes one bounded, search-specific request with low/minimal budgets.
These requests require network access and can incur provider charges.
Each live case has an explicit timeout above its request budget.

Run only live E2E tests:

```sh
bun run test:live
```

Build the ESM distribution bundle to `dist/`:

```sh
bun run build
```

## Architecture

See `CONTEXT.md` for the complete architecture specification, provider wire formats, and verification guides.
