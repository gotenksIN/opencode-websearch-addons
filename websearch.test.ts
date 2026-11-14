import { describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { connect } from "node:net"
import { join } from "node:path"
import { Cause, Exit, Schema } from "effect"
import { HttpClientError } from "effect/http"
import { WebSearch } from "@opencode/core/websearch"
import { createHost } from "./tests/host.js"
import { barrier, cleanup, serve, sse } from "./tests/transport.js"

const fakeKey = "fixture-secret-123456"

const empty = () => Response.json({ output: [], candidates: [{ finishReason: "STOP" }] })

describe("host setup and wire options", () => {
  test("defaults execute both providers through the real host and dispose registrations", async () => {
    const requests: { path: string; body: object; accept: string | null }[] = []

    const origin = serve(async (request) => {
      requests.push({
        path: new URL(request.url).pathname,
        body: Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(await request.json()),
        accept: request.headers.get("accept"),
      })

      return empty()
    })

    const host = await createHost(origin)
    cleanup(host.close)
    expect((await host.query("openai")).results).toEqual([])
    expect((await host.query("google")).results).toEqual([])
    expect(requests).toEqual([
      {
        path: "/responses",
        accept: "text/event-stream",
        body: {
          model: "gpt-6-luna",
          input: [{ role: "user", content: [{ type: "input_text", text: "fixture query" }] }],
          tools: [{ type: "web_search", search_context_size: "medium", external_web_access: true }],
          reasoning: { effort: "medium" },
          include: ["web_search_call.action.sources"],
          store: false,
          stream: true,
        },
      },
      {
        path: "/models/gemini-3.5-flash-lite:streamGenerateContent",
        accept: "text/event-stream",
        body: {
          contents: [{ role: "user", parts: [{ text: "fixture query" }] }],
          tools: [{ googleSearch: {} }],
          generationConfig: { thinkingConfig: { thinkingLevel: "MEDIUM" } },
        },
      },
    ])
    await host.disposePlugin()
    await expect(host.query("openai")).rejects.toThrow()
  })

  test("valid overrides reach provider payloads with bounded calendar filters", async () => {
    const bodies: object[] = []

    const origin = serve(async (request) => {
      bodies.push(Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(await request.json()))
      expect(request.url).toMatch(/\/responses$|\/models\/gemini-custom:streamGenerateContent\?alt=sse$/)

      return empty()
    })

    for (const [effort, thinking, range, size] of [
      ["none", "minimal", "lastDay", "low"],
      ["minimal", "low", "lastWeek", "high"],
      ["low", "medium", "lastMonth", "medium"],
      ["medium", "minimal", "lastYear", "low"],
    ] as const) {
      const host = await createHost(origin, {
        timeoutMs: 1000,
        openai: {
          model: "openai-custom",
          reasoningEffort: effort,
          searchContextSize: size,
          userLocation: { city: "London", country: "GB", region: "", timezone: "Europe/London" },
        },
        google: { model: "gemini-custom", thinkingLevel: thinking, searchTimeRange: range },
      })

      cleanup(host.close)
      await host.query("openai")
      await host.query("google")
      expect(bodies.at(-2)).toMatchObject({
        model: "openai-custom",
        reasoning: { effort },
        tools: [{
          search_context_size: size,
          user_location: { type: "approximate", city: "London", country: "GB", timezone: "Europe/London" },
        }],
      })

      const googleBody = Schema.decodeUnknownSync(Schema.Struct({
        tools: Schema.Array(Schema.Struct({
          googleSearch: Schema.Struct({
            timeRangeFilter: Schema.Struct({ startTime: Schema.String, endTime: Schema.String }),
          }),
        })),
        generationConfig: Schema.Struct({ thinkingConfig: Schema.Struct({ thinkingLevel: Schema.String }) }),
      }))(bodies.at(-1))

      const filter = googleBody.tools[0]?.googleSearch.timeRangeFilter
      expect(filter?.startTime).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
      expect(filter?.endTime).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
      expect(Date.parse(filter?.startTime ?? "")).toBeLessThan(Date.parse(filter?.endTime ?? ""))
      expect(googleBody.generationConfig.thinkingConfig.thinkingLevel).toBe(thinking?.toUpperCase())
    }
  })

  test("setup rejects invalid option equivalence classes with exact messages", async () => {
    const cases: [object, string, string][] = [
      [{ openai: [] }, "openai", "an object"],
      [{ google: "" }, "google", "an object"],
      ...["", "x".repeat(101), 7].map((model): [object, string, string] =>
        [{ openai: { model } }, "openai.model", "a non-empty string of at most 100 characters"]),
      [{ google: { model: false } }, "google.model", "a non-empty string of at most 100 characters"],
      ...["high", "xhigh", "max", 1].map((reasoningEffort): [object, string, string] =>
        [{ openai: { reasoningEffort } }, "openai.reasoningEffort", 'one of "none", "minimal", "low", or "medium"']),
      ...["high", false].map((thinkingLevel): [object, string, string] =>
        [{ google: { thinkingLevel } }, "google.thinkingLevel", 'one of "minimal", "low", or "medium"']),
      [{ openai: { searchContextSize: "huge" } }, "openai.searchContextSize", 'one of "low", "medium", or "high"'],
      [{ google: { searchTimeRange: "today" } }, "google.searchTimeRange", 'one of "any", "lastDay", "lastWeek", "lastMonth", or "lastYear"'],
      [{ openai: { userLocation: "London" } }, "openai.userLocation", "an object with optional string fields city, country, region, or timezone"],
      [{ openai: { userLocation: { zip: "" } } }, "openai.userLocation.zip", "a key from city, country, region, timezone"],
      [{ openai: { userLocation: { city: 1 } } }, "openai.userLocation.city", "a string"],
      ...[99, 120001, 1.5, "1000"].map((timeoutMs): [object, string, string] =>
        [{ timeoutMs }, "timeoutMs", "an integer from 100 through 120000"]),
    ]

    for (const [options, name, expected] of cases) {
      await expect(createHost(undefined, options)).rejects.toMatchObject({
        message: `Invalid plugin option ${name}; expected ${expected}.`,
      })
    }
  }, 30_000)
})

describe("host credential resolution", () => {
  test("legacy Codex methods keep their fixed origin and legacy-only headers", async () => {
    // A trusted test CA and CONNECT proxy run only in fixture subprocesses.
    // No production endpoint override, global fetch patch, or TLS bypass.
    const cache = join(import.meta.dir, ".cache")
    mkdirSync(cache, { recursive: true })
    const directory = mkdtempSync(join(cache, "legacy-tls-"))
    cleanup(() => rmSync(directory, { recursive: true, force: true }))
    const key = join(directory, "key.pem")
    const cert = join(directory, "cert.pem")

    const certificate = Bun.spawnSync([
      "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=chatgpt.com",
      "-addext", "subjectAltName=DNS:chatgpt.com",
    ], { stdout: "pipe", stderr: "pipe" })

    expect(certificate.exitCode).toBe(0)
    const received: { path: string; authorization: string | null; originator: string | null; account: string | null }[] = []

    const upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      tls: { key: Bun.file(key), cert: Bun.file(cert) },
      fetch(request) {
        received.push({
          path: new URL(request.url).pathname,
          authorization: request.headers.get("authorization"),
          originator: request.headers.get("originator"),
          account: request.headers.get("chatgpt-account-id"),
        })

        return Response.json({ error: { message: "echo legacy-fixture-access" } }, { status: 401 })
      },
    })

    cleanup(() => upstream.stop(true))
    const destinations: (string | undefined)[] = []
    const proxy = createServer()
    proxy.on("connect", (request, client, head) => {
      destinations.push(request.url)

      const socket = connect(Number(upstream.port), "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
        socket.write(head)
        client.pipe(socket)
        socket.pipe(client)
      })

      socket.on("error", () => client.destroy())
      client.on("error", () => socket.destroy())
      client.on("close", () => socket.destroy())
      socket.on("close", () => client.destroy())
    })
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
    cleanup(() => { proxy.closeAllConnections(); proxy.close() })
    const address = proxy.address()

    if (!address || Object.prototype.toString.call(address) === "[object String]") {
      throw new Error("Expected loopback proxy address")
    }

    // SAFETY: listen uses an IP host, so address is an AddressInfo, not a pipe path.
    const proxyPort = (address as import("node:net").AddressInfo).port

    for (const method of ["chatgpt-browser", "chatgpt-headless"]) {
      const child = Bun.spawn([process.execPath, "tests/legacy-runner.ts", method], {
        cwd: import.meta.dir,
        env: {
          ...process.env,
          HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
          https_proxy: `http://127.0.0.1:${proxyPort}`,
          NO_PROXY: "", no_proxy: "",
          NODE_EXTRA_CA_CERTS: cert,
        },
        stdout: "pipe", stderr: "pipe",
      })

      cleanup(() => { child.kill() })

      const [status, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])

      expect({ status, stdout: stdout.trim(), stderr: stderr.trim() }).toEqual({
        status: 0, stdout: "legacy-ok", stderr: "",
      })
    }

    expect(destinations).toEqual(["chatgpt.com:443", "chatgpt.com:443"])
    expect(received).toEqual([
      { path: "/backend-api/codex/responses", authorization: "Bearer legacy-fixture-access", originator: "opencode", account: "fixture-account" },
      { path: "/backend-api/codex/responses", authorization: "Bearer legacy-fixture-access", originator: "opencode", account: null },
    ])
  }, 20_000)

  test("settings fallback, active connection switches, and token-sharing routing stay request-scoped", async () => {
    const received: (string | null)[] = []

    const origin = serve((request) => {
      expect(new URL(request.url).pathname).toBe("/responses")
      expect(request.headers.get("originator")).toBeNull()
      expect(request.headers.get("chatgpt-account-id")).toBeNull()
      received.push(request.headers.get("authorization"))

      return empty()
    })

    const host = await createHost(`${origin}///`)
    cleanup(host.close)
    await host.query("openai")
    await host.credential("openai", { type: "key", key: "active-key" })
    await host.query("openai")
    await host.credential("openai", {
      type: "oauth",
      methodID: "chatgpt-token-sharing",
      access: "sharing-access",
      refresh: "sharing-refresh",
      expires: Date.now() + 3600_000,
      metadata: { accountID: "must-not-send" },
    })
    await host.query("openai")
    expect(received).toEqual([`Bearer ${fakeKey}`, "Bearer active-key", "Bearer sharing-access"])
  })

  test("unsupported credentials and failed settings never send an authenticated request", async () => {
    let received = 0

    const origin = serve(() => {
      received++

      return empty()
    })

    const host = await createHost(origin)
    cleanup(host.close)
    await host.credential("openai", { type: "external", methodID: "external" })
    expect((await host.failureCause("openai")).message).toBe("Unsupported OpenAI credential type")
    await host.credential("openai", {
      type: "oauth", methodID: "unknown", access: fakeKey, refresh: "refresh", expires: Date.now() + 3600_000,
    })
    expect((await host.failureCause("openai")).message).toStartWith("Unsupported OpenAI OAuth method")
    await host.credential("google", {
      type: "oauth", methodID: "oauth", access: fakeKey, refresh: "refresh", expires: Date.now() + 3600_000,
    })
    expect((await host.failureCause("google")).message).toBe("Unsupported Google credential type; expected a key credential")
    await host.credential("openai", { type: "key", key: fakeKey })
    host.failSettings()
    expect((await host.failureCause("openai")).message).toBe("Unable to read openai provider settings. Try again.")
    const missing = await createHost(origin, {}, new Map([["openai", {}], ["google", {}]]))
    cleanup(missing.close)

    for (const provider of ["openai", "google"]) {
      expect((await missing.failureCause(provider)).message).toBe(
        `No active ${provider} connection. Connect the ${provider} integration in OpenCode first.`,
      )
    }

    expect(received).toBe(0)
  })
})

