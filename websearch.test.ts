import { afterEach, describe, expect, test, vi } from "bun:test"
import plugin from "./index.js"
import { defaultConfig, parseConfig } from "./src/config.js"
import type { PluginConfig } from "./src/config.js"
import { searchGoogle } from "./src/google.js"
import { normalizeGenerateContent, timeRangeFilterFor } from "./src/google.js"
import { normalizeOutput, searchOpenAI } from "./src/openai.js"
import { resolveCredential } from "./src/auth.js"

afterEach(() => {
  vi.restoreAllMocks()
})

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(
    (async (input: unknown, init?: RequestInit) => handler(typeof input === "string" ? input : String(input), init ?? {})) as never,
  )
}

function sseResponse(events: readonly string[]): Response {
  const body = events.map((event) => `data: ${event}\n`).join("")
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } })
}

function jsonResponse(body: unknown, status = 200, contentType = "application/json"): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": contentType } })
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>
}

function providerCtx(auth: { connection?: unknown; credential?: unknown }, settings?: Record<string, unknown>) {
  return {
    integration: {
      connection: {
        active: async () => auth.connection,
        resolve: async () => auth.credential,
      },
    },
    catalog: {
      provider: {
        get: async () => ({ data: { settings: settings ?? {} } }),
      },
    },
  }
}

const keyCredential = { type: "key", key: "sk-test-secret-key-123" } as const
const oauthCredential = {
  type: "oauth",
  methodID: "chatgpt-browser",
  refresh: "refresh-token",
  access: "access-token-456",
  expires: 4_000_000_000,
  metadata: { accountID: "acc-1001" },
} as const

const fullConfig: PluginConfig = {
  openai: {
    model: "gpt-custom-model",
    reasoningEffort: "high",
    searchContextSize: "high",
    userLocation: { city: "London", country: "GB" },
  },
  google: {
    model: "gemini-custom-model",
    thinkingLevel: "high",
    searchTimeRange: "lastWeek",
  },
  timeoutMs: 60_000,
}

async function openaiResults(config: PluginConfig, auth: unknown, query = "what is the weather") {
  return searchOpenAI(providerCtx({ connection: {}, credential: auth }) as never, config.openai, config.timeoutMs, query, new AbortController().signal)
}

async function googleResults(config: PluginConfig, auth: unknown, query = "what is the weather") {
  return searchGoogle(providerCtx({ connection: {}, credential: auth }) as never, config.google, config.timeoutMs, query, new AbortController().signal)
}

