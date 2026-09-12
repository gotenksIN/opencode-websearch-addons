import { Plugin } from "@opencode/plugin"
import { parseConfig } from "./src/config.js"
import { searchGoogle } from "./src/google.js"
import { searchOpenAI } from "./src/openai.js"

export default Plugin.define({
  id: "opencode-websearch-addons",
  async setup(ctx) {
    const config = parseConfig(ctx.options)
    const registration = await ctx.websearch.transform((draft) => {
      draft.add({
        id: "openai",
        name: "OpenAI Web Search",
        execute: ({ query }, { signal }) => searchOpenAI(ctx, config.openai, config.timeoutMs, query, signal),
      })
      draft.add({
        id: "google",
        name: "Gemini Google Search",
        execute: ({ query }, { signal }) => searchGoogle(ctx, config.google, config.timeoutMs, query, signal),
      })
    })
    return () => registration.dispose()
  },
})
