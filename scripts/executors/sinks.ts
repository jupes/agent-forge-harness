import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { validateLedgerEventInput } from "../hearth/validate";
import type { EventSink } from "./types";

/**
 * Stand-in for the ledger until `scripts/ledger` (x1gs.2.1) exists: one JSON
 * event per line. Events are validated first, so a file written here can be
 * replayed into `appendEvent` unchanged.
 */
export function ndjsonSink(file: string): EventSink {
  mkdirSync(dirname(file), { recursive: true });
  return (event) => {
    const checked = validateLedgerEventInput(event);
    if (!checked.ok)
      throw new Error(`refusing invalid event: ${checked.error}`);
    appendFileSync(file, `${JSON.stringify(event)}\n`);
  };
}
