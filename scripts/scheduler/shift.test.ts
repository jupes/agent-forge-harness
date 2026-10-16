import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LedgerEventInput } from "../../types/hearth";
import { loadConfig } from "../config/load";
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
import { readEligibility } from "./eligibility";
import { createQueue } from "./queue";
import {
  answerQueueList,
  childOf,
  type QueueTracker,
  queueTracker,
  type TrackedBead,
} from "./queue-fixture";
import {
  runShift,
  SHIFT_ENDINGS,
  type ShiftDeps,
  type ShiftOptions,
  shiftOptions,
} from "./shift";
import { PR_FAILURES, type ToolResult, type ToolRun } from "./shift-pr";
import {
  processAlive,
  readShiftRecord,
  requestStop,
  writeShiftRecord,
} from "./shift-store";

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

/** What a scripted run does: end after `after` ms with `exit` (and `stderr`), or run until it is stopped. */
type Plan =
  | { after: number; exit: 0 | 1; costUsd?: number; stderr?: string }
  | "hang";

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
  onSpawn: (request: SpawnRequest) => void = () => undefined,
) {
  const runs: FakeRun[] = [];
  let live = 0;
  let maxLive = 0;
  const attempts = new Map<string, number>();
  const adapter: ExecutorAdapter = {
    provider: "claude",
    doctor: async () => ({ provider: "claude", found: true, ok: true }),
    async spawn(request: SpawnRequest) {
      onSpawn(request);
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
        timers.push(
          setTimeout(
            () => end({ exitCode: step.exit, stderr: step.stderr ?? "" }),
            step.after,
          ),
        );
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

interface Called {
  args: string[];
  cwd: string;
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
  /** Every git and gh call, and the start point of every worktree made. */
  git: Called[];
  gh: Called[];
  startPoints: string[];
  /** Answer a git or gh call yourself, as `intercept` does for bd. */
  gitAnswer: ((args: string[]) => ToolResult | undefined) | null;
  ghAnswer: ((args: string[]) => ToolResult | undefined) | null;
  /** `git <verb>`, `bd <verb>`, `gh <verb>` and `spawn <bead>`, in the order they happened. */
  order: string[];
  deps: ShiftDeps;
  fake: ReturnType<typeof fakeAdapter>;
  labels(id: string): string[];
  reservations(): number;
  /** The texts of the `comments add` calls for a bead, in order. */
  comments(id: string): string[];
  events(filter?: { runId?: string }): Array<{
    kind: string;
    runId?: string;
    beadId?: string;
    payload: unknown;
  }>;
}

const FAST: Partial<ShiftOptions> = { tickMs: 10, pollMs: 40, repairs: 0 };

/** The commit the fake git says origin's base names. */
const BASE_SHA = "b".repeat(40);

const answered = (stdout: string): ToolResult => ({
  status: 0,
  stdout,
  stderr: "",
});

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
  const order: string[] = [];
  const fake = fakeAdapter(plan, reservations, (request) =>
    order.push(`spawn ${request.beadId}`),
  );
  const calls: string[][] = [];
  // The tracker answers the queue's `show` and `update` and the shift's
  // comments; the list shapes of eligibility are answered from the same beads.
  const runBd: BdRunner = async (args) => {
    calls.push(args);
    order.push(`bd ${args[0]}`);
    return (
      self.intercept?.(args) ??
      tracker.answer(args) ??
      tracker.answerComment(args) ??
      answerQueueList(args, [...tracker.beads.values()]) ?? {
        status: 1,
        stdout: "",
        stderr: `Error: the test tracker does not answer: ${args.join(" ")}\n`,
      }
    );
  };
  // git answers as a repository whose origin has the base, and takes every
  // push; gh opens pull request after pull request. Neither is the real one.
  const git: ToolRun = async (args, cwd) => {
    self.git.push({ args: [...args], cwd });
    order.push(`git ${args[0]}`);
    const given = self.gitAnswer?.([...args]);
    if (given !== undefined) return given;
    if (args[0] === "fetch" || args[0] === "push") return answered("");
    if (args[0] === "rev-parse") return answered(`${BASE_SHA}\n`);
    if (args[0] === "log") return answered("abc1234 the run's work\n");
    return {
      status: 1,
      stdout: "",
      stderr: `the test's git does not answer: ${args.join(" ")}`,
    };
  };
  const gh: ToolRun = async (args, cwd) => {
    self.gh.push({ args: [...args], cwd });
    order.push(`gh ${args[0]}`);
    return (
      self.ghAnswer?.([...args]) ??
      answered(`https://github.com/example/harness/pull/${self.gh.length}\n`)
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
    makeWorktree: ({ id, startPoint }) => {
      self.startPoints.push(startPoint);
      const path = join(root, "trees", id);
      mkdirSync(join(path, ".git"), { recursive: true });
      return { ok: true, path };
    },
    git,
    gh,
    checkPrBody: async () => null,
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
    git: [],
    gh: [],
    startPoints: [],
    gitAnswer: null,
    ghAnswer: null,
    order,
    deps,
    fake,
    labels: (id) =>
      (tracker.beads.get(id)?.labels ?? []).filter((l) =>
        l.startsWith("queue:"),
      ),
    reservations,
    comments: (id) =>
      calls
        .filter((args) => args[0] === "comments" && args[4] === id)
        .map((args) => args[5] ?? ""),
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
  return ended(runShift({ ...FAST, ...options }, r.deps));
}

/** How a shift `runShift` was given ended; a refusal fails the test. */
async function ended(running: ReturnType<typeof runShift>) {
  const outcome = await running;
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

  test("only queued beads are taken: a proposed bead, an approved one and the child of a queued one are not started until an operator queues them", async () => {
    const parent = queued("t-q");
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
      // Made as `bd create --parent` makes it: the parent's queue:queued label, none of its backing.
      childOf(parent, "t-q.1"),
      parent,
    ]);
    const done = await shift(r, { concurrency: 2 });
    expect(done.reason).toBe("drained");
    expect(r.fake.runs.map((run) => run.beadId)).toEqual(["t-q"]);
    expect(r.labels("t-p")).toEqual(["queue:proposed"]);
    expect(r.labels("t-a")).toEqual(["queue:approved"]);
    expect(r.labels("t-q.1")).toEqual(["queue:queued"]);
    expect(r.labels("t-q")).toEqual(["queue:review"]);
  });

  test("the time cap: at --for every run is stopped, its bead put back in queued and its reservation released, and the shift ends elapsed", async () => {
    const r = rig([queued("t-1"), queued("t-2")], () => "hang");
    // Long enough for both runs to start first: on the windows-latest CI
    // runner a cap of 1 s ended the shift before either had started.
    const forMs = 3_000;
    const began = Date.now();
    const done = await shift(r, { concurrency: 2, forMs });
    expect(done.reason).toBe("elapsed");
    expect(Date.now() - began).toBeLessThan(forMs + 5_000);
    expect(r.fake.runs).toHaveLength(2);
    // Each run was given no more than the time that was left.
    for (const run of r.fake.runs)
      expect(run.timeoutMs ?? Infinity).toBeLessThanOrEqual(forMs);
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
    // It never started: no comment on it, and no pull request.
    expect(r.comments("t-1")).toEqual([]);
    expect(r.gh).toEqual([]);
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
      [{ base: "--upload-pack=x" }, "base"],
      [{ base: "shift/shift-20261014-120000-0a0b/t-1" }, "base"],
      [{ base: "a..b" }, "base"],
    ] as const) {
      const outcome = await runShift({ ...FAST, ...given }, r.deps);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toContain(error);
    }
    expect(existsSync(r.deps.shiftsDir)).toBe(false);
    expect(r.events()).toEqual([]);
    expect(r.git).toEqual([]);
  });
});

