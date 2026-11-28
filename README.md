# opencode-websearch-addons

This OpenCode V2 plugin adds OpenAI and Gemini native web search providers to the built-in `websearch` tool.
It adds no custom tools.

It registers two providers:

- `openai`: OpenAI Web Search
- `google`: Gemini Google Search

The plugin requires `@opencode/plugin` 2.4.1 or newer and `effect` 4.1.0 or newer.

## Installation

Add the package to your `opencode.json` or `opencode.jsonc` file.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-websearch-addons",
    },
  ],
}
```

Register the package once.
Do not load it from `.opencode/plugins/` at the same time.

Select a provider in the same file:

```jsonc
{
  "websearch": {
    "provider": "google",
  },
}
```

Both providers stay registered when you select one.
A missing credential causes an error only when its provider runs.

## Authentication

Connect the `openai` or `google` integration in OpenCode before you search.
The plugin reads the active connection on every search and stores no credentials.
When no connection is active, it uses the `apiKey` from the provider settings in your OpenCode configuration.

- OpenAI accepts API keys and ChatGPT OAuth connections.
- Google accepts API keys only, including keys from environment variables.

The plugin reads only two provider settings: `baseURL` and `apiKey`.
Other provider settings, such as custom headers, do not apply.
If you use a gateway, set `baseURL` to a gateway that supports native search.
OpenAI connections that use the `chatgpt-browser` or `chatgpt-headless` sign-in methods ignore `baseURL` and always use the ChatGPT endpoint.

## Options

Set options on the plugin entry:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-websearch-addons",
      "options": {
        "timeoutMs": 60000,
        "openai": { "reasoningEffort": "low" },
        "google": { "searchTimeRange": "lastMonth" },
      },
    },
  ],
}
```

| Option                     | Default                   | Allowed values                                                      |
| -------------------------- | ------------------------- | ------------------------------------------------------------------- |
| `openai.model`             | `"gpt-6-luna"`            | Non-empty string up to 100 characters                               |
| `openai.reasoningEffort`   | `"medium"`                | `"none"`, `"minimal"`, `"low"`, or `"medium"`                       |
| `openai.searchContextSize` | `"medium"`                | `"low"`, `"medium"`, or `"high"`                                    |
| `openai.userLocation`      | none                      | Object with optional string `city`, `country`, `region`, `timezone` |
| `google.model`             | `"gemini-3.5-flash-lite"` | Non-empty string up to 100 characters                               |
| `google.thinkingLevel`     | `"medium"`                | `"minimal"`, `"low"`, or `"medium"`                                 |
| `google.searchTimeRange`   | `"any"`                   | `"any"`, `"lastDay"`, `"lastWeek"`, `"lastMonth"`, or `"lastYear"`  |
| `timeoutMs`                | `120000`                  | Integer from 100 through 120000                                     |

Set `openai.userLocation` only when you need location-biased results.

## Output

Each result has a source URL and can include a title, a publication time, and content.
The model writes the content and cites the source.
It does not copy text from the source page.
A search with no web sources returns no results.

Google can return `searchEntryPoint` search suggestions, but OpenCode has no place to display them.
For this reason, the plugin does not fully meet Google's [Grounding with Google Search terms](https://ai.google.dev/gemini-api/terms#grounding-with-google-search).
Review those terms before you use this plugin in a product.
The plugin keeps Google source URLs unchanged.
Do not rewrite them.
