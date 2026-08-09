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

## Scope and Providers

The plugin registers two web search providers:

- `openai`: OpenAI Web Search
- `google`: Gemini Google Search

The plugin registers no custom tools.
Provider selection remains in standard OpenCode configuration.

## Provider Selection

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

### OpenAI Authentication

OpenAI supports API key credentials and ChatGPT OAuth credentials.
Key credentials send requests to `https://api.openai.com/v1/responses`.
OAuth credentials send requests to `https://chatgpt.com/backend-api/codex/responses`.
OAuth requests include the `originator: opencode` header and the `chatgpt-account-id` header when an account ID exists.

### Google Authentication

Google supports API key credentials and environment variables.
Requests send the key in the `x-goog-api-key` HTTP header.
OAuth authentication is not supported for Google in OpenCode V2.

## Configuration Options

Configure plugin options in your OpenCode configuration file under `plugins`.

```jsonc
{
  "plugins": [
    {
      "package": "opencode-websearch-addons",
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

### Options Reference

| Option | Type | Default | Validation Rules |
| --- | --- | --- | --- |
| `openai.model` | string | `"gpt-5.6-luna"` | Non-empty string up to 100 characters |
| `openai.reasoningEffort` | string | `"medium"` | `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, or `"max"` |
| `openai.searchContextSize` | string | `"medium"` | `"low"`, `"medium"`, or `"high"` |
| `openai.userLocation` | object | `undefined` | Optional object with string fields `city`, `country`, `region`, or `timezone` |
| `google.model` | string | `"gemini-3.5-flash-lite"` | Non-empty string up to 100 characters |
| `google.thinkingLevel` | string | `"medium"` | `"minimal"`, `"low"`, `"medium"`, or `"high"` |
| `google.searchTimeRange` | string | `"any"` | `"any"`, `"lastDay"`, `"lastWeek"`, `"lastMonth"`, or `"lastYear"` |
| `timeoutMs` | number | `120000` | Integer from 100 through 120000 |

### Search Features and Wire Mappings

- `openai.searchContextSize` maps to `tools[].web_search.search_context_size`.
- `openai.reasoningEffort` maps to `reasoning.effort`.
- `openai.userLocation` maps to `tools[].web_search.user_location` with type `approximate`.
  Do not set `userLocation` unless location-biased search results are required.
- `google.thinkingLevel` maps to `generationConfig.thinkingConfig.thinkingLevel` using uppercase enum values (`MINIMAL`, `LOW`, `MEDIUM`, `HIGH`).
- `google.searchTimeRange` computes `tools[].googleSearch.timeRangeFilter` ISO timestamp bounds for options other than `"any"`.

## Output Format

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

## Development Workflow

This package uses Bun for scripts and testing.

Run full type checking and unit tests:

```sh
bun check
```

Run agent unit tests:

```sh
bun test:agent
```

Run live integration smoke tests against real provider APIs:

```sh
LIVE=1 OPENAI_API_KEY=... GEMINI_API_KEY=... bun test:live
```

Build the distribution output to `dist/`:

```sh
bun run build
```
