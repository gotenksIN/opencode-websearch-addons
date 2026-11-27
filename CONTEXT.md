# Project decisions

## Target the latest OpenCode V2 release

Development uses `latest` for `@opencode/core` and `@opencode/plugin`.
The peer floor is `@opencode/plugin ^2.4.1` and `effect ^4.0.0`.
The bundle externalizes both peers so the plugin shares the host's runtime identity.

## Extend the built-in `websearch` tool

The plugin registers `openai` and `google` providers through `ctx.websearch`.
It adds no custom tools and does not change the selected provider.
Users keep one search tool and select a provider in standard OpenCode configuration.

## Use direct provider HTTP

Native search tools and citation data are not available through the plain text generation interface.
The plugin calls each provider's native search API directly.
It reads only `settings.baseURL` and fallback `settings.apiKey`.
It does not inherit headers, body overlays, or other model-pipeline settings, because merging them into search bodies is unsafe.

## Delegate credentials to OpenCode

OpenCode owns connections, stored credentials, OAuth renewal, and active selection.
The plugin resolves the active credential on every execution and keeps no credentials between executions.
OpenAI routes OAuth by `methodID`: `chatgpt-token-sharing` uses the key route, and `chatgpt-browser` and `chatgpt-headless` use the Codex route.
The plugin rejects unknown OAuth methods and external credentials.
Google accepts key credentials only, because OpenCode `v2.4.1` has no built-in Google OAuth method.
Revisit this decision if OpenCode adds one.

## Fail closed

Authenticated redirects, incomplete responses, and blocked responses are errors.
HTTP status failures become credential-free Effect `HttpClientError` values.
This keeps OpenCode 429 cooldowns and status-specific messages without exposing secrets.

## Parse streams defensively

The shared SSE parser holds a trailing `\r` at the end of a chunk until the next chunk or EOF so split `\r\n` line endings parse cleanly.
It emits a final event at EOF even when the stream omits a trailing blank line, and suppresses cancellation errors during cleanup so the original provider or parse error surfaces.
OpenAI treats responses without a `Content-Type` header as SSE, prefers non-empty terminal `response.completed` output over partial item events, and bounds passages using every citation marker (including skipped URLs) across UTF-16 and Unicode code point offsets.

## Attribute content and preserve sources

`content` holds only model-generated spans attributed to a source URL, never verbatim source excerpts.
Google source URLs stay unchanged, including redirect links.
`WebSearch.Result` cannot show Google `searchEntryPoint`, so the project does not claim full Grounding Display Terms compliance.

## Bound effort and thinking

The plugin limits OpenAI reasoning effort to `none` through `medium`.
It limits Google thinking level to `minimal` through `medium`.
Search requests stay fast and inexpensive.

## Test without mocks

Tests run the plugin in the real in-process OpenCode host.
Host contracts need no network, and live E2E calls the real OpenAI and Google APIs.
Mocks drift from upstream behavior, so the suite has no loopback servers, payload fixtures, or spies.
As a result, HTTP 429 cooldowns, redirect rejection, and error redaction rely on code invariants rather than automated tests.

## Keep tooling strict

Bun runs every script.
Type-aware Oxlint with Ultracite core, anti-slop, and landmines rules, and Oxfmt, gate every change.
The only lint allowlist grants three live network timeouts in `test/live.test.ts` for `landmines-testing/no-flake-masking`.
Keep `ultracite`, `oxlint`, `oxlint-tsgolint`, and `oxfmt` on `latest` instead of pinning versions.
Pin `@interfere/landmines` to `0.1.1` until Ultracite updates `ultracite/oxlint/landmines` for `@interfere/landmines >= 0.2.0`.
