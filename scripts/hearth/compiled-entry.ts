import {
  INTERACTIVE_BOOTSTRAP_FLAG,
  runInteractiveBootstrap,
} from "../executors/interactive-bootstrap";

// Bun compiled executables bypass the source CLI entry check. This build-only
// entry is executed directly and deliberately is not imported as a CLI module.
if (process.argv[2] === INTERACTIVE_BOOTSTRAP_FLAG)
  await runInteractiveBootstrap();
else if (process.argv[2] === "--codex-sync")
  process.exitCode = (await import("../sync-codex")).runCodexSyncEntry();
else if (process.argv[2] === "--keeper-reader")
  (await import("../keeper/reader-entry")).runKeeperReader(
    process.argv.slice(3),
  );
else
  await (await import("./server")).runHearthServer(
    process.argv.slice(2),
    [process.execPath, "--keeper-reader"],
    [process.execPath, "--codex-sync"],
  );
