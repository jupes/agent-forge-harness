import { runKeeperReader } from "../keeper/reader-entry";
import { runProjectShiftExecutionEntry } from "../shifts/execution-entry";
import { runHearthServer } from "./server";

// Bun compiled executables bypass the source CLI entry check. This build-only
// entry is executed directly and deliberately is not imported as a CLI module.
if (process.argv[2] === "--keeper-reader")
  runKeeperReader(process.argv.slice(3));
else if (process.argv[2] === "--project-shift-run")
  await runProjectShiftExecutionEntry(process.argv.slice(3));
else
  await runHearthServer(
    process.argv.slice(2),
    [process.execPath, "--keeper-reader"],
    [process.execPath, "--project-shift-run"],
  );