describe("registration", () => {
  test("registers exactly the openai and google providers with expected display names", async () => {
    const added: Array<{ id: string; name: string; execute: unknown }> = []
    const setDefault = vi.fn()
    const toolTransform = vi.fn()
    const ctx = {
      options: {},
      integration: { connection: { active: async () => undefined, resolve: async () => undefined } },
      websearch: {
        transform: async (callback: (draft: {
          add: (definition: { id: string; name: string; execute: unknown }) => void
          default: { set: () => void }
        }) => void) => {
          callback({
            add: (definition) => added.push(definition),
            default: { set: setDefault },
          })
          return { dispose: async () => undefined }
        },
      },
      tool: { transform: toolTransform },
    }
    const cleanup = await plugin.setup(ctx as never)
    expect(added.map((item) => [item.id, item.name])).toEqual([
      ["openai", "OpenAI Web Search"],
      ["google", "Gemini Google Search"],
    ])
    expect(setDefault).not.toHaveBeenCalled()
    expect(toolTransform).not.toHaveBeenCalled()
    expect(typeof cleanup).toBe("function")
    await (cleanup as () => Promise<void>)()
  })

  test("providers execute through the registered execute functions", async () => {
    const added: Array<{ id: string; name: string; execute: (input: { query: string }, context: { signal: AbortSignal }) => Promise<unknown> }> = []
    const ctx = {
      options: {},
      integration: {
        connection: {
          active: async () => ({ type: "credential", id: "cred_1" }),
          resolve: async () => keyCredential,
        },
      },
      websearch: {
        transform: async (callback: (draft: { add: (definition: unknown) => void }) => void) => {
          callback({ add: (definition) => added.push(definition as never) })
          return { dispose: async () => undefined }
        },
      },
    }
    const fetchSpy = mockFetch((_url, _init) => jsonResponse({ output: [] }))
    await plugin.setup(ctx as never)
    const openaiResult = await added[0]!.execute({ query: "hello" }, { signal: new AbortController().signal })
    const googleResult = await added[1]!.execute({ query: "hello" }, { signal: new AbortController().signal })
    expect(openaiResult).toEqual([])
    expect(googleResult).toEqual([])
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})

describe("options", () => {
  test("applies defaults when no options are supplied", () => {
    expect(parseConfig({})).toEqual(defaultConfig)
  })

  test("accepts configured model, reasoning, and provider-specific values", () => {
    const config = parseConfig({
      timeoutMs: 30_000,
      openai: {
        model: "gpt-5.6-luna",
        reasoningEffort: "max",
        searchContextSize: "high",
        userLocation: { city: "London", country: "GB", region: "England", timezone: "Europe/London" },
      },
      google: {
        model: "gemini-3.5-flash-lite",
        thinkingLevel: "low",
        searchTimeRange: "lastYear",
      },
    })
    expect(config.openai.reasoningEffort).toBe("max")
    expect(config.openai.searchContextSize).toBe("high")
    expect(config.openai.userLocation).toEqual({ city: "London", country: "GB", region: "England", timezone: "Europe/London" })
    expect(config.google.thinkingLevel).toBe("low")
    expect(config.google.searchTimeRange).toBe("lastYear")
    expect(config.timeoutMs).toBe(30_000)
  })

  test("rejects invalid option values with a precise message", () => {
    expect(() => parseConfig({ openai: { model: "" } })).toThrow(/Invalid plugin option openai\.model; expected a non-empty string of at most 100 characters/)
    expect(() => parseConfig({ openai: { model: "x".repeat(101) } })).toThrow(/Invalid plugin option openai\.model/)
    expect(() => parseConfig({ openai: { reasoningEffort: "turbo" } })).toThrow(/Invalid plugin option openai\.reasoningEffort/)
    expect(() => parseConfig({ openai: { searchContextSize: "ultra" } })).toThrow(/Invalid plugin option openai\.searchContextSize/)
    expect(() => parseConfig({ google: { model: 42 } })).toThrow(/Invalid plugin option google\.model/)
    expect(() => parseConfig({ google: { thinkingLevel: "extreme" } })).toThrow(/Invalid plugin option google\.thinkingLevel/)
    expect(() => parseConfig({ google: { searchTimeRange: "yesterday" } })).toThrow(/Invalid plugin option google\.searchTimeRange/)
    expect(() => parseConfig({ timeoutMs: 50 })).toThrow(/Invalid plugin option timeoutMs; expected an integer from 100 through 120000/)
    expect(() => parseConfig({ timeoutMs: 1.5 })).toThrow(/Invalid plugin option timeoutMs/)
    expect(() => parseConfig({ openai: "not-an-object" })).toThrow(/Invalid plugin option openai; expected an object/)
    expect(() => parseConfig({ google: [] })).toThrow(/Invalid plugin option google; expected an object/)
    expect(() => parseConfig({ openai: { userLocation: "London" } })).toThrow(/Invalid plugin option openai\.userLocation/)
    expect(() => parseConfig({ openai: { userLocation: { city: 7 } } })).toThrow(/Invalid plugin option openai\.userLocation\.city/)
    expect(() => parseConfig({ openai: { userLocation: { zip: "12345" } } })).toThrow(/Invalid plugin option openai\.userLocation\.zip/)
  })

  test("computes correct timeRangeFilter windows for each range choice", () => {
    const now = new Date("2026-08-09T12:34:56.789Z")
    const lastDay = timeRangeFilterFor("lastDay", now)
    expect(lastDay).toEqual({ startTime: "2026-08-08T12:34:56Z", endTime: "2026-08-09T12:34:56Z" })
    const lastWeek = timeRangeFilterFor("lastWeek", now)
    expect(lastWeek).toEqual({ startTime: "2026-08-02T12:34:56Z", endTime: "2026-08-09T12:34:56Z" })
    const lastMonth = timeRangeFilterFor("lastMonth", now)
    expect(lastMonth).toEqual({ startTime: "2026-07-09T12:34:56Z", endTime: "2026-08-09T12:34:56Z" })
    const lastYear = timeRangeFilterFor("lastYear", now)
    expect(lastYear).toEqual({ startTime: "2025-08-09T12:34:56Z", endTime: "2026-08-09T12:34:56Z" })
    expect(() => timeRangeFilterFor("any", now)).toThrow(/Invalid searchTimeRange any/)
  })

  test("omits timeRangeFilter for searchTimeRange any and user_location when not configured", async () => {
    const fetchSpy = mockFetch((_url, _init) => jsonResponse({ output: [] }))
    await openaiResults(defaultConfig, keyCredential)
    await googleResults(defaultConfig, keyCredential)
    const [openaiInit, googleInit] = fetchSpy.mock.calls.map((call) => call[1]) as RequestInit[]
    const openaiBody = bodyOf(openaiInit!)
    const tool = (openaiBody.tools as Record<string, unknown>[])[0]!
    expect(tool.user_location).toBeUndefined()
    expect(openaiBody.instructions).toBeUndefined()
    const googleBody = bodyOf(googleInit!)
    const googleTool = (googleBody.tools as Record<string, unknown>[])[0]!
    expect(googleTool.googleSearch).toEqual({})
  })
})

describe("authentication", () => {
  test("resolves the active connection for every execution with the right integration IDs", async () => {
    const active = vi.fn(async () => ({ type: "credential", id: "cred_1" }))
    const resolve = vi.fn(async () => keyCredential)
    mockFetch((_url, _init) => jsonResponse({ output: [] }))
    const ctx = { integration: { connection: { active, resolve } } }
    await searchOpenAI(ctx as never, defaultConfig.openai, defaultConfig.timeoutMs, "q", new AbortController().signal)
    await searchGoogle(ctx as never, defaultConfig.google, defaultConfig.timeoutMs, "q", new AbortController().signal)
    expect(active).toHaveBeenNthCalledWith(1, "openai")
    expect(active).toHaveBeenNthCalledWith(2, "google")
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  test("resolves both credential and env connection types without branching on connection type", async () => {
    const active = vi
      .fn()
      .mockResolvedValueOnce({ type: "credential", id: "cred_1", label: "API key" })
      .mockResolvedValueOnce({ type: "env", name: "OPENAI_API_KEY" })
    const resolve = vi.fn(async () => keyCredential)
    mockFetch((_url, _init) => jsonResponse({ output: [] }))
    const ctx = { integration: { connection: { active, resolve } } }
    await searchOpenAI(ctx as never, defaultConfig.openai, defaultConfig.timeoutMs, "q", new AbortController().signal)
    await searchOpenAI(ctx as never, defaultConfig.openai, defaultConfig.timeoutMs, "q", new AbortController().signal)
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(resolve).toHaveBeenCalledWith({ type: "credential", id: "cred_1", label: "API key" })
    expect(resolve).toHaveBeenCalledWith({ type: "env", name: "OPENAI_API_KEY" })
  })

  test("falls back to provider catalog settings when no active integration connection exists", async () => {
    const ctx = providerCtx({ connection: undefined, credential: undefined }, { apiKey: "catalog-api-key" })
    const credential = await resolveCredential(ctx as never, "google")
    expect(credential).toEqual({ type: "key", key: "catalog-api-key" })
  })

  test("throws a precise error when no active connection exists", async () => {
    const ctx = { integration: { connection: { active: async () => undefined, resolve: async () => undefined } } }
    await expect(resolveCredential(ctx as never, "openai")).rejects.toThrow(/No active openai connection/)
    await expect(resolveCredential(ctx as never, "google")).rejects.toThrow(/No active google connection/)
  })

  test("throws when credentials cannot be resolved or resolution fails", async () => {
    const unresolved = { integration: { connection: { active: async () => ({}), resolve: async () => undefined } } }
    await expect(resolveCredential(unresolved as never, "openai")).rejects.toThrow(/Unable to resolve openai credentials/)
    const failing = {
      integration: {
        connection: {
          active: async () => ({}),
          resolve: async () => {
            throw new Error("refresh failed")
          },
        },
      },
    }
    await expect(resolveCredential(failing as never, "google")).rejects.toThrow(/Unable to resolve google credentials/)
  })

  test("rejects unsupported credential types", async () => {
    const unsupported = { type: "ssh", key: "nope" }
    await expect(openaiResults(defaultConfig, unsupported)).rejects.toThrow(/Unsupported OpenAI credential type/)
    await expect(googleResults(defaultConfig, unsupported)).rejects.toThrow(/Unsupported Google credential type/)
    await expect(googleResults(defaultConfig, oauthCredential)).rejects.toThrow(/Unsupported Google credential type/)
  })

  test("never exposes credential values in errors", async () => {
    mockFetch((_url, _init) => jsonResponse({ error: { message: "provider says no" } }, 401))
    await expect(openaiResults(defaultConfig, keyCredential)).rejects.toThrow(
      /OpenAI web search failed \(HTTP 401\): provider says no/,
    )
    mockFetch((_url, _init) => jsonResponse({ error: { message: "provider says no" } }, 401))
    await expect(openaiResults(defaultConfig, keyCredential)).rejects.not.toThrow(/sk-test-secret-key-123/)
  })

  test("picks up a changed active connection on the next execution", async () => {
    let current: unknown = keyCredential
    const ctx = {
      integration: {
        connection: {
          active: async () => ({}),
          resolve: async () => current,
        },
      },
    }
    const fetchSpy = mockFetch((_url, _init) => jsonResponse({ output: [] }))
    await searchOpenAI(ctx as never, defaultConfig.openai, defaultConfig.timeoutMs, "q", new AbortController().signal)
    current = oauthCredential
    await searchOpenAI(ctx as never, defaultConfig.openai, defaultConfig.timeoutMs, "q", new AbortController().signal)
    const urls = fetchSpy.mock.calls.map((call) => String(call[0]))
    expect(urls).toEqual([
      "https://api.openai.com/v1/responses",
      "https://chatgpt.com/backend-api/codex/responses",
    ])
  })
})

describe("openai", () => {
  test("sends the configured model and web_search tool without an allowlist", async () => {
    const fetchSpy = mockFetch((_url, _init) => jsonResponse({ output: [] }))
    await openaiResults(fullConfig, keyCredential)
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(String(url)).toBe("https://api.openai.com/v1/responses")
    const body = bodyOf(init!)
    expect(body.model).toBe("gpt-custom-model")
    expect(body.store).toBe(false)
    expect(body.stream).toBe(true)
    expect(body.include).toContain("web_search_call.action.sources")
    const tool = (body.tools as Record<string, unknown>[])[0]!
    expect(tool.type).toBe("web_search")
    expect(tool.search_context_size).toBe("high")
    expect(tool.external_web_access).toBe(true)
    expect(tool.user_location).toEqual({ type: "approximate", city: "London", country: "GB" })
    expect(body.reasoning).toEqual({ effort: "high" })
  })

  test("uses the public endpoint with a Bearer key and no originator for key credentials", async () => {
    const fetchSpy = mockFetch((_url, _init) => jsonResponse({ output: [] }))
    await openaiResults(defaultConfig, keyCredential)
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(String(url)).toBe("https://api.openai.com/v1/responses")
    const headers = init!.headers as Record<string, string>
    expect(headers.Authorization).toBe("Bearer sk-test-secret-key-123")
    expect(headers.originator).toBeUndefined()
    expect(headers["chatgpt-account-id"]).toBeUndefined()
    const body = bodyOf(init!)
    expect(body.instructions).toBeUndefined()
  })

  test("uses the provider settings baseURL for key credentials when configured", async () => {
    const fetchSpy = mockFetch((_url, _init) => jsonResponse({ output: [] }))
    await searchOpenAI(
      providerCtx({ connection: {}, credential: keyCredential }, { baseURL: "https://example.com/openai/v1" }) as never,
      defaultConfig.openai,
      defaultConfig.timeoutMs,
      "q",
      new AbortController().signal,
    )
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("https://example.com/openai/v1/responses")
  })

  test("keeps the codex endpoint for OAuth even when a baseURL is configured", async () => {
    const fetchSpy = mockFetch((_url, _init) => jsonResponse({ output: [] }))
    await searchOpenAI(
      providerCtx({ connection: {}, credential: oauthCredential }, { baseURL: "https://example.com/openai/v1" }) as never,
      defaultConfig.openai,
      defaultConfig.timeoutMs,
      "q",
      new AbortController().signal,
    )
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("https://chatgpt.com/backend-api/codex/responses")
  })

  test("falls back to the official endpoint when provider settings are unavailable", async () => {
    const ctx = {
      integration: {
        connection: {
          active: async () => ({}),
          resolve: async () => keyCredential,
        },
      },
      catalog: {
        provider: {
          get: async () => {
            throw new Error("catalog unavailable")
          },
        },
      },
    }
    const fetchSpy = mockFetch((_url, _init) => jsonResponse({ output: [] }))
    await searchOpenAI(ctx as never, defaultConfig.openai, defaultConfig.timeoutMs, "q", new AbortController().signal)
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("https://api.openai.com/v1/responses")
  })

  test("uses the codex endpoint with originator and account headers for OAuth credentials", async () => {
    const fetchSpy = mockFetch((_url, _init) => jsonResponse({ output: [] }))
    await openaiResults(defaultConfig, oauthCredential)
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(String(url)).toBe("https://chatgpt.com/backend-api/codex/responses")
    const headers = init!.headers as Record<string, string>
    expect(headers.Authorization).toBe("Bearer access-token-456")
    expect(headers.originator).toBe("opencode")
    expect(headers["chatgpt-account-id"]).toBe("acc-1001")
    const body = bodyOf(init!)
    expect(body.instructions).toBeUndefined()
  })

  test("reads chatgpt-account-id from both accountID and accountId metadata keys", async () => {
    for (const key of ["accountID", "accountId"] as const) {
      const auth = { ...oauthCredential, metadata: { [key]: "acc-2002" } }
      const fetchSpy = mockFetch((_url, _init) => jsonResponse({ output: [] }))
      await openaiResults(defaultConfig, auth)
      const headers = fetchSpy.mock.calls[0]![1]!.headers as Record<string, string>
      expect(headers["chatgpt-account-id"]).toBe("acc-2002")
      vi.restoreAllMocks()
    }
  })

  test("normalizes annotations and action sources, deduplicates URLs and spans", async () => {
    const output = [
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Alpha system is interesting and Beta system is not.",
            annotations: [
              { type: "url_citation", start_index: 0, end_index: 5, url: "https://example.com/alpha", title: "Alpha Paper" },
              { type: "url_citation", start_index: 31, end_index: 35, url: "https://example.com/beta", title: "Beta Paper" },
              { type: "url_citation", start_index: 0, end_index: 5, url: "https://example.com/alpha", title: "Alpha Paper" },
              { type: "url_citation", start_index: 26, end_index: 31, url: "https://example.com/alpha", title: "Alpha Paper" },
            ],
          },
        ],
      },
      {
        type: "web_search_call",
        id: "ws_1",
        action: {
          sources: [
            { type: "url", url: "https://example.com/alpha", title: "Alpha Paper" },
            { type: "url", url: "https://example.com/gamma", title: "Gamma Doc" },
          ],
        },
      },
    ]
    const results = normalizeOutput(output)
    expect(results).toEqual([
      {
        url: "https://example.com/alpha",
        title: "Alpha Paper",
        content: "Alpha g and",
        time: {},
      },
      {
        url: "https://example.com/beta",
        title: "Beta Paper",
        content: " Bet",
        time: {},
      },
      {
        url: "https://example.com/gamma",
        title: "Gamma Doc",
        time: {},
      },
    ])
  })

  test("handles out-of-range annotation indices without throwing", () => {
    const output = [
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "short",
            annotations: [
              { type: "url_citation", start_index: -5, end_index: 999, url: "https://example.com/short", title: "Short" },
            ],
          },
        ],
      },
    ]
    const results = normalizeOutput(output)
    expect(results).toEqual([
      { url: "https://example.com/short", title: "Short", content: "short", time: {} },
    ])
  })

  test("returns [] for a valid response without sources", () => {
    expect(normalizeOutput([])).toEqual([])
    expect(normalizeOutput([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "no sources", annotations: [] }] }])).toEqual([])
  })

  test("rejects malformed and unsuccessful responses", async () => {
    mockFetch((_url, _init) => jsonResponse({ error: { message: "Invalid API key" } }, 401))
    await expect(openaiResults(defaultConfig, keyCredential)).rejects.toThrow(/OpenAI web search failed \(HTTP 401\): Invalid API key/)

    mockFetch((_url, _init) => jsonResponse("not json at all", 502, "text/plain"))
    await expect(openaiResults(defaultConfig, keyCredential)).rejects.toThrow(/OpenAI web search failed \(HTTP 502\)/)

    expect(() => normalizeOutput(null)).toThrow(/missing output/)
  })

  test("parses the SSE stream via output_item.done events", async () => {
    const events = [
      JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } }),
      JSON.stringify({
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "Alpha system is interesting and Beta system is not.",
              annotations: [
                { type: "url_citation", start_index: 0, end_index: 5, url: "https://example.com/alpha", title: "Alpha Paper" },
                { type: "url_citation", start_index: 31, end_index: 35, url: "https://example.com/beta", title: "Beta Paper" },
              ],
            },
          ],
        },
      }),
      JSON.stringify({
        type: "response.output_item.done",
        output_index: 1,
        item: {
          type: "web_search_call",
          id: "ws_1",
          action: { sources: [{ type: "url", url: "https://example.com/gamma", title: "Gamma Doc" }] },
        },
      }),
      JSON.stringify({ type: "response.completed", response: { id: "resp_1", output: [] } }),
      "[DONE]",
    ]
    mockFetch((_url, _init) => sseResponse(events))
    const results = await openaiResults(defaultConfig, keyCredential)
    expect(results.map((result) => result.url)).toEqual([
      "https://example.com/alpha",
      "https://example.com/beta",
      "https://example.com/gamma",
    ])
    expect(results[0]!.content).toBe("Alpha")
  })

  test("falls back to the completed event output when no output_item.done events arrive", async () => {
    const events = [
      JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_1",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "Alpha system is interesting.",
                  annotations: [{ type: "url_citation", start_index: 0, end_index: 5, url: "https://example.com/alpha", title: "Alpha" }],
                },
              ],
            },
          ],
        },
      }),
    ]
    mockFetch((_url, _init) => sseResponse(events))
    const results = await openaiResults(defaultConfig, keyCredential)
    expect(results).toEqual([{ url: "https://example.com/alpha", title: "Alpha", content: "Alpha", time: {} }])
  })

  test("accepts a non-SSE JSON response as a fallback", async () => {
    mockFetch((_url, _init) =>
      jsonResponse({
        id: "resp_1",
        output: [
          {
            type: "web_search_call",
            id: "ws_1",
            action: { sources: [{ type: "url", url: "https://example.com/alpha", title: "Alpha" }] },
          },
        ],
      }),
    )
    const results = await openaiResults(defaultConfig, keyCredential)
    expect(results).toEqual([{ url: "https://example.com/alpha", title: "Alpha", time: {} }])
  })

  test("throws on a failed SSE event", async () => {
    const events = [
      JSON.stringify({ type: "response.failed", response: { error: { message: "server exploded" } } }),
    ]
    mockFetch((_url, _init) => sseResponse(events))
    await expect(openaiResults(defaultConfig, keyCredential)).rejects.toThrow(/OpenAI web search failed: server exploded/)
  })

  test("throws on malformed stream events", async () => {
    mockFetch((_url, _init) => sseResponse(["this is not json"]))
    await expect(openaiResults(defaultConfig, keyCredential)).rejects.toThrow(/malformed stream event/)
  })
})

