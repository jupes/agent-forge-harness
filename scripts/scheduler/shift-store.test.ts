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