describe("framing and normalized host results", () => {
  test("OpenAI multiline SSE, CR/LF/CRLF, split UTF-8, citations, and action sources render safely", async () => {
    const output = [
      { type: "message", content: [{
        type: "output_text", text: "Café facts",
        annotations: [
          { type: "url_citation", url: "https://example.com/a", title: "A", start_index: 0, end_index: 4, published: 8.64e15 },
          { type: "url_citation", url: "https://example.com/a", start_index: 0, end_index: 4 },
          { type: "url_citation", url: "javascript:alert(1)", start_index: 0, end_index: 4 },
        ],
      }] },
      { type: "web_search_call", action: { sources: [
        { type: "url", url: "http://example.com/b", published: -8.64e15 },
        { type: "url", url: "https://example.com/c", published: 8.64e15 + 1 },
        { type: "url", url: "https://example.com/d", published: -8.64e15 - 1 },
        { type: "url", url: "https://example.com/e", published_date: "2026-01-02" },
        { type: "url", url: "not a url" },
        { type: "url", url: "file:///etc/passwd" },
      ] } },
    ]

    const frame = `: comment\r\nevent: ignored\r\ndata: {"type":"response.completed",\rdata: "response":${JSON.stringify({ output })}}\r\r`
    const bytes = new TextEncoder().encode(frame)
    const split = bytes.indexOf(0xc3) + 1

    const origin = serve(() => new Response(new ReadableStream({
      async start(controller) {
        controller.enqueue(bytes.slice(0, split))
        await Bun.sleep(10)
        controller.enqueue(bytes.slice(split))
        controller.close()
      },
    }), { headers: { "Content-Type": "text/event-stream" } }))

    const host = await createHost(origin)
    cleanup(host.close)
    const rendered = await host.render("openai")
    expect(rendered.output).toEqual({
      provider: "openai",
      results: [
        { url: "https://example.com/a", title: "A", content: "Café", time: { published: 8.64e15 } },
        { url: "http://example.com/b", time: { published: -8.64e15 } },
        { url: "https://example.com/c", time: {} },
        { url: "https://example.com/d", time: {} },
        { url: "https://example.com/e", time: { published: 1767312000000 } },
      ],
    })
    expect(rendered.content).toContain("+275760-09-13T00:00:00.000Z")
    expect(rendered.content).toContain("-271821-04-20T00:00:00.000Z")
  })

  test("Gemini appends global chunk indices and supports before deduplicating URLs across multiple parts", async () => {
    const origin = serve(() => sse([
      JSON.stringify({ candidates: [{
        content: { parts: [{ text: "Café" }, { text: "Beta" }] },
        groundingMetadata: {
          groundingChunks: [{ web: { uri: "https://example.com/a?keep=%2f", title: "A" } }],
          groundingSupports: [{ segment: { endIndex: 5 }, groundingChunkIndices: [0] }],
        },
      }] }),
      JSON.stringify({ candidates: [{
        content: { parts: [{ text: " facts" }, { text: " details" }] },
        groundingMetadata: {
          groundingChunks: [
            { web: { uri: "https://example.com/a?keep=%2f", title: "Duplicate" } },
            { web: { uri: "https://example.com/b", title: "B", published: 1e20 } },
            { web: { uri: "data:text/plain,invalid" } },
          ],
          groundingSupports: [
            { segment: { startIndex: 6, endIndex: 11 }, groundingChunkIndices: [1, 2] },
            { segment: { partIndex: 1, endIndex: 4 }, groundingChunkIndices: [2] },
          ],
        },
        finishReason: "STOP",
      }] }),
    ]))

    const host = await createHost(origin)
    cleanup(host.close)
    expect((await host.query("google")).results).toEqual([
      { url: "https://example.com/a?keep=%2f", title: "A", content: "Café facts", time: {} },
      { url: "https://example.com/b", title: "B", content: "facts Beta", time: {} },
    ])
  })

  test("JSON fallbacks, item-done streams, and valid ungrounded responses use the host schema", async () => {
    const replies = [
      Response.json({ output: [{ type: "web_search_call", action: { sources: [{ type: "url", url: "https://example.com" }] } }] }),
      sse([
        "[DONE]",
        JSON.stringify({ type: "response.output_item.done", item: {
          type: "web_search_call", action: { sources: [{ type: "url", url: "https://example.com/done" }] },
        } }),
        JSON.stringify({ type: "response.completed", response: { output: [] } }),
      ]),
      Response.json({ candidates: [{ finishReason: "STOP" }] }),
      sse([JSON.stringify({ candidates: [{ content: { parts: [{ text: "ungrounded" }] }, finishReason: "STOP" }] })]),
      Response.json({ output: [] }),
    ]

    const origin = serve(() => replies.shift() ?? empty())
    const host = await createHost(origin)
    cleanup(host.close)
    expect((await host.query("openai")).results).toEqual([{ url: "https://example.com", time: {} }])
    expect((await host.query("openai")).results).toEqual([{ url: "https://example.com/done", time: {} }])
    expect((await host.query("google")).results).toEqual([])
    expect((await host.query("google")).results).toEqual([])
    expect((await host.render("openai")).content).toBe("No search results found. Please try a different query.")
  })
})

