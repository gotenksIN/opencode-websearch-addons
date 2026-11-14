import { afterEach } from "bun:test";

const closers: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  await Array.fromAsync(closers.splice(0).toReversed(), async (close) => {
    await close();
  });
});

export const cleanup = (close: () => void | Promise<void>): void => {
  closers.push(close);
};

export const serve = (
  handler: (request: Request) => Response | Promise<Response>
): string => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: handler,
    idleTimeout: 0,
  });

  cleanup(async () => {
    await server.stop(true);
  });

  return server.url.origin;
};

export const sse = (events: readonly string[]): Response =>
  new Response(events.map((event) => `data: ${event}\n\n`).join(""), {
    headers: { "Content-Type": "text/event-stream" },
  });

export const barrier = () => Promise.withResolvers<undefined>();
