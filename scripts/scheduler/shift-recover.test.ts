import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LedgerEventInput, LedgerEventKind } from "../../types/hearth";
import type { BdResult, BdRunner } from "../hearth/routes/dev-api";
import { type AppendResult, appendEvent } from "../ledger/append";
import { closeLedger } from "../ledger/db";
import { activeReservations, queryEvents } from "../ledger/query";
import { resolveCheckout } from "../ledger/workspace";
import { createQueue } from "./queue";
import {
  type QueueTracker,
  queueTracker,
  type TrackedBead,
} from "./queue-fixture";
import { release, reserve } from "./reservations";
import { shiftRunId } from "./shift";
import {
  RECOVER_LOCK_FILE,
  type RecoverDeps,
  recoveredComment,
  recoverShift,
} from "./shift-recover";
import {
  readShiftRecord,
  type ShiftBeadRecord,
  type ShiftRecord,
  writeShiftRecord,
} from "./shift-store";
import { comparablePath } from "./worktrees";

/**
 * Recovering a shift whose process ended, hermetic: `bd` is the queue's
 * in-memory tracker, and the ledger, the locks and the shift records are in a
 * temp home. What a dead shift leaves behind is made with the modules a shift
 * uses (`createQueue(...).move(id, "start", "scheduler")` and `reserve`, each
 * event carrying the bead's run id, and a record written as the shift writes
 * it), then the process that owned it is one that does not exist.
 */

const roots: string[] = [];
const ledgers: string[] = [];
afterAll(() => {
  for (const ledger of ledgers) closeLedger(ledger);
  for (const root of roots)
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

/** No process has this id. */
const DEAD = 2_000_000_000;
const A = "shift-20261015-090000-a0a0";
const B = "shift-20261015-100000-b0b0";

const queued = (id: string): TrackedBead => ({
  id,
  labels: ["queue:queued"],
  metadata: { queue_state: "queued" },
  description: `Work.\n\n## Files\nsrc/${id}/**\n`,
});

interface Rig {
  root: string;
  ledger: string;
  workspace: string;
  tracker: QueueTracker;
  /** Every argument array `bd` was given through the recovery's runner. */
  calls: string[][];
  /** Answer a recovery's `bd` call yourself: return a result to use it. */
  intercept: ((args: string[]) => BdResult | undefined) | null;
  deps: RecoverDeps;
  labels(id: string): string[];
  /** Reservations held, as `[bead, worktree]`. */
  held(): Array<[string, string]>;
  /** The texts of the comments put on a bead. */
  comments(id: string): string[];
  events(filter?: { runId?: string; kinds?: LedgerEventKind[] }): Array<{
    kind: string;
    runId?: string;
    beadId?: string;
    payload: unknown;
  }>;
}

function rig(beads: TrackedBead[]): Rig {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "af recover ")));
  roots.push(root);
  mkdirSync(join(root, ".git"));
  const home = join(root, "forge home");
  mkdirSync(home);
  const ledger = join(home, "ledger.db");
  ledgers.push(ledger);
  const { workspace } = resolveCheckout(root);
  const tracker = queueTracker(beads);
  const calls: string[][] = [];
  const runBd: BdRunner = async (args) => {
    calls.push(args);
    return self.intercept?.(args) ?? tracker.run(args);
  };
  const self: Rig = {
    root,
    ledger,
    workspace,
    tracker,
    calls,
    intercept: null,
    deps: {
      workspace,
      runBd,
      ledgerPath: ledger,
      lockFile: join(home, "queue-lock.db"),
      shiftsDir: join(home, "shifts"),
      mainCheckout: root,
    },
    labels: (id) =>
      (tracker.beads.get(id)?.labels ?? []).filter((label) =>
        label.startsWith("queue:"),
      ),
    held: () =>
      activeReservations({ workspace }, { path: ledger })
        .map((r): [string, string] => [r.beadId, r.worktree])
        .sort(),
    comments: (id) => tracker.beads.get(id)?.comments ?? [],
    events: (filter = {}) =>
      queryEvents(
        {
          workspace,
          ...(filter.runId !== undefined ? { runId: filter.runId } : {}),
          ...(filter.kinds !== undefined ? { kinds: filter.kinds } : {}),
        },
        { path: ledger },
      ).map((event) => ({
        kind: event.kind,
        ...(event.runId !== undefined ? { runId: event.runId } : {}),
        ...(event.beadId !== undefined ? { beadId: event.beadId } : {}),
        payload: event.payload,
      })),
  };
  return self;
}