describe("provider failures at the host boundary", () => {
  test("incomplete, blocked, malformed, and SSE failures reject with redacted diagnostics", async () => {
    const replies: Response[] = []
    const origin = serve(() => replies.shift() ?? empty())
    const host = await createHost(origin)
    cleanup(host.close)

    for (const reason of ["content_filter", "max_output_tokens", `echo ${fakeKey}`]) {
      for (const reply of [
        Response.json({ status: "incomplete", incomplete_details: { reason }, output: [] }),
        sse([JSON.stringify({ type: "response.incomplete", response: { incomplete_details: { reason }, output: [] } })]),
      ]) {
        replies.push(reply)
        expect((await host.failureCause("openai")).message).toBe(`OpenAI web search incomplete: ${reason.replace(fakeKey, "[REDACTED]")}`)
      }
    }

    for (const reason of ["ESCALATION", "PUP_LIMITED_DISABLED", "SAFETY", "MAX_TOKENS", "CONTINUATION", "OTHER", "IMAGE_OTHER", "MALFORMED_RESPONSE"]) {
      replies.push(sse([JSON.stringify({ candidates: [{ finishReason: reason }] })]))
      expect((await host.failureCause("google")).message).toContain(`finish reason ${reason}`)
    }

    for (const provider of ["openai", "google"]) {
      for (const reply of [
        new Response("{not json"),
        Response.json({}),
        sse(["not json"]),
        sse([JSON.stringify({})]),
        sse([JSON.stringify({ type: "error", error: { message: `authorization: Bearer ${fakeKey}` } })]),
      ]) {
        replies.push(reply)
        const failure = await host.failureCause(provider)
        expect(String(failure)).not.toContain(fakeKey)
        expect(String(failure)).toMatch(/not valid JSON|missing output|malformed response envelope|malformed stream event|without a terminal event|REDACTED/)
      }
    }
  })

  test("HTTP status errors drive cooldowns and status-specific tool messages without retaining secrets", async () => {
    let requests = 0
    let status = 429

    const origin = serve(() => {
      requests++

      return Response.json({ error: { message: `echo ${fakeKey}` } }, {
        status,
        headers: { "retry-after": "60", "x-secret": fakeKey },
      })
    })

    const host = await createHost(origin)
    cleanup(host.close)
    const failure = await host.failure("openai")
    expect(failure).toBeInstanceOf(WebSearch.RequestError)

    if (!(failure instanceof WebSearch.RequestError) || !HttpClientError.isHttpClientError(failure.cause)) {
      throw new Error("Expected an Effect HTTP status error from the real host")
    }

    expect(failure.cause.response?.status).toBe(429)
    expect(failure.cause.reason._tag).toBe("StatusCodeError")
    expect(failure.cause.message).toContain("[REDACTED]")
    expect(JSON.stringify(failure.cause)).not.toContain(fakeKey)
    expect(Bun.inspect(failure.cause)).not.toContain(fakeKey)

    for (const [code, message] of [
      [429, "Web search rate limited (HTTP 429)"],
      [401, "Web search authentication failed (HTTP 401)"],
      [503, "Web search request failed (HTTP 503)"],
    ] as const) {
      status = code
      await expect(host.render("openai")).rejects.toThrow(message)
    }

    status = 429
    await host.selectRandom()
    await host.failure()
    const afterCooldown = requests
    await host.failure()
    expect(requests).toBe(afterCooldown)
  })

  test("redirect rejection never forwards either credential to another origin", async () => {
    let destinations = 0

    const destination = serve(() => {
      destinations++

      return empty()
    })

    const origin = serve(() => Response.redirect(`${destination}/stolen`, 307))
    const host = await createHost(origin)
    cleanup(host.close)

    for (const provider of ["openai", "google"]) await expect(host.query(provider)).rejects.toThrow()
    expect(destinations).toBe(0)
  })
})

