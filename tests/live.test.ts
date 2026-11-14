import { beforeAll, describe, expect, test } from "bun:test"
import { Schema } from "effect"
import type { Provider } from "@opencode/core/provider"
import { WebSearch } from "@opencode/core/websearch"
import { createHost } from "./host.js"

const timeoutMs = 60_000

const suiteBudgetMs = 2 * (timeoutMs + 5_000)

let settings: ReadonlyMap<string, Provider.Settings>

let deadline = 0

const credentials = Schema.Struct({
  baseURL: Schema.String.check(Schema.isMinLength(1)),
  apiKey: Schema.String.check(Schema.isMinLength(1)),
})

beforeAll(async () => {
  // OpenCode performs JSONC normalization and env/file substitution. All
  // writable paths and the database remain isolated; only config is read.
  const reader = await createHost(undefined, {}, undefined, true).catch(() => {
    throw new Error("Live E2E prerequisite: unable to resolve your OpenCode global provider configuration.")
  })

  try {
    settings = await reader.settings()

    for (const id of ["openai", "google"]) {
      const value = settings.get(id)

      if (!Schema.is(credentials)(value) || !value.baseURL.trim() || !value.apiKey.trim() || !URL.canParse(value.baseURL)) {
        throw new Error(`Live E2E prerequisite: configure ${id} settings.baseURL and settings.apiKey in your OpenCode global config.`)
      }
    }
  } finally {
    await reader.close()
  }

  deadline = Date.now() + suiteBudgetMs
}, 15_000)

describe("default live host E2E", () => {
  for (const provider of ["openai", "google"]) {
    test(`${provider} returns attributed web sources through the built-in tool`, async () => {
      if (Date.now() + timeoutMs > deadline) throw new Error("Live E2E suite budget exhausted")

      const host = await createHost(undefined, {
        timeoutMs,
        openai: { reasoningEffort: "low", searchContextSize: "low" },
        google: { thinkingLevel: "minimal" },
      }, settings)

      try {
        const result = await host.render(provider,
          "Search the web for the official Bun JavaScript runtime documentation. Return two source links and one short attributed sentence per source. Do not write a tutorial.")

        const output = Schema.decodeUnknownSync(Schema.Struct({
          provider: Schema.String,
          results: Schema.Array(WebSearch.Result),
        }))(result.output)

        expect(output.provider).toBe(provider)
        expect(output.results.length).toBeGreaterThan(0)
        expect(output.results.some((source) => source.content && source.content.length > 0)).toBe(true)

        for (const source of output.results) {
          expect(["http:", "https:"]).toContain(new URL(source.url).protocol)
          expect(result.content).toContain(source.url)

          if (source.time.published !== undefined) {
            expect(new Date(source.time.published).toISOString()).toBeString()
          }
        }
      } catch {
        // Assertions and upstream failures must not print live bodies,
        // gateway addresses, or credentials in the test runner.
        throw new Error(`Live ${provider} host E2E failed. Check gateway search support, credentials, model access, and the request budget.`)
      } finally {
        await host.close()
      }
    }, timeoutMs + 5_000)
  }
})
