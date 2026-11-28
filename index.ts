import { Plugin } from "@opencode/plugin/effect";
import { Effect } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";

import { parseConfig } from "./src/config.js";
import { searchGoogle } from "./src/google.js";
import { searchOpenAI } from "./src/openai.js";

export default Plugin.define({
  id: "opencode-websearch-addons",
  effect: Effect.fnUntraced(function* setup(ctx) {
    const config = yield* Effect.sync(() => parseConfig(ctx.options));

    const client = yield* HttpClient.HttpClient.pipe(
      Effect.provide(FetchHttpClient.layer)
    );

    yield* ctx.websearch.transform((draft) => {
      draft.add({
        id: "openai",
        name: "OpenAI Web Search",
        execute: ({ query }) =>
          searchOpenAI(ctx, client, config.openai, config.timeoutMs, query),
      });
      draft.add({
        id: "google",
        name: "Gemini Google Search",
        execute: ({ query }) =>
          searchGoogle(ctx, client, config.google, config.timeoutMs, query),
      });
    });
  }),
});
