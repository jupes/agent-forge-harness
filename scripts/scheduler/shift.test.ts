import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LedgerEventInput } from "../../types/hearth";
import { claudeAdapter } from "../executors/claude";
import { liveChildCount } from "../executors/supervisor";
import type {
  ExecResult,
  ExecutorAdapter,
  SpawnRequest,
} from "../executors/types";
import type { BdResult, BdRunner } from "../hearth/routes/dev-api";
import { type AppendResult, appendEvent } from "../ledger/append";
import { closeLedger } from "../ledger/db";
import { activeReservations, queryEvents } from "../ledger/query";
import { resolveCheckout } from "../ledger/workspace";
import { createQueue } from "./queue";
import {
  answerQueueList,
  type QueueTracker,
  queueTracker,
  type TrackedBead,
} from "./queue-fixture";
import { runShift, type ShiftDeps, type ShiftOptions } from "./shift";
import { processAlive, readShiftRecord, requestStop } from "./shift-store";

/**
 * The shift loop, hermetic: `bd` is the queue's in-memory tracker, the
 * ledger, the lock and the shift records are in a temp home, worktrees are
 * plain directories under the temp root (each with a `.git` of its own, so a
 * run resolves to it and to nothing outside), and the provider is a fake.
 * Most tests use a fake adapter whose runs the test scripts; the kill test
 * runs the Claude adapter on the fake binary, behind a guard that refuses any
 * spawn without that override, so no test reaches a real provider CLI.
 */

const FAKE = join(
  import.meta.dir,
  "..",
  "executors",
  "fixtures",
  "fake-cli.ts",
);