/** An appender that adds the run id, as the shift's own does. */
const appendFor =
  (r: Rig, runId?: string) =>
  (event: LedgerEventInput): AppendResult =>
    appendEvent(runId === undefined ? event : { ...event, runId }, {
      path: r.ledger,
    });

const worktreeOf = (r: Rig, shiftId: string, n: number): string =>
  join(r.root, "trees", `${shiftId}-${n}`);

/**
 * What a shift's admit does for its `n`th bead: `start` as the scheduler,
 * then `reserve` for `<main>/trees/<shift-id>-<n>`, each event carrying the
 * bead's run id. Answers the record entry the shift writes once the bead runs.
 */
async function claim(
  r: Rig,
  shiftId: string,
  beadId: string,
  n: number,
): Promise<ShiftBeadRecord> {
  const runId = shiftRunId(beadId, shiftId, n);
  const started = await createQueue({
    workspace: r.workspace,
    runBd: r.tracker.run,
    appendEvent: appendFor(r, runId),
    lockFile: r.deps.lockFile,
  }).move(beadId, "start", "scheduler");
  if (!started.ok) throw new Error(started.error);
  const worktree = worktreeOf(r, shiftId, n);
  mkdirSync(join(worktree, ".git"), { recursive: true });
  const reserved = await reserve(
    { beadId, worktree, globs: [`src/${beadId}/**`] },
    {
      workspace: r.workspace,
      ledgerPath: r.ledger,
      appendEvent: appendFor(r, runId),
      lockFile: r.deps.lockFile,
      // As the shift reserves: with the shift records.
      shiftsDir: r.deps.shiftsDir,
    },
  );
  if (!reserved.ok) throw new Error(reserved.error);
  return {
    beadId,
    runId,
    outcome: "running",
    attempts: 1,
    smith: "claude-master",
    worktree,
    branch: `shift/${shiftId}/${beadId}`,
  };
}

/** The operator's move, through the queue, as the hearth makes it. */
async function operator(r: Rig, id: string, action: "pause" | "resume") {
  const moved = await createQueue({
    workspace: r.workspace,
    runBd: r.tracker.run,
    appendEvent: appendFor(r),
    lockFile: r.deps.lockFile,
  }).move(id, action, "operator");
  if (!moved.ok) throw new Error(moved.error);
}

/** The record a shift left running when its process ended. */
function died(
  r: Rig,
  shiftId: string,
  beads: ShiftBeadRecord[],
  more: Partial<ShiftRecord> = {},
): ShiftRecord {
  const record: ShiftRecord = {
    shiftId,
    pid: DEAD,
    workspace: r.workspace,
    startedAt: "2026-10-15T09:00:00.000Z",
    deadline: "2026-10-15T11:00:00.000Z",
    state: "running",
    options: {
      concurrency: 2,
      forMs: 7_200_000,
      maxBeads: 4,
      maxUsd: 10,
      repairs: 3,
      base: "master",
    },
    baseSha: "b".repeat(40),
    spentUsd: 0,
    unpriced: 0,
    beads,
    ...more,
  };
  writeShiftRecord(r.deps.shiftsDir, record);
  return record;
}

async function recovered(r: Rig, id = A) {
  const outcome = await recoverShift(id, r.deps);
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome.value;
}

const recordFile = (r: Rig, id: string) =>
  readFileSync(join(r.deps.shiftsDir, `${id}.json`), "utf8");