describe("forge:shift — the config's [shift]", () => {
  /** A sampler that is never busy and keeps the threshold of each call. */
  const sampled = () => {
    const thresholds: number[] = [];
    const sampleHost = async (threshold: number) => {
      thresholds.push(threshold);
      return { busy: false };
    };
    return { thresholds, sampleHost };
  };

  test("each bound not given is the workspace file's [shift] and a given one wins; the record carries the values that applied, throttle included, shift.started the bounds, and the host is sampled against [shift] throttle", async () => {
    const { thresholds, sampleHost } = sampled();
    const r = rig([queued("t-1"), queued("t-2"), queued("t-3")], undefined, {
      sampleHost,
    });
    writeFileSync(
      join(r.root, "agent-forge.toml"),
      '[shift]\nconcurrency = 1\nfor = "90m"\nmax_beads = 2\nmax_usd = 7\nrepairs = 2\nthrottle = 0.5\n',
    );
    // FAST gives repairs = 0, which wins over the file's 2.
    const done = await shift(r);
    expect(done.reason).toBe("count");
    expect(r.fake.maxLive()).toBe(1);
    expect(r.fake.runs.map((run) => run.beadId)).toEqual(["t-1", "t-2"]);
    expect(done.record.options).toEqual({
      concurrency: 1,
      forMs: 90 * 60_000,
      maxBeads: 2,
      maxUsd: 7,
      repairs: 0,
      throttle: 0.5,
      base: "master",
    });
    expect(r.events()[0]).toMatchObject({
      kind: "shift.started",
      payload: {
        concurrency: 1,
        durationMs: 90 * 60_000,
        maxBeads: 2,
        maxUsd: 7,
      },
    });
    expect(thresholds.length).toBeGreaterThan(0);
    expect([...new Set(thresholds)]).toEqual([0.5]);
  });

  test("a [shift] key the machine file sets applies with a workspace file present, and the workspace file wins a key both set", async () => {
    const r = rig([queued("t-1")]);
    // The rig's home stands in for the OS home: its machine file is here.
    mkdirSync(join(r.root, ".agent-forge"), { recursive: true });
    writeFileSync(
      join(r.root, ".agent-forge", "config.toml"),
      "[shift]\nmax_usd = 3\nmax_beads = 9\n",
    );
    writeFileSync(join(r.root, "agent-forge.toml"), "[shift]\nmax_beads = 5\n");
    const done = await shift(r);
    expect(done.record.options).toMatchObject({ maxUsd: 3, maxBeads: 5 });
  });

  test("with no [shift] each bound not given is the builtin, and the host is sampled against the builtin threshold, which the record names", async () => {
    const { thresholds, sampleHost } = sampled();
    const r = rig([queued("t-1")], undefined, { sampleHost });
    const done = await shift(r);
    expect(done.record.options).toEqual({
      concurrency: 2,
      forMs: 2 * 3_600_000,
      maxBeads: 4,
      maxUsd: 10,
      repairs: 0,
      throttle: 0.85,
      base: "master",
    });
    expect([...new Set(thresholds)]).toEqual([0.85]);
  });

  test("a [shift] value outside the shift's bounds refuses the shift before anything is done, naming the file and the key", async () => {
    const r = rig([queued("t-1")]);
    const file = join(r.root, "agent-forge.toml");
    writeFileSync(file, "[shift]\nmax_usd = 0\n");
    expect(await runShift(FAST, r.deps)).toEqual({
      ok: false,
      error: `the config could not be read: ${file}: shift.max_usd: expected dollars above 0, at most 1000`,
    });
    expect(existsSync(r.deps.shiftsDir)).toBe(false);
    expect(r.events()).toEqual([]);
    expect(r.git).toEqual([]);
    expect(r.calls).toEqual([]);
  });

  test("shiftOptions and the [shift] loader refuse a value one past each bound with the same words", () => {
    const cases: Array<[keyof ShiftOptions, string, number]> = [
      ["concurrency", "concurrency", 9],
      ["concurrency", "concurrency", 0],
      ["maxBeads", "max_beads", 101],
      ["repairs", "repairs", 11],
      ["maxUsd", "max_usd", 1000.01],
      ["maxUsd", "max_usd", 0],
    ];
    for (const [field, key, value] of cases) {
      const option = shiftOptions({ [field]: value });
      if (option.ok) throw new Error(`shiftOptions took ${field} = ${value}`);
      expect(option.error).toStartWith(`${field}: expected`);
      const words = option.error.slice(`${field}: `.length);
      const root = realpathSync.native(mkdtempSync(join(tmpdir(), "af cfg ")));
      roots.push(root);
      const file = join(root, "agent-forge.toml");
      writeFileSync(file, `[shift]\n${key} = ${value}\n`);
      expect(() =>
        loadConfig({ harnessRoot: root, home: root, env: {} }),
      ).toThrow(`${file}: shift.${key}: ${words}`);
    }
  });
});

