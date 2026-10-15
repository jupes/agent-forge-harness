import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LedgerEventInput, OperatorEnvelope } from "../../../types/hearth";
import { appendEvent } from "../../ledger/append";
import { activeReservations } from "../../ledger/query";
import { createQueue } from "../../scheduler/queue";
import { type QueueTracker, queueTracker } from "../../scheduler/queue-fixture";
import { reserve } from "../../scheduler/reservations";
import type { Recovery } from "../../scheduler/shift-recover";
import {
  type ListedShift,
  readShiftRecord,
  SHIFTS_DIR,
  type ShiftRecord,
  writeShiftRecord,
} from "../../scheduler/shift-store";
import { startTestHearth, type TestHearth } from "../testing";
import { validateOperatorEnvelope } from "../validate";
import { QUEUE_LOCK_FILE } from "./queue";

/**
 * The shift rows, through a hermetic hearth: the records are written into the
 * hearth's own home as a shift would write them, and what is checked is the
 * answer, the stop request on disk, the tracker, the ledger and the audit
 * rows. No shift runs here: the loop that honours a stop request is tested in
 * `scripts/scheduler/shift.test.ts`, and recovery itself in
 * `scripts/scheduler/shift-recover.test.ts`.
 */

const open: TestHearth[] = [];
afterEach(async () => {
  for (const hearth of open.splice(0)) await hearth.close();
});

async function start(): Promise<TestHearth> {
  const h = await startTestHearth();
  open.push(h);
  return h;
}

const shifts = (h: TestHearth) => join(h.home, SHIFTS_DIR);

function record(
  shiftId: string,
  workspace: string,
  more: Partial<ShiftRecord> = {},
): ShiftRecord {
  return {
    shiftId,
    pid: process.pid,
    workspace,
    startedAt: `2026-10-14T${shiftId.slice(15, 17)}:00:00.000Z`,
    deadline: "2026-10-14T23:00:00.000Z",
    state: "running",
    options: {
      concurrency: 2,
      forMs: 7_200_000,
      maxBeads: 4,
      maxUsd: 10,
      repairs: 3,
    },
    spentUsd: 0,
    unpriced: 0,
    beads: [],
    ...more,
  };
}

async function answer<T>(
  response: Response,
): Promise<{ status: number; body: OperatorEnvelope<T> }> {
  const checked = validateOperatorEnvelope(await response.json());
  if (!checked.ok) throw new Error(`not an envelope: ${checked.error}`);
  // justification: the guard above proved the envelope; `T` is the caller's claim about `data`.
  return {
    status: response.status,
    body: checked.value as OperatorEnvelope<T>,
  };
}

const post = async (
  h: TestHearth,
  path: string,
  token: string | null = h.hearth.token,
) =>
  answer<{ shiftId: string; already: boolean }>(
    await fetch(`${h.api}${path}`, {
      method: "POST",
      headers: h.headers(token),
      body: "{}",
    }),
  );

describe("GET /shifts", () => {
  test("lists this workspace's shift records, newest first, each saying whether its process is alive; another workspace's are not listed", async () => {
    const h = await start();
    writeShiftRecord(
      shifts(h),
      record("shift-20261014-090000-0001", h.workspace, {
        pid: 2_000_000_000,
        state: "stopped",
        reason: "elapsed",
      }),
    );
    writeShiftRecord(
      shifts(h),
      record("shift-20261014-100000-0001", h.workspace),
    );
    writeShiftRecord(
      shifts(h),
      record("shift-20261014-110000-0001", "c:/another/checkout"),
    );
    const listed = await answer<ListedShift[]>(
      await fetch(`${h.api}/shifts`, { headers: h.headers() }),
    );
    expect(listed.status).toBe(200);
    expect(
      listed.body.data?.map((each) => [each.shiftId, each.state, each.alive]),
    ).toEqual([
      ["shift-20261014-100000-0001", "running", true],
      ["shift-20261014-090000-0001", "stopped", false],
    ]);
  });

  test("with no shift ever run, the list is empty", async () => {
    const h = await start();
    const listed = await answer<ListedShift[]>(
      await fetch(`${h.api}/shifts`, { headers: h.headers() }),
    );
    expect(listed).toEqual({
      status: 200,
      body: { ok: true, data: [], error: null },
    });
  });
});