const roots: string[] = [];
const ledgers: string[] = [];
afterAll(() => {
  for (const ledger of ledgers) closeLedger(ledger);
  for (const root of roots)
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

/** A queued bead, by the queue's own writing, with a file map of its own. */
function queued(
  id: string,
  files = `src/${id}/**`,
  more: Partial<TrackedBead> = {},
): TrackedBead {
  return {
    id,
    labels: ["queue:queued"],
    metadata: { queue_state: "queued" },
    description: `Work.\n\n## Files\n${files}\n`,
    ...more,
  };
}

/** What a scripted run does: end after `after` ms with `exit`, or run until it is stopped. */
type Plan = { after: number; exit: 0 | 1; costUsd?: number } | "hang";

interface FakeRun {
  beadId: string;
  prompt: string;
  worktree: string;
  timeoutMs: number | undefined;
  startedAt: number;
  endedAt?: number;
  /** Reservations held in the ledger when the run started. */
  reservedAtStart: number;
}

/**
 * An adapter that starts no process: each spawn is a run the plan scripts,
 * honouring `stop()` and the request's timeout as the real supervisor does.
 */
function fakeAdapter(
  plan: (beadId: string, attempt: number) => Plan,
  reservations: () => number,
) {
  const runs: FakeRun[] = [];
  let live = 0;
  let maxLive = 0;
  const attempts = new Map<string, number>();
  const adapter: ExecutorAdapter = {
    provider: "claude",
    doctor: async () => ({ provider: "claude", found: true, ok: true }),
    async spawn(request: SpawnRequest) {
      const attempt = (attempts.get(request.beadId) ?? 0) + 1;
      attempts.set(request.beadId, attempt);
      const run: FakeRun = {
        beadId: request.beadId,
        prompt: request.prompt,
        worktree: request.worktree,
        timeoutMs: request.timeoutMs,
        startedAt: Date.now(),
        reservedAtStart: reservations(),
      };
      runs.push(run);
      live++;
      maxLive = Math.max(maxLive, live);
      const sessionId = `fake-session-${runs.length}`;
      const step = plan(request.beadId, attempt);
      let finish: (result: ExecResult) => void = () => undefined;
      const done = new Promise<ExecResult>((resolve) => {
        finish = resolve;
      });
      const timers: Array<ReturnType<typeof setTimeout>> = [];
      let settled = false;
      let cost: number | undefined;
      const end = (how: Partial<ExecResult>) => {
        if (settled) return;
        settled = true;
        for (const timer of timers) clearTimeout(timer);
        live--;
        run.endedAt = Date.now();
        finish({
          exitCode: 0,
          timedOut: false,
          stopped: false,
          stderr: "",
          providerErrors: [],
          ...how,
        });
      };
      if (step !== "hang") {
        cost = step.costUsd;
        timers.push(setTimeout(() => end({ exitCode: step.exit }), step.after));
      }
      if (request.timeoutMs !== undefined)
        timers.push(
          setTimeout(
            () => end({ exitCode: 1, timedOut: true }),
            request.timeoutMs,
          ),
        );
      const base = {
        workspace: resolveCheckout(request.workspace).workspace,
        beadId: request.beadId,
        ...(request.runId !== undefined ? { runId: request.runId } : {}),
        sessionId,
      };
      async function* events(): AsyncGenerator<LedgerEventInput> {
        yield {
          ...base,
          kind: "session.started",
          payload: {
            source: "headless:claude",
            kind: "headless",
            worktree: request.worktree,
          },
        };
        const result = await done;
        yield {
          ...base,
          kind: "session.ended",
          payload: {
            reason: result.timedOut
              ? "timeout"
              : result.stopped
                ? "stopped: fake"
                : result.exitCode === 0
                  ? "completed"
                  : `failed: exit ${result.exitCode}`,
            ...(cost !== undefined && !result.stopped && !result.timedOut
              ? { usage: { costUsd: cost } }
              : {}),
          },
        };
      }
      return {
        sessionId,
        pid: 0,
        events: events(),
        done,
        stop: async () => {
          end({ exitCode: 1, stopped: true });
          await done;
        },
      };
    },
  };
  return {
    adapter,
    runs,
    maxLive: () => maxLive,
  };
}

interface Rig {
  root: string;
  home: string;
  ledger: string;
  workspace: string;
  tracker: QueueTracker;
  /** Every argument array `bd` was given. */
  calls: string[][];
  /** Answer a `bd` call yourself: return a result to use it, or nothing to let the tracker answer. */
  intercept: ((args: string[]) => BdResult | undefined) | null;
  deps: ShiftDeps;
  fake: ReturnType<typeof fakeAdapter>;
  labels(id: string): string[];
  reservations(): number;
  events(filter?: { runId?: string }): Array<{
    kind: string;
    runId?: string;
    beadId?: string;
    payload: unknown;
  }>;
}

const FAST: Partial<ShiftOptions> = { tickMs: 10, pollMs: 40, repairs: 0 };

function rig(
  beads: TrackedBead[],
  plan: (beadId: string, attempt: number) => Plan = () => ({
    after: 30,
    exit: 0,
  }),
  more: Partial<ShiftDeps> = {},
): Rig {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "af shift ")));
  roots.push(root);
  mkdirSync(join(root, ".git"));
  const home = join(root, "forge home");
  mkdirSync(home);
  const ledger = join(home, "ledger.db");
  ledgers.push(ledger);
  const { workspace } = resolveCheckout(root);
  const tracker = queueTracker(beads);
  const reservations = () =>
    activeReservations({ workspace }, { path: ledger }).length;
  const fake = fakeAdapter(plan, reservations);
  const calls: string[][] = [];
  // The tracker answers the queue's `show` and `update`; the list shapes of
  // eligibility are answered from the same beads.
  const runBd: BdRunner = async (args) => {
    calls.push(args);
    return (
      self.intercept?.(args) ??
      tracker.answer(args) ??
      answerQueueList(args, [...tracker.beads.values()]) ?? {
        status: 1,
        stdout: "",
        stderr: `Error: the test tracker does not answer: ${args.join(" ")}\n`,
      }
    );
  };
  const deps: ShiftDeps = {
    root,
    runBd,
    ledgerPath: ledger,
    lockFile: join(home, "queue-lock.db"),
    shiftsDir: join(home, "shifts"),
    mainCheckout: root,
    sampleHost: async () => ({ busy: false }),
    makeWorktree: ({ id }) => {
      const path = join(root, "trees", id);
      mkdirSync(join(path, ".git"), { recursive: true });
      return { ok: true, path };
    },
    exec: {
      env: { PATH: process.env["PATH"] ?? "", AGENT_FORGE_HOME: home },
      home: root,
      adapters: { claude: fake.adapter },
    },
    ...more,
  };
  const self: Rig = {
    root,
    home,
    ledger,
    workspace,
    tracker,
    calls,
    intercept: null,
    deps,
    fake,
    labels: (id) =>
      (tracker.beads.get(id)?.labels ?? []).filter((l) =>
        l.startsWith("queue:"),
      ),
    reservations,
    events: (filter = {}) =>
      queryEvents({ workspace, ...filter }, { path: ledger }).map((event) => ({
        kind: event.kind,
        ...(event.runId !== undefined ? { runId: event.runId } : {}),
        ...(event.beadId !== undefined ? { beadId: event.beadId } : {}),
        payload: event.payload,
      })),
  };
  return self;
}

