# Agent instructions

## Tooling

Use Bun for all repository operations.
Do not use `npm`, `npx`, or `bunx`.

- `bun test`: Run the full suite, including live E2E.
- `bun run test:live`: Run only live E2E.
- `bun run typecheck`: Run TypeScript type checking.
- `bun run lint`: Run `oxlint --type-aware .` with Ultracite core, anti-slop, and landmines.
- `bun run format`: Apply Oxfmt formatting.
- `bun run check`: Check lint, formatting, types, and the full suite.
- `bun run build`: Build the ESM bundle to `dist/`.

Keep the Ultracite core, anti-slop, and landmines lint rules unrelaxed (with `landmines-testing/no-flake-masking` allowlisting `3` live timeouts in `test/live.test.ts` only).
Keep `ultracite`, `oxlint`, `oxlint-tsgolint`, and `oxfmt` devDependencies on `latest`, and keep the temporary `"@interfere/landmines": "0.1.1"` pin until Ultracite supports `@interfere/landmines >= 0.2.0`.
Keep Oxfmt `proseWrap: "preserve"`.

## OpenCode target

Target the latest available OpenCode V2 plugin API.
Keep `@opencode/core` and `@opencode/plugin` devDependencies on `latest`.
`^2.4.1` is the minimum `@opencode/plugin` peer floor, not a compatibility ceiling.
Keep `@opencode/plugin` and `effect` as runtime peers and external build imports.

## Code standards

- Import relative files with `.js` extensions (NodeNext resolution).
- Omit explicit function return-type annotations (except type predicates) and use `satisfies` or typed variables when pinning contracts (`landmines-types/no-explicit-return-types`).
- Do not write prose comments in source or test files (`landmines-style/no-comments`); record design rationale and invariants in `CONTEXT.md`.
- Validate all plugin options in `parseConfig` (`src/config.ts`) with exact `Invalid plugin option <name>; expected <description>.` errors.
- Guard provider payloads with the JSON type guards in `src/types.ts`.
- Resolve credentials on every execution through `resolveCredential` (`src/auth.ts`).
- Never log, store, or include credential values in errors.
- Apply the shared cancellation and timeout pattern to every provider fetch.
- Return results that satisfy OpenCode's `WebSearch.Result` schema.
- Return `[]` when a valid response contains no grounded web sources.
- Limit `content` to model-generated text spans attributed to a source URL; never copy verbatim source excerpts.
- Read only provider `settings.baseURL` and fallback `settings.apiKey`; direct HTTP does not inherit the model pipeline.
- Preserve Google source URLs. `WebSearch.Result` cannot display `searchEntryPoint`; do not claim full Grounding Display Terms compliance.
- Google supports key credentials only; OpenCode has no built-in Google OAuth method. Keep the fail-closed rejection of non-key Google credentials.

## Test contracts

- Load `index.ts` through the latest `@opencode/core` in-process host (`test/host.test-utils.ts`) and the built-in `websearch` tool.
- Use no mocks: no loopback servers, provider payload fixtures, spies, global fetch patches, or imitated plugin contexts.
- Replace host layers only to isolate state (paths, config, watcher, location) and to skip permission prompts. Keep `Provider`, `Credential`, `WebSearch`, and `Tool` services unmodified.
- `websearch.test.ts` holds mock-free host contracts: registration and disposal, option validation through setup, fail-closed credentials, and pre-aborted signals.
- `test/live.test.ts` holds live E2E against real OpenAI and Google APIs. `bun test` runs it by default.
- Read `openai` and `google` `settings.baseURL` and `settings.apiKey` read-only through OpenCode config resolution.
- Fail clearly on missing live prerequisites; do not skip. ChatGPT OAuth is not a live prerequisite.
- Never print live response bodies, gateway URLs, or credentials from live failures.
- Bound live prompts, cost, and request budgets. Set each test timeout above its plugin `timeoutMs`.
- Tests run concurrently (`bunfig.toml`). Give every host its own temporary directory and state; never mutate global user state or shared module state.
- Do not retain live provider responses as fixtures.
