import { HttpClientError } from "effect/http";

import { createHost } from "./host.js";

// Run in a subprocess so the test CA and HTTPS proxy cannot affect other
// tests or live credentials. The production endpoint remains unchanged.
const [methodID] = process.argv.slice(2);

if (methodID !== "chatgpt-browser" && methodID !== "chatgpt-headless") {
  throw new Error("Expected a supported legacy fixture method");
}

const host = await createHost("http://127.0.0.1:1/must-not-use", {
  timeoutMs: 3000,
});

try {
  await host.credential("openai", {
    type: "oauth",
    methodID,
    access: "legacy-fixture-access",
    refresh: "legacy-fixture-refresh",
    expires: Date.now() + 3_600_000,
    metadata:
      methodID === "chatgpt-browser" ? { accountID: "fixture-account" } : {},
  });
  const cause = await host.failureCause("openai");

  if (
    !HttpClientError.isHttpClientError(cause) ||
    cause.response?.status !== 401 ||
    !cause.message.includes("[REDACTED]") ||
    Bun.inspect(cause).includes("legacy-fixture-access")
  ) {
    throw new Error(
      "Legacy route did not produce the expected sanitized HTTP failure"
    );
  }

  console.log("legacy-ok");
} finally {
  await host.close();
}
