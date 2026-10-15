import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CONNECTION_LOST,
  councilRunEventsUrl,
  followCouncilRun,
  MAX_FALLBACKS,
  UNREADABLE_UPDATE,
} from "../../docs/js/council-run-follow";
import {
  fetchTransport,
  type SseMessage,
  type StreamHandlers,
  type StreamTransport,
  type Timers,
} from "../../docs/js/use-stream";
import { FakeCouncilTransport } from "../council/fake-transport";
import { councilJobDelta } from "../council/job-delta";
import {
  type CouncilServiceJob,
  createCouncilService,
} from "../council/service";
import { COUNCIL_SCHEMA_VERSION, type ModelTransport } from "../council/types";
import { OPERATOR_HEADER } from "../hearth/paths";
import { COUNCIL_API, councilHttpHandler } from "../hearth/routes/council";

/**
 * How the Council page follows a running council: it asks for the run's
 * stream with `?deltas=1` and rebuilds the job from the whole job it is sent
 * first and the deltas after it (`docs/js/council-run-follow.ts`).
 *
 * Most tests drive the follower with a stand-in stream and stand-in timers, so
 * each decides what arrives and when. The last one runs it over HTTP against
 * the hearth's real council route and a real service with simulated seats.
 */

const RUN = "run-1";

function event(seq: number, runId: string = RUN) {
  return {
    schemaVersion: COUNCIL_SCHEMA_VERSION,
    runId,
    seq,
    at: "2026-10-14T10:00:00.000Z",
    type: "seat.completed",
    payload: { seq },
  };
}

/** A job of `events` events; `updatedAt` follows the count, so no two jobs of a run are equal. */
function jobOf(
  events: number,
  status: CouncilServiceJob["status"] = "running",
  runId: string = RUN,
): CouncilServiceJob {
  return {
    runId,
    status,
    startedAt: "2026-10-14T10:00:00.000Z",
    updatedAt: `2026-10-14T10:00:${String(events).padStart(2, "0")}.000Z`,
    events: Array.from({ length: events }, (_, seq) => event(seq, runId)),
  };
}

const raw = (kind: string, data: string): SseMessage => ({
  event: kind,
  id: null,
  data,
});

const snapshotOf = (job: CouncilServiceJob): SseMessage =>
  raw("snapshot", JSON.stringify(job));

/** The delta the hearth sends to a client that has `before`, as a message. */
function deltaOf(
  before: CouncilServiceJob,
  after: CouncilServiceJob,
): SseMessage {
  const delta = councilJobDelta(before, after);
  if (delta === null) throw new Error("no delta between the two jobs");
  return raw("delta", JSON.stringify(delta));
}

interface Connection {
  handlers: StreamHandlers;
  closed: boolean;
}

/**
 * A transport that opens nothing: the test pushes messages into the
 * connections the follower asked for. `send` and `end` reach a connection
 * the follower has closed or replaced too, which a real transport never does
 * after `close()`: the tests that do it show that the follower ignores
 * anything from a connection that is no longer the current one, and does not
 * rely on the transport for that.
 */
function standInStream() {
  const connections: Connection[] = [];
  const transport: StreamTransport = (_lastEventId, handlers) => {
    const connection: Connection = { handlers, closed: false };
    connections.push(connection);
    return {
      close() {
        connection.closed = true;
      },
    };
  };
  const at = (index: number): Connection => {
    const connection = connections[index];
    if (!connection) throw new Error(`no connection ${index}`);
    return connection;
  };
  return {
    transport,
    connections,
    send: (index: number, message: SseMessage) =>
      at(index).handlers.onMessage(message),
    end: (index: number) => at(index).handlers.onEnd("ended"),
  };
}

