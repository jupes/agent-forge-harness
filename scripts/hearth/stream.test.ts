import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import {
  type AddressInfo,
  connect as connectSocket,
  type Socket,
} from "node:net";
import type {
  LedgerEvent,
  OperatorEnvelope,
  StreamSnapshot,
} from "../../types/hearth";
import { appendEvent } from "../ledger/append";
import type { BdResult } from "./routes/dev-api";
import {
  createLedgerStream,
  type LedgerStreamDeps,
  STREAM_KEEPALIVE_MS,
  STREAM_MAX_BUFFERED_BYTES,
  STREAM_MAX_CONNECTIONS,
  STREAM_POLL_MS,
  STREAM_STALLED_MS,
} from "./stream";
import {
  type StreamClient as Client,
  type StreamMessage as Message,
  openEventStream,
  startTestHearth,
  type TestHearth,
  type TestHearthOptions,
} from "./testing";
import { validateLedgerEvent, validateOperatorEnvelope } from "./validate";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function start(options: TestHearthOptions = {}): Promise<TestHearth> {
  const hearth = await startTestHearth(options);
  cleanup.push(() => hearth.close());
  return hearth;
}

/** Open a stream that the test's cleanup closes. */
async function connect(
  url: string,
  headers: Record<string, string>,
): Promise<Client> {
  const client = await openEventStream(url, headers);
  cleanup.push(() => client.close());
  return client;
}

const stream = (
  h: TestHearth,
  headers: Record<string, string> = {},
): Promise<Client> =>
  connect(`${h.api}/stream`, { Origin: h.hearth.url, ...headers });

const TOOL = { tool: "Bash", argsHash: "sha256:ab12" };
const COLLECTIONS = [
  "sessions",
  "runs",
  "queue",
  "reservations",
  "smiths",
  "config",
] as const;

function snapshotOf(message: Message | null): StreamSnapshot {
  if (message?.event !== "snapshot")
    throw new Error(`expected a snapshot, got ${message?.event ?? "the end"}`);
  return JSON.parse(message.data) as StreamSnapshot;
}

function deltaOf(message: Message | null): LedgerEvent {
  if (message?.event !== "delta")
    throw new Error(`expected a delta, got ${message?.event ?? "the end"}`);
  const checked = validateLedgerEvent(JSON.parse(message.data));
  if (!checked.ok) throw new Error(checked.error);
  expect(message.id).toBe(String(checked.value.id));
  return checked.value;
}

