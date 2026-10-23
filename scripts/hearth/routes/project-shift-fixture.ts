import { join } from "node:path";
import { FIXTURE_PROJECT_ID } from "../../projects/testing";
import { SHIFTS_DIR, writeShiftRecord } from "../../scheduler/shift-store";
import { createProjectShiftRegistry } from "../../shifts/registry";
import type { TestHearth } from "../testing";

export const FIXTURE_SHIFT_ID = "shift-20261023-063000-0001";
export const FIXTURE_SHIFT_START = {
  requestId: "b14cc7eb-3231-4930-a288-d411c5ee0426",
  expectedCatalogRevision: 1,
  options: {
    for: "2h",
    concurrency: 2,
    maxBeads: 4,
    maxUsd: 10,
    repairs: 3,
    base: "master",
  },
};
/** Private fake original only; no engine, process, Git or tracker write. */
export async function seedProjectShift(
  h: TestHearth,
  actual?: "live" | "dead",
) {
  const { intent } = await createProjectShiftRegistry({
    home: h.home,
    root: h.root,
  }).reserve(FIXTURE_PROJECT_ID, FIXTURE_SHIFT_START, async () => ({
    shiftId: FIXTURE_SHIFT_ID,
  }));
  if (actual) {
    const startedAt = new Date(Date.parse(intent.createdAt) + 1);
    writeShiftRecord(join(h.home, SHIFTS_DIR), {
      shiftId: FIXTURE_SHIFT_ID,
      workspace: h.workspace,
      pid: actual === "live" ? process.pid : 2_000_000_000,
      state: "running",
      startedAt: startedAt.toISOString(),
      deadline: new Date(startedAt.getTime() + 7_200_000).toISOString(),
      options: {
        concurrency: 2,
        forMs: 7_200_000,
        maxBeads: 4,
        maxUsd: 10,
        repairs: 3,
        base: "master",
      },
      spentUsd: 0,
      unpriced: 0,
      admitted: 0,
      beads: [],
    });
  }
}
