/** Explicit source composition for this run's closed-world tracker fixture. */
import { join } from "node:path";
import { operatorCouncilLedger } from "../../scripts/council/ledger-wiring";
import { bdRunner } from "../../scripts/hearth/routes/dev-api";
import { closeOnSignal, createHearth } from "../../scripts/hearth/server";
import { isMain } from "../../scripts/is-main";
import { completeFixtureModel } from "../../scripts/projects/complete-tracker-test-model";
import { REPOSITORY } from "./environment";

async function run() {
  if (
    process.argv.length !== 4 ||
    process.argv[2] !== "--root" ||
    process.argv[3] !== REPOSITORY
  )
    throw Error("Invalid isolated Shift fixture root.");
  const root = REPOSITORY;
  const hearth = await createHearth({
    root,
    port: Number(process.env.HEARTH_PORT),
    councilLedger: operatorCouncilLedger(),
    projectShiftCommand: [
      process.execPath,
      join(import.meta.dir, "shift-entry.ts"),
    ],
    api: {
      completeTracker: async () =>
        completeFixtureModel(
          await bdRunner(root)(["export", "--readonly", "--no-memories"]),
        ),
    },
  });
  if (hearth.kind !== "started") throw Error("Fixture Hearth was reused.");
  process.stdout.write(`hearth listening on ${hearth.url}\n`);
  closeOnSignal(hearth);
}
if (isMain(import.meta)) await run();