describe("POST /shifts/:id/stop", () => {
  test("asks a running shift to stop: the audit row first, then the stop request the shift looks for; a second ask says it was asked already", async () => {
    const h = await start();
    const id = "shift-20261014-100000-0002";
    writeShiftRecord(shifts(h), record(id, h.workspace));
    const first = await post(h, `/shifts/${id}/stop`);
    expect(first).toEqual({
      status: 200,
      body: { ok: true, data: { shiftId: id, already: false }, error: null },
    });
    expect(existsSync(join(shifts(h), `${id}.stop`))).toBe(true);
    const second = await post(h, `/shifts/${id}/stop`);
    expect(second.body.data).toEqual({ shiftId: id, already: true });
    expect(h.events().map((event) => [event.kind, event.payload])).toEqual([
      ["operator.action", { action: "shift.stop", surface: "api", target: id }],
      ["operator.action", { action: "shift.stop", surface: "api", target: id }],
    ]);
  });

  test("no such shift, and a shift of another workspace, are 404; a stopped one is 409; none of them gets a stop request", async () => {
    const h = await start();
    const other = "shift-20261014-100000-0003";
    const stopped = "shift-20261014-100000-0004";
    writeShiftRecord(shifts(h), record(other, "c:/another/checkout"));
    writeShiftRecord(
      shifts(h),
      record(stopped, h.workspace, { state: "stopped", reason: "drained" }),
    );
    expect(
      (await post(h, "/shifts/shift-20261014-100000-0005/stop")).status,
    ).toBe(404);
    expect((await post(h, `/shifts/${other}/stop`)).status).toBe(404);
    const refused = await post(h, `/shifts/${stopped}/stop`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("has stopped already (drained)");
    for (const id of [other, stopped])
      expect(existsSync(join(shifts(h), `${id}.stop`))).toBe(false);
  });

  test("an id that is not a shift's is 400 and writes nothing; without the operator token it is 403 and writes nothing", async () => {
    const h = await start();
    const id = "shift-20261014-100000-0006";
    writeShiftRecord(shifts(h), record(id, h.workspace));
    expect((await post(h, "/shifts/shift-nope/stop")).status).toBe(400);
    expect((await post(h, `/shifts/${id}/stop`, null)).status).toBe(403);
    expect(existsSync(join(shifts(h), `${id}.stop`))).toBe(false);
    expect(h.events()).toEqual([]);
  });
});

describe("POST /shifts/:id/recover", () => {
  /** No process has this id. */
  const DEAD = 2_000_000_000;

  /**
   * A shift of this workspace that died running `h-1`: the bead started as
   * the scheduler and its reservation taken, each event with its run id, as
   * the shift writes them; the hearth's bd answers from the same tracker.
   */
  async function deadShift(
    h: TestHearth,
    id: string,
  ): Promise<{ tracker: QueueTracker; runId: string }> {
    const tracker = queueTracker([
      {
        id: "h-1",
        labels: ["queue:queued"],
        metadata: { queue_state: "queued" },
      },
    ]);
    h.bd.answer = (args) => tracker.answer(args) ?? tracker.answerComment(args);
    const runId = `h-1-${id}`;
    const append = (event: LedgerEventInput) =>
      appendEvent({ ...event, runId }, { path: h.ledger });
    const lockFile = join(h.home, QUEUE_LOCK_FILE);
    const started = await createQueue({
      workspace: h.workspace,
      runBd: tracker.run,
      appendEvent: append,
      lockFile,
    }).move("h-1", "start", "scheduler");
    if (!started.ok) throw new Error(started.error);
    const worktree = join(h.root, "trees", `${id}-1`);
    const reserved = await reserve(
      { beadId: "h-1", worktree, globs: ["src/h-1/**"] },
      {
        workspace: h.workspace,
        ledgerPath: h.ledger,
        appendEvent: append,
        lockFile,
      },
    );
    if (!reserved.ok) throw new Error(reserved.error);
    writeShiftRecord(
      shifts(h),
      record(id, h.workspace, {
        pid: DEAD,
        beads: [
          { beadId: "h-1", runId, outcome: "running", attempts: 1, worktree },
        ],
      }),
    );
    return { tracker, runId };
  }

  const recover = async (
    h: TestHearth,
    id: string,
    token: string | null = h.hearth.token,
  ) =>
    answer<Recovery>(
      await fetch(`${h.api}/shifts/${id}/recover`, {
        method: "POST",
        headers: h.headers(token),
        body: "{}",
      }),
    );

  test("recovers a dead shift of this workspace: the audit row first, then its bead released to queued, its reservation freed and shift.stopped recorded; the record is closed", async () => {
    const h = await start();
    const id = "shift-20261015-090000-0e01";
    const { tracker, runId } = await deadShift(h, id);
    const seen = h.events().length;

    const recovered = await recover(h, id);
    expect(recovered.status).toBe(200);
    expect(recovered.body.data).toMatchObject({
      shiftId: id,
      complete: true,
      stopped: "recorded",
      beads: [{ beadId: "h-1", runId, outcome: "released" }],
      reservations: [{ beadId: "h-1", outcome: "released" }],
    });
    expect(
      h
        .events()
        .slice(seen)
        .map((event) => [event.kind, event.payload]),
    ).toEqual([
      [
        "operator.action",
        { action: "shift.recover", surface: "api", target: id },
      ],
      [
        "bead.transitioned",
        { from: "running", to: "queued", reason: "release:scheduler" },
      ],
      [
        "reservation.released",
        {
          worktree: expect.any(String),
          globs: ["src/h-1/**"],
        },
      ],
      ["shift.stopped", { shiftId: id, reason: "recovered" }],
    ]);
    expect(tracker.beads.get("h-1")?.labels).toEqual(["queue:queued"]);
    expect(tracker.beads.get("h-1")?.comments).toHaveLength(1);
    expect(
      activeReservations({ workspace: h.workspace }, { path: h.ledger }),
    ).toEqual([]);
    expect(readShiftRecord(shifts(h), id)).toMatchObject({
      state: "stopped",
      reason: "recovered",
    });
  });

  test("no such shift and another workspace's are 404; a stopped one and one whose process is alive are 409; an id that is not a shift's is 400 with no audit row; none of them moves a bead or changes a record", async () => {
    const h = await start();
    const other = "shift-20261015-090000-0e02";
    const stopped = "shift-20261015-090000-0e03";
    const alive = "shift-20261015-090000-0e04";
    writeShiftRecord(
      shifts(h),
      record(other, "c:/another/checkout", { pid: DEAD }),
    );
    writeShiftRecord(
      shifts(h),
      record(stopped, h.workspace, { state: "stopped", reason: "drained" }),
    );
    writeShiftRecord(shifts(h), record(alive, h.workspace));
    const files = [other, stopped, alive].map((id) =>
      readFileSync(join(shifts(h), `${id}.json`), "utf8"),
    );

    expect((await recover(h, "shift-nope")).status).toBe(400);
    expect(h.events()).toEqual([]);
    expect((await recover(h, "shift-20261015-090000-0e05")).status).toBe(404);
    expect((await recover(h, other)).status).toBe(404);
    const done = await recover(h, stopped);
    expect(done.status).toBe(409);
    expect(done.body.error).toContain("has stopped already (drained)");
    const running = await recover(h, alive);
    expect(running.status).toBe(409);
    expect(running.body.error).toContain(`pid ${process.pid}) is running`);
    expect((await recover(h, alive, null)).status).toBe(403);

    expect(h.bd.calls).toEqual([]);
    expect(h.events().map((event) => event.kind)).toEqual([
      "operator.action",
      "operator.action",
      "operator.action",
      "operator.action",
    ]);
    expect(
      [other, stopped, alive].map((id) =>
        readFileSync(join(shifts(h), `${id}.json`), "utf8"),
      ),
    ).toEqual(files);
  });

  test("a recovery that cannot finish is 502, says what is left, and leaves the record running and the bead running", async () => {
    const h = await start();
    const id = "shift-20261015-090000-0e06";
    const { tracker } = await deadShift(h, id);
    h.bd.answer = (args) =>
      args[0] === "update"
        ? { status: 1, stdout: "", stderr: "Error: database is locked\n" }
        : (tracker.answer(args) ?? tracker.answerComment(args));
    const recovered = await recover(h, id);
    expect(recovered.status).toBe(502);
    expect(recovered.body.error).toContain(`${id} is not recovered yet`);
    expect(recovered.body.error).toContain("h-1: release:");
    expect(recovered.body.error).toContain("recover it again");
    expect(tracker.beads.get("h-1")?.labels).toEqual(["queue:running"]);
    expect(readShiftRecord(shifts(h), id)?.state).toBe("running");
    expect(h.events(["shift.stopped"])).toEqual([]);
  });
});
