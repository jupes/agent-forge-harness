import { appendEvent } from "../ledger/append";
import type { EventSink } from "./types";

/**
 * The executors' way into the ledger: one `appendEvent` per event. Like
 * `appendEvent` it never throws; a refusal comes back as `{ ok: false }` (and
 * one stderr line from the ledger), so the caller can report it and carry on.
 * Without `path` the event goes to the ledger of the process environment.
 */
export function ledgerSink(options: { path?: string } = {}): EventSink {
  return (event) => {
    const result = appendEvent(event, options);
    return result.ok ? { ok: true } : result;
  };
}