function standInTimers() {
  const pending = new Map<number, { run: () => void; ms: number }>();
  let next = 0;
  const timers: Timers = {
    set(run, ms) {
      next += 1;
      pending.set(next, { run, ms });
      return next;
    },
    clear(handle) {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    waits: (): number[] => [...pending.values()].map((timer) => timer.ms),
    /** Run every timer that is waiting. */
    fire(): void {
      for (const [handle, timer] of [...pending]) {
        pending.delete(handle);
        timer.run();
      }
    },
  };
}

/** Let the promises a read resolves settle. */
const flush = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

/** A follower on a stand-in stream; `readRun` is what a read of the run answers. */
function follow(
  readRun: () => Promise<CouncilServiceJob> = async () => jobOf(9),
) {
  const stream = standInStream();
  const clock = standInTimers();
  const jobs: CouncilServiceJob[] = [];
  const errors: string[] = [];
  let finished = 0;
  let reads = 0;
  const follower = followCouncilRun({
    runId: RUN,
    transport: stream.transport,
    readRun: () => {
      reads += 1;
      return readRun();
    },
    onJob: (job) => jobs.push(job),
    onError: (message) => errors.push(message),
    onFinished: () => {
      finished += 1;
    },
    retryMs: 1_000,
    timers: clock.timers,
  });
  return {
    follower,
    stream,
    clock,
    jobs,
    errors,
    finished: () => finished,
    reads: () => reads,
  };
}

describe("followCouncilRun over a stand-in stream", () => {
  test("a run's stream is asked for with deltas, the run id escaped", () => {
    expect(councilRunEventsUrl("/__agent-forge/council-api", "run 1/a")).toBe(
      "/__agent-forge/council-api/runs/run%201%2Fa/events?deltas=1",
    );
  });

  test("the whole job first and a delta after it rebuild each job; a run that completes closes the stream and refreshes the history once, with no read of the run", () => {
    const first = jobOf(2);
    const second = jobOf(3);
    const last = jobOf(5, "completed");
    const h = follow();

    h.stream.send(0, snapshotOf(first));
    h.stream.send(0, deltaOf(first, second));
    expect(h.jobs).toEqual([first, second]);
    expect(h.stream.connections[0]?.closed).toBe(false);
    expect(h.finished()).toBe(0);

    h.stream.send(0, deltaOf(second, last));
    expect(h.jobs).toEqual([first, second, last]);
    expect(h.stream.connections[0]?.closed).toBe(true);
    expect(h.finished()).toBe(1);
    // The hearth ends the stream after the last job; that is not a loss.
    h.stream.end(0);
    expect(h.reads()).toBe(0);
    expect(h.stream.connections).toHaveLength(1);
    expect(h.errors).toEqual([]);
  });

  test("a whole job after the first (the hearth sends one when an update is not the job before plus appended entries) replaces the job held, and the next delta is made from it", () => {
    const first = jobOf(2);
    const replaced = jobOf(4);
    const next = jobOf(5);
    const h = follow();

    h.stream.send(0, snapshotOf(first));
    h.stream.send(0, snapshotOf(replaced));
    h.stream.send(0, deltaOf(replaced, next));
    expect(h.jobs).toEqual([first, replaced, next]);
  });

  test("a new connection starts from its own whole job: a delta applies to what that connection was sent, not to the job the page showed before", async () => {
    const h = follow(async () => jobOf(3));
    h.stream.send(0, snapshotOf(jobOf(2)));
    // The stream stops while the run is going: the run is read, and followed again after the wait.
    h.stream.end(0);
    await flush();
    expect(h.reads()).toBe(1);
    expect(h.jobs.at(-1)).toEqual(jobOf(3));
    expect(h.clock.waits()).toEqual([1_000]);
    h.clock.fire();
    expect(h.stream.connections).toHaveLength(2);

    // The hearth sends the new connection the run as it is now, then changes to it.
    h.stream.send(1, snapshotOf(jobOf(4)));
    h.stream.send(1, deltaOf(jobOf(4), jobOf(5)));
    expect(h.jobs.at(-1)).toEqual(jobOf(5));
    expect(h.jobs.at(-1)?.events.map((item) => item.seq)).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect(h.errors).toEqual([]);
  });

  test("a delta that comes before the new connection's whole job is not applied to the job the last connection was sent", async () => {
    const h = follow(async () => jobOf(3));
    h.stream.send(0, snapshotOf(jobOf(2)));
    h.stream.end(0);
    await flush();
    h.clock.fire();
    expect(h.stream.connections).toHaveLength(2);
    expect(h.reads()).toBe(1);

    // Made from a job of three events, and the last connection's job has two.
    h.stream.send(1, deltaOf(jobOf(3), jobOf(4)));
    expect(h.jobs.map((job) => job.events.length)).toEqual([2, 3]);
    expect(h.stream.connections[1]?.closed).toBe(true);
    expect(h.reads()).toBe(2);
  });

  describe("a delta that cannot be applied reads the run again", () => {
    const base = jobOf(2);
    const fine = councilJobDelta(base, jobOf(3));
    if (fine === null) throw new Error("no delta");
    const cases: Array<[string, SseMessage[]]> = [
      ["one that comes before any whole job", [deltaOf(base, jobOf(3))]],
      [
        "one made for another run",
        [
          snapshotOf(base),
          deltaOf(jobOf(2, "running", "other"), jobOf(3, "running", "other")),
        ],
      ],
      ["one that is not JSON", [snapshotOf(base), raw("delta", "{not json")]],
      ["one that is JSON null", [snapshotOf(base), raw("delta", "null")]],
      [
        "one without its events",
        [
          snapshotOf(base),
          raw("delta", JSON.stringify({ ...fine, events: undefined })),
        ],
      ],
      [
        "one without its discussion",
        [
          snapshotOf(base),
          raw("delta", JSON.stringify({ ...fine, discussion: "none" })),
        ],
      ],
      [
        "one with a null set",
        [
          snapshotOf(base),
          raw("delta", JSON.stringify({ ...fine, set: null })),
        ],
      ],
      [
        "one whose unset is not a list",
        [
          snapshotOf(base),
          raw("delta", JSON.stringify({ ...fine, unset: "status" })),
        ],
      ],
    ];
    for (const [name, messages] of cases)
      test(`${name}: the connection is closed, the run is read and shown, and it is followed again from a whole job`, async () => {
        const fresh = jobOf(7);
        const h = follow(async () => fresh);
        for (const message of messages) h.stream.send(0, message);
        // Only the whole job (if any) was shown: nothing was made of the delta.
        expect(h.jobs).toEqual(messages[0]?.event === "snapshot" ? [base] : []);
        expect(h.stream.connections[0]?.closed).toBe(true);
        expect(h.reads()).toBe(1);

        await flush();
        expect(h.jobs.at(-1)).toEqual(fresh);
        expect(h.errors).toEqual([]);
        expect(h.clock.waits()).toEqual([1_000]);
        h.clock.fire();
        expect(h.stream.connections).toHaveLength(2);
        // The new connection's whole job is what its deltas are applied to.
        h.stream.send(1, snapshotOf(jobOf(8)));
        h.stream.send(1, deltaOf(jobOf(8), jobOf(9)));
        expect(h.jobs.at(-1)).toEqual(jobOf(9));
        expect(h.reads()).toBe(1);
      });

    test("when the read finds the run finished, it is shown, the history is refreshed and the stream is not followed again", async () => {
      const done = jobOf(6, "completed");
      const h = follow(async () => done);
      h.stream.send(0, snapshotOf(base));
      h.stream.send(0, raw("delta", "{"));
      await flush();
      expect(h.jobs.at(-1)).toEqual(done);
      expect(h.finished()).toBe(1);
      expect(h.clock.waits()).toEqual([]);
      expect(h.stream.connections).toHaveLength(1);
    });

    test("when the read fails, the page is told the connection was lost and nothing is retried", async () => {
      const h = follow(async () => {
        throw new Error("down");
      });
      h.stream.send(0, snapshotOf(base));
      h.stream.send(0, raw("delta", "{"));
      await flush();
      expect(h.errors).toEqual([CONNECTION_LOST]);
      expect(h.clock.waits()).toEqual([]);
      expect(h.jobs).toEqual([base]);
    });
  });

  test("a whole job that cannot be read is reported and not shown, and the stream is kept; the next whole job is shown", () => {
    const h = follow();
    h.stream.send(0, raw("snapshot", "{broken"));
    h.stream.send(0, raw("snapshot", "null"));
    h.stream.send(0, raw("snapshot", JSON.stringify({ runId: RUN })));
    expect(h.errors).toEqual([
      UNREADABLE_UPDATE,
      UNREADABLE_UPDATE,
      UNREADABLE_UPDATE,
    ]);
    expect(h.jobs).toEqual([]);
    expect(h.stream.connections[0]?.closed).toBe(false);
    expect(h.reads()).toBe(0);
    h.stream.send(0, snapshotOf(jobOf(1)));
    expect(h.jobs).toEqual([jobOf(1)]);
  });

  test("a message of another kind is ignored", () => {
    const h = follow();
    h.stream.send(0, snapshotOf(jobOf(1)));
    h.stream.send(0, raw("comment", "hello"));
    h.stream.send(0, raw("message", "{}"));
    expect(h.jobs).toEqual([jobOf(1)]);
    expect(h.reads()).toBe(0);
    expect(h.errors).toEqual([]);
  });

  test("close() stops the stream and any wait for a retry, and nothing arriving after it is shown", async () => {
    const h = follow(async () => jobOf(3));
    h.stream.send(0, snapshotOf(jobOf(1)));
    h.stream.end(0);
    await flush();
    expect(h.clock.waits()).toEqual([1_000]);

    h.follower.close();
    expect(h.clock.waits()).toEqual([]);
    h.clock.fire();
    expect(h.stream.connections).toHaveLength(1);

    const shown = h.jobs.length;
    h.stream.send(0, snapshotOf(jobOf(4)));
    h.stream.end(0);
    await flush();
    expect(h.jobs).toHaveLength(shown);
    expect(h.reads()).toBe(1);
    expect(h.stream.connections[0]?.closed).toBe(true);
  });

  test("a read that returns after close() is not shown and starts no retry", async () => {
    let answer: (job: CouncilServiceJob) => void = () => {};
    const h = follow(
      () =>
        new Promise<CouncilServiceJob>((done) => {
          answer = done;
        }),
    );
    h.stream.send(0, raw("delta", "{"));
    h.follower.close();
    answer(jobOf(5));
    await flush();
    expect(h.jobs).toEqual([]);
    expect(h.clock.waits()).toEqual([]);
  });
});

const seqs = (job: CouncilServiceJob | undefined): number[] =>
  job?.events.map((item) => item.seq) ?? [];

/** A discussion round as the hearth sends it: only what a repeat is told by. */
const round = (stage: string, completedAt: string) => ({
  stage,
  round: 1,
  completedAt,
  findings: [],
});

const deltaMessage = (parts: Record<string, unknown>): SseMessage =>
  raw(
    "delta",
    JSON.stringify({
      runId: RUN,
      events: [],
      discussion: [],
      set: {},
      unset: [],
      ...parts,
    }),
  );

describe("a message that does not follow the job the connection holds", () => {
  test("a delta sent twice is applied once, and the second reads the run again", async () => {
    const two = jobOf(2);
    const three = jobOf(3);
    const h = follow(async () => jobOf(7));
    h.stream.send(0, snapshotOf(two));
    h.stream.send(0, deltaOf(two, three));
    h.stream.send(0, deltaOf(two, three));
    expect(h.jobs.map(seqs)).toEqual([
      [0, 1],
      [0, 1, 2],
    ]);
    expect(h.stream.connections[0]?.closed).toBe(true);
    expect(h.reads()).toBe(1);
    await flush();
    expect(seqs(h.jobs.at(-1))).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  test("a delta made for a later job, arriving before the one between, is not applied: the run is read again", async () => {
    const h = follow(async () => jobOf(7));
    h.stream.send(0, snapshotOf(jobOf(2)));
    h.stream.send(0, deltaOf(jobOf(3), jobOf(4)));
    expect(h.jobs.map(seqs)).toEqual([[0, 1]]);
    expect(h.reads()).toBe(1);
    h.stream.send(0, deltaOf(jobOf(2), jobOf(3)));
    await flush();
    expect(seqs(h.jobs.at(-1))).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(h.reads()).toBe(1);
  });

  test("a delta whose own events skip one is not applied", () => {
    const h = follow();
    h.stream.send(0, snapshotOf(jobOf(2)));
    h.stream.send(0, deltaMessage({ events: [event(2), event(4)] }));
    expect(h.jobs.map(seqs)).toEqual([[0, 1]]);
    expect(h.reads()).toBe(1);
  });

  test("a delta that carries a round the job already has is not applied", () => {
    const first = round("independent", "2026-10-14T10:00:05.000Z");
    const held = { ...jobOf(2), discussion: [first] };
    const h = follow();
    h.stream.send(0, snapshotOf(held as unknown as CouncilServiceJob));
    h.stream.send(0, deltaMessage({ discussion: [first] }));
    expect(h.jobs).toHaveLength(1);
    expect(h.reads()).toBe(1);

    const other = follow();
    other.stream.send(0, snapshotOf(held as unknown as CouncilServiceJob));
    other.stream.send(
      0,
      deltaMessage({ discussion: [round("peer", "2026-10-14T10:00:09.000Z")] }),
    );
    expect(other.jobs).toHaveLength(2);
    expect(other.reads()).toBe(0);
  });

  test("a delta that appends to a job with no events, or appends none, is applied", () => {
    const h = follow();
    h.stream.send(0, snapshotOf(jobOf(0)));
    h.stream.send(0, deltaOf(jobOf(0), jobOf(2)));
    h.stream.send(0, deltaOf(jobOf(2), { ...jobOf(2), status: "cancelling" }));
    expect(h.jobs.map((job) => [seqs(job), job.status])).toEqual([
      [[], "running"],
      [[0, 1], "running"],
      [[0, 1], "cancelling"],
    ]);
    expect(h.reads()).toBe(0);
  });

  test("a whole job of another run is not taken for this one: it is reported, not shown, and the next delta reads the run again", () => {
    const h = follow();
    h.stream.send(0, snapshotOf(jobOf(2)));
    h.stream.send(0, snapshotOf(jobOf(3, "running", "other")));
    expect(h.errors).toEqual([UNREADABLE_UPDATE]);
    expect(h.jobs).toEqual([jobOf(2)]);
    h.stream.send(0, deltaOf(jobOf(2), jobOf(3)));
    expect(h.jobs).toEqual([jobOf(2)]);
    expect(h.reads()).toBe(1);
  });

  test("a whole job that cannot be read leaves no job held: the next delta reads the run again instead of landing on the job before", async () => {
    const h = follow(async () => jobOf(7));
    h.stream.send(0, snapshotOf(jobOf(2)));
    h.stream.send(0, raw("snapshot", "{broken"));
    h.stream.send(0, deltaOf(jobOf(2), jobOf(3)));
    expect(h.errors).toEqual([UNREADABLE_UPDATE]);
    expect(h.jobs).toEqual([jobOf(2)]);
    expect(h.reads()).toBe(1);
    await flush();
    expect(h.jobs.at(-1)).toEqual(jobOf(7));
  });
});

describe("a connection that is no longer the current one", () => {
  test("a delta arriving late on the connection before is not applied to the new connection's job, and starts no read", async () => {
    const h = follow(async () => jobOf(3));
    h.stream.send(0, snapshotOf(jobOf(2)));
    h.stream.end(0);
    await flush();
    h.clock.fire();
    h.stream.send(1, snapshotOf(jobOf(5)));
    const shown = h.jobs.length;

    h.stream.send(0, deltaOf(jobOf(2), jobOf(3)));
    h.stream.send(0, snapshotOf(jobOf(99)));
    expect(h.jobs).toHaveLength(shown);
    expect(seqs(h.jobs.at(-1))).toEqual([0, 1, 2, 3, 4]);
    expect(h.reads()).toBe(1);
    expect(h.clock.waits()).toEqual([]);
    expect(h.stream.connections[1]?.closed).toBe(false);
    // The current connection goes on from its own job.
    h.stream.send(1, deltaOf(jobOf(5), jobOf(6)));
    expect(seqs(h.jobs.at(-1))).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("a connection closed at a bad delta that then ends does not start a second read", async () => {
    const h = follow(async () => jobOf(7));
    h.stream.send(0, snapshotOf(jobOf(2)));
    h.stream.send(0, raw("delta", "{"));
    expect(h.reads()).toBe(1);
    h.stream.end(0);
    h.stream.send(0, raw("delta", "{"));
    await flush();
    expect(h.reads()).toBe(1);
    expect(h.clock.waits()).toEqual([1_000]);
    h.clock.fire();
    expect(h.stream.connections).toHaveLength(2);
  });
});

/** Connection `index` is sent a whole job and a delta that cannot be applied; the run is read and the next connection opened. */
async function fallBack(
  h: ReturnType<typeof follow>,
  index: number,
): Promise<void> {
  h.stream.send(index, snapshotOf(jobOf(2)));
  h.stream.send(index, raw("delta", "{"));
  await flush();
  h.clock.fire();
}

describe("reading the run again is capped", () => {
  test(`after ${MAX_FALLBACKS} reads in a row the page is told the connection was lost, and the stream is not followed again`, async () => {
    const h = follow(async () => jobOf(7));
    for (let index = 0; index < MAX_FALLBACKS; index++)
      await fallBack(h, index);
    expect(h.reads()).toBe(MAX_FALLBACKS);
    expect(h.errors).toEqual([]);
    expect(h.stream.connections).toHaveLength(MAX_FALLBACKS + 1);

    await fallBack(h, MAX_FALLBACKS);
    expect(h.reads()).toBe(MAX_FALLBACKS);
    expect(h.errors).toEqual([CONNECTION_LOST]);
    expect(h.clock.waits()).toEqual([]);
    expect(h.stream.connections).toHaveLength(MAX_FALLBACKS + 1);
    expect(h.stream.connections[MAX_FALLBACKS]?.closed).toBe(true);
  });

  test("a stream that keeps stopping after its first message counts as well", async () => {
    const h = follow(async () => jobOf(7));
    for (let index = 0; index < MAX_FALLBACKS; index++) {
      h.stream.send(index, snapshotOf(jobOf(2)));
      h.stream.end(index);
      await flush();
      h.clock.fire();
    }
    expect(h.errors).toEqual([]);
    h.stream.send(MAX_FALLBACKS, snapshotOf(jobOf(2)));
    h.stream.end(MAX_FALLBACKS);
    await flush();
    expect(h.reads()).toBe(MAX_FALLBACKS);
    expect(h.errors).toEqual([CONNECTION_LOST]);
    expect(h.clock.waits()).toEqual([]);
  });

  test("a connection that delivers a second good message starts the count again", async () => {
    const h = follow(async () => jobOf(7));
    for (let index = 0; index < MAX_FALLBACKS - 1; index++)
      await fallBack(h, index);
    // This connection makes progress: a whole job and a delta that applies.
    const progress = MAX_FALLBACKS - 1;
    h.stream.send(progress, snapshotOf(jobOf(2)));
    h.stream.send(progress, deltaOf(jobOf(2), jobOf(3)));
    h.stream.send(progress, raw("delta", "{"));
    await flush();
    h.clock.fire();
    for (let index = progress + 1; index < progress + MAX_FALLBACKS; index++)
      await fallBack(h, index);
    expect(h.errors).toEqual([]);
    expect(h.reads()).toBe(MAX_FALLBACKS - 1 + MAX_FALLBACKS);

    await fallBack(h, progress + MAX_FALLBACKS);
    expect(h.errors).toEqual([CONNECTION_LOST]);
  });
});

// ── Against the hearth's real route ─────────────────────────────────────────

const TOKEN = "9".repeat(64);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

/** Wait up to two seconds for `check` to hold; the caller asserts it. */
const until = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !check(); i++)
    await new Promise((done) => setTimeout(done, 10));
};

describe("followCouncilRun against the hearth's council route", () => {
  test("over HTTP with the operator token, a run of simulated seats: the request asks for deltas, the stream is one whole job and then deltas, and the jobs shown are exactly the jobs a client that asks for whole jobs is sent", async () => {
    const root = mkdtempSync(join(tmpdir(), "council-follow-"));
    let release = () => {};
    const open = new Promise<void>((done) => {
      release = done;
    });
    let reached = () => {};
    const blocked = new Promise<void>((done) => {
      reached = done;
    });
    const simulated = new FakeCouncilTransport();
    const gated: ModelTransport = {
      async generate(request, signal) {
        reached();
        await open;
        return simulated.generate(request, signal);
      },
    };
    const service = createCouncilService({
      workspaceRoot: root,
      harnessRoot: resolve(import.meta.dir, "../.."),
      runsRoot: join(root, "runs"),
      resolveTransport: () => () => gated,
    });
    let subscriptions = 0;
    const counted: typeof service = {
      ...service,
      subscribe(runId, listener) {
        subscriptions++;
        return service.subscribe(runId, listener);
      },
    };
    const handler = councilHttpHandler(counted, { expectedToken: () => TOKEN });
    const requested: string[] = [];
    const server: Server = createServer((req, res) => {
      requested.push(req.url ?? "");
      void handler(req, res, () => {
        res.statusCode = 404;
        res.end();
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No test server address");
    const api = `http://127.0.0.1:${address.port}${COUNCIL_API}`;
    cleanup.push(async () => {
      await service.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      rmSync(root, { recursive: true, force: true });
    });

    service.start({
      sourceType: "text",
      source: "Evaluate this plan and record any missing evidence.",
      runId: "followed",
    });
    await blocked;
    const withToken = (input: string, init?: RequestInit) =>
      fetch(input, {
        ...init,
        headers: { ...init?.headers, [OPERATOR_HEADER]: TOKEN },
      });
    // A client that asks for whole jobs, to compare with, subscribed at the same time.
    const whole = withToken(`${api}/runs/followed/events`).then((r) =>
      r.text(),
    );
    const kinds: string[] = [];
    const base = fetchTransport(councilRunEventsUrl(api, "followed"), {
      fetch: withToken,
    });
    const transport: StreamTransport = (last, handlers) =>
      base(last, {
        ...handlers,
        onMessage(message) {
          kinds.push(message.event);
          handlers.onMessage(message);
        },
      });
    const shown: CouncilServiceJob[] = [];
    let finished = 0;
    const follower = followCouncilRun({
      runId: "followed",
      transport,
      readRun: async () => {
        throw new Error("the run must not need a read");
      },
      onJob: (job) => shown.push(job),
      onError: (message) => {
        throw new Error(message);
      },
      onFinished: () => {
        finished += 1;
      },
    });
    cleanup.push(async () => follower.close());
    await until(() => subscriptions === 2);
    expect(subscriptions).toBe(2);
    release();
    const wholeBody = await whole;
    await until(() => finished > 0);

    expect(requested).toContain(
      "/__agent-forge/council-api/runs/followed/events?deltas=1",
    );
    expect(kinds[0]).toBe("snapshot");
    expect(kinds.filter((kind) => kind === "delta").length).toBeGreaterThan(10);
    const sentWhole = wholeBody
      .split("\n\n")
      .filter((block) => block.startsWith("event: snapshot"))
      .map(
        (block) =>
          JSON.parse(
            block.slice(block.indexOf("data: ") + 6),
          ) as CouncilServiceJob,
      );
    expect(shown).toHaveLength(kinds.length);
    expect(shown).toEqual(sentWhole);
    expect(shown.at(-1)?.status).toBe("completed");
    expect(shown.at(-1)?.events.length).toBeGreaterThan(10);
    expect(finished).toBe(1);
  }, 20_000);
});