describe("forge:shift — the base, the draft pull request and the worklog comments", () => {
  test("origin's base is fetched before anything else, and every worktree of the shift starts at the commit it names; --base names another branch, and the pull requests go into it", async () => {
    const r = rig([queued("t-1"), queued("t-2")]);
    const done = await shift(r, { concurrency: 2, base: "release/2" });
    expect(done.reason).toBe("drained");
    expect(r.order[0]).toBe("git fetch");
    expect(r.git[0]).toEqual({
      args: [
        "fetch",
        "--no-tags",
        "origin",
        "+refs/heads/release/2:refs/remotes/origin/release/2",
      ],
      cwd: r.root,
    });
    expect(r.startPoints).toEqual([BASE_SHA, BASE_SHA]);
    expect(done.record.options.base).toBe("release/2");
    expect(done.record.baseSha).toBe(BASE_SHA);
    expect(
      r.gh.map((call) => call.args.find((arg) => arg.startsWith("--base="))),
    ).toEqual(["--base=release/2", "--base=release/2"]);
  });

  test("a base that cannot be fetched refuses the shift before anything is written: no record, no event, no bd call", async () => {
    const r = rig([queued("t-1")]);
    r.gitAnswer = (args) =>
      args[0] === "fetch"
        ? {
            status: 128,
            stdout: "",
            stderr: "fatal: couldn't find remote ref refs/heads/release\n",
          }
        : undefined;
    const outcome = await runShift({ ...FAST, base: "release" }, r.deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("the base could not be fetched");
      expect(outcome.error).toContain("couldn't find remote ref");
      expect(outcome.error).toContain("nothing was started");
    }
    expect(r.calls).toEqual([]);
    expect(existsSync(r.deps.shiftsDir)).toBe(false);
    expect(r.events()).toEqual([]);
  });

  test("a bead that reaches review gets a draft pull request once it is in review: only its shift branch is pushed, gh opens it into the base, and its URL is on the bead's record entry", async () => {
    const r = rig([queued("t-1")]);
    let labelAtGh: string[] = [];
    r.ghAnswer = () => {
      labelAtGh = r.labels("t-1");
      return undefined;
    };
    const done = await shift(r);
    const branch = `shift/${done.shiftId}/t-1`;
    const entry = done.record.beads[0];
    expect(entry).toMatchObject({
      outcome: "review",
      prUrl: "https://github.com/example/harness/pull/1",
      prBody: "shift",
    });
    expect(entry?.error).toBeUndefined();
    expect(labelAtGh).toEqual(["queue:review"]);
    expect(
      r.git.filter((call) => call.args[0] === "push").map((call) => call),
    ).toEqual([
      {
        args: [
          "push",
          "--porcelain",
          "--no-follow-tags",
          "--recurse-submodules=no",
          "origin",
          `${BASE_SHA}:refs/heads/${branch}`,
        ],
        cwd: r.root,
      },
    ]);
    expect(r.gh).toHaveLength(1);
    expect(r.gh[0]?.args.slice(0, 5)).toEqual([
      "pr",
      "create",
      "--draft",
      "--base=master",
      `--head=${branch}`,
    ]);
    expect(r.gh[0]?.cwd).toBe(r.root);
    // Nothing merges, nothing is marked ready.
    for (const call of r.gh)
      expect(call.args.filter((arg) => /merge|ready/.test(arg))).toEqual([]);
  });

  test("a pull request step that fails leaves the bead in review with the reason on its record entry and a fixed sentence in its end comment, and the shift goes on to the next bead", async () => {
    const r = rig([queued("t-1"), queued("t-2"), queued("t-3")]);
    r.gitAnswer = (args) =>
      args[0] === "push" && (args.at(-1) ?? "").endsWith("/t-1")
        ? {
            status: 1,
            stdout: "",
            stderr: " ! [remote rejected] (pre-receive hook declined)\n",
          }
        : undefined;
    r.ghAnswer = (args) =>
      args.some((arg) => arg.startsWith("--head=") && arg.endsWith("/t-2"))
        ? {
            status: 1,
            stdout: "",
            stderr: "GraphQL: Resource not accessible (createPullRequest)\n",
          }
        : undefined;
    const done = await shift(r, { concurrency: 1 });
    expect(done.reason).toBe("drained");
    for (const id of ["t-1", "t-2", "t-3"])
      expect(r.labels(id)).toEqual(["queue:review"]);
    const [one, two, three] = done.record.beads;
    expect(one).toMatchObject({ outcome: "review" });
    expect(one?.prUrl).toBeUndefined();
    expect(one?.error).toContain("pull request: push:");
    expect(one?.error).toContain("pre-receive hook declined");
    expect(two?.prUrl).toBeUndefined();
    expect(two?.error).toContain("pull request: gh:");
    expect(three?.prUrl).toMatch(/\/pull\/\d+$/);
    expect(three?.error).toBeUndefined();
    const ended = (id: string) => r.comments(id).at(-1) ?? "";
    expect(ended("t-1")).toContain(PR_FAILURES.push);
    expect(ended("t-1")).not.toContain("pre-receive");
    expect(ended("t-2")).toContain(PR_FAILURES.gh);
    expect(ended("t-2")).not.toContain("GraphQL");
    expect(ended("t-3")).toContain(three?.prUrl ?? "no url");
  });

  test("a body that looks like it holds a secret is not pushed or posted: the bead stays in review, its record and end comment name a body failure, and neither holds the secret", async () => {
    const token = `ghp_${"Zx9Qw8Er7Ty6".repeat(3)}`;
    const r = rig([queued("t-1")]);
    // The run's one commit names the key; the shift's own body would list it.
    r.gitAnswer = (args) =>
      args[0] === "log" ? answered(`abc1234 add ${token}\n`) : undefined;
    const done = await shift(r);
    const entry = done.record.beads[0];
    expect(entry).toMatchObject({ outcome: "review", prBody: "shift" });
    expect(entry?.prUrl).toBeUndefined();
    expect(entry?.error).toContain("pull request: body:");
    expect(entry?.error).toContain("github-token");
    expect(r.gh).toEqual([]);
    expect(r.git.filter((call) => call.args[0] === "push")).toEqual([]);
    expect(r.comments("t-1").at(-1)).toContain(PR_FAILURES.body);
    for (const text of r.comments("t-1")) expect(text).not.toContain(token);
    expect(
      readFileSync(join(r.deps.shiftsDir, `${done.shiftId}.json`), "utf8"),
    ).not.toContain(token);
  });

  test("a bead that ran gets one worklog: comment when it starts and one when it ends, each a single bd comments add with every value after --", async () => {
    const r = rig([queued("t-1")]);
    const done = await shift(r);
    const entry = done.record.beads[0];
    if (entry === undefined) throw new Error("no bead");
    const posted = r.calls.filter((args) => args[0] === "comments");
    expect(posted).toHaveLength(2);
    for (const args of posted) {
      expect(args.slice(0, 5)).toEqual([
        "comments",
        "add",
        "--json",
        "--",
        "t-1",
      ]);
      expect(args).toHaveLength(6);
    }
    expect(r.comments("t-1")).toEqual([
      `worklog: shift ${done.shiftId} started this bead: run ${entry.runId}, smith ${entry.smith}, worktree ${entry.worktree}, branch ${entry.branch}. Its events: bun run forge:audit --run ${entry.runId}.`,
      `worklog: shift ${done.shiftId} ended this bead after 1 run: review. A run succeeded and the bead was submitted for review. Draft pull request: ${entry.prUrl}.`,
    ]);
    expect(r.tracker.beads.get("t-1")?.comments).toEqual(r.comments("t-1"));
    // Started before its first run; ended after its pull request.
    const at = (step: string) => r.order.indexOf(step);
    expect(at("bd comments")).toBeLessThan(at("spawn t-1"));
    expect(r.order.lastIndexOf("bd comments")).toBeGreaterThan(at("gh pr"));
    expect(entry.commentError).toBeUndefined();
  });

  test("the end comment of a bead halted, released or left gives the run count and a fixed reason, never the provider's own words", async () => {
    const words = "PROVIDER-PRIVATE: the key is in ~/.secret";
    const halted = rig([queued("t-bad")], () => ({
      after: 10,
      exit: 1,
      stderr: words,
    }));
    const h = await shift(halted, { repairs: 1 });
    expect(h.record.beads[0]?.error).toContain("PROVIDER-PRIVATE");
    expect(halted.comments("t-bad").at(-1)).toBe(
      `worklog: shift ${h.shiftId} ended this bead after 2 runs: halted. Every run failed; the bead was halted, and the operator's queue action is the way out.`,
    );

    const released = rig([queued("t-1")], () => "hang");
    const rel = await shift(released, { forMs: 400 });
    expect(released.comments("t-1").at(-1)).toBe(
      `worklog: shift ${rel.shiftId} ended this bead after 1 run: released. The shift stopped its run (its time ran out, or it was asked to stop) and put the bead back in queued.`,
    );

    const left = rig([queued("t-1")], () => "hang");
    const running = shift(left, { pollMs: 30 });
    await until(() => left.fake.runs.length === 1);
    const operator = createQueue({
      workspace: left.workspace,
      runBd: left.tracker.run,
      appendEvent: (event) => appendEvent(event, { path: left.ledger }),
      lockFile: left.deps.lockFile,
    });
    expect((await operator.move("t-1", "pause", "operator")).ok).toBe(true);
    const l = await running;
    expect(left.comments("t-1").at(-1)).toBe(
      `worklog: shift ${l.shiftId} ended this bead after 1 run: left. It was moved while it ran (it is queue:paused) and was left as it is.`,
    );
    for (const r of [halted, released, left])
      for (const text of r.calls
        .filter((args) => args[0] === "comments")
        .map((args) => args[5] ?? ""))
        expect(text).not.toContain("PROVIDER-PRIVATE");
  });

  test("a comment bd refuses is written on the bead's record entry and stops nothing: the bead still ends in review with its pull request, and the next bead still runs", async () => {
    const r = rig([queued("t-1"), queued("t-2")]);
    r.intercept = (args) =>
      args[0] === "comments" && args[4] === "t-1"
        ? {
            status: 1,
            stdout: `${JSON.stringify({ error: "database is locked" })}\n`,
            stderr: `Command failed: bd ${args.join(" ")}`,
          }
        : undefined;
    const done = await shift(r, { concurrency: 1 });
    expect(done.reason).toBe("drained");
    const [one, two] = done.record.beads;
    expect(one).toMatchObject({ outcome: "review" });
    expect(one?.prUrl).toBeDefined();
    expect(one?.error).toBeUndefined();
    expect(one?.commentError).toBe(
      "started comment: bd comments add failed: database is locked; ended comment: bd comments add failed: database is locked",
    );
    expect(two).toMatchObject({ outcome: "review" });
    expect(two?.commentError).toBeUndefined();
    expect(r.tracker.beads.get("t-2")?.comments).toHaveLength(2);
    // Each comment was asked for once: none is repeated.
    expect(
      r.calls.filter((args) => args[0] === "comments" && args[4] === "t-1"),
    ).toHaveLength(2);
  });
});