async function shift(r: Rig, options: Partial<ShiftOptions> = {}) {
  const outcome = await runShift({ ...FAST, ...options }, r.deps);
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome.value;
}

/** Wait until `ready()` holds, or fail after `ms`. */
async function until(ready: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}

describe("forge:shift — the loop, on a fake adapter", () => {
  test("runs at most --concurrency beads at once, each in a worktree of its own holding a reservation of its own, and ends drained when nothing is left", async () => {
    const r = rig([queued("t-1"), queued("t-2"), queued("t-3")], () => ({
      after: 500,
      exit: 0,
    }));
    const done = await shift(r, { concurrency: 2 });
    expect(done.reason).toBe("drained");
    expect(r.fake.runs.map((run) => run.beadId).sort()).toEqual([
      "t-1",
      "t-2",
      "t-3",
    ]);
    expect(r.fake.maxLive()).toBe(2);
    // Never more reservations than runs: each run started holding its own.
    for (const run of r.fake.runs) {
      expect(run.reservedAtStart).toBeGreaterThanOrEqual(1);
      expect(run.reservedAtStart).toBeLessThanOrEqual(2);
    }
    expect(new Set(r.fake.runs.map((run) => run.worktree)).size).toBe(3);
    for (const id of ["t-1", "t-2", "t-3"])
      expect(r.labels(id)).toEqual(["queue:review"]);
    expect(r.reservations()).toBe(0);
    expect(
      done.record.beads.map((b) => [b.beadId, b.outcome, b.attempts]),
    ).toEqual([
      ["t-1", "review", 1],
      ["t-2", "review", 1],
      ["t-3", "review", 1],
    ]);
  });

  test("two beads whose file maps overlap never run at the same time, even with room for both", async () => {
    const r = rig(
      [queued("t-a", "src/**"), queued("t-b", "src/shared.ts")],
      () => ({ after: 80, exit: 0 }),
    );
    const done = await shift(r, { concurrency: 2 });
    expect(done.reason).toBe("drained");
    const [first, second] = r.fake.runs;
    expect(r.fake.runs).toHaveLength(2);
    expect(second?.startedAt ?? 0).toBeGreaterThanOrEqual(
      first?.endedAt ?? Infinity,
    );
    expect(r.fake.maxLive()).toBe(1);
  });

  test("only queued beads are taken: a proposed and an approved bead are not started until an operator queues them", async () => {
    const r = rig([
      {
        ...queued("t-p"),
        labels: ["queue:proposed"],
        metadata: { queue_state: "proposed" },
      },
      {
        ...queued("t-a"),
        labels: ["queue:approved"],
        metadata: { queue_state: "approved" },
      },
      // Inherited from a parent: the label without the queue's own backing.
      { ...queued("t-i"), metadata: {} },
      queued("t-q"),
    ]);
    const done = await shift(r, { concurrency: 2 });
    expect(done.reason).toBe("drained");
    expect(r.fake.runs.map((run) => run.beadId)).toEqual(["t-q"]);
    expect(r.labels("t-p")).toEqual(["queue:proposed"]);
    expect(r.labels("t-a")).toEqual(["queue:approved"]);
    expect(r.labels("t-i")).toEqual(["queue:queued"]);
    expect(r.labels("t-q")).toEqual(["queue:review"]);
  });

  test("the time cap: at --for every run is stopped, its bead put back in queued and its reservation released, and the shift ends elapsed", async () => {
    const r = rig([queued("t-1"), queued("t-2")], () => "hang");
    const began = Date.now();
    const done = await shift(r, { concurrency: 2, forMs: 1000 });
    expect(done.reason).toBe("elapsed");
    expect(Date.now() - began).toBeLessThan(6000);
    expect(r.fake.runs).toHaveLength(2);
    // Each run was given no more than the time that was left.
    for (const run of r.fake.runs)
      expect(run.timeoutMs ?? Infinity).toBeLessThanOrEqual(1000);
    for (const id of ["t-1", "t-2"])
      expect(r.labels(id)).toEqual(["queue:queued"]);
    expect(r.reservations()).toBe(0);
    expect(done.record.beads.map((b) => b.outcome)).toEqual([
      "released",
      "released",
    ]);
  });

  test("a failed run is repaired up to --repairs times, told how the run before it ended; then the bead is halted and its reservation released", async () => {
    const r = rig([queued("t-bad")], () => ({ after: 10, exit: 1 }));
    const done = await shift(r, { repairs: 2 });
    expect(done.reason).toBe("drained");
    expect(r.fake.runs).toHaveLength(3);
    expect(r.fake.runs[0]?.prompt).not.toContain("repair");
    expect(r.fake.runs[1]?.prompt).toContain(
      "This is repair 1 of 2. The run before it ended: provider exited 1",
    );
    expect(r.fake.runs[2]?.prompt).toContain("This is repair 2 of 2.");
    expect(r.labels("t-bad")).toEqual(["queue:halted"]);
    expect(r.reservations()).toBe(0);
    expect(done.record.beads[0]).toMatchObject({
      outcome: "halted",
      attempts: 3,
    });
  });

  test("a run that fails and then succeeds on repair is submitted for review", async () => {
    const r = rig([queued("t-flaky")], (_id, attempt) => ({
      after: 10,
      exit: attempt === 1 ? 1 : 0,
    }));
    const done = await shift(r, { repairs: 3 });
    expect(r.fake.runs).toHaveLength(2);
    expect(r.labels("t-flaky")).toEqual(["queue:review"]);
    expect(done.record.beads[0]).toMatchObject({
      outcome: "review",
      attempts: 2,
    });
  });

  test("a stop request (forge:shift stop, POST /shifts/:id/stop) ends the shift as operator: its runs are stopped, their beads released to queued and their reservations freed", async () => {
    const shiftId = "shift-20261014-120000-0a0b";
    const r = rig([queued("t-1"), queued("t-2")], () => "hang", { shiftId });
    const running = shift(r, { concurrency: 2 });
    await until(() => r.fake.runs.length === 2);
    expect(requestStop(r.deps.shiftsDir, shiftId)).toMatchObject({ ok: true });
    const done = await running;
    expect(done.reason).toBe("operator");
    for (const id of ["t-1", "t-2"])
      expect(r.labels(id)).toEqual(["queue:queued"]);
    expect(r.reservations()).toBe(0);
    expect(readShiftRecord(r.deps.shiftsDir, shiftId)).toMatchObject({
      state: "stopped",
      reason: "operator",
    });
  });

  test("a bead the operator pauses while it runs: its run is stopped, its reservation freed, and its queue state left as the operator put it", async () => {
    const r = rig([queued("t-1")], () => "hang");
    const running = shift(r, { pollMs: 30 });
    await until(() => r.fake.runs.length === 1);
    const operator = createQueue({
      workspace: r.workspace,
      runBd: r.tracker.run,
      appendEvent: (event) => appendEvent(event, { path: r.ledger }),
      lockFile: r.deps.lockFile,
    });
    expect(await operator.move("t-1", "pause", "operator")).toMatchObject({
      ok: true,
    });
    // With nothing else queued, the shift has nothing left once it lets the bead go.
    const done = await running;
    expect(done.reason).toBe("drained");
    expect(r.fake.runs[0]?.endedAt).toBeDefined();
    expect(r.reservations()).toBe(0);
    expect(r.labels("t-1")).toEqual(["queue:paused"]);
    expect(done.record.beads[0]).toMatchObject({ outcome: "left" });
    expect(done.record.beads[0]?.error).toContain("queue:paused");
  });

  test("--max-beads: the shift admits that many beads, then ends count once they are done; the rest stay queued", async () => {
    const r = rig([queued("t-1"), queued("t-2"), queued("t-3")]);
    const done = await shift(r, { concurrency: 1, maxBeads: 2 });
    expect(done.reason).toBe("count");
    expect(r.fake.runs.map((run) => run.beadId)).toEqual(["t-1", "t-2"]);
    expect(r.labels("t-3")).toEqual(["queue:queued"]);
  });

  test("--max-usd: once the runs reported that much spent nothing more is admitted, and the shift ends budget", async () => {
    const r = rig([queued("t-1"), queued("t-2"), queued("t-3")], () => ({
      after: 10,
      exit: 0,
      costUsd: 0.6,
    }));
    const done = await shift(r, { concurrency: 1, maxUsd: 1 });
    expect(done.reason).toBe("budget");
    expect(r.fake.runs.map((run) => run.beadId)).toEqual(["t-1", "t-2"]);
    expect(done.record.spentUsd).toBeCloseTo(1.2);
    expect(done.record.beads.map((b) => b.costUsd)).toEqual([0.6, 0.6]);
    expect(r.labels("t-3")).toEqual(["queue:queued"]);
  });

  test("a busy host admits nothing: the shift waits rather than drain, and ends at its time", async () => {
    const r = rig([queued("t-1")], undefined, {
      sampleHost: async () => ({
        busy: true,
        reason: "CPU 99% is at or above 85%",
      }),
    });
    const done = await shift(r, { forMs: 200 });
    expect(done.reason).toBe("elapsed");
    expect(r.fake.runs).toHaveLength(0);
    expect(r.tracker.updates()).toEqual([]);
  });

  test("--epic takes only the beads under it: a dotted id below it, or a bead whose parent it is", async () => {
    const r = rig([
      queued("ep-1.1"),
      queued("t-child", "src/child/**", { parent: { id: "ep-1" } }),
      queued("t-other"),
    ]);
    const done = await shift(r, { concurrency: 1, epic: "ep-1" });
    expect(done.reason).toBe("drained");
    expect(r.fake.runs.map((run) => run.beadId).sort()).toEqual([
      "ep-1.1",
      "t-child",
    ]);
    expect(r.labels("t-other")).toEqual(["queue:queued"]);
  });

  test("a bead whose claim bd refuses is set aside and the next one is run", async () => {
    const r = rig([queued("t-1"), queued("t-2")]);
    r.intercept = (args) =>
      args[0] === "update" &&
      args.at(-1) === "t-1" &&
      args.includes("--add-label=queue:running")
        ? { status: 1, stdout: "", stderr: "Error: database is locked\n" }
        : undefined;
    const done = await shift(r, { concurrency: 1 });
    expect(r.fake.runs.map((run) => run.beadId)).toEqual(["t-2"]);
    expect(done.record.beads[0]).toMatchObject({
      beadId: "t-1",
      outcome: "set-aside",
      attempts: 0,
    });
    expect(done.record.beads[0]?.error).toContain("start:");
    expect(r.labels("t-1")).toEqual(["queue:queued"]);
  });

  test("a bead whose worktree cannot be made is given back: its reservation freed and the bead released to queued, and it is not tried again by this shift", async () => {
    const r = rig([queued("t-1")], undefined, {
      makeWorktree: () => ({ ok: false, error: "trees/ is not ignored" }),
    });
    const done = await shift(r);
    expect(done.reason).toBe("drained");
    expect(r.fake.runs).toHaveLength(0);
    expect(r.labels("t-1")).toEqual(["queue:queued"]);
    expect(r.reservations()).toBe(0);
    expect(done.record.beads).toHaveLength(1);
    expect(done.record.beads[0]?.error).toContain(
      "worktree: trees/ is not ignored",
    );
  });

  test("a worktree maker that throws is a worktree that cannot be made: the bead is given back and the shift goes on", async () => {
    const r = rig([queued("t-1"), queued("t-2")], undefined, {
      makeWorktree: ({ id, beadId }) => {
        if (beadId === "t-1") throw new Error("git could not be started");
        const path = join(r.root, "trees", id);
        mkdirSync(join(path, ".git"), { recursive: true });
        return { ok: true, path };
      },
    });
    const done = await shift(r, { concurrency: 1 });
    expect(done.reason).toBe("drained");
    expect(r.fake.runs.map((run) => run.beadId)).toEqual(["t-2"]);
    expect(r.labels("t-1")).toEqual(["queue:queued"]);
    expect(r.reservations()).toBe(0);
    expect(done.record.beads[0]?.error).toContain(
      "worktree: git could not be started",
    );
  });

  test("eligibility that cannot be read three times in a row halts the shift, with nothing started", async () => {
    const r = rig([queued("t-1")]);
    r.intercept = (args) =>
      args[0] === "list"
        ? { status: 1, stdout: "", stderr: "Error: no database\n" }
        : undefined;
    const done = await shift(r, { pollMs: 1 });
    expect(done.reason).toBe("halted");
    expect(r.fake.runs).toHaveLength(0);
  });

  test("the ledger: shift.started first, shift.stopped last, and each bead's moves, reservations and session carry its run id", async () => {
    const r = rig([queued("t-1")]);
    const done = await shift(r, { maxBeads: 3, maxUsd: 5 });
    const events = r.events();
    expect(events[0]).toMatchObject({
      kind: "shift.started",
      payload: {
        shiftId: done.shiftId,
        concurrency: 2,
        durationMs: 7_200_000,
        maxBeads: 3,
        maxUsd: 5,
      },
    });
    expect(events.at(-1)).toMatchObject({
      kind: "shift.stopped",
      payload: { shiftId: done.shiftId, reason: "drained" },
    });
    const runId = done.record.beads[0]?.runId ?? "";
    expect(runId).toBe(`t-1-${done.shiftId}`);
    expect(
      r
        .events({ runId })
        .map((event) => [
          event.kind,
          (event.payload as { to?: string }).to ?? null,
        ]),
    ).toEqual([
      ["bead.transitioned", "running"],
      ["reservation.acquired", null],
      ["session.started", null],
      ["session.ended", null],
      ["bead.transitioned", "review"],
      ["reservation.released", null],
    ]);
    expect(done.recorded).toBe(true);
  });

  test("a ledger that does not store shift.started starts nothing: no bead is moved and the record says it stopped", async () => {
    const shiftId = "shift-20261014-120000-0c0d";
    const r = rig([queued("t-1")], undefined, {
      shiftId,
      appendEvent: (): AppendResult => ({ ok: false, error: "disk full" }),
    });
    const outcome = await runShift(FAST, r.deps);
    expect(outcome).toEqual({
      ok: false,
      error:
        "the ledger did not store shift.started (disk full); nothing was started",
    });
    expect(r.calls).toEqual([]);
    expect(readShiftRecord(r.deps.shiftsDir, shiftId)).toMatchObject({
      state: "stopped",
      reason: "halted",
    });
  });

  test("options that are not a shift's are refused before anything is written", async () => {
    const r = rig([queued("t-1")]);
    for (const [given, error] of [
      [{ concurrency: 0 }, "concurrency"],
      [{ forMs: 25 * 60 * 60 * 1000 }, "forMs"],
      [{ maxUsd: 0 }, "maxUsd"],
      [{ repairs: -1 }, "repairs"],
      [{ epic: "--all" }, "epic"],
      [{ smith: "no-such-smith" }, 'unknown smith "no-such-smith"'],
    ] as const) {
      const outcome = await runShift({ ...FAST, ...given }, r.deps);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toContain(error);
    }
    expect(existsSync(r.deps.shiftsDir)).toBe(false);
    expect(r.events()).toEqual([]);
  });
});