describe("GET /stream on a hearth", () => {
  test("a connect gets a snapshot of every collection at the ledger's newest id", async () => {
    const h = await start();
    h.append({ kind: "session.started", sessionId: "s-1", payload: {} });
    const newest = h.append({
      kind: "tool.called",
      sessionId: "s-1",
      payload: TOOL,
    });

    const client = await stream(h);
    expect(client.response.status).toBe(200);
    expect(client.response.headers.get("content-type")).toBe(
      "text/event-stream",
    );
    const first = await client.next();
    expect(first?.event).toBe("snapshot");
    expect(first?.id).toBe(String(newest));
    const snapshot = snapshotOf(first);
    expect(snapshot.cursor).toBe(newest);
    expect(Object.keys(snapshot).sort()).toEqual(
      ["cursor", ...COLLECTIONS].sort(),
    );
    for (const name of COLLECTIONS) {
      const checked = validateOperatorEnvelope(snapshot[name]);
      expect({ name, envelope: checked.ok, ok: snapshot[name].ok }).toEqual({
        name,
        envelope: true,
        ok: true,
      });
    }
    expect(snapshot.sessions.data?.map((session) => session.sessionId)).toEqual(
      ["s-1"],
    );
    expect(snapshot.queue.data).toEqual([]);
    expect(snapshot.smiths.data?.defaultSmith).toBe("claude-journeyman");
  });

  test("a ledger append arrives as a delta in under 1 s at the default poll interval, and deltas keep id order", async () => {
    // No interval is injected: this is the hearth as it ships.
    const h = await start();
    const client = await stream(h);
    snapshotOf(await client.next());

    for (let round = 0; round < 3; round++) {
      const id = h.append({
        kind: "gate.ran",
        payload: { gate: `g-${round}`, passed: true },
      });
      const appended = performance.now();
      const delta = deltaOf(await client.next(1000));
      const elapsed = performance.now() - appended;
      expect(delta.id).toBe(id);
      expect(elapsed).toBeLessThan(1000);
    }

    const ids = [1, 2, 3, 4, 5].map(() =>
      h.append({ kind: "tool.called", payload: TOOL }),
    );
    const seen: number[] = [];
    for (const _ of ids) seen.push(deltaOf(await client.next(1000)).id);
    expect(seen).toEqual(ids);
  });

  test("a collection that cannot be read carries its own error; the rest of the snapshot is intact", async () => {
    const h = await start();
    h.bd.list = {
      status: 1,
      stdout: "",
      stderr: "Error: database is locked\n",
    };
    const snapshot = snapshotOf(await (await stream(h)).next());
    expect(snapshot.queue).toMatchObject({ ok: false, data: null });
    expect(snapshot.queue.error).toContain("database is locked");
    for (const name of COLLECTIONS.filter(
      (collection) => collection !== "queue",
    ))
      expect({ name, ok: snapshot[name].ok }).toEqual({ name, ok: true });
  });

  test("a bd that never answers does not hold the stream: the snapshot arrives with the queue as an error", async () => {
    const h = await start({ api: { bdTimeoutMs: 100 } });
    h.bd.list = () => new Promise<BdResult>(() => {});
    const snapshot = snapshotOf(await (await stream(h)).next(3000));
    expect(snapshot.queue.ok).toBe(false);
    expect(snapshot.queue.error).toContain(
      "did not answer within its 100 ms limit",
    );
    expect(snapshot.sessions.ok && snapshot.runs.ok && snapshot.config.ok).toBe(
      true,
    );
  });

  test("the connect window: an event appended while the snapshot is being built arrives after it, as a delta", async () => {
    const h = await start({ api: { streamPollMs: 20 } });
    let answer: (result: BdResult) => void = () => {};
    let asked = false;
    h.bd.list = () =>
      new Promise<BdResult>((resolve) => {
        asked = true;
        answer = resolve;
      });
    const before = h.append({ kind: "tool.called", payload: TOOL });

    const client = await stream(h);
    for (let i = 0; i < 200 && !asked; i++)
      await new Promise((done) => setTimeout(done, 5));
    expect(asked).toBe(true);
    // The snapshot is waiting on bd. This event is newer than its cursor.
    const during = h.append({
      kind: "gate.ran",
      payload: { gate: "late", passed: true },
    });
    // Several poll intervals pass; nothing may be sent ahead of the snapshot.
    expect(await client.quiet(200)).toBe(true);

    answer({ status: 0, stdout: "[]", stderr: "" });
    const snapshot = snapshotOf(await client.next());
    expect(snapshot.cursor).toBe(before);
    expect(snapshot.cursor).toBeLessThan(during);
    expect(deltaOf(await client.next()).id).toBe(during);
  });

  test("Last-Event-ID resumes after that id with no snapshot; an id ahead of the ledger gets a snapshot; a malformed one is 400", async () => {
    const h = await start({ api: { streamPollMs: 20 } });
    const a = h.append({ kind: "tool.called", payload: TOOL });
    const b = h.append({ kind: "tool.called", payload: TOOL });
    const c = h.append({ kind: "tool.called", payload: TOOL });

    const resumed = await stream(h, { "Last-Event-ID": String(a) });
    expect(deltaOf(await resumed.next()).id).toBe(b);
    expect(deltaOf(await resumed.next()).id).toBe(c);
    expect(await resumed.quiet(100)).toBe(true);

    const caughtUp = await stream(h, { "Last-Event-ID": String(c) });
    expect(await caughtUp.quiet(100)).toBe(true);
    const d = h.append({ kind: "tool.called", payload: TOOL });
    expect(deltaOf(await caughtUp.next()).id).toBe(d);

    // An id the ledger has not reached: the client is out of step, so it starts over.
    const ahead = await stream(h, { "Last-Event-ID": String(d + 1000) });
    expect(snapshotOf(await ahead.next()).cursor).toBe(d);

    for (const bad of ["abc", "-1", "1.5", "", " ", "9".repeat(400), "1 2"]) {
      const response = await fetch(`${h.api}/stream`, {
        headers: { Origin: h.hearth.url, "Last-Event-ID": bad },
      });
      // An empty or blank value is no header at all to HTTP, and starts a new stream.
      const expected = bad.trim() === "" ? 200 : 400;
      expect({ bad, status: response.status }).toEqual({
        bad,
        status: expected,
      });
      if (expected === 400)
        expect(validateOperatorEnvelope(await response.json()).ok).toBe(true);
      else await response.body?.cancel();
    }
    const withQuery = await fetch(`${h.api}/stream?after=3`, {
      headers: { Origin: h.hearth.url },
    });
    expect(withQuery.status).toBe(400);
  });

  test("stays inside the hearth's workspace: another checkout's events move neither the cursor nor the stream", async () => {
    const h = await start({ api: { streamPollMs: 20 } });
    const elsewhere = (gate: string): void => {
      const stored = appendEvent(
        {
          kind: "gate.ran",
          workspace: "c:/work/another-checkout",
          payload: { gate, passed: true },
        },
        { path: h.ledger },
      );
      if (!stored.ok) throw new Error(stored.error);
    };
    const own = h.append({ kind: "tool.called", payload: TOOL });
    elsewhere("newer-than-the-cursor");

    const client = await stream(h);
    // The other checkout's event has the higher id; the cursor is still this workspace's newest.
    expect(snapshotOf(await client.next()).cursor).toBe(own);

    elsewhere("while-connected");
    expect(await client.quiet(200)).toBe(true);
    const next = h.append({
      kind: "gate.ran",
      payload: { gate: "mine", passed: true },
    });
    const delta = deltaOf(await client.next());
    expect(delta.id).toBe(next);
    expect(delta.workspace).toBe(h.workspace);

    // A resume does not replay them either.
    const resumed = await stream(h, { "Last-Event-ID": "0" });
    const replayed = [
      deltaOf(await resumed.next()).id,
      deltaOf(await resumed.next()).id,
    ];
    expect(replayed).toEqual([own, next]);
    expect(await resumed.quiet(100)).toBe(true);
  });

  test("a keepalive comment arrives at the configured interval; the default is 15 s", async () => {
    expect(STREAM_KEEPALIVE_MS).toBe(15_000);
    expect(STREAM_POLL_MS).toBeLessThanOrEqual(500);
    const h = await start({ api: { streamKeepaliveMs: 40 } });
    const client = await stream(h);
    snapshotOf(await client.next());
    const first = await client.next(1000);
    expect(first).toMatchObject({ event: "comment", data: "keepalive" });
    expect(await client.next(1000)).toMatchObject({ event: "comment" });
  });

  test("refuses a request that does not declare the hearth's own origin, and does not count it against the cap", async () => {
    const h = await start();
    for (const headers of [
      {},
      { Origin: "https://evil.example" },
      { "Sec-Fetch-Site": "same-site" },
    ] as Array<Record<string, string>>) {
      for (let i = 0; i < STREAM_MAX_CONNECTIONS + 2; i++) {
        const response = await fetch(`${h.api}/stream`, { headers });
        expect(response.status).toBe(403);
        await response.body?.cancel();
      }
    }
    const client = await stream(h);
    expect(client.response.status).toBe(200);
    snapshotOf(await client.next());
  });

  test("at most 32 streams are open at once; the next is refused, and a slot frees when a client leaves", async () => {
    expect(STREAM_MAX_CONNECTIONS).toBe(32);
    const h = await start();
    const clients: Client[] = [];
    for (let i = 0; i < STREAM_MAX_CONNECTIONS; i++) {
      const client = await stream(h);
      expect(client.response.status).toBe(200);
      clients.push(client);
    }
    const refused = await fetch(`${h.api}/stream`, {
      headers: { Origin: h.hearth.url },
    });
    expect(refused.status).toBe(503);
    const body: unknown = await refused.json();
    expect(validateOperatorEnvelope(body)).toMatchObject({
      ok: true,
      value: { ok: false },
    });

    clients[0]?.close();
    let admitted = 0;
    for (let attempt = 0; attempt < 100 && admitted !== 200; attempt++) {
      await new Promise((done) => setTimeout(done, 20));
      const again = await fetch(`${h.api}/stream`, {
        headers: { Origin: h.hearth.url },
      });
      admitted = again.status;
      await again.body?.cancel();
    }
    expect(admitted).toBe(200);
  }, 20_000);

  test("closing the hearth ends its open streams", async () => {
    const h = await startTestHearth();
    const client = await stream(h);
    snapshotOf(await client.next());
    await h.close();
    expect(await client.next(2000)).toBeNull();
  });
});

