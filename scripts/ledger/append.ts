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
import { redactSecrets } from "../secret-patterns";
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

/** One row of the `events` table, ready to insert. */
interface Row {
  ulid: string;
  ts: string;
  kind: LedgerEventInput["kind"];
  workspace: string;
  beadId: string | null;
  runId: string | null;
  sessionId: string | null;
  provider: string | null;
  model: string | null;
  effort: string | null;
  smith: string | null;
  payload: string;
}

/**
 * The first of the given fields the secret scanner would change, as a refusal
 * message that does not repeat the value. These fields are what events are
 * joined on, so they are stored exactly as given or not at all: a redacted id
 * would no longer match anything, and a secret-shaped one is a bug in the
 * emitter.
 */
function secretShaped(fields: Record<string, string | null>): string | null {
  for (const [name, value] of Object.entries(fields)) {
    if (value === null) continue;
    const found = redactSecrets(value).redactions[0];
    if (found !== undefined)
      return `${name} looks like a secret (${found.kind}); the event was dropped rather than stored under a secret or a redacted id`;
  }
  return null;
}

/** Strip, redact and lay out one validated event, or say why it cannot be stored. */
function toRow(
  input: LedgerEventInput,
  opts: AppendOptions,
): { ok: true; row: Row } | { ok: false; error: string } {
  const ulid = opts.ulid ?? mintUlid();
  const workspace = comparableCheckout(input.workspace);
  const beadId = input.beadId ?? null;
  const runId = input.runId ?? null;
  const sessionId = input.sessionId ?? input.executor?.sessionId ?? null;
  const error = secretShaped({ workspace, beadId, runId, sessionId, ulid });
  if (error !== null) return { ok: false, error };

  const executor = input.executor ? redactDeep(input.executor) : undefined;
  const payload = capSummary(
    redactDeep(stripPayload(input.kind, input.payload)),
  );
  return {
    ok: true,
    row: {
      ulid,
      ts: input.ts
        ? new Date(input.ts).toISOString()
        : (opts.now?.() ?? new Date()).toISOString(),
      kind: input.kind,
      workspace,
      beadId,
      runId,
      sessionId,
      provider: executor?.provider ?? null,
      model: executor?.model ?? null,
      effort: executor?.effort ?? null,
      smith: executor?.smith ?? null,
      payload: JSON.stringify(payload),
    },
  };
}

function insert(row: Row, path: string | undefined): AppendResult {
  const db = openLedger(path);
  const result = db
    .query(INSERT)
    .run(
      row.ulid,
      row.ts,
      row.kind,
      row.workspace,
      row.beadId,
      row.runId,
      row.sessionId,
      row.provider,
      row.model,
      row.effort,
      row.smith,
      row.payload,
    );
  if (result.changes > 0)
    return { ok: true, id: Number(result.lastInsertRowid), ulid: row.ulid };

  // Ignored: either this ulid is already stored, or the session already has its
  // one `session.started` (the partial unique index).
  if (row.kind === "session.started" && row.sessionId !== null) {
    const existing = db
      .query<{ ulid: string }, [string]>(
        "SELECT ulid FROM events WHERE session_id = ? AND kind = 'session.started'",
      )
      .get(row.sessionId);
    if (existing) return { ok: true, duplicate: true, ulid: existing.ulid };
  }
  return { ok: true, duplicate: true, ulid: row.ulid };
}

/**
 * Validate, strip to the kind's allowlist, redact, and insert one event.
 * The payload and the executor's provider, model, effort and smith are stored
 * redacted; an event whose workspace, bead, run, session or ulid is
 * secret-shaped is refused. A repeated `ulid`, or a second `session.started`
 * for a session, is reported as `duplicate` and stores nothing. An insert that
 * finds the ledger busy is tried once more, then refused.
 */
export function appendEvent(
  input: LedgerEventInput,
  opts: AppendOptions = {},
): AppendResult {
  try {
    const valid = validateLedgerEventInput(input);
    if (!valid.ok) return refuse(valid.error);
    const prepared = toRow(valid.value, opts);
    if (!prepared.ok) return refuse(prepared.error);
    try {
      return insert(prepared.row, opts.path);
    } catch (error) {
      if (!isBusy(error)) throw error;
      return insert(prepared.row, opts.path);
    }
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }
}
