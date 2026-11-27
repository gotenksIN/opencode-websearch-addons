import { describe, expect, test } from "bun:test";

import { WebSearch } from "@opencode/core/websearch";
import type { Plugin } from "@opencode/plugin/effect";
import { Cause, Exit } from "effect";

import { createHost } from "./test/host.test-utils.js";

const fixtureSecret = "fixture-secret-123456";

const fallbackKey = "fallback-placeholder-key";

const setupRejection = async (options: Plugin.Context["options"]) => {
  try {
    const host = await createHost(options);
    await host.close();
  } catch (error) {
    return error;
  }

  throw new Error("Expected plugin setup to reject");
};

const invalidOptions: [Plugin.Context["options"], string, string][] = [
  [{ openai: [] }, "openai", "an object"],
  [{ google: "" }, "google", "an object"],
  ...["", "x".repeat(101), 7].map(
    (model) =>
      [
        { openai: { model } },
        "openai.model",
        "a non-empty string of at most 100 characters",
      ] satisfies [Plugin.Context["options"], string, string]
  ),
  [
    { google: { model: false } },
    "google.model",
    "a non-empty string of at most 100 characters",
  ],
  ...["high", "xhigh", "max", 1].map(
    (reasoningEffort) =>
      [
        { openai: { reasoningEffort } },
        "openai.reasoningEffort",
        'one of "none", "minimal", "low", or "medium"',
      ] satisfies [Plugin.Context["options"], string, string]
  ),
  ...["high", false].map(
    (thinkingLevel) =>
      [
        { google: { thinkingLevel } },
        "google.thinkingLevel",
        'one of "minimal", "low", or "medium"',
      ] satisfies [Plugin.Context["options"], string, string]
  ),
  [
    { openai: { searchContextSize: "huge" } },
    "openai.searchContextSize",
    'one of "low", "medium", or "high"',
  ],
  [
    { google: { searchTimeRange: "today" } },
    "google.searchTimeRange",
    'one of "any", "lastDay", "lastWeek", "lastMonth", or "lastYear"',
  ],
  [
    { openai: { userLocation: "London" } },
    "openai.userLocation",
    "an object with optional string fields city, country, region, or timezone",
  ],
  [
    { openai: { userLocation: { zip: "" } } },
    "openai.userLocation.zip",
    "a key from city, country, region, timezone",
  ],
  [
    { openai: { userLocation: { city: 1 } } },
    "openai.userLocation.city",
    "a string",
  ],
  ...[99, 120_001, 1.5, "1000"].map(
    (timeoutMs) =>
      [
        { timeoutMs },
        "timeoutMs",
        "an integer from 100 through 120000",
      ] satisfies [Plugin.Context["options"], string, string]
  ),
];

describe("plugin setup through the real host", () => {
  test("registers both providers and removes them on dispose", async () => {
    const host = await createHost();

    try {
      const registered = await host.providers();
      expect(registered).toHaveLength(2);
      expect(registered).toContainEqual({
        id: WebSearch.ID.make("openai"),
        name: "OpenAI Web Search",
      });
      expect(registered).toContainEqual({
        id: WebSearch.ID.make("google"),
        name: "Gemini Google Search",
      });
      await host.disposePlugin();
      expect(await host.providers()).toEqual([]);
    } finally {
      await host.close();
    }
  });

  test.each(invalidOptions)(
    "setup rejects %p as invalid %s",
    async (options, name, expected) => {
      expect(await setupRejection(options)).toMatchObject({
        message: `Invalid plugin option ${name}; expected ${expected}.`,
      });
    }
  );
});

describe("fail-closed credential resolution", () => {
  test("missing connections without a fallback key reject both providers", async () => {
    const host = await createHost();

    try {
      await Array.fromAsync(["openai", "google"], async (provider) => {
        const failure = await host.failureCause(provider);
        expect(failure.message).toBe(
          `No active ${provider} connection. Connect the ${provider} integration in OpenCode first.`
        );
      });
    } finally {
      await host.close();
    }
  });

  test("unsupported credential types and OAuth methods reject before any request", async () => {
    const fallback = {
      apiKey: fallbackKey,
      baseURL: "https://provider.invalid",
    };

    const host = await createHost(
      {},
      new Map([
        ["openai", fallback],
        ["google", fallback],
      ])
    );

    try {
      await host.credential("openai", {
        type: "external",
        methodID: "external",
      });
      const external = await host.failureCause("openai");
      expect(external.message).toBe("Unsupported OpenAI credential type");

      await host.credential("openai", {
        type: "oauth",
        methodID: "unknown",
        access: fixtureSecret,
        refresh: "refresh",
        expires: Date.now() + 3_600_000,
      });
      const unknown = await host.failureCause("openai");
      expect(unknown.message).toStartWith("Unsupported OpenAI OAuth method");
      expect(unknown.message).not.toContain(fixtureSecret);

      await host.credential("google", {
        type: "oauth",
        methodID: "oauth",
        access: fixtureSecret,
        refresh: "refresh",
        expires: Date.now() + 3_600_000,
      });
      const google = await host.failureCause("google");
      expect(google.message).toBe(
        "Unsupported Google credential type; expected a key credential"
      );
    } finally {
      await host.close();
    }
  });
});

describe("cancellation", () => {
  test("a pre-aborted signal interrupts both providers", async () => {
    const host = await createHost();

    try {
      const controller = new AbortController();
      controller.abort();

      await Array.fromAsync(["openai", "google"], async (provider) => {
        const exit = await host.queryExit(provider, controller.signal);
        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(
          true
        );
      });
    } finally {
      await host.close();
    }
  });
});