describe("forge:shift — stopping kills what it started (Claude adapter, fake binary)", () => {
  /** The Claude adapter, refusing any spawn that would run the real binary. */
  const guarded: ExecutorAdapter = {
    ...claudeAdapter,
    spawn: (request) => {
      if (request.command === undefined)
        throw new Error("a test reached for the real claude binary");
      return claudeAdapter.spawn(request);
    },
  };

  test("aborting the shift kills the provider process it started: the process is gone, no supervised child is left, and the bead is back in queued", async () => {
    const controller = new AbortController();
    const r = rig([queued("t-1")], undefined, { signal: controller.signal });
    const dump = join(r.root, "fake dump.json");
    r.deps.exec = {
      ...r.deps.exec,
      adapters: { claude: guarded },
      command: [
        process.execPath,
        FAKE,
        "--fake-provider",
        "claude",
        "--fake-mode",
        "hang",
        "--fake-dump",
        dump,
      ],
    };
    const running = shift(r);
    await until(() => existsSync(dump));
    const { pid, argv } = JSON.parse(readFileSync(dump, "utf8")) as {
      pid: number;
      argv: string[];
    };
    // The fake ran, with the adapter's own flags after the test's.
    expect(argv.slice(0, 4)).toEqual([
      "--fake-provider",
      "claude",
      "--fake-mode",
      "hang",
    ]);
    expect(argv).toContain("--permission-mode");
    expect(processAlive(pid)).toBe(true);
    controller.abort();
    const done = await running;
    expect(done.reason).toBe("operator");
    expect(processAlive(pid)).toBe(false);
    expect(liveChildCount()).toBe(0);
    expect(r.labels("t-1")).toEqual(["queue:queued"]);
    expect(r.reservations()).toBe(0);
    const ended = r.events().filter((event) => event.kind === "session.ended");
    expect(ended.map((event) => event.payload)).toMatchObject([
      { reason: "stopped: shift operator" },
    ]);
  }, 15_000);
});
