import {
  INTERACTIVE_BOOTSTRAP_FLAG,
  runInteractiveBootstrap,
} from "../executors/interactive-bootstrap";
import type { HearthInternalCommands } from "./server";

const commands: HearthInternalCommands = {
  keeperReaderCommand: [process.execPath, "--keeper-reader"],
  projectShiftCommand: [process.execPath, "--project-shift-run"],
  codexSyncCommand: [process.execPath, "--codex-sync"],
  interactiveBootstrapCommand: [process.execPath, INTERACTIVE_BOOTSTRAP_FLAG],
};

// Compiled modes import only pure handlers. No source CLI or server starts before its explicit mode.
if (process.argv[2] === INTERACTIVE_BOOTSTRAP_FLAG)
  await runInteractiveBootstrap();
else if (process.argv[2] === "--codex-sync")
  process.exitCode = (await import("../sync-codex-core")).runCodexSyncEntry();
else if (process.argv[2] === "--keeper-reader")
  (await import("../keeper/reader-runtime")).runKeeperReader(
    process.argv.slice(3),
  );
else if (process.argv[2] === "--project-shift-run")
  await (
    await import("../shifts/execution-runtime")
  ).runProjectShiftExecutionEntry(process.argv.slice(3), commands);
else
  await (await import("./server")).runHearthServer(
    process.argv.slice(2),
    commands,
  );
