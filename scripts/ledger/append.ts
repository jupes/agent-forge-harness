/**
 * `appendEvent` — the one way anything is written to the ledger.
 *
 * Synchronous and local: one validated, redacted insert, no network. It never
 * throws — an emitter (a hook, a gate, a CLI) must not fail because the audit
 * trail could not be written — and reports a failure as a result plus one
 * stderr line.
 */

import type { LedgerEventInput } from "../../types/hearth";
import { comparableCheckout } from "../forge/runs";
import { validateLedgerEventInput } from "../hearth/validate";
import { isBusy, openLedger } from "./db";
import { stripPayload } from "./payload-allowlist";
import { capSummary, redactDeep } from "./redact";
import { ulid as mintUlid } from "./ulid";

export type AppendResult =
  | { ok: true; id: number; ulid: string }
  | { ok: true; duplicate: true; ulid: string }
  | { ok: false; error: string };

export interface AppendOptions {
  /** Supplied by an emitter that may deliver the same event twice. */
  ulid?: string;
  /** The ledger file; defaults to the one under `AGENT_FORGE_HOME` / `~/.agent-forge`. */
  path?: string;
  now?: () => Date;
}

const INSERT = `INSERT OR IGNORE INTO events
  (ulid, ts, kind, workspace, bead_id, run_id, session_id, provider, model, effort, smith, payload)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function refuse(error: string): AppendResult {
  console.error(`ledger: event not recorded: ${error}`);
  return { ok: false, error };
}

function insert(input: LedgerEventInput, opts: AppendOptions): AppendResult {
  const db = openLedger(opts.path);
  const ulid = opts.ulid ?? mintUlid();
  const ts = input.ts
    ? new Date(input.ts).toISOString()
    : (opts.now?.() ?? new Date()).toISOString();
  const executor = input.executor ? redactDeep(input.executor) : undefined;
  const sessionId = input.sessionId ?? input.executor?.sessionId ?? null;
  const payload = capSummary(
    redactDeep(stripPayload(input.kind, input.payload)),
  );
  const result = db
    .query(INSERT)
    .run(
      ulid,
      ts,
      input.kind,
      comparableCheckout(input.workspace),
      input.beadId ?? null,
      input.runId ?? null,
      sessionId,
      executor?.provider ?? null,
      executor?.model ?? null,
      executor?.effort ?? null,
      executor?.smith ?? null,
      JSON.stringify(payload),
    );
  if (result.changes > 0)
    return { ok: true, id: Number(result.lastInsertRowid), ulid };

  // Ignored: either this ulid is already stored, or the session already has its
  // one `session.started` (the partial unique index).
  if (input.kind === "session.started" && sessionId !== null) {
    const existing = db
      .query<{ ulid: string }, [string]>(
        "SELECT ulid FROM events WHERE session_id = ? AND kind = 'session.started'",
      )
      .get(sessionId);
    if (existing) return { ok: true, duplicate: true, ulid: existing.ulid };
  }
  return { ok: true, duplicate: true, ulid };
}

/**
 * Validate, strip to the kind's allowlist, redact, and insert one event.
 * A repeated `ulid`, or a second `session.started` for a session, is reported
 * as `duplicate` and stores nothing.
 */
export function appendEvent(
  input: LedgerEventInput,
  opts: AppendOptions = {},
): AppendResult {
  try {
    const valid = validateLedgerEventInput(input);
    if (!valid.ok) return refuse(valid.error);
    try {
      return insert(valid.value, opts);
    } catch (error) {
      if (!isBusy(error)) throw error;
      return insert(valid.value, opts);
    }
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }
}
