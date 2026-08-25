# opencode-websearch-addons

`opencode-websearch-addons` is a plugin for OpenCode V2.
This plugin attaches OpenAI and Gemini native search providers to the built-in OpenCode `websearch` tool.

## Features

- Registers two native search providers: OpenAI Web Search and Gemini Google Search.
- Adds no custom tools; providers plug into the built-in `websearch` tool.
- Supports key and OAuth credentials through OpenCode integration connections.
- Supports custom provider `baseURL` options for gateways and proxies.
- Parses Server-Sent Events streams with citation span extraction and grounding normalization.
- Supports configurable options for model, reasoning effort, search context size, user location, thinking level, and search time range.
- Handles cancellation and timeout requests for in-flight search operations.
- Includes unit tests with mocked HTTP requests and opt-in live smoke tests.

## Installation

Add the plugin package to your `opencode.json` or `opencode.jsonc` configuration file.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-websearch-addons@1.0.5"
    }
  ]
}
```

Connect the `openai` or `google` integration in OpenCode before you run a search.
The plugin resolves credentials from the active integration connection on every search.
As a fallback, it reads an `apiKey` from the provider settings in your OpenCode configuration.
Restart the OpenCode service after you install or update the plugin so every project location registers the providers.

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
OAuth credentials send requests to `https://chatgpt.com/backend-api/codex/responses`.
OAuth requests include the `originator: opencode` header and the `chatgpt-account-id` header when an account ID exists.

### Google authentication

Google supports API key credentials and environment variables.
Requests send the key in the `x-goog-api-key` HTTP header.
OAuth authentication is not supported for Google in OpenCode V2.

## Configuration options

Configure plugin options in your OpenCode configuration file under `plugins`.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-websearch-addons@1.0.5",
      "options": {
        "timeoutMs": 120000,
        "openai": {
          "model": "gpt-5.6-luna",
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
| `openai.model` | string | `"gpt-5.6-luna"` | Non-empty string up to 100 characters |
| `openai.reasoningEffort` | string | `"medium"` | `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, or `"max"` |
| `openai.searchContextSize` | string | `"medium"` | `"low"`, `"medium"`, or `"high"` |
| `openai.userLocation` | object | `undefined` | Optional object with string fields `city`, `country`, `region`, or `timezone` |
| `google.model` | string | `"gemini-3.5-flash-lite"` | Non-empty string up to 100 characters |
| `google.thinkingLevel` | string | `"medium"` | `"minimal"`, `"low"`, `"medium"`, or `"high"` |
| `google.searchTimeRange` | string | `"any"` | `"any"`, `"lastDay"`, `"lastWeek"`, `"lastMonth"`, or `"lastYear"` |
| `timeoutMs` | number | `120000` | Integer from 100 through 120000 |

### Search features and wire mappings

- `openai.searchContextSize` maps to `tools[].web_search.search_context_size`.
- `openai.reasoningEffort` maps to `reasoning.effort`.
- `openai.userLocation` maps to `tools[].web_search.user_location` with type `approximate`.
  Do not set `userLocation` unless location-biased search results are required.
- `google.thinkingLevel` maps to `generationConfig.thinkingConfig.thinkingLevel` using uppercase enum values (`MINIMAL`, `LOW`, `MEDIUM`, `HIGH`).
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

Run unit tests:

```sh
bun test
```

Run type checking and unit tests together:

```sh
bun run check
```

Run agent unit tests:

```sh
bun test:agent
```

Run live integration smoke tests against real provider APIs:

```sh
LIVE=1 OPENAI_API_KEY=... GEMINI_API_KEY=... bun test:live
```

Build the ESM distribution bundle to `dist/`:

```sh
bun run build
```

## Architecture

See `CONTEXT.md` for the complete architecture specification, provider wire formats, and verification guides.
