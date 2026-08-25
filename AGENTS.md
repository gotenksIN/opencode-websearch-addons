# Agent instructions

## Tooling

Use Bun for all repository operations.
Do not use `npm`, `npx`, or `bunx`.

- `bun test`: Run the test suite.
- `bun run typecheck`: Run TypeScript type checking.
- `bun run build`: Build the ESM distribution bundle.
- `bun run lint`: Run code linter checks.

Always maintain compatibility with the OpenCode V2 plugin API.

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

## Test contracts

- Test public provider execution paths with mocked `fetch` calls and mock integration contexts.
- Assert normalized `WebSearch.Result` output, endpoint routing, request headers, request payloads, stream parsing, error messages, and abort or timeout behavior.
- Test configuration validation through `parseConfig` defaults and exact error messages.
- Do not write tests that only verify symbol presence, command registrations, or type definitions.
- Let the TypeScript compiler enforce static type relationships.
- Run live smoke tests only with `LIVE=1` and real provider credentials.