describe("forge:shift recover — refusals write nothing", () => {
  test("an id that is not a shift's, no record, another workspace's shift and a shift that has stopped are refused: no bd call, no event, no lock file, no record changed", async () => {
    const r = rig([queued("t-1")]);
    const entry = await claim(r, A, "t-1", 1);
    died(r, A, [entry], { workspace: "c:/another/checkout" });
    const stopped = "shift-20261015-080000-c0c0";
    died(r, stopped, [], { state: "stopped", reason: "drained" });
    const files = readdirSync(r.deps.shiftsDir).sort();
    const before = [recordFile(r, A), recordFile(r, stopped)];
    const events = r.events().length;
    const asked: Array<[string, string]> = [
      ["../escape", "invalid"],
      ["shift-20261015-070000-d0d0", "not-found"],
      [A, "not-found"],
      [stopped, "stopped"],
    ];
    for (const [id, kind] of asked)
      expect(await recoverShift(id, r.deps)).toMatchObject({ ok: false, kind });
    expect(r.calls).toEqual([]);
    expect(r.events()).toHaveLength(events);
    expect(readdirSync(r.deps.shiftsDir).sort()).toEqual(files);
    expect([recordFile(r, A), recordFile(r, stopped)]).toEqual(before);
    expect(r.labels("t-1")).toEqual(["queue:running"]);
  });

  test("a shift whose process is alive is refused, and the refusal says a pid reused by another program reads as alive too; nothing is written", async () => {
    const r = rig([queued("t-1")]);
    const entry = await claim(r, A, "t-1", 1);
    died(r, A, [entry], { pid: process.pid });
    const before = recordFile(r, A);
    const events = r.events().length;
    const outcome = await recoverShift(A, r.deps);
    expect(outcome).toMatchObject({ ok: false, kind: "alive" });
    if (!outcome.ok) {
      expect(outcome.error).toContain(`pid ${process.pid}`);
      expect(outcome.error).toContain(`bun run forge:shift stop ${A}`);
      expect(outcome.error).toContain("gave its pid to another program");
    }
    expect(r.calls).toEqual([]);
    expect(r.events()).toHaveLength(events);
    expect(recordFile(r, A)).toBe(before);
    expect(r.labels("t-1")).toEqual(["queue:running"]);
    expect(r.held()).toHaveLength(1);
    expect(readdirSync(r.deps.shiftsDir)).toEqual([`${A}.json`]);
  });
});

