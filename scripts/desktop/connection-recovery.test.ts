import { expect, test } from "bun:test";
import { createDesktopConnection } from "../../apps/desktop/src/connection-recovery";
import {
  createStreamClient,
  type StreamHandlers,
} from "../../docs/js/use-stream";

function fixture(
  post: () => Promise<Response> = async () =>
    Response.json({ ok: true, data: { url: "fresh-launch" }, error: null }),
) {
  let handlers: StreamHandlers | undefined;
  let opens = 0;
  let posts = 0;
  let refreshed = 0;
  const stream = createStreamClient({
    transport: (_cursor, next) => {
      opens++;
      handlers = next;
      return { close() {} };
    },
    read: async () => ({ ok: true, data: [], error: null }),
  });
  const connection = createDesktopConnection({
    stream,
    health: async () => ({ apiVersion: 1 }),
    post: async () => {
      posts++;
      return post();
    },
    refreshSession: async (url) => {
      expect(url).toBe("fresh-launch");
      refreshed++;
      return { state: "exchanged" };
    },
  });
  const leave = connection.subscribe(() => {});
  return {
    stream,
    connection,
    leave,
    counts: () => ({ opens, posts, refreshed }),
    fail: () => handlers?.onEnd("refused"),
    live: () => {
      handlers?.onOpen();
      handlers?.onMessage({
        event: "snapshot",
        id: "1",
        data: JSON.stringify({
          cursor: 1,
          sessions: { ok: true, data: [], error: null },
          runs: { ok: true, data: [], error: null },
          queue: { ok: true, data: [], error: null },
          reservations: { ok: true, data: [], error: null },
          smiths: { ok: false, data: null, error: "none" },
          config: { ok: false, data: null, error: "none" },
        }),
      });
    },
  };
}

const settle = () => new Promise((done) => setImmediate(done));

test("desktop recovery refreshes authentication once and resumes one stream without replaying writes", async () => {
  const f = fixture();
  expect(f.connection.postProblem("/workspace-action")).toContain(
    "unavailable",
  );
  f.live();
  await settle();
  expect(f.connection.get().connection.writesAllowed).toBe(true);
  f.fail();
  await f.connection.restart();
  expect(f.counts()).toEqual({ opens: 2, posts: 1, refreshed: 1 });
  expect(f.connection.get().connection.writesAllowed).toBe(false);
  f.live();
  await settle();
  expect(f.connection.get().connection.writesAllowed).toBe(true);
  f.leave();
});

test("an uncertain restart holds the action until the operator checks, even after reads recover", async () => {
  const f = fixture(async () => {
    throw new Error("answer lost");
  });
  f.fail();
  await f.connection.restart();
  expect(f.connection.get().unknown).toBe(true);
  expect(f.connection.get().message).toContain("Check");
  f.live();
  await settle();
  await f.connection.restart();
  expect(f.counts().posts).toBe(1);
  f.connection.acknowledge();
  expect(f.connection.get().unknown).toBe(false);
  f.leave();
});
