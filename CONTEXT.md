# Architecture specification

## Support contract

This package registers OpenAI and Gemini native search providers for the latest available OpenCode V2 plugin API.
Development dependencies use `latest`; the verified host and plugin SDK resolve to 2.3.0 and both require Effect 4.1.0.
Runtime peers are `@opencode/plugin ^2.3.0` and `effect ^4.0.0`; these are minimum floors, not a fixed host target.
The ESM bundle externalizes both packages to preserve host runtime identity.
Use Bun and the scripts in `package.json` for installation, verification, and builds.
Keep the existing Oxlint configuration and vendored anti-slop rules together.

## Module boundaries

- `index.ts` defines the plugin and registers `openai` and `google` through `ctx.websearch.transform`.
  Its disposer removes the registration.
  It registers no custom tool and does not change the selected provider.
- `src/config.ts` validates options at setup with exact `Invalid plugin option <name>; expected <description>.` errors.
  Defaults and enum tuples are private.
  See README.md for the option matrix.
- `src/auth.ts` resolves the active integration connection on every execution.
  OpenCode owns environment connections, stored credentials, OAuth renewal, and active selections.
  When no active connection exists, a non-empty provider `settings.apiKey` supplies a key credential.
  Connection resolution failures do not fall back to another credential.
- `src/openai.ts` and `src/google.ts` own native HTTP requests and private normalization.
- `src/types.ts` owns JSON guards, cancellable metadata lookups, framing, redaction, HTTP errors, and result construction.

Use official `Plugin.Context["provider"]` metadata access.
There is no legacy catalog compatibility layer.
Lookup failures fail closed before an authenticated request.
Do not retain credentials across executions.

## Provider settings scope

Direct native HTTP preserves provider-specific search tools and attribution that the plain text generation interface does not expose.
It is not the OpenCode model-request pipeline.
The supported provider settings are `baseURL` and fallback `apiKey` only.
Active credentials take precedence over the settings key.
Trailing slashes are removed from base URLs.
Provider/model headers and body overlays, organization/project headers, custom TLS, encoding, transport selection, model eligibility, session/model hooks, and model-resolver `${ENV}` URL expansion are not inherited.
Do not blindly merge arbitrary model-request configuration into native search bodies.

## OpenAI wire contract

| Credential | Endpoint | Authentication headers |
| --- | --- | --- |
| Key | `<settings.baseURL>/responses` or `https://api.openai.com/v1/responses` | Bearer key |
| OAuth `chatgpt-token-sharing` | Same as key | Bearer access token |
| OAuth `chatgpt-browser` / `chatgpt-headless` | `https://chatgpt.com/backend-api/codex/responses` | Bearer access token, `originator: opencode`, optional `chatgpt-account-id` |

Reject unknown OAuth methods and external credentials.
All requests use POST, JSON content type, `Accept: text/event-stream`, `redirect: "error"`, and the combined cancellation/timeout signal.
Only legacy Codex methods send account and originator headers.

The body contains the configured model, a user input-text message, `tools: [{ type: "web_search", search_context_size, external_web_access: true }]`, `reasoning.effort`, `include: ["web_search_call.action.sources"]`, `store: false`, and `stream: true`.
Optional approximate user location belongs on `tools[].user_location`.
Leave `tool_choice` omitted so automatic selection remains enabled.
Supported effort values are `none`, `minimal`, `low`, and `medium`.

Collect `response.output_item.done` items, or use `response.completed.response.output` when no done items arrive.
Reject streams without a terminal event.
Reject `response.failed`, top-level errors, and `response.incomplete`.
JSON fallback requires an output array and rejects failed or incomplete status.
Incomplete errors report sanitized `incomplete_details.reason`, including `content_filter` and `max_output_tokens`.

Normalize message URL citations and web-search action sources.
Citation spans use bounded JavaScript string offsets.
Deduplicate exact URLs and spans while retaining discovery order and the first non-empty title.
Action sources can retain valid publication metadata without attributed content.

## Gemini wire contract

Only key credentials are supported by this plugin's Google implementation.
OpenCode can resolve environment connections to key credentials.
This restriction does not describe all Google authentication capabilities in OpenCode.

POST to `<settings.baseURL>/models/<encoded-model>:streamGenerateContent?alt=sse`, or use `https://generativelanguage.googleapis.com/v1beta` as the base.
Send the key in `x-goog-api-key`, JSON content type, and `Accept: text/event-stream`.
The body contains user `contents`, `tools: [{ googleSearch: {} }]`, and `generationConfig.thinkingConfig.thinkingLevel`.
Supported thinking values map to `MINIMAL`, `LOW`, and `MEDIUM`.
For non-`any` time ranges, include `googleSearch.timeRangeFilter`.
Compute UTC calendar bounds for one day, one week, one month, or one year.
Clamp month-end and leap-day transitions and omit milliseconds from ISO bounds.

