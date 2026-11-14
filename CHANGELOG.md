# Changelog

All notable changes to `opencode-websearch-addons` are documented in this file.

## 1.1.0 (2026-11-14)

- Move `@opencode/plugin` (`^2.3.0`) and `effect` (`^4.0.0`) to `peerDependencies`, externalize both in the distribution bundle, and remove legacy `ctx.catalog` compatibility shims.
- Route `chatgpt-token-sharing` OAuth credentials through the configured provider `baseURL` or `https://api.openai.com/v1/responses` without Codex headers, restrict the Codex endpoint to `chatgpt-browser` and `chatgpt-headless`, and reject unknown OAuth methods.
- Reject OpenAI `response.incomplete` stream events and JSON `status: "incomplete"` responses with redacted details, and send explicit `Accept: text/event-stream` headers.
- Accumulate Gemini `groundingChunks` and `groundingSupports` in arrival order across streamed events, deduplicate result URLs after support resolution, preserve source URLs unmodified, and reject `ESCALATION` and `PUP_LIMITED_DISABLED` finish reasons.
- Emit sanitized Effect `HttpClientError` causes on failed HTTP responses for host 429 cooldowns and status-specific messages, omit out-of-range publication timestamps (`±8.64e15` ms), and restrict result URLs to `http:` and `https:`.
- Narrow `openai.reasoningEffort` to `none`, `minimal`, `low`, and `medium`, narrow `google.thinkingLevel` to `minimal`, `low`, and `medium`, and privatize internal helpers and option constants.
- Replace helper micro-tests and fetch spies with an in-process `@opencode/core` host suite, loopback transport failure scenarios, and default live E2E tests reading configured OpenCode `baseURL` and `apiKey` settings.
- Migrate linting and formatting from vendored anti-slop rules to Ultracite, Oxfmt, and type-aware Oxlint (`oxlint --type-aware`), and reconcile `README.md`, `CONTEXT.md`, and `AGENTS.md`.

## 1.0.10 (2026-10-29)

- Update `@opencode/plugin` to `2.2.1`, Oxlint dependencies to `1.90.0`, and `@types/bun` to `1.4.4`.
- Change the default OpenAI search model to `gpt-6-luna`.
- Reject HTTP redirects on authenticated provider requests so credential headers do not reach another origin.
- Parse complete Server-Sent Events, including events that span several `data:` lines and streams that use CRLF or CR line endings.
- Install the latest release in README examples instead of pinning `1.0.6`.

## 1.0.9 (2026-10-02)

- Update `@opencode/plugin` to `2.0.21`, Oxlint dependencies to `1.86.0`, and TypeScript to `7.0.2`.

## 1.0.8 (2026-09-23)

- Update the OpenCode V2 plugin and Bun development dependencies.
- Map Gemini grounding citations to the correct generated text across UTF-8 offsets, streamed chunks, and response parts.
- Stop searches cancelled during credential or provider-settings lookup before sending a provider request.
- Reject malformed Gemini response envelopes while preserving empty results for valid responses without grounded sources.

## 1.0.7 (2026-09-16)

- Update all direct dependencies to their latest releases, including `@opencode/plugin` 2.0.3 and Oxlint 1.83.0.
- Read provider settings from the current OpenCode V2 provider domain while retaining compatibility with the 2.0.3 catalog surface.
- Reject OpenAI stream error events and streams that end before a terminal response event.
- Preserve OpenAI stream error codes when providers omit an error message.
- Stop consuming OpenAI streams at terminal events and cancel response bodies after early exits.
- Reject failed or malformed OpenAI JSON response envelopes.
- Fail before sending credentials when provider endpoint settings cannot be read.
- Reject Gemini prompt blocks, content filters, malformed output finish reasons, and malformed stream errors.
- Reject pre-aborted searches and truncated Gemini streams.
- Preserve Gemini grounding offsets across reasoning parts and omitted zero indices.
- Clamp Gemini calendar search ranges at month-end and leap-day boundaries.

## 1.0.6 (2026-09-12)

- Update `@opencode/plugin` dependency to `2.0.2` for the OpenCode V2 release.
- Externalize `@opencode/plugin` in the distribution build bundle.
- Add `prepack` script to run bundle compilation before publishing.
- Redact sensitive credentials in provider error responses and stream failures.
- Centralize SDK type exports in `src/types.ts`.
- Remove registration-only tests to align with behavioral testing contracts.
- Update vendored anti-slop Oxlint rules to the latest upstream release.

## 1.0.5 (2026-08-25)

- Pin `@opencode-ai/plugin` to `0.0.0-dev-18153` in dependencies.
- Configure `main` and `exports` to `./dist/index.js`.
- Align types and tests with testing rules and YAGNI guidance.

## 1.0.4 (2026-08-25)

- OpenCode V2 plugin API upgrade for OpenAI and Gemini search providers.
- Switch distribution build to Bun.
- Add author, repository, and homepage package metadata.
