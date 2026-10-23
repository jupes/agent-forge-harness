/** Closed browser-only metadata fixture. It never launches a shift or a provider. */
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { writeOwnerOnly } from "../../scripts/hearth/token";
import { FIXTURE_PROJECT_ID } from "../../scripts/projects/testing";
import {
  listShiftRecords,
  mintShiftId,
  SHIFTS_DIR,
  type ShiftRecord,
  writeShiftRecord,
} from "../../scripts/scheduler/shift-store";
import {
  createProjectShiftRegistry,
  projectShiftRegistryFile,
} from "../../scripts/shifts/registry";
import { SHIFT_STOP_REASONS } from "../../types/hearth";

const input = z.tuple([
  z.string().min(1),
  z.enum(["reset", "corrupt", "gallery"]),
  z.coerce.number().int().positive(),
]);
const [rawRoot, mode, witnessPid] = input.parse(process.argv.slice(2));
const root = realpathSync.native(rawRoot),
  repository = join(root, "checkout"),
  home = join(repository, "home");
if (
  lstatSync(rawRoot).isSymbolicLink() ||
  realpathSync.native(dirname(root)) !== realpathSync.native(tmpdir()) ||
  !/^agent-forge-desktop-shift-[a-zA-Z0-9]+$/.test(basename(root)) ||
  [repository, home].some(
    (path) =>
      lstatSync(path).isSymbolicLink() || realpathSync.native(path) !== path,
  ) ||
  readFileSync(join(repository, "attended-native-fixture.marker"), "utf8") !==
    "agent-forge-attended-native-fixture-v1"
)
  throw Error("The state gallery requires its checked disposable checkout.");
const directory = join(home, SHIFTS_DIR);
if (
  existsSync(directory) &&
  listShiftRecords(directory, 1000).some(
    (record) => record.state === "running" && record.alive,
  )
)
  throw Error("The state gallery cannot replace a live fixture original.");

const file = projectShiftRegistryFile(home);
writeOwnerOnly(
  file,
  JSON.stringify({ version: mode === "corrupt" ? 999 : 1, records: [] }),
);
if (mode === "gallery") {
  // A real, bounded inert process supplies only a live observation. It is never
  // a control target, and the browser never sends Stop against planted records.
  process.kill(witnessPid, 0);
  const registry = createProjectShiftRegistry({ home, root: repository });
  for (const reason of [...SHIFT_STOP_REASONS, null]) {
    const shiftId = mintShiftId(new Date()),
      { intent } = await registry.reserve(
        FIXTURE_PROJECT_ID,
        {
          requestId: crypto.randomUUID(),
          expectedCatalogRevision: 1,
          options: {
            for: "1m",
            concurrency: 1,
            maxBeads: 1,
            maxUsd: 5,
            repairs: 0,
            base: "main",
          },
        },
        async () => ({ shiftId }),
      );
    await registry.markAttempted(
      FIXTURE_PROJECT_ID,
      intent.request.requestId,
      intent.requestHash,
    );
    const startedAt = new Date().toISOString();
    const record: ShiftRecord = {
      shiftId,
      pid: witnessPid,
      workspace: intent.workspace,
      startedAt,
      deadline: new Date(Date.parse(startedAt) + 60000).toISOString(),
      state: reason === null ? "running" : "stopped",
      ...(reason === null ? {} : { reason, endedAt: startedAt }),
      options: {
        concurrency: 1,
        forMs: 60000,
        maxBeads: 1,
        maxUsd: 5,
        repairs: 0,
        base: "main",
        throttle: 1,
      },
      spentUsd: 0,
      unpriced: 0,
      admitted: 0,
      host: { asOf: startedAt, cpu: 1, memory: 0.5, busy: reason === null },
      beads: [],
    };
    writeShiftRecord(directory, record);
  }
}
console.log(JSON.stringify({ ok: true, data: { mode }, error: null }));
