import { describe, expect, test } from "bun:test"
import { defaultConfig } from "../src/config.js"
import { searchGoogle } from "../src/google.js"
import { searchOpenAI } from "../src/openai.js"

const live = process.env.LIVE === "1"

const openAIKey = process.env.OPENAI_API_KEY

const chatGPTAccess = process.env.CHATGPT_ACCESS_TOKEN

const chatGPTAccountID = process.env.CHATGPT_ACCOUNT_ID

const googleKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY

interface OAuthCredential {
  readonly type: "oauth"
  readonly methodID: string
  readonly refresh: string
  readonly access: string | undefined
  readonly expires: number
  metadata?: { accountID: string }
}

function liveContext<T>(credential: T) {
  return {
    integration: {
      connection: {
        active: async () => ({ type: "credential", id: "live" }),
        resolve: async () => credential,
      },
    },
  }
}

describe("live smoke tests", () => {
  test.skipIf(!live || !openAIKey)("OpenAI API key path returns normalized results", async () => {
    const results = await searchOpenAI(
      // SAFETY: liveContext supplies only the connection surface searchOpenAI uses; as never omits the unused IntegrationDomain members.
      liveContext({ type: "key", key: openAIKey }) as never,
      defaultConfig.openai,
      defaultConfig.timeoutMs,
      "OpenCode AI CLI latest release",
      new AbortController().signal,
    )

    expect(results.length).toBeGreaterThan(0)

    for (const result of results) {
      expect(result.url).toBeTypeOf("string")
      expect(result.url.startsWith("http")).toBe(true)
      expect(result.time).toBeDefined()
    }
  })

  test.skipIf(!live || !chatGPTAccess)("OpenAI ChatGPT OAuth path returns normalized results", async () => {
    const credential: OAuthCredential = {
      type: "oauth",
      methodID: "chatgpt-browser",
      refresh: "live-refresh",
      access: chatGPTAccess,
      expires: 4_000_000_000,
    }

    if (chatGPTAccountID) {
      credential.metadata = { accountID: chatGPTAccountID }
    }

    const results = await searchOpenAI(
      // SAFETY: liveContext supplies only the connection surface searchOpenAI uses; as never omits the unused IntegrationDomain members.
      liveContext(credential) as never,
      defaultConfig.openai,
      defaultConfig.timeoutMs,
      "OpenCode AI CLI latest release",
      new AbortController().signal,
    )

    expect(results.length).toBeGreaterThan(0)

    for (const result of results) {
      expect(result.url).toBeTypeOf("string")
      expect(result.time).toBeDefined()
    }
  })

  test.skipIf(!live || !googleKey)("Gemini key path returns normalized results", async () => {
    const results = await searchGoogle(
      // SAFETY: liveContext supplies only the connection surface searchGoogle uses; as never omits the unused IntegrationDomain members.
      liveContext({ type: "key", key: googleKey }) as never,
      defaultConfig.google,
      defaultConfig.timeoutMs,
      "OpenCode AI CLI latest release",
      new AbortController().signal,
    )

    expect(results.length).toBeGreaterThan(0)

    for (const result of results) {
      expect(result.url).toBeTypeOf("string")
      expect(result.url.startsWith("http")).toBe(true)
      expect(result.time).toBeDefined()
    }
  })
})