describe("createLedgerStream (injected ledger, bare server)", () => {
  interface Harness {
    url: string;
    deps: { reads: number; cursor: number; events: LedgerEvent[] };
    stream: ReturnType<typeof createLedgerStream>;
  }

  async function harness(
    options: Partial<LedgerStreamDeps> = {},
  ): Promise<Harness> {
    const state = { reads: 0, cursor: 0, events: [] as LedgerEvent[] };
    const ledgerStream = createLedgerStream({
      cursor: () => state.cursor,
      collections: async () => ({
        runs: { ok: true, data: [], error: null } satisfies OperatorEnvelope,
      }),
      eventsAfter: (cursor, limit) => {
        state.reads++;
        return state.events
          .filter((event) => event.id > cursor)
          .slice(0, limit);
      },
      pollMs: 10,
      keepaliveMs: 60_000,
      ...options,
    });
    const server = createServer((req, res) => {
      void ledgerStream.open(req, res, null).then((refusal) => {
        if (refusal === undefined) return;
        res.statusCode = refusal.status;
        res.end(JSON.stringify(refusal));
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    cleanup.push(async () => {
      ledgerStream.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    });
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}/`,
      deps: state,
      stream: ledgerStream,
    };
  }

  const settled = async (check: () => boolean): Promise<boolean> => {
    for (let i = 0; i < 200 && !check(); i++)
      await new Promise((done) => setTimeout(done, 10));
    return check();
  };

  test("when a client leaves, its connection is dropped and the ledger is not read for it again", async () => {
    const h = await harness();
    const client = await connect(h.url, {});
    snapshotOf(await client.next());
    expect(h.stream.connections()).toBe(1);
    expect(await settled(() => h.deps.reads > 2)).toBe(true);

    client.close();
    expect(await settled(() => h.stream.connections() === 0)).toBe(true);
    const reads = h.deps.reads;
    await new Promise((done) => setTimeout(done, 100));
    expect(h.deps.reads).toBe(reads);
  });

  test("a ledger read that throws skips that tick and the stream carries on", async () => {
    let fail = true;
    const event = {
      id: 5,
      ulid: "01J",
      ts: "2026-10-01T00:00:00.000Z",
      workspace: "w",
      kind: "gate.ran",
      payload: { gate: "g", passed: true },
    } as LedgerEvent;
    const h = await harness({
      eventsAfter: (cursor) => {
        if (fail) throw new Error("database is locked");
        return cursor < 5 ? [event] : [];
      },
    });
    const client = await connect(h.url, {});
    snapshotOf(await client.next());
    expect(await client.quiet(80)).toBe(true);
    fail = false;
    expect(deltaOf(await client.next()).id).toBe(5);
  });

  test("a cursor that cannot be read is a 503, and holds no connection", async () => {
    const h = await harness({
      cursor: () => {
        throw new Error("unable to open database file");
      },
    });
    const response = await fetch(h.url);
    expect(response.status).toBe(503);
    expect(h.stream.connections()).toBe(0);
  });

  test("more events than one batch are all delivered, in order", async () => {
    const h = await harness();
    const client = await connect(h.url, {});
    snapshotOf(await client.next());
    h.deps.events = Array.from({ length: 1200 }, (_, index) => ({
      id: index + 1,
      ulid: `u${index}`,
      ts: "2026-10-01T00:00:00.000Z",
      workspace: "w",
      kind: "gate.ran" as const,
      payload: { gate: "g", passed: true },
    }));
    let last = 0;
    for (let i = 0; i < 1200; i++) {
      const delta = deltaOf(await client.next());
      expect(delta.id).toBe(last + 1);
      last = delta.id;
    }
    expect(last).toBe(1200);
  });
});

describe("a stream client that does not read (raw socket, injected ledger)", () => {
  const backlog = (count: number): LedgerEvent[] =>
    Array.from({ length: count }, (_, index) => ({
      id: index + 1,
      ulid: `u${index}`,
      ts: "2026-10-01T00:00:00.000Z",
      workspace: "w",
      kind: "gate.ran" as const,
      // About a kilobyte each, so a few thousand are megabytes.
      payload: { gate: "g".repeat(1000), passed: true },
    }));

  interface Stalled {
    reads: () => number;
    asked: () => number;
    connections: () => number;
    socket: Socket;
    received: () => string;
    /** Whether the server has closed its end of the connection. */
    serverClosed: () => boolean;
  }

  /** A stream with a backlog, and a client that has asked for it and reads nothing. */
  async function stalled(
    options: Partial<LedgerStreamDeps>,
    events: LedgerEvent[],
  ): Promise<Stalled> {
    let reads = 0;
    let asked = 0;
    const ledgerStream = createLedgerStream({
      cursor: () => 0,
      collections: async () => ({}),
      eventsAfter: (cursor, limit) => {
        reads++;
        asked = Math.max(asked, cursor);
        return events.filter((event) => event.id > cursor).slice(0, limit);
      },
      pollMs: 5,
      keepaliveMs: 60_000,
      ...options,
    });
    let serverClosed = false;
    const server = createServer((req, res) => {
      req.socket.once("close", () => {
        serverClosed = true;
      });
      void ledgerStream.open(req, res, null);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    let received = "";
    const socket = connectSocket(port, "127.0.0.1", () => {
      socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
      socket.pause();
    });
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
    });
    socket.on("error", () => {});
    cleanup.push(async () => {
      socket.destroy();
      ledgerStream.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    });
    return {
      reads: () => reads,
      asked: () => asked,
      connections: () => ledgerStream.connections(),
      socket,
      received: () => received,
      serverClosed: () => serverClosed,
    };
  }

  const pause = (ms: number): Promise<void> =>
    new Promise((done) => setTimeout(done, ms));

  test("is not fed without bound: the ledger is not read for it while its buffer is full, and it loses nothing when it reads again", async () => {
    const events = backlog(6000);
    const client = await stalled(
      { maxBufferedBytes: 256_000, stalledMs: 60_000 },
      events,
    );

    // Give the stream every chance to push the whole backlog at a client that takes none of it.
    await pause(400);
    const readsWhileFull = client.reads();
    const askedWhileFull = client.asked();
    await pause(300);
    expect(client.reads()).toBe(readsWhileFull);
    // Far short of the backlog: megabytes are still in the ledger, not in this process.
    expect(askedWhileFull).toBeLessThan(events.length / 2);
    expect(client.connections()).toBe(1);

    client.socket.resume();
    for (let i = 0; i < 400 && !client.received().includes("\nid: 6000\n"); i++)
      await pause(25);
    const ids = [
      ...client.received().matchAll(/event: delta\nid: (\d+)\n/g),
    ].map((match) => Number(match[1]));
    expect(ids.length).toBe(6000);
    expect(ids).toEqual(events.map((event) => event.id));
  }, 30_000);

  test("is dropped once it has stayed full for the stall limit, and its slot is free again", async () => {
    const client = await stalled(
      { maxBufferedBytes: 64_000, stalledMs: 150 },
      backlog(3000),
    );
    await pause(100);
    expect(client.connections()).toBe(1);
    expect(client.serverClosed()).toBe(false);
    for (let i = 0; i < 200 && client.connections() !== 0; i++) await pause(20);
    expect(client.connections()).toBe(0);
    const reads = client.reads();
    await pause(100);
    expect(client.reads()).toBe(reads);
    // The connection itself is closed, not left for the client to finish: the
    // client is still attached and has read nothing, and the server's end is gone.
    expect(client.received()).toBe("");
    expect(client.serverClosed()).toBe(true);
  }, 20_000);

  test("a client that falls behind and catches up, again and again, is never counted as stalled", async () => {
    // A backlog far larger than the socket's own buffers, so every pause finds
    // the connection full again.
    const events = backlog(20_000);
    const client = await stalled(
      { maxBufferedBytes: 64_000, stalledMs: 600 },
      events,
    );
    // Each pause is half the stall limit; together they are twice it.
    for (let round = 0; round < 4; round++) {
      await pause(300);
      expect({ round, open: client.connections() }).toEqual({ round, open: 1 });
      client.socket.resume();
      await pause(60);
      client.socket.pause();
    }
    client.socket.resume();
    for (
      let i = 0;
      i < 800 && !client.received().includes("\nid: 20000\n");
      i++
    )
      await pause(25);
    const ids = [
      ...client.received().matchAll(/event: delta\nid: (\d+)\n/g),
    ].map((match) => Number(match[1]));
    expect(ids.length).toBe(events.length);
    expect(ids).toEqual(events.map((event) => event.id));
    expect(client.connections()).toBe(1);
    expect(client.serverClosed()).toBe(false);
  }, 60_000);

  test("the default limits are one megabyte waiting and thirty seconds stalled", () => {
    expect(STREAM_MAX_BUFFERED_BYTES).toBe(1_000_000);
    expect(STREAM_STALLED_MS).toBe(30_000);
  });
});