describe("forge:shift recover — a shift whose process died", () => {
  test("a bead it still owns goes back to queued as the scheduler with one worklog comment, its reservation is freed, every event carries its run id, and the record is closed as recovered with one shift.stopped", async () => {
    const r = rig([queued("t-1")]);
    const entry = await claim(r, A, "t-1", 1);
    died(r, A, [entry]);
    const done = await recovered(r);

    expect(done.complete).toBe(true);
    expect(done.unfinished).toEqual([]);
    expect(done.stopped).toBe("recorded");
    expect(done.beads).toMatchObject([
      { beadId: "t-1", runId: entry.runId, outcome: "released" },
    ]);
    expect(done.reservations).toEqual([
      {
        beadId: "t-1",
        worktree: comparablePath(entry.worktree ?? ""),
        outcome: "released",
      },
    ]);
    expect(r.labels("t-1")).toEqual(["queue:queued"]);
    expect(r.held()).toEqual([]);
    expect(r.comments("t-1")).toEqual([
      recoveredComment({
        shiftId: A,
        pid: DEAD,
        runId: entry.runId,
        attempts: 1,
      }),
    ]);
    // The bead's story, from claim to recovery, under its run id.
    expect(
      r
        .events({ runId: entry.runId })
        .map((event) => [
          event.kind,
          (event.payload as { reason?: string }).reason ?? null,
        ]),
    ).toEqual([
      ["bead.transitioned", "start:scheduler"],
      ["reservation.acquired", null],
      ["bead.transitioned", "release:scheduler"],
      ["reservation.released", null],
    ]);
    expect(r.events({ kinds: ["shift.stopped"] })).toEqual([
      { kind: "shift.stopped", payload: { shiftId: A, reason: "recovered" } },
    ]);
    const record = readShiftRecord(r.deps.shiftsDir, A);
    expect(record).toMatchObject({ state: "stopped", reason: "recovered" });
    expect(record?.endedAt).toBeDefined();
    expect(record?.error).toContain(`its process (pid ${DEAD}) ended`);
    expect(record?.beads[0]).toMatchObject({ outcome: "released" });
    expect(record?.beads[0]?.error).toContain("recovered:");
    expect(done.record).toEqual(record as ShiftRecord);
  });

  test("beads it no longer owns are left as they are and reported: one the operator paused, one paused, resumed and started by another shift once its reservation in this shift's worktree was freed by hand; their reservations in its worktrees are freed and the other shift's is not", async () => {
    const r = rig([queued("t-own"), queued("t-paused"), queued("t-taken")]);
    const own = await claim(r, A, "t-own", 1);
    const paused = await claim(r, A, "t-paused", 2);
    const taken = await claim(r, A, "t-taken", 3);
    // After A's process ended: the operator pauses two of its beads and
    // resumes one, and shift B picks that one up again. B may reserve it
    // only once A's worktree no longer holds it (x1gs.5.4.13): until then
    // its reserve is refused, and here the operator frees A's by hand.
    await operator(r, "t-paused", "pause");
    await operator(r, "t-taken", "pause");
    await operator(r, "t-taken", "resume");
    const store = {
      workspace: r.workspace,
      ledgerPath: r.ledger,
      appendEvent: appendFor(r),
      lockFile: r.deps.lockFile,
      shiftsDir: r.deps.shiftsDir,
    };
    died(r, A, [own, paused, taken]);
    const refused = await reserve(
      {
        beadId: "t-taken",
        worktree: worktreeOf(r, B, 1),
        globs: ["src/t-taken/**"],
      },
      store,
    );
    expect(refused.ok ? "" : refused.error).toContain(`shift ${A} (dead)`);
    expect(
      (
        await release(
          { beadId: "t-taken", worktree: taken.worktree ?? "" },
          store,
        )
      ).ok,
    ).toBe(true);
    const again = await claim(r, B, "t-taken", 1);
    died(r, A, [own, paused, taken]);
    const updates = r.tracker.updates().length;

    const done = await recovered(r);
    expect(done.complete).toBe(true);
    expect(done.beads.map((bead) => [bead.beadId, bead.outcome])).toEqual([
      ["t-own", "released"],
      ["t-paused", "left"],
      ["t-taken", "left"],
    ]);
    expect(done.beads[1]?.why).toContain("running to paused (pause:operator)");
    expect(done.beads[2]?.why).toContain(`run ${again.runId}`);
    expect(r.labels("t-own")).toEqual(["queue:queued"]);
    expect(r.labels("t-paused")).toEqual(["queue:paused"]);
    // Still B's, and still running.
    expect(r.labels("t-taken")).toEqual(["queue:running"]);
    expect(r.held()).toEqual([
      ["t-taken", comparablePath(worktreeOf(r, B, 1))],
    ]);
    expect(r.comments("t-paused")).toEqual([]);
    expect(r.comments("t-taken")).toEqual([]);
    expect(r.comments("t-own")).toHaveLength(1);
    // No move of a bead it does not own was even tried.
    expect(
      r.tracker
        .updates()
        .slice(updates)
        .map((args) => args.at(-1)),
    ).toEqual(["t-own"]);
    const record = readShiftRecord(r.deps.shiftsDir, A);
    expect(record?.beads.map((bead) => bead.outcome)).toEqual([
      "released",
      "left",
      "left",
    ]);
  });

  test("ownership is read again just before the write: a start by another shift recorded after the first check (made here while the move reads the bead) refuses the release, and the bead is left running", async () => {
    const r = rig([queued("t-1")]);
    const entry = await claim(r, A, "t-1", 1);
    died(r, A, [entry]);
    const other = shiftRunId("t-1", B, 1);
    let injected = false;
    r.intercept = (args) => {
      if (args[0] === "show" && args.at(-1) === "t-1" && !injected) {
        injected = true;
        // As if the operator paused and resumed it and shift B started it,
        // between the recovery's first look and its write. The bead's label
        // is running again, as B's start left it.
        for (const [from, to, reason, runId] of [
          ["running", "paused", "pause:operator", undefined],
          ["paused", "queued", "resume:operator", undefined],
          ["queued", "running", "start:scheduler", other],
        ] as const)
          appendFor(
            r,
            runId,
          )({
            kind: "bead.transitioned",
            workspace: r.workspace,
            beadId: "t-1",
            payload: { from, to, reason },
          });
      }
      return undefined;
    };
    const done = await recovered(r);
    expect(done.beads).toMatchObject([{ beadId: "t-1", outcome: "left" }]);
    expect(done.beads[0]?.why).toContain(`run ${other}`);
    expect(r.labels("t-1")).toEqual(["queue:running"]);
    expect(
      r.tracker.updates().filter((args) => args.at(-1) === "t-1"),
    ).toHaveLength(1);
    expect(r.comments("t-1")).toEqual([]);
    expect(
      r
        .events({ runId: entry.runId })
        .filter((event) => event.kind === "bead.transitioned"),
    ).toHaveLength(1);
  });

  test("every reservation still held in one of its worktrees is freed, whichever bead holds it; reservations in another shift's worktree or a worktree it did not make are not", async () => {
    const r = rig([
      queued("t-review"),
      queued("t-aside"),
      queued("t-other"),
      queued("t-hand"),
    ]);
    // A bead that moved on (submitted for review) whose reservation the
    // shift died before freeing, and one set aside after its reservation was
    // taken, whose worktree was never made.
    const review = await claim(r, A, "t-review", 1);
    await createQueue({
      workspace: r.workspace,
      runBd: r.tracker.run,
      appendEvent: appendFor(r, review.runId),
      lockFile: r.deps.lockFile,
    }).move("t-review", "submit", "scheduler");
    const aside = shiftRunId("t-aside", A, 2);
    const store = (runId?: string) => ({
      workspace: r.workspace,
      ledgerPath: r.ledger,
      appendEvent: appendFor(r, runId),
      lockFile: r.deps.lockFile,
    });
    for (const [beadId, worktree, runId] of [
      ["t-aside", worktreeOf(r, A, 2), aside],
      ["t-other", worktreeOf(r, B, 1), undefined],
      ["t-hand", join(r.root, "trees", `${A}-1b`), undefined],
    ] as const) {
      const reserved = await reserve(
        { beadId, worktree, globs: [`src/${beadId}/**`] },
        store(runId),
      );
      if (!reserved.ok) throw new Error(reserved.error);
    }
    died(r, A, [
      { ...review, outcome: "review" },
      { beadId: "t-aside", runId: aside, outcome: "set-aside", attempts: 0 },
    ]);

    const done = await recovered(r);
    expect(done.complete).toBe(true);
    expect(done.beads).toEqual([]);
    expect(
      done.reservations.map((each) => [each.beadId, each.outcome]).sort(),
    ).toEqual([
      ["t-aside", "released"],
      ["t-review", "released"],
    ]);
    expect(r.held()).toEqual([
      ["t-hand", comparablePath(join(r.root, "trees", `${A}-1b`))],
      ["t-other", comparablePath(worktreeOf(r, B, 1))],
    ]);
    expect(r.labels("t-review")).toEqual(["queue:review"]);
    expect(r.events({ runId: aside }).map((event) => event.kind)).toEqual([
      "reservation.acquired",
      "reservation.released",
    ]);
  });

  test("a reservation in a worktree named like one of its own (<shift-id>-1) but outside <main>/trees/ is kept", async () => {
    const r = rig([queued("t-out")]);
    const outside = join(r.root, "elsewhere", `${A}-1`);
    const reserved = await reserve(
      { beadId: "t-out", worktree: outside, globs: ["src/t-out/**"] },
      {
        workspace: r.workspace,
        ledgerPath: r.ledger,
        appendEvent: appendFor(r),
        lockFile: r.deps.lockFile,
      },
    );
    if (!reserved.ok) throw new Error(reserved.error);
    died(r, A, []);

    const done = await recovered(r);
    expect(done.complete).toBe(true);
    expect(done.reservations).toEqual([]);
    expect(r.held()).toEqual([["t-out", comparablePath(outside)]]);
  });

  test("a bead it claimed that its record does not list as running (never saved, or saved before the claim as set-aside) is found from the ledger and released; a bead it gave back itself is not touched", async () => {
    const r = rig([queued("t-unsaved"), queued("t-early"), queued("t-back")]);
    await claim(r, A, "t-unsaved", 1);
    const early = await claim(r, A, "t-early", 2);
    const back = await claim(r, A, "t-back", 3);
    await createQueue({
      workspace: r.workspace,
      runBd: r.tracker.run,
      appendEvent: appendFor(r, back.runId),
      lockFile: r.deps.lockFile,
    }).move("t-back", "release", "scheduler");
    died(r, A, [
      {
        beadId: "t-early",
        runId: early.runId,
        outcome: "set-aside",
        attempts: 0,
      },
      {
        beadId: "t-back",
        runId: back.runId,
        outcome: "set-aside",
        attempts: 0,
      },
    ]);
    const updates = r.tracker.updates().length;

    const done = await recovered(r);
    expect(done.complete).toBe(true);
    expect(
      done.beads.map((bead) => [bead.beadId, bead.outcome]).sort(),
    ).toEqual([
      ["t-early", "released"],
      ["t-unsaved", "released"],
    ]);
    expect(r.labels("t-unsaved")).toEqual(["queue:queued"]);
    expect(r.labels("t-early")).toEqual(["queue:queued"]);
    expect(r.tracker.updates()).toHaveLength(updates + 2);
    expect(r.comments("t-back")).toEqual([]);
    const record = readShiftRecord(r.deps.shiftsDir, A);
    expect(record?.beads.map((bead) => [bead.beadId, bead.outcome])).toEqual([
      ["t-early", "released"],
      ["t-back", "set-aside"],
      ["t-unsaved", "released"],
    ]);
    expect(r.held()).toEqual([]);
  });

  test("a bd failure half way leaves the record running and says what is left; recovering again finishes the job without moving or commenting on a bead twice, and shift.stopped is appended once", async () => {
    const r = rig([queued("t-1"), queued("t-2")]);
    const one = await claim(r, A, "t-1", 1);
    const two = await claim(r, A, "t-2", 2);
    died(r, A, [one, two]);
    r.intercept = (args) =>
      args[0] === "update" && args.at(-1) === "t-2"
        ? { status: 1, stdout: "", stderr: "Error: database is locked\n" }
        : undefined;

    const first = await recovered(r);
    expect(first.complete).toBe(false);
    expect(first.stopped).toBe("pending");
    expect(first.beads.map((bead) => [bead.beadId, bead.outcome])).toEqual([
      ["t-1", "released"],
      ["t-2", "pending"],
    ]);
    expect(first.unfinished.join(" ")).toContain("t-2: release:");
    expect(first.unfinished.join(" ")).toContain("database is locked");
    expect(readShiftRecord(r.deps.shiftsDir, A)).toMatchObject({
      state: "running",
      beads: [{ outcome: "released" }, { outcome: "running" }],
    });
    expect(r.labels("t-2")).toEqual(["queue:running"]);
    expect(r.events({ kinds: ["shift.stopped"] })).toEqual([]);

    r.intercept = null;
    const second = await recovered(r);
    expect(second.complete).toBe(true);
    expect(second.beads.map((bead) => [bead.beadId, bead.outcome])).toEqual([
      ["t-2", "released"],
    ]);
    expect(r.labels("t-1")).toEqual(["queue:queued"]);
    expect(r.labels("t-2")).toEqual(["queue:queued"]);
    expect(r.comments("t-1")).toHaveLength(1);
    expect(r.comments("t-2")).toHaveLength(1);
    expect(
      r
        .events({ runId: one.runId })
        .filter((event) => event.kind === "bead.transitioned"),
    ).toHaveLength(2);
    expect(r.events({ kinds: ["shift.stopped"] })).toHaveLength(1);
    expect(readShiftRecord(r.deps.shiftsDir, A)?.state).toBe("stopped");
  });

  test("two recoveries at once: one does the work and the other is refused, so each bead is moved and commented once and shift.stopped is appended once", async () => {
    const r = rig([queued("t-1"), queued("t-2")]);
    const one = await claim(r, A, "t-1", 1);
    const two = await claim(r, A, "t-2", 2);
    died(r, A, [one, two]);
    const updates = r.tracker.updates().length;

    const both = await Promise.all([
      recoverShift(A, r.deps),
      recoverShift(A, r.deps),
    ]);
    const finished = both.filter((each) => each.ok);
    const refused = both.filter((each) => !each.ok);
    expect(finished).toHaveLength(1);
    expect(refused).toMatchObject([{ ok: false, kind: "stopped" }]);
    expect(r.tracker.updates()).toHaveLength(updates + 2);
    expect(r.comments("t-1")).toHaveLength(1);
    expect(r.comments("t-2")).toHaveLength(1);
    expect(r.events({ kinds: ["shift.stopped"] })).toHaveLength(1);
    expect(
      readShiftRecord(r.deps.shiftsDir, A)?.beads.map((bead) => bead.outcome),
    ).toEqual(["released", "released"]);
    // No marker is left beside the record: only the lock's file, which the
    // operating system unlocks with its holder.
    expect(readdirSync(r.deps.shiftsDir).sort()).toEqual(
      [`${A}.json`, RECOVER_LOCK_FILE].sort(),
    );
  });

  test("an entry still listed as running whose newest move is this shift's own release (moved before the record was written) is reported left, not moved again, and gets no comment", async () => {
    const r = rig([queued("t-1")]);
    const entry = await claim(r, A, "t-1", 1);
    await createQueue({
      workspace: r.workspace,
      runBd: r.tracker.run,
      appendEvent: appendFor(r, entry.runId),
      lockFile: r.deps.lockFile,
    }).move("t-1", "release", "scheduler");
    died(r, A, [entry]);
    const updates = r.tracker.updates().length;

    const done = await recovered(r);
    expect(done.complete).toBe(true);
    expect(done.beads).toMatchObject([{ beadId: "t-1", outcome: "left" }]);
    expect(done.beads[0]?.why).toContain(
      `this shift's own and not its start: running to queued (release:scheduler, run ${entry.runId})`,
    );
    expect(r.tracker.updates()).toHaveLength(updates);
    expect(r.comments("t-1")).toEqual([]);
    expect(r.labels("t-1")).toEqual(["queue:queued"]);
  });

  test("a shift.stopped an earlier recovery appended before it could close the record is not appended again", async () => {
    const r = rig([]);
    died(r, A, []);
    appendEvent(
      {
        kind: "shift.stopped",
        workspace: r.workspace,
        payload: { shiftId: A, reason: "recovered" },
      },
      { path: r.ledger },
    );
    const done = await recovered(r);
    expect(done.complete).toBe(true);
    expect(done.stopped).toBe("found");
    expect(r.events({ kinds: ["shift.stopped"] })).toHaveLength(1);
    expect(readShiftRecord(r.deps.shiftsDir, A)).toMatchObject({
      state: "stopped",
      reason: "recovered",
    });
  });

  test("a record entry that names no run id is not this shift's: a bead an operator started by hand (no run id) is left running and reported", async () => {
    const r = rig([queued("t-1")]);
    const started = await createQueue({
      workspace: r.workspace,
      runBd: r.tracker.run,
      appendEvent: appendFor(r),
      lockFile: r.deps.lockFile,
    }).move("t-1", "start", "operator");
    if (!started.ok) throw new Error(started.error);
    // As a record edited by hand or written before entries carried run ids.
    const entry: Record<string, unknown> = {
      beadId: "t-1",
      outcome: "running",
      attempts: 1,
    };
    // justification: the record on disk lacks a field the type requires; that is the case under test.
    died(r, A, [entry as unknown as ShiftBeadRecord]);
    const updates = r.tracker.updates().length;

    const done = await recovered(r);
    expect(done.beads).toMatchObject([
      { beadId: "t-1", runId: "", outcome: "left" },
    ]);
    expect(done.beads[0]?.why).toContain("names no run id");
    expect(r.labels("t-1")).toEqual(["queue:running"]);
    expect(r.tracker.updates()).toHaveLength(updates);
    expect(r.comments("t-1")).toEqual([]);
  });
});

