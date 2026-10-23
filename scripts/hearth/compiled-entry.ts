import { runHearthServer } from "./server";

// Bun compiled executables bypass the source CLI entry check. This build-only
// entry is executed directly and deliberately is not imported as a CLI module.
if (process.argv[2] === "--keeper-reader")
  (await import("../keeper/reader-runtime")).runKeeperReader(
    process.argv.slice(3),
  );
else
  await runHearthServer(process.argv.slice(2), [
    process.execPath,
    "--keeper-reader",
  ]);