describe("gemini", () => {
  test("sends the configured model, googleSearch tool, and uppercase thinking level", async () => {
    const fetchSpy = mockFetch((_url, _init) => sseResponse([JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] })]))
    await googleResults(fullConfig, keyCredential)
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(String(url)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-custom-model:streamGenerateContent?alt=sse",
    )
    const headers = init!.headers as Record<string, string>
    expect(headers["x-goog-api-key"]).toBe("sk-test-secret-key-123")
    const body = bodyOf(init!)
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "what is the weather" }] }])
    const tool = (body.tools as Record<string, unknown>[])[0]!
    expect(tool.googleSearch).toBeDefined()
    const timeRange = (tool.googleSearch as Record<string, unknown>).timeRangeFilter as Record<string, unknown>
    expect(typeof timeRange.startTime).toBe("string")
    expect(typeof timeRange.endTime).toBe("string")
    expect(timeRange.startTime).toMatch(/Z$/)
    expect((body.generationConfig as Record<string, unknown>).thinkingConfig).toEqual({ thinkingLevel: "HIGH" })
  })

  test("uses the provider settings baseURL for Gemini when configured", async () => {
    const fetchSpy = mockFetch((_url, _init) => sseResponse([JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] })]))
    await searchGoogle(
      providerCtx({ connection: {}, credential: keyCredential }, { baseURL: "https://example.com/google/v1beta" }) as never,
      defaultConfig.google,
      defaultConfig.timeoutMs,
      "q",
      new AbortController().signal,
    )
    expect(String(fetchSpy.mock.calls[0]![0])).toBe(
      "https://example.com/google/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse",
    )
  })

  test("maps every thinking level to its uppercase wire enum", async () => {
    const levels: Array<[string, string]> = [
      ["minimal", "MINIMAL"],
      ["low", "LOW"],
      ["medium", "MEDIUM"],
      ["high", "HIGH"],
    ]
    for (const [option, wire] of levels) {
      const fetchSpy = mockFetch((_url, _init) => sseResponse([JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] })]))
      const config = { ...defaultConfig, google: { ...defaultConfig.google, thinkingLevel: option as never } }
      await googleResults(config, keyCredential)
      const body = bodyOf(fetchSpy.mock.calls[0]![1]!)
      expect((body.generationConfig as Record<string, unknown>).thinkingConfig).toEqual({ thinkingLevel: wire })
      vi.restoreAllMocks()
    }
  })

  test("omits timeRangeFilter for searchTimeRange any", async () => {
    const fetchSpy = mockFetch((_url, _init) => sseResponse([JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] })]))
    await googleResults(defaultConfig, keyCredential)
    const body = bodyOf(fetchSpy.mock.calls[0]![1]!)
    const tool = (body.tools as Record<string, unknown>[])[0]!
    expect(tool.googleSearch).toEqual({})
  })

  test("extracts URIs and titles from grounding chunks and aggregates supported segments", () => {
    const merged = {
      parts: ["Alpha facts are here and Beta details too."],
      finishReason: "STOP",
      grounding: {
        groundingChunks: [
          { web: { uri: "https://example.com/alpha", title: "Alpha Facts" } },
          { web: { uri: "https://example.com/beta", title: "Beta Details" } },
          { web: { uri: "https://example.com/gamma", title: "Gamma Uncited" } },
        ],
        groundingSupports: [
          { segment: { startIndex: 0, endIndex: 10 }, groundingChunkIndices: [0] },
          { segment: { startIndex: 21, endIndex: 34 }, groundingChunkIndices: [1, 0] },
        ],
      },
    }
    const results = normalizeGenerateContent(merged as never)
    expect(results).toEqual([
      {
        url: "https://example.com/alpha",
        title: "Alpha Facts",
        content: "Alpha fact and Beta deta",
        time: {},
      },
      {
        url: "https://example.com/beta",
        title: "Beta Details",
        content: "and Beta deta",
        time: {},
      },
      {
        url: "https://example.com/gamma",
        title: "Gamma Uncited",
        time: {},
      },
    ])
  })

  test("merges text and grounding across streamed chunks", async () => {
    const chunk1 = { candidates: [{ content: { parts: [{ text: "Alpha facts are here" }] } }] }
    const chunk2 = {
      candidates: [
        {
          content: { parts: [{ text: " and Beta details too." }] },
          finishReason: "STOP",
          groundingMetadata: {
            groundingChunks: [{ web: { uri: "https://example.com/alpha", title: "Alpha Facts" } }],
            groundingSupports: [{ segment: { startIndex: 0, endIndex: 10 }, groundingChunkIndices: [0] }],
          },
        },
      ],
    }
    mockFetch((_url, _init) => sseResponse([JSON.stringify(chunk1), JSON.stringify(chunk2)]))
    const results = await googleResults(defaultConfig, keyCredential)
    expect(results).toEqual([
      { url: "https://example.com/alpha", title: "Alpha Facts", content: "Alpha fact", time: {} },
    ])
  })

  test("deduplicates repeated URLs across chunks preserving grounding order", () => {
    const merged = {
      parts: ["one two"],
      finishReason: "STOP",
      grounding: {
        groundingChunks: [
          { web: { uri: "https://example.com/a", title: "A" } },
          { web: { uri: "https://example.com/a", title: "A again" } },
          { web: { uri: "https://example.com/b", title: "B" } },
        ],
        groundingSupports: [
          { segment: { startIndex: 0, endIndex: 3 }, groundingChunkIndices: [0] },
          { segment: { startIndex: 0, endIndex: 3 }, groundingChunkIndices: [1] },
          { segment: { startIndex: 4, endIndex: 7 }, groundingChunkIndices: [2] },
        ],
      },
    }
    const results = normalizeGenerateContent(merged as never)
    expect(results.map((result) => result.url)).toEqual(["https://example.com/a", "https://example.com/b"])
    expect(results[0]!.content).toBe("one")
    expect(results[0]!.title).toBe("A")
  })

  test("returns [] for a valid response without grounded web sources", async () => {
    const results = normalizeGenerateContent({ parts: ["nothing grounded"], finishReason: "STOP" })
    expect(results).toEqual([])
  })

  test("rejects blocked, malformed, and unsuccessful responses", async () => {
    const blocked = {
      candidates: [{ content: { parts: [{ text: "nope" }] }, finishReason: "BLOCKED" }],
    }
    mockFetch((_url, _init) => sseResponse([JSON.stringify(blocked)]))
    await expect(googleResults(defaultConfig, keyCredential)).rejects.toThrow(/blocked by the provider/)

    mockFetch((_url, _init) => jsonResponse({ error: { message: "API key not valid" } }, 400))
    await expect(googleResults(defaultConfig, keyCredential)).rejects.toThrow(/Gemini web search failed \(HTTP 400\): API key not valid/)

    mockFetch((_url, _init) => sseResponse([JSON.stringify({ error: { message: "stream exploded" } })]))
    await expect(googleResults(defaultConfig, keyCredential)).rejects.toThrow(/Gemini web search failed: stream exploded/)
  })
})