describe("forge:shift recover — a ledger read that fails", () => {
  /**
   * The ledger's query, failing every read of one bead's moves from its
   * `from`th on (1: every read; 2: the one inside the queue lock and after).
   */
  function failing(beads: Record<string, number>): typeof queryEvents {
    const reads = new Map<string, number>();
    return (filter, opts) => {
      const beadId = filter?.beadExact === true ? filter.beadId : undefined;
      const from = beadId === undefined ? undefined : beads[beadId];
      if (beadId !== undefined && from !== undefined) {
        const n = (reads.get(beadId) ?? 0) + 1;
        reads.set(beadId, n);
        if (n >= from) throw new Error("database is locked");
      }
      return queryEvents(filter, opts);
    };
  }

  /** A shift that died holding two beads: one its record lists, one only its run ids in the ledger show. */
  async function twoBeads() {
    const r = rig([queued("t-listed"), queued("t-unsaved")]);
    const listed = await claim(r, A, "t-listed", 1);
    await claim(r, A, "t-unsaved", 2);
    died(r, A, [listed]);
    return r;
  }

  async function expectPendingThenFinished(r: Rig, first: RecoverDeps) {
    const updates = r.tracker.updates().length;
    const outcome = await recoverShift(A, first);
    if (!outcome.ok) throw new Error(outcome.error);
    const done = outcome.value;
    expect(done.complete).toBe(false);
    expect(done.stopped).toBe("pending");
    expect(
      done.beads.map((bead) => [bead.beadId, bead.outcome]).sort(),
    ).toEqual([
      ["t-listed", "pending"],
      ["t-unsaved", "pending"],
    ]);
    expect(done.unfinished.join(" ")).toContain(
      "t-unsaved: the ledger could not be read to tell whose it is (database is locked)",
    );
    expect(r.tracker.updates()).toHaveLength(updates);
    expect(r.labels("t-listed")).toEqual(["queue:running"]);
    expect(r.labels("t-unsaved")).toEqual(["queue:running"]);
    expect(readShiftRecord(r.deps.shiftsDir, A)?.state).toBe("running");
    expect(r.events({ kinds: ["shift.stopped"] })).toEqual([]);

    // With the ledger readable again, recovering again finishes the job.
    const again = await recovered(r);
    expect(again.complete).toBe(true);
    expect(r.labels("t-listed")).toEqual(["queue:queued"]);
    expect(r.labels("t-unsaved")).toEqual(["queue:queued"]);
    expect(readShiftRecord(r.deps.shiftsDir, A)?.state).toBe("stopped");
  }

  test("the first read of whose a bead is failing leaves it pending, listed or found only through the ledger: nothing is moved, the record stays running with no shift.stopped, and the next recovery finishes", async () => {
    const r = await twoBeads();
    await expectPendingThenFinished(r, {
      ...r.deps,
      queryEvents: failing({ "t-listed": 1, "t-unsaved": 1 }),
    });
  });

  test("the read inside the queue lock failing leaves the bead pending, listed or found only through the ledger: the update never reaches bd, and the next recovery finishes", async () => {
    const r = await twoBeads();
    await expectPendingThenFinished(r, {
      ...r.deps,
      queryEvents: failing({ "t-listed": 2, "t-unsaved": 2 }),
    });
  });
});

