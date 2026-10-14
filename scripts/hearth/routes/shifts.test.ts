import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { OperatorEnvelope } from "../../../types/hearth";
import {
  type ListedShift,
  SHIFTS_DIR,
  type ShiftRecord,
  writeShiftRecord,
} from "../../scheduler/shift-store";
import { startTestHearth, type TestHearth } from "../testing";
import { validateOperatorEnvelope } from "../validate";

/**
 * The shift rows, through a hermetic hearth: the records are written into the
 * hearth's own home as a shift would write them, and what is checked is the
 * answer, the stop request on disk and the audit rows. No shift runs here: the
 * loop that honours a stop request is tested in
 * `scripts/scheduler/shift.test.ts`.
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
