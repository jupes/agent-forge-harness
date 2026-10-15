import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isShiftId,
  listShiftRecords,
  mintShiftId,
  readShiftRecord,
  requestStop,
  type ShiftRecord,
  shiftIdInUse,
  shiftOfWorktree,
  shiftStanding,
  stopRequested,
  writeShiftRecord,
} from "./shift-store";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots)
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

/** A shifts directory of its own, under a path with a space. */
function dir(): string {
  const root = mkdtempSync(join(tmpdir(), "af shift store "));
  roots.push(root);
  return join(root, "forge home", "shifts");
}

function record(shiftId: string, more: Partial<ShiftRecord> = {}): ShiftRecord {
  return {
    shiftId,
    pid: process.pid,
    workspace: "c:/work/harness",
    startedAt: "2026-10-14T12:00:00.000Z",
    deadline: "2026-10-14T14:00:00.000Z",
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

describe("shift ids", () => {
  test("a minted id names the UTC second the shift started and four hex digits, and is a shift id", () => {
    const id = mintShiftId(new Date("2026-10-14T09:05:03.250Z"), () => "a3f1");
    expect(id).toBe("shift-20261014-090503-a3f1");
    expect(isShiftId(id)).toBe(true);
  });

  test("anything else is not a shift id: another shape, a path, a padded or a cased one", () => {
    for (const value of [
      "shift-20261014-090503",
      "shift-20261014-090503-A3F1",
      "../shift-20261014-090503-a3f1",
      " shift-20261014-090503-a3f1",
      "shift-20261014-090503-a3f1/x",
      "",
      42,
      null,
    ])
      expect(isShiftId(value)).toBe(false);
  });

  test("an id is in use once a record, a record that does not parse, or a stop request has it; one that is not a shift id is never free", () => {
    const shifts = dir();
    const free = "shift-20261015-120000-0e10";
    const recorded = "shift-20261015-120000-0e11";
    const broken = "shift-20261015-120000-0e12";
    const asked = "shift-20261015-120000-0e13";
    // No directory yet: every shift id is free.
    expect(shiftIdInUse(shifts, free)).toBe(false);
    writeShiftRecord(shifts, record(recorded));
    writeFileSync(join(shifts, `${broken}.json`), "{ not json");
    writeFileSync(join(shifts, `${asked}.stop`), "");
    expect(shiftIdInUse(shifts, free)).toBe(false);
    expect(shiftIdInUse(shifts, recorded)).toBe(true);
    expect(shiftIdInUse(shifts, broken)).toBe(true);
    expect(shiftIdInUse(shifts, asked)).toBe(true);
    for (const id of ["shift-nope", "../shift-20261015-120000-0e10", ""])
      expect(shiftIdInUse(shifts, id)).toBe(true);
  });
});

describe("shift records", () => {
  test("a record written is read back whole, and replacing it leaves no temporary file beside it", () => {
    const shifts = dir();
    const id = "shift-20261014-120000-0001";
    writeShiftRecord(shifts, record(id));
    writeShiftRecord(
      shifts,
      record(id, { state: "stopped", reason: "drained" }),
    );
    expect(readShiftRecord(shifts, id)).toEqual(
      record(id, { state: "stopped", reason: "drained" }),
    );
    expect(readdirSync(shifts)).toEqual([`${id}.json`]);
  });

  test("no record, a record that does not parse, or one that names another shift reads as none", () => {
    const shifts = dir();
    expect(readShiftRecord(shifts, "shift-20261014-120000-0002")).toBeNull();
    mkdirSync(shifts, { recursive: true });
    writeFileSync(join(shifts, "shift-20261014-120000-0003.json"), "{broken");
    expect(readShiftRecord(shifts, "shift-20261014-120000-0003")).toBeNull();
    writeFileSync(
      join(shifts, "shift-20261014-120000-0004.json"),
      JSON.stringify(record("shift-20261014-120000-0005")),
    );
    expect(readShiftRecord(shifts, "shift-20261014-120000-0004")).toBeNull();
    expect(readShiftRecord(shifts, "../escape")).toBeNull();
  });

  test("the list is newest first, says whether each shift's process is alive, and skips files that are not records", () => {
    const shifts = dir();
    writeShiftRecord(
      shifts,
      record("shift-20261014-100000-0001", {
        startedAt: "2026-10-14T10:00:00.000Z",
        // No process has this id.
        pid: 2_000_000_000,
      }),
    );
    writeShiftRecord(
      shifts,
      record("shift-20261014-110000-0001", {
        startedAt: "2026-10-14T11:00:00.000Z",
      }),
    );
    writeFileSync(join(shifts, "notes.txt"), "not a record");
    writeFileSync(join(shifts, "shift-20261014-120000-0001.json"), "{");
    const listed = listShiftRecords(shifts);
    expect(listed.map((each) => [each.shiftId, each.alive])).toEqual([
      ["shift-20261014-110000-0001", true],
      ["shift-20261014-100000-0001", false],
    ]);
    expect(listShiftRecords(join(shifts, "none here"))).toEqual([]);
  });
});

describe("stop requests", () => {
  test("a stop request for a running shift is written once; a second is answered as already asked", () => {
    const shifts = dir();
    const id = "shift-20261014-120000-0006";
    writeShiftRecord(shifts, record(id));
    expect(stopRequested(shifts, id)).toBe(false);
    expect(requestStop(shifts, id)).toEqual({
      ok: true,
      value: { shiftId: id, already: false },
    });
    expect(stopRequested(shifts, id)).toBe(true);
    expect(requestStop(shifts, id)).toEqual({
      ok: true,
      value: { shiftId: id, already: true },
    });
  });

  test("a stop request is refused for an id that is not a shift's, for no such shift and for a shift that has stopped, and writes nothing", () => {
    const shifts = dir();
    const stopped = "shift-20261014-120000-0007";
    writeShiftRecord(
      shifts,
      record(stopped, { state: "stopped", reason: "elapsed" }),
    );
    expect(requestStop(shifts, "../../etc")).toMatchObject({
      ok: false,
      kind: "invalid",
    });
    expect(requestStop(shifts, "shift-20261014-120000-0008")).toMatchObject({
      ok: false,
      kind: "not-found",
    });
    expect(requestStop(shifts, stopped)).toMatchObject({
      ok: false,
      kind: "stopped",
    });
    expect(existsSync(join(shifts, `${stopped}.stop`))).toBe(false);
    expect(readdirSync(shifts)).toEqual([`${stopped}.json`]);
  });
});

describe("a shift's worktrees, as eligibility reads them (x1gs.5.4.13)", () => {
  const id = "shift-20261015-120000-0a0b";

  test("a worktree is a shift's only as <trees>/<shift-id>-<n>, nothing after the digits", () => {
    const trees = "c:/work/harness/trees";
    expect(shiftOfWorktree(trees, `${trees}/${id}-1`)).toBe(id);
    expect(shiftOfWorktree(trees, `${trees}/${id}-12`)).toBe(id);
    for (const other of [
      `${trees}/${id}`,
      `${trees}/${id}-1x`,
      `${trees}/${id}-1/sub`,
      `${trees}/t-1`,
      `${trees}/shift-1-1`,
      `c:/work/harness/elsewhere/${id}-1`,
      `c:/work/harness/trees-old/${id}-1`,
    ])
      expect({ other, shift: shiftOfWorktree(trees, other) }).toEqual({
        other,
        shift: null,
      });
  });

  test("a shift stands live, dead or stopped by its record of this workspace; no record, another workspace's or a pid that is no process id is unknown", () => {
    const shifts = dir();
    const workspace = "c:/work/harness";
    const ids = [1, 2, 3, 4, 5].map((n) => `shift-20261015-120000-000${n}`);
    const at = (n: number, more: Partial<ShiftRecord>) =>
      writeShiftRecord(shifts, record(ids[n] ?? "", more));
    at(0, { pid: process.pid });
    // No process has this id (shift-recover.test.ts uses it as dead too).
    at(1, { pid: 2_000_000_000 });
    at(2, { state: "stopped", reason: "operator" });
    at(3, { workspace: "c:/work/other" });
    at(4, { pid: 0 });
    expect(
      [...ids, "shift-20261015-120000-0006"].map((shiftId) =>
        shiftStanding(shifts, shiftId, workspace),
      ),
    ).toEqual(["live", "dead", "stopped", "unknown", "unknown", "unknown"]);
    // The workspace in any spelling.
    expect(shiftStanding(shifts, ids[0] ?? "", "C:\\work\\harness\\")).toBe(
      "live",
    );
  });
});
