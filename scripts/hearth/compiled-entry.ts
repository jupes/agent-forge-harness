import { runHearthServer } from "./server";

// Bun compiled executables bypass the source CLI entry check. This build-only
// entry is executed directly and deliberately is not imported as a CLI module.
await runHearthServer(process.argv.slice(2));
