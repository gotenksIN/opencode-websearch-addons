# Agent instructions

## Tooling and dependencies

- Use Bun for all repository operations; never use `npm`, `npx`, or `bunx`.
- Keep non-pinned devDependencies on `latest` rather than pinning exact versions.
- Keep `"@interfere/landmines": "0.1.1"` pinned until Ultracite updates `ultracite/oxlint/landmines` for `@interfere/landmines >= 0.2.0`.
- Keep `effect` at `4.1.0` in devDependencies and externalize both `@opencode/plugin` (`^2.4.1` peer floor) and `effect` (`^4.1.0` peer floor) in the bundle so the plugin shares the host's runtime identity.
- Keep Ultracite core, anti-slop, and landmines lint rules unrelaxed; `landmines-testing/no-flake-masking` allowlists only the exact 3 live network timeouts in `test/live.test.ts`.
- Keep `proseWrap: "preserve"` in `oxfmt.config.ts`.
- Because `landmines-style/no-comments` forbids prose comments in source and test files, record non-obvious design rationale and invariants here.

## Architecture and provider invariants

- Extend the built-in `websearch` tool through `ctx.websearch` (`@opencode/plugin/effect`); add no custom tools and do not alter the user's selected provider.
- Call each provider's native search API directly over HTTP because plain text generation interfaces do not expose native search tools or citation data. Keep request tracing disabled, and govern each search from credential lookup through result normalization under one `timeoutMs` budget.
- Read only `settings.baseURL` and fallback `settings.apiKey`; never inherit headers, body overlays, or other model-pipeline settings because merging them into search bodies is unsafe.
- Delegate credential storage, OAuth renewal, and active selection to OpenCode. Resolve the active credential on every execution, keep secrets wrapped in `Redacted` until wire or sanitization boundaries, store no credentials between runs, and never log or include credential values in errors.
- Route OpenAI OAuth by `methodID`: `chatgpt-token-sharing` uses the key route; `chatgpt-browser` and `chatgpt-headless` use the Codex route. Reject unknown OAuth methods and external credentials.
- Accept key credentials only for Google because OpenCode has no built-in Google OAuth method. Keep the fail-closed rejection of non-key Google credentials (revisit only if OpenCode adds one).
- Fail closed on authenticated redirects, incomplete responses, and blocked responses. Sanitize HTTP status, transport, and encoding failures into credential-free Effect `HttpClientError` values so OpenCode preserves 429 cooldowns and status-specific messages without exposing secrets.
- Bound OpenAI `reasoningEffort` to `none`–`medium` and Google `thinkingLevel` to `minimal`–`medium` to keep search requests fast and inexpensive.

## Streaming and output invariants

- Keep `maxEventSize: Number.POSITIVE_INFINITY` on the `Sse.makeParser` channel adapter, ignore `retry:` directives, and feed `"\n\n"` once on clean upstream EOF so a trailing event without a blank line still flushes.
- Let the enclosing request scope abort the fetch on early stop or interruption so stream cleanup never masks an earlier parse or provider error.
- Preserve intentional `Content-Type` asymmetries:
  - OpenAI treats headerless responses as SSE, stops at `response.completed` before parsing later records in the same chunk, prefers non-empty terminal output over partial item events, and bounds passages using every citation marker (including skipped URLs) across UTF-16 and Unicode code point offsets.
  - Google treats headerless responses as JSON and consumes SSE streams through EOF before requiring finish, block, or usage metadata.
- Limit `content` to model-generated text spans attributed to a source URL; never copy verbatim source excerpts. Return `[]` when a valid response contains no grounded web sources.
- Preserve Google source URLs unchanged, including redirect links. Because `WebSearch.Result` cannot display Google's `searchEntryPoint`, never claim full Grounding Display Terms compliance.

## Test contracts

- Use no mocks: no loopback servers, provider payload fixtures, spies, global fetch patches, or imitated plugin contexts. Mocks drift from upstream behavior, so HTTP 429 cooldowns, redirect rejection, and error redaction rely on code invariants rather than automated tests.
- Load `index.ts` through the real in-process `@opencode/core` host (`test/host.test-utils.ts`). Replace host layers only to isolate state (paths, config, watcher, location) and skip permission prompts; keep `Provider`, `Credential`, `WebSearch`, and `Tool` services unmodified.
- `test/live.test.ts` runs by default in `bun test` against real OpenAI and Google APIs, reading `settings.baseURL` and `settings.apiKey` read-only from OpenCode global config. Fail clearly on missing prerequisites rather than skipping; ChatGPT OAuth is not a prerequisite.
- Never print live response bodies, gateway URLs, or credentials in failure output, and never retain live provider responses as fixtures.
- Bound live prompts, cost, and request budgets, set each live test timeout above its plugin `timeoutMs`, and isolate temporary directories and state for concurrent execution.
