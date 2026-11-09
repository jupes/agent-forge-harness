import { completeTrackerEntry } from "./complete-tracker-entry";

// Fixed source-mode entry; packaged mode dispatches the same handler directly.
await completeTrackerEntry(process.argv.slice(2));