describe("runtime contract", () => {
  test("every result contains url and time and no unsupported fields", async () => {
    const output = [
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Alpha system is interesting.",
            annotations: [{ type: "url_citation", start_index: 0, end_index: 5, url: "https://example.com/alpha", title: "Alpha" }],
          },
        ],
      },
    ]
    mockFetch((_url, _init) => jsonResponse({ output }))
    const results = await openaiResults(defaultConfig, keyCredential)
    expect(results.length).toBeGreaterThan(0)
    for (const result of results) {
      expect(typeof result.url).toBe("string")
      expect(result.time).toBeDefined()
      expect(Object.keys(result).sort()).toEqual(["content", "time", "title", "url"].sort())
    }
  })

  test("OpenCode's abort signal reaches fetch and cancels in-flight requests", async () => {
    const controller = new AbortController()
    mockFetch((_url, init) => {
      const signal = init.signal as AbortSignal
      if (signal.aborted) return Promise.reject(signal.reason)
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason))
      })
    })
    const request = searchOpenAI(
      providerCtx({ connection: {}, credential: keyCredential }) as never,
      defaultConfig.openai,
      defaultConfig.timeoutMs,
      "q",
      controller.signal,
    )
    const reason = new Error("cancelled by opencode")
    controller.abort(reason)
    await expect(request).rejects.toThrow("cancelled by opencode")
  })

  test("timeout cancellation aborts the fetch signal", async () => {
    mockFetch((_url, init) => {
      const signal = init.signal as AbortSignal
      if (signal.aborted) return Promise.reject(signal.reason)
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason))
      })
    })
    const started = Date.now()
    await expect(
      searchOpenAI(
        providerCtx({ connection: {}, credential: keyCredential }) as never,
        defaultConfig.openai,
        100,
        "q",
        new AbortController().signal,
      ),
    ).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(5000)
  })

  test("provider failures reject rather than being swallowed", async () => {
    mockFetch((_url, _init) => jsonResponse({ error: { message: "boom" } }, 500))
    await expect(openaiResults(defaultConfig, keyCredential)).rejects.toThrow(/OpenAI web search failed \(HTTP 500\): boom/)
    mockFetch((_url, _init) => jsonResponse({ error: { message: "boom" } }, 500))
    await expect(googleResults(defaultConfig, keyCredential)).rejects.toThrow(/Gemini web search failed \(HTTP 500\): boom/)
  })

  test("valid no-source responses return []", async () => {
    mockFetch((_url, _init) => jsonResponse({ output: [] }))
    expect(await openaiResults(defaultConfig, keyCredential)).toEqual([])
    mockFetch((_url, _init) => sseResponse([JSON.stringify({ candidates: [{ content: { parts: [{ text: "no sources" }] }, finishReason: "STOP" }] })]))
    expect(await googleResults(defaultConfig, keyCredential)).toEqual([])
  })
})
