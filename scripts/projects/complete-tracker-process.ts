import { isMain } from "../is-main";
import { completeTrackerEntry } from "./complete-tracker-entry";

// Fixed source-mode entry; packaged mode dispatches the same handler directly.
if (isMain(import.meta)) await completeTrackerEntry(process.argv.slice(2));