describe("forge:shift recover — a record it cannot read", () => {
  test("is refused as unreadable, with nothing written and nothing thrown: a workspace that is not a string, a pid process.kill cannot ask about, a bead entry that is not an object, has no Beads id, a run id that is not a string, an unknown outcome or a negative run count", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["workspace: expected a path", { workspace: 5 }],
      ["pid: expected a process id", { pid: -1 }],
      ["pid: expected a process id", { pid: 0 }],
      ["pid: expected a process id", { pid: 1.5 }],
      ["pid: expected a process id", { pid: 2 ** 32 + process.pid }],
      ["pid: expected a process id", { pid: 1e20 }],
      [
        "beads[0].beadId: expected a Beads issue id",
        {
          beads: [
            { beadId: "--help", runId: "x", outcome: "running", attempts: 1 },
          ],
        },
      ],
      ["beads[0]: expected an object", { beads: ["t-1"] }],
      [
        "beads[0].runId: expected a string",
        {
          beads: [{ beadId: "t-1", runId: 5, outcome: "running", attempts: 1 }],
        },
      ],
      [
        "beads[0].outcome: expected one of",
        {
          beads: [
            { beadId: "t-1", runId: "x", outcome: "flying", attempts: 1 },
          ],
        },
      ],
      [
        "beads[0].attempts: expected a whole number",
        {
          beads: [
            { beadId: "t-1", runId: "x", outcome: "running", attempts: -1 },
          ],
        },
      ],
    ];
    for (const [why, fields] of cases) {
      const r = rig([queued("t-1")]);
      const entry = await claim(r, A, "t-1", 1);
      // justification: the fields under test are not what the record's type allows.
      died(r, A, [entry], fields as Partial<ShiftRecord>);
      const before = recordFile(r, A);
      const events = r.events().length;
      const outcome = await recoverShift(A, r.deps);
      expect({ fields, outcome }).toMatchObject({
        fields,
        outcome: { ok: false, kind: "unreadable" },
      });
      if (!outcome.ok) expect(outcome.error).toContain(why);
      expect(r.calls).toEqual([]);
      expect(r.events()).toHaveLength(events);
      expect(recordFile(r, A)).toBe(before);
      expect(r.labels("t-1")).toEqual(["queue:running"]);
    }
  });
});
