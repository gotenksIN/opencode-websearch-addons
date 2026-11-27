import { beforeAll, describe, expect, test } from "bun:test";

import type { Provider } from "@opencode/core/provider";
import { WebSearch } from "@opencode/core/websearch";
import type { Plugin } from "@opencode/plugin/effect";
import { Schema } from "effect";

import { createHost } from "./host.test-utils.js";

// The plugin default `timeoutMs` is 120 000 ms.
const defaultTimeoutMs = 120_000;

const configuredTimeoutMs = 60_000;

const testTimeout = (timeoutMs: number) => timeoutMs + 5000;

// Two default-option requests and four configured or ungrounded requests.
const suiteBudgetMs =
  2 * testTimeout(defaultTimeoutMs) + 4 * testTimeout(configuredTimeoutMs);

const configured = {
  timeoutMs: configuredTimeoutMs,
  openai: { reasoningEffort: "low", searchContextSize: "low" },
  google: { thinkingLevel: "minimal", searchTimeRange: "lastYear" },
};

const searchQuery =
  "Use web search to find the latest stable Bun JavaScript runtime release and its release date. Answer in two short sentences and cite the official Bun blog and the GitHub release page inline.";

const ungroundedQuery =
  "What is 2 + 2? Answer with the number only. Do not search the web and do not cite sources.";

const Output = Schema.Array(
  Schema.Struct({
    url: WebSearch.Result.fields.url,
    title: WebSearch.Result.fields.title,
    published: WebSearch.Result.fields.time.fields.published,
    content: WebSearch.Result.fields.content,
  })
);

const Metadata = Schema.Struct({ provider: Schema.String });

// Content that is only a citation link carries no generated claim.
const bareLink = /^\(?\[[^\]\r\n]*\]\(https?:\/\/[^\s)\r\n]+\)\)?$/u;

const credentials = Schema.Struct({
  baseURL: Schema.String.check(Schema.isMinLength(1)),
  apiKey: Schema.String.check(Schema.isMinLength(1)),
});

let settings: ReadonlyMap<string, Provider.Settings>;

let deadline = 0;

beforeAll(async () => {
  // OpenCode performs JSONC normalization and env/file substitution. All
  // writable paths and the database remain isolated; only config is read.
  const reader = await createHost({}, undefined, true).catch(() => {
    throw new Error(
      "Live E2E prerequisite: unable to resolve your OpenCode global provider configuration."
    );
  });

  try {
    settings = await reader.settings();

    for (const id of ["openai", "google"]) {
      const value = settings.get(id);

      if (
        !Schema.is(credentials)(value) ||
        !value.baseURL.trim() ||
        !value.apiKey.trim() ||
        !URL.canParse(value.baseURL)
      ) {
        throw new Error(
          `Live E2E prerequisite: configure ${id} settings.baseURL and settings.apiKey in your OpenCode global config.`
        );
      }
    }
  } finally {
    await reader.close();
  }

  deadline = Date.now() + suiteBudgetMs;
}, 15_000);

const live = async (
  provider: string,
  options: Plugin.Context["options"],
  timeoutMs: number,
  query: string,
  verify: (result: {
    readonly output: typeof Output.Type;
    readonly content: string;
  }) => void
) => {
  if (Date.now() + timeoutMs > deadline) {
    throw new Error("Live E2E suite budget exhausted");
  }

  let host: Awaited<ReturnType<typeof createHost>> | undefined;
  let failure: Error | undefined;

  try {
    host = await createHost(options, settings);
    const result = await host.render(provider, query);
    const metadata = Schema.decodeUnknownSync(Metadata)(result.metadata);
    expect(metadata.provider).toBe(provider);
    verify({
      output: Schema.decodeUnknownSync(Output)(result.output),
      content: Schema.decodeUnknownSync(Schema.String)(result.content),
    });
  } catch {
    // Setup, assertion, and upstream failures must not print live bodies,
    // gateway addresses, or credentials in the test runner.
    failure = new Error(
      `Live ${provider} host E2E failed. Check gateway search support, credentials, model access, and the request budget.`
    );
  }

  try {
    await host?.close();
  } catch {
    // Keep an earlier redacted failure; never expose raw cleanup errors.
    failure ??= new Error(`Live ${provider} host cleanup failed.`);
  }

  if (failure) {
    throw failure;
  }
};

const expectAttributedSources = ({
  output,
  content,
}: {
  readonly output: typeof Output.Type;
  readonly content: string;
}) => {
  expect(output.length).toBeGreaterThan(0);
  expect(
    output.some(
      (source) =>
        source.content !== undefined &&
        source.content.trim().length > 0 &&
        !bareLink.test(source.content.trim())
    )
  ).toBe(true);

  for (const source of output) {
    expect(["http:", "https:"]).toContain(new URL(source.url).protocol);
    expect(content).toContain(source.url);

    if (source.published !== undefined) {
      expect(new Date(source.published).toISOString()).toBeString();
    }
  }
};

describe("live host E2E", () => {
  test.each(["openai", "google"])(
    "%s returns attributed web sources with default options",
    async (provider) => {
      await live(
        provider,
        {},
        defaultTimeoutMs,
        searchQuery,
        expectAttributedSources
      );
    },
    testTimeout(defaultTimeoutMs)
  );

  test.each(["openai", "google"])(
    "%s returns attributed web sources with configured options",
    async (provider) => {
      await live(
        provider,
        configured,
        configuredTimeoutMs,
        searchQuery,
        expectAttributedSources
      );
    },
    testTimeout(configuredTimeoutMs)
  );

  test.each(["openai", "google"])(
    "%s returns no results for a prompt without web search",
    async (provider) => {
      await live(
        provider,
        configured,
        configuredTimeoutMs,
        ungroundedQuery,
        ({ output, content }) => {
          expect(output).toEqual([]);
          expect(content).toBe(
            "No search results found. Please try a different query."
          );
        }
      );
    },
    testTimeout(configuredTimeoutMs)
  );
});
