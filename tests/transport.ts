import { afterEach } from "bun:test"

const closers: (() => void | Promise<void>)[] = []

afterEach(async () => {
  for (const close of closers.splice(0).toReversed()) await close()
})

export function cleanup(close: () => void | Promise<void>): void {
  closers.push(close)
}

export function serve(handler: (request: Request) => Response | Promise<Response>): string {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler, idleTimeout: 0 })
  cleanup(() => server.stop(true))

  return server.url.origin
}

export function sse(events: readonly string[]): Response {
  return new Response(events.map((event) => `data: ${event}\n\n`).join(""), {
    headers: { "Content-Type": "text/event-stream" },
  })
}

export function barrier() {
  return Promise.withResolvers<void>()
}
