# Changelog

All notable changes to `opencode-websearch-addons` are documented in this file.

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
