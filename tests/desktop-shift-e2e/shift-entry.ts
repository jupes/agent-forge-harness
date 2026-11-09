/** Real attended engine/provider adapters; explicit closed-world tracker only. */
import { bdRunner } from "../../scripts/hearth/routes/dev-api";
import { isMain } from "../../scripts/is-main";
import { completeFixtureModel } from "../../scripts/projects/complete-tracker-test-model";
import { runProjectShiftExecutionEntry } from "../../scripts/shifts/execution-runtime";

if (isMain(import.meta))
  await runProjectShiftExecutionEntry(process.argv.slice(2), {}, async () =>
    completeFixtureModel(
      await bdRunner(process.cwd())(["export", "--readonly", "--no-memories"]),
    ),
  );