describe("real cancellation and timeout", () => {
  test("pre-abort and request/body barriers cancel both providers", async () => {
    for (const provider of ["openai", "google"]) {
      for (const phase of ["pre", "request", "body"]) {
        const started = barrier()
        const release = barrier()
        const disconnected = barrier()
        let received = 0

        const origin = serve(async (incoming) => {
          received++
          incoming.signal.addEventListener("abort", () => disconnected.resolve(), { once: true })

          if (phase === "request") {
            started.resolve()
            await release.promise

            return empty()
          }

          return new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(": body started\n\n"))
              started.resolve()
            },
            cancel() {
              disconnected.resolve()
            },
          }), { headers: { "content-type": "text/event-stream" } })
        })

        const host = await createHost(origin, { timeoutMs: 1000 })
        cleanup(host.close)
        const controller = new AbortController()
        const reading = barrier()
        const nativeRead = ReadableStreamDefaultReader.prototype.read

        // Observe entry to the native body reader without replacing fetch,
        // payloads, sockets, or the read operation.
        const observer = phase === "body"
          ? spyOn(ReadableStreamDefaultReader.prototype, "read").mockImplementation(function (this: ReadableStreamDefaultReader) {
            const pending = nativeRead.call(this)
            reading.resolve()

            return pending
          })
          : undefined

        cleanup(() => observer?.mockRestore())

        if (phase === "pre") controller.abort()
        const request = host.queryExit(provider, controller.signal)

        if (phase !== "pre") {
          await (phase === "body" ? reading.promise : started.promise)
          controller.abort()
        }

        const exit = await request
        observer?.mockRestore()

        try {
          if (phase !== "pre") {
            // An interrupted Effect alone does not prove that fetch stops.
            // Require remote disconnect before the provider's 1000 ms timeout.
            const timer = setTimeout(() => disconnected.reject(new Error("Provider left the HTTP transport running after cancellation")), 500)

            try {
              await disconnected.promise
            } finally {
              clearTimeout(timer)
            }
          }
        } finally {
          release.resolve()
        }

        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
        expect(received).toBe(phase === "pre" ? 0 : 1)
      }
    }
  }, 15_000)

  test("stalled SSE preserves timeout reasons for both providers", async () => {
    const origin = serve(() => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(": stalled\n\n"))
      },
    }), { headers: { "Content-Type": "text/event-stream" } }))

    const host = await createHost(origin, { timeoutMs: 100 })
    cleanup(host.close)

    for (const provider of ["openai", "google"]) {
      const failure = await host.failure(provider)
      expect(failure).toBeInstanceOf(WebSearch.RequestError)

      if (!(failure instanceof WebSearch.RequestError)) throw new Error("Expected host request failure")
      expect(failure.cause).toBeInstanceOf(DOMException)
      expect(String(failure.cause)).toContain("TimeoutError")
    }
  })
})