describe("forge:shift — a bead resumed before its shift read it back (x1gs.5.4.13)", () => {
  /** The operator's queue, as the hearth moves beads: no run id on its events. */
  const operatorQueue = (r: Rig) =>
    createQueue({
      workspace: r.workspace,
      runBd: r.tracker.run,
      appendEvent: (event) => appendEvent(event, { path: r.ledger }),
      lockFile: r.deps.lockFile,
    });
  const runsOf = (r: Rig, beadId: string) =>
    r.fake.runs.filter((run) => run.beadId === beadId);

  /** A shift's own `bd`: the first call `holds` picks waits until `open()`. */
  function gated(r: Rig, holds: (args: string[]) => boolean) {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((done) => {
      open = done;
    });
    const state = { used: false, held: false };
    const runBd: BdRunner = async (args) => {
      if (!state.used && holds(args)) {
        state.used = true;
        state.held = true;
        await gate;
      }
      return r.deps.runBd(args);
    };
    return { runBd, state, open: () => open() };
  }

  /** A shift run in the background, with a flag for when it has ended. */
  function background(
    options: Partial<ShiftOptions>,
    deps: ShiftDeps,
  ): { done: () => boolean; outcome: ReturnType<typeof runShift> } {
    let finished = false;
    const outcome = runShift({ ...FAST, ...options }, deps);
    void outcome.finally(() => {
      finished = true;
    });
    return { done: () => finished, outcome };
  }

  const startsOf = (r: Rig, runId: string) =>
    r
      .events({ runId })
      .filter(
        (event) =>
          event.kind === "bead.transitioned" &&
          (event.payload as { to?: string }).to === "running",
      );

  test("P1, the gap between a shift's start and its reserve: paused and resumed there, and started and reserved by a second shift meanwhile, the first shift's reserve is refused, it gives the bead back, and only one run ever runs", async () => {
    const A = "shift-20261015-130000-0a11";
    const B = "shift-20261015-130000-0b12";
    const r = rig([queued("t-1")], () => "hang");
    // A holds at its read of t-1 that follows its start: before its reserve.
    let startedByA = false;
    const gate = gated(
      r,
      (args) => startedByA && args[0] === "show" && args.at(-1) === "t-1",
    );
    const runA: BdRunner = async (args) => {
      const result = await gate.runBd(args);
      if (
        args[0] === "update" &&
        args.at(-1) === "t-1" &&
        args.includes("--add-label=queue:running")
      )
        startedByA = true;
      return result;
    };
    const stopA = new AbortController();
    const stopB = new AbortController();
    const a = background(
      { concurrency: 1, maxBeads: 1 },
      { ...r.deps, shiftId: A, runBd: runA, signal: stopA.signal },
    );
    let b: ReturnType<typeof background> | undefined;
    try {
      await until(() => gate.state.held);
      const operator = operatorQueue(r);
      expect((await operator.move("t-1", "pause", "operator")).ok).toBe(true);
      expect((await operator.move("t-1", "resume", "operator")).ok).toBe(true);
      // B reads eligibility now: t-1 is queued and holds no reservation.
      b = background(
        { concurrency: 1 },
        { ...r.deps, shiftId: B, signal: stopB.signal },
      );
      await until(() => r.fake.runs.length === 1);
      expect(r.fake.runs[0]?.worktree).toContain(B);
      gate.open();
      const first = await ended(a.outcome);
      expect(r.fake.maxLive()).toBe(1);
      expect(first.record.beads[0]).toMatchObject({ outcome: "set-aside" });
      expect(first.record.beads[0]?.error).toContain(
        `reservation: t-1 is still held in`,
      );
      expect(first.record.beads[0]?.error).toContain(`shift ${B} (live)`);
      // B reads t-1 back out of running and lets its run go.
      const second = await ended(b.outcome);
      expect(second.record.beads[0]).toMatchObject({ outcome: "left" });
    } finally {
      stopA.abort();
      stopB.abort();
      await a.outcome.catch(() => undefined);
      await b?.outcome.catch(() => undefined);
    }
    expect(r.fake.maxLive()).toBe(1);
    expect(r.fake.runs).toHaveLength(1);
    expect(r.labels("t-1")).toEqual(["queue:queued"]);
    expect(r.reservations()).toBe(0);
    const now = await readEligibility({
      root: r.root,
      runBd: r.deps.runBd,
      ledgerPath: r.ledger,
      host: { busy: false },
      shiftsDir: r.deps.shiftsDir,
    });
    expect(now.ok ? now.value.eligible.map((e) => e.id) : []).toEqual(["t-1"]);
  });

  for (const unstored of [false, true])
    test(
      unstored
        ? "P6, a second shift's start the ledger did not store: its reserve is still refused, it gives the bead back, and the first shift's run is the only one; that run lets it go once it reads it back"
        : "P2, a second shift acting on an eligibility read taken before the first shift claimed the bead: its start goes through after a pause and resume, its reserve is refused, it gives the bead back, and the first shift's run is the only one; that run lets it go once it reads it back",
      async () => {
        const A = "shift-20261015-140000-0a21";
        const B = "shift-20261015-140000-0b22";
        // Under an epic, so B reads t-1 once more (outside the queue lock)
        // between its eligibility read and its start: there it is held.
        const r = rig(
          [queued("t-1", "src/t-1/**", { parent: { id: "ep-9" } })],
          () => "hang",
        );
        let skewA = 0;
        const gate = gated(
          r,
          (args) => args[0] === "show" && args.at(-1) === "t-1",
        );
        const stopA = new AbortController();
        const stopB = new AbortController();
        const b = background(
          { concurrency: 1, epic: "ep-9" },
          {
            ...r.deps,
            shiftId: B,
            runBd: gate.runBd,
            signal: stopB.signal,
            ...(unstored
              ? {
                  appendEvent: (event: LedgerEventInput): AppendResult =>
                    event.kind === "bead.transitioned"
                      ? { ok: false, error: "disk full" }
                      : appendEvent(event, { path: r.ledger }),
                }
              : {}),
          },
        );
        let a: ReturnType<typeof background> | undefined;
        try {
          await until(() => gate.state.held);
          // A claims t-1, reserves it and runs it; its watch waits for the clock.
          a = background(
            { concurrency: 1, maxBeads: 1, pollMs: 60_000 },
            {
              ...r.deps,
              shiftId: A,
              signal: stopA.signal,
              now: () => new Date(Date.now() + skewA),
            },
          );
          await until(() => r.fake.runs.length === 1);
          const operator = operatorQueue(r);
          expect((await operator.move("t-1", "pause", "operator")).ok).toBe(
            true,
          );
          expect((await operator.move("t-1", "resume", "operator")).ok).toBe(
            true,
          );
          gate.open();
          await until(() => b.done() || r.fake.runs.length > 1);
          expect(r.fake.runs).toHaveLength(1);
          const second = await ended(b.outcome);
          expect(second.record.beads[0]).toMatchObject({
            outcome: "set-aside",
          });
          expect(second.record.beads[0]?.error).toContain(`shift ${A} (live)`);
          expect(startsOf(r, `t-1-${B}`)).toHaveLength(unstored ? 0 : 1);
          // A's next read finds t-1 out of running: its run is let go.
          skewA += 60_000;
          const first = await ended(a.outcome);
          expect(first.record.beads[0]).toMatchObject({ outcome: "left" });
          expect(first.record.beads[0]?.error).toContain("queue:queued");
        } finally {
          stopA.abort();
          stopB.abort();
          await b.outcome.catch(() => undefined);
          await a?.outcome.catch(() => undefined);
        }
        expect(r.fake.maxLive()).toBe(1);
        expect(r.labels("t-1")).toEqual(["queue:queued"]);
        expect(r.reservations()).toBe(0);
      },
    );

  test("a ledger read that fails tells the watch nothing: a healthy run read back as running goes on", async () => {
    let skew = 0;
    let reads = 0;
    const r = rig([queued("t-1")], () => "hang", {
      now: () => new Date(Date.now() + skew),
      queryEvents: () => {
        reads++;
        throw new Error("database is locked");
      },
    });
    const stop = new AbortController();
    const running = runShift(
      { ...FAST, pollMs: 60_000 },
      { ...r.deps, signal: stop.signal },
    );
    try {
      await until(() => r.fake.runs.length === 1);
      skew += 60_000;
      await until(() => reads > 0);
      // Ticks later the run is still going.
      await Bun.sleep(100);
      expect(r.fake.runs[0]?.endedAt).toBeUndefined();
    } finally {
      stop.abort();
    }
    const done = await ended(running);
    expect(done.reason).toBe("operator");
    expect(done.record.beads[0]).toMatchObject({ outcome: "released" });
    expect(r.labels("t-1")).toEqual(["queue:queued"]);
  });

  test("a second shift does not start a bead paused and resumed while the first runs it, until that run has ended and released its reservation; then it does", async () => {
    const A = "shift-20261015-120000-0a01";
    const B = "shift-20261015-120000-0b02";
    const r = rig([queued("t-1"), queued("t-2")], () => "hang");
    const stopA = new AbortController();
    const stopB = new AbortController();
    // A takes t-1 only, and never reads it back during the test (pollMs).
    const first = runShift(
      { ...FAST, concurrency: 1, maxBeads: 1, pollMs: 600_000 },
      { ...r.deps, shiftId: A, signal: stopA.signal },
    );
    let second: ReturnType<typeof runShift> | undefined;
    try {
      await until(() => runsOf(r, "t-1").length === 1);
      const operator = operatorQueue(r);
      expect((await operator.move("t-1", "pause", "operator")).ok).toBe(true);
      expect((await operator.move("t-1", "resume", "operator")).ok).toBe(true);
      expect(r.labels("t-1")).toEqual(["queue:queued"]);

      // What every reader of eligibility sees now (the Workbench too).
      const seen = await readEligibility({
        root: r.root,
        runBd: r.deps.runBd,
        ledgerPath: r.ledger,
        host: { busy: false },
        shiftsDir: r.deps.shiftsDir,
      });
      if (!seen.ok) throw new Error(seen.error);
      expect(seen.value.waiting.find((w) => w.id === "t-1")).toMatchObject({
        waitsOnShift: A,
      });
      expect(seen.value.waiting.find((w) => w.id === "t-1")?.why).toContain(
        "has not ended",
      );

      second = runShift(
        { ...FAST, concurrency: 2 },
        { ...r.deps, shiftId: B, signal: stopB.signal },
      );
      await until(() => runsOf(r, "t-2").length === 1);
      // Let B read eligibility again and again while A's run goes on (B,
      // with a slot free, reads every pollMs), or start t-1 a second time.
      const lists = () => r.calls.filter((args) => args[0] === "list").length;
      const listed = lists();
      await until(() => lists() >= listed + 10 || runsOf(r, "t-1").length > 1);
      expect(runsOf(r, "t-1")).toHaveLength(1);
      expect(runsOf(r, "t-1")[0]?.endedAt).toBeUndefined();

      // A stops: its run ends, and A releases its reservation of t-1.
      stopA.abort();
      const a = await ended(first);
      expect(a.reason).toBe("operator");
      await until(() => runsOf(r, "t-1").length === 2);
      const [earlier, later] = runsOf(r, "t-1");
      expect(later?.worktree).toContain(B);
      expect(later?.startedAt ?? 0).toBeGreaterThanOrEqual(
        earlier?.endedAt ?? Number.POSITIVE_INFINITY,
      );
      // B claimed it only after A's reservation was released.
      const events = r.events();
      const freedByA = events.findIndex(
        (event) =>
          event.kind === "reservation.released" && event.runId === `t-1-${A}`,
      );
      const startedByB = events.findIndex(
        (event) =>
          event.kind === "bead.transitioned" &&
          event.runId === `t-1-${B}` &&
          (event.payload as { to?: string }).to === "running",
      );
      expect(freedByA).toBeGreaterThan(-1);
      expect(startedByB).toBeGreaterThan(freedByA);
    } finally {
      stopA.abort();
      stopB.abort();
      await first.catch(() => undefined);
      await second?.catch(() => undefined);
    }
    for (const id of ["t-1", "t-2"])
      expect(r.labels(id)).toEqual(["queue:queued"]);
    expect(r.reservations()).toBe(0);
  });

  test("a reservation a stopped shift left behind (its release failed) does not keep the bead from the next shift, which reads that shift's record", async () => {
    const gone = "shift-20261015-110000-0c03";
    const r = rig([queued("t-1")]);
    writeShiftRecord(r.deps.shiftsDir, {
      shiftId: gone,
      pid: process.pid,
      workspace: r.workspace,
      startedAt: "2026-10-15T11:00:00.000Z",
      deadline: "2026-10-15T13:00:00.000Z",
      endedAt: "2026-10-15T11:30:00.000Z",
      state: "stopped",
      reason: "operator",
      options: {
        concurrency: 2,
        forMs: 7_200_000,
        maxBeads: 4,
        maxUsd: 10,
        repairs: 0,
      },
      spentUsd: 0,
      unpriced: 0,
      beads: [],
    });
    appendEvent(
      {
        kind: "reservation.acquired",
        workspace: r.workspace,
        beadId: "t-1",
        payload: {
          worktree: join(r.root, "trees", `${gone}-1`),
          globs: ["src/t-1/**"],
        },
      },
      { path: r.ledger },
    );
    const done = await shift(r);
    expect(done.reason).toBe("drained");
    expect(r.fake.runs.map((run) => run.beadId)).toEqual(["t-1"]);
    expect(r.labels("t-1")).toEqual(["queue:review"]);
  });

  test("a bead another run started since this shift started it: the watch stops this shift's run as left, its reservation freed, and leaves the bead running for that run", async () => {
    let skew = 0;
    const r = rig([queued("t-1")], () => "hang", {
      now: () => new Date(Date.now() + skew),
    });
    const stop = new AbortController();
    const running = runShift(
      { ...FAST, pollMs: 60_000 },
      { ...r.deps, signal: stop.signal },
    );
    try {
      await until(() => r.fake.runs.length === 1);
      const operator = operatorQueue(r);
      expect((await operator.move("t-1", "pause", "operator")).ok).toBe(true);
      expect((await operator.move("t-1", "resume", "operator")).ok).toBe(true);
      // Another shift's claim, as its queue records it: with its run id.
      const other = createQueue({
        workspace: r.workspace,
        runBd: r.tracker.run,
        appendEvent: (event) =>
          appendEvent({ ...event, runId: "t-1-other-run" }, { path: r.ledger }),
        lockFile: r.deps.lockFile,
      });
      expect((await other.move("t-1", "start", "scheduler")).ok).toBe(true);
      // The shift's next tick reads the bead back.
      skew += 60_000;
      await until(() => r.fake.runs[0]?.endedAt !== undefined);
    } finally {
      stop.abort();
    }
    const done = await ended(running);
    expect(r.labels("t-1")).toEqual(["queue:running"]);
    expect(r.reservations()).toBe(0);
    expect(done.record.beads[0]).toMatchObject({ outcome: "left" });
    expect(done.record.beads[0]?.error).toContain(
      "another run (t-1-other-run) started the bead",
    );
    expect(r.comments("t-1").at(-1)).toBe(
      `worklog: shift ${done.shiftId} ended this bead after 1 run: left. ${SHIFT_ENDINGS.taken}`,
    );
    // Nothing of the shift's moved the bead after the other run's start.
    expect(
      r
        .events()
        .filter((event) => event.kind === "bead.transitioned")
        .at(-1),
    ).toMatchObject({ runId: "t-1-other-run", payload: { to: "running" } });
  });

  test("a start that names no run (an operator's, by hand) is no other run's: the watch reads the bead back and lets its own run go on", async () => {
    let skew = 0;
    const r = rig([queued("t-1")], () => "hang", {
      now: () => new Date(Date.now() + skew),
    });
    const stop = new AbortController();
    const running = runShift(
      { ...FAST, pollMs: 60_000 },
      { ...r.deps, signal: stop.signal },
    );
    try {
      await until(() => r.fake.runs.length === 1);
      const operator = operatorQueue(r);
      for (const action of ["pause", "resume", "start"] as const)
        expect((await operator.move("t-1", action, "operator")).ok).toBe(true);
      const shows = () =>
        r.calls.filter((args) => args[0] === "show" && args.at(-1) === "t-1")
          .length;
      const before = shows();
      skew += 60_000;
      await until(() => shows() > before);
      // A tick later the run is still going.
      await Bun.sleep(100);
      expect(r.fake.runs[0]?.endedAt).toBeUndefined();
    } finally {
      stop.abort();
    }
    const done = await ended(running);
    expect(done.reason).toBe("operator");
    expect(done.record.beads[0]).toMatchObject({ outcome: "released" });
    expect(r.labels("t-1")).toEqual(["queue:queued"]);
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
