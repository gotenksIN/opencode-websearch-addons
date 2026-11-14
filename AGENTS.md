# Agent instructions

## Tooling

Use Bun for all repository operations.
Do not use `npm`, `npx`, or `bunx`.

- `bun test`: Run the test suite.
- `bun run typecheck`: Run TypeScript type checking.
- `bun run build`: Build the ESM distribution bundle.
- `bun run lint`: Run `oxlint --type-aware .` with Ultracite core and anti-slop.
- `bun run format`: Apply Oxfmt formatting.
- `bun run check`: Check lint, formatting, types, and the full test suite.

Keep the core lint rules unrelaxed.
Preserve semantic Markdown line breaks with Oxfmt's `proseWrap: "preserve"`.

Maintain compatibility with the latest available OpenCode V2 plugin API.
Keep development host and plugin SDK dependencies on `latest`; `^2.3.0` is the minimum runtime peer floor, not a compatibility ceiling.
Keep `@opencode/plugin` and `effect` as runtime peers and external build imports.

## Code standards

- Write source code in TypeScript with ECMAScript Modules (ESM).
- Import relative files with `.js` extensions to satisfy NodeNext module resolution.
- Validate all plugin options in `parseConfig` (`src/config.ts`) with exact `Invalid plugin option <name>; expected <description>.` errors.
- Guard provider payloads with the JSON type guards in `src/types.ts`.
- Resolve credentials on every execution through `resolveCredential` (`src/auth.ts`).
- Never log, store, or include credential values in errors.
- Apply the shared cancellation and timeout pattern to every provider fetch.
- Return results that satisfy OpenCode's `WebSearch.Result` schema.
- Return an empty array when a valid response contains no grounded web sources.
- Keep `content` limited to model-generated text spans attributed to a source URL; never copy verbatim source excerpts.
- Read only provider `settings.baseURL` and fallback `settings.apiKey`; direct HTTP does not inherit the model pipeline.
- Preserve Google source URLs. `WebSearch.Result` cannot display `searchEntryPoint`; do not claim full Grounding Display Terms compliance.

## Test contracts

- Execute `index.ts` through the latest `@opencode/core` in-process host and built-in websearch tool.
- Use real fetch with `Bun.serve({ port: 0 })` for deterministic HTTP/SSE failure scenarios.
- Keep each observable contract in one owning scenario. Keep implementation helpers private.
- Do not monkeypatch global fetch, imitate plugin contexts, or import implementation modules from tests.
- Assert normalized `WebSearch.Result` output, endpoint routing, request headers, request payloads, stream parsing, error messages, and abort or timeout behavior.
- Test defaults, valid options, and exact validation errors through plugin setup.
- Do not write tests that only verify symbol presence, command registrations, or type definitions.
- Let the TypeScript compiler enforce static type relationships.
- Run live E2E by default in `bun test`. Read `openai` and `google` baseURL/apiKey through OpenCode config/provider resolution, read-only.
- Fail clearly on missing live prerequisites; do not skip. ChatGPT OAuth is not a live prerequisite.
- Isolate test credentials and state. Do not mutate global user state or retain live provider responses as fixtures.
- Bound live prompts, cost, and request budgets. Set explicit test timeouts above request budgets.
