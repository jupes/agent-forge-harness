import type { LedgerEventInput } from "../../types/hearth";
import { appendEvent } from "../ledger/append";
import type { SinkResult } from "./types";

/**
 * The executors' way into the ledger — an `EventSink` that makes one
 * `appendEvent` per event and always says whether it was stored. Like
 * `appendEvent` it never throws; a refusal comes back as `{ ok: false }` (and
 * one stderr line from the ledger), so the caller can report it and carry on.
 * Without `path` the event goes to the ledger of the process environment.
 */
export function ledgerSink(
  options: { path?: string } = {},
): (event: LedgerEventInput) => SinkResult {
  return (event) => {
    const result = appendEvent(event, options);
    return result.ok ? { ok: true } : result;
  };
}
