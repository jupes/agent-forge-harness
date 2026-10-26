/** Minimal standalone subprocess for the routing journal mutex test. */
import { writeFileSync } from "node:fs";
import { createSmithConfigJournalStorage } from "./smith-config-journal-storage";

const profile = process.env["SMITH_ROUTING_STORAGE_CHILD_PROFILE"],
  signal = process.env["SMITH_ROUTING_STORAGE_CHILD_SIGNAL"],
  entered = process.env["SMITH_ROUTING_STORAGE_CHILD_ENTERED"];

if (
  process.env["SMITH_ROUTING_STORAGE_CHILD_ROLE"] !== "exclusive" ||
  !profile ||
  !signal ||
  !entered
) {
  process.exitCode = 2;
} else {
  try {
    const storage = createSmithConfigJournalStorage(profile, "routing");
    writeFileSync(signal, "started", { flag: "wx" });
    await storage.exclusive(async () => {
      writeFileSync(entered, "entered", { flag: "wx" });
    });
  } catch {
    // The owner observes a nonzero exit without exposing local paths or errors.
    process.exitCode = 1;
  }
}