Concatenate visible text by part index and exclude thought parts.
Append `groundingChunks` in arrival order across events without deduplicating the indexed array.
Append `groundingSupports` across events.
Support indices refer to the full accumulated chunk array.
Resolve indices before deduplicating output URLs.
Slice each support's own part with UTF-8 byte offsets; an omitted start index means zero.
Use supplied segment text only when it occurs in the visible part.

Reject prompt blocks, safety/policy finish reasons (including `ESCALATION` and `PUP_LIMITED_DISABLED`), malformed tool/output reasons, `OTHER`, `IMAGE_OTHER`, `MAX_TOKENS`, and incomplete `CONTINUATION`.
The finish-reason and incremental grounding contracts follow the [Gemini API reference](https://ai.google.dev/api/generate-content#FinishReason).
Accept valid ungrounded output as `[]`.

### Grounding display and retention

Preserve Google's source URLs exactly, including redirect links.
Do not rewrite or bypass them.
OpenCode's result schema has no slot for `searchEntryPoint` suggestions.
The plugin drops that widget and cannot establish full compliance with the [Google Grounding Display Terms](https://ai.google.dev/gemini-api/terms#grounding-with-google-search).
Resolve product display and retention obligations before deployment.
Use hand-authored protocol fixtures; retain live grounding results only with a permitted purpose and retention policy.

## Shared runtime and security

Results satisfy `WebSearch.Result`: required HTTP(S) `url` and `time`, optional `title`, attributed `content`, and `time.published`.
Skip invalid and non-HTTP(S) source URLs without changing valid URL strings.
Numeric publication timestamps are milliseconds and must lie within ±8.64e15.
Parse string dates with `Date.parse`.
Omit invalid dates so `WebSearchTool` can call `toISOString` safely.
Content includes only attributed model-generated spans, not verbatim source excerpts.

The SSE parser handles multiline data, comments, LF/CR/CRLF, split UTF-8 bytes, and a final event without a blank terminator.
Malformed JSON and malformed events fail without reflecting raw provider bodies.
Cancel unfinished readers and release reader locks.

Resolve credentials and settings under the request timeout.
Check pre-abort before lookup and fetch.
Forward host cancellation to the fetch/body signal and preserve abort/timeout reasons.
Clear timers and remove host-signal listeners in `finally`.
Reject authenticated redirects to prevent credential forwarding.

Failed HTTP responses throw Effect `HttpClientError` wrapping `StatusCodeError`.
This enables OpenCode random-provider 429 cooldowns and status-specific tool messages.
Retain only synthetic credential-free request metadata, the status, and sanitized Retry-After.
Never attach a native request/response, body, transport cause, or authenticated URL to that error.
Sanitize provider diagnostics and known credentials before constructing errors.

## Verification

Tests load `index.ts` through the latest real in-process `@opencode/core` host (2.3.0 in the verified lockfile).
Use the real websearch, provider, integration, credential, and built-in websearch-tool boundaries with isolated state.
Keep one owning scenario per observable contract rather than testing private helpers repeatedly.
Use real fetch against ephemeral loopback HTTP/SSE servers for deterministic framing, failure, redirect, cancellation, and rendering contracts.
Never monkeypatch global fetch or imitate plugin contexts.

`bun test` includes live E2E by default.
Resolve the user's OpenCode configuration read-only and require both `openai` and `google` `baseURL` plus `apiKey`.
Missing credentials fail with a clear prerequisite error, not a skip.
Live E2E does not require ChatGPT OAuth.
Use bounded search prompts, low/minimal budgets, explicit test timeouts above request budgets, and isolated host state.
Requests can incur charges.
Do not log credentials or preserve real provider responses as fixtures.

Run `bun run typecheck`, `bun run lint`, `bun test`, and `bun run build`.
Use `bun test websearch.test.ts` for deterministic development checks and `bun run test:live` for only live E2E.
The deterministic command is not evidence that the full suite passes.

For service-level inspection, use:

```sh
opencode api get /api/websearch/provider
opencode api post /api/websearch --data '{"providerID":"openai","query":"OpenCode CLI release"}'
opencode api post /api/websearch --data '{"providerID":"google","query":"OpenCode CLI release"}'
```

Registries are location-scoped.
Register the plugin once through configuration or `.opencode/plugins/`.
OpenCode keeps the first duplicate ID and reports later duplicates as isolated failures.
Configuration reload and pending package reapplication do not require a prescribed service restart.
