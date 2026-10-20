import { runDesktopEntry } from "../hearth/desktop-entry";

// Bun compiled executables bypass the source CLI entry check. This build-only
// entry is executed directly and deliberately is not imported as a CLI module.
await runDesktopEntry(process.argv.slice(2));
