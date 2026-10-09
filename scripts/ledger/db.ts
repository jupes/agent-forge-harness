/**
 * The ledger's SQLite connection and schema.
 *
 * One file, opened once per process and path, migrated by `PRAGMA user_version`.
 * `bun:sqlite` only loads under Bun: nothing the dashboard bundles or Vite loads
 * under Node may import this module.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { ledgerPath } from "./paths";

/** Migration `n` takes the file from `user_version` n to n + 1. Append only. */
const MIGRATIONS: readonly string[] = [
  `
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ulid TEXT NOT NULL UNIQUE,
  ts TEXT NOT NULL, kind TEXT NOT NULL, workspace TEXT NOT NULL,
  bead_id TEXT, run_id TEXT, session_id TEXT,
  provider TEXT, model TEXT, effort TEXT, smith TEXT,
  payload TEXT NOT NULL
);
CREATE INDEX events_bead ON events(bead_id, id);
CREATE INDEX events_run ON events(run_id, id);
CREATE INDEX events_session ON events(session_id, id);
CREATE INDEX events_kind ON events(kind, id);
CREATE INDEX events_workspace ON events(workspace, id);
CREATE UNIQUE INDEX events_session_started_once ON events(session_id) WHERE kind = 'session.started';
CREATE TABLE session_models (
  session_id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL,
  effort TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE daily_summaries (
  day TEXT NOT NULL, workspace TEXT NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL,
  PRIMARY KEY (day, workspace, kind)
);
`,
];

export const LEDGER_SCHEMA_VERSION = MIGRATIONS.length;

/** How long a first open waits for another process that is creating the schema. */
const MIGRATION_BUSY_MS = 2000;
/** How long an append waits on a writer before giving up: hooks must stay fast. */
const APPEND_BUSY_MS = 50;

const connections = new Map<string, Database>();

function userVersion(db: Database): number {
  const row = db
    .query<{ user_version: number }, []>("PRAGMA user_version")
    .get();
  return row?.user_version ?? 0;
}

export function isBusy(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("SQLITE_BUSY");
}

/**
 * Bring the file to the current schema. Several processes can open an empty
 * ledger at the same moment, so the version is re-read under the write lock:
 * whoever loses the race finds the schema current and applies nothing.
 * Exported so a test can enter it the way the loser does — having seen an
 * empty file before the winner committed; `prepare` is the only caller.
 */
export function migrate(db: Database): void {
  // The journal mode cannot change inside a transaction, and it persists in the file.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (let v = userVersion(db); v < MIGRATIONS.length; v++) {
      db.exec(MIGRATIONS[v] ?? "");
      db.exec(`PRAGMA user_version = ${v + 1}`);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Errors that go away when another process finishes creating the file: a held
 * lock, or (seen on Windows while the journal mode is being switched) a
 * transient I/O error on the journal files.
 */
function isTransientOpenError(error: unknown): boolean {
  if (isBusy(error)) return true;
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return (
    typeof code === "string" &&
    (code.startsWith("SQLITE_IOERR") || code.startsWith("SQLITE_LOCKED"))
  );
}

function prepare(file: string): Database {
  const db = new Database(file, { create: true });
  try {
    // Both are per-connection settings, so they are issued on every open.
    db.exec(`PRAGMA busy_timeout = ${MIGRATION_BUSY_MS}`);
    db.exec("PRAGMA synchronous = NORMAL");
    if (userVersion(db) < MIGRATIONS.length) migrate(db);
    db.exec(`PRAGMA busy_timeout = ${APPEND_BUSY_MS}`);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * The connection for a ledger file, opened once per process and path. Creates
 * the directory, the file and the schema as needed. Throws when the file
 * cannot be opened or migrated; `appendEvent` turns that into a result.
 */
export function openLedger(path: string = ledgerPath()): Database {
  const file = resolve(path);
  const cached = connections.get(file);
  if (cached) return cached;
  mkdirSync(dirname(file), { recursive: true });
  const deadline = Date.now() + MIGRATION_BUSY_MS;
  for (;;) {
    try {
      const db = prepare(file);
      connections.set(file, db);
      return db;
    } catch (error) {
      if (!isTransientOpenError(error) || Date.now() > deadline) throw error;
      Bun.sleepSync(5);
    }
  }
}

/** Close one ledger connection, or every one this process holds. */
export function closeLedger(path?: string): void {
  const files = path === undefined ? [...connections.keys()] : [resolve(path)];
  for (const file of files) {
    connections.get(file)?.close();
    connections.delete(file);
  }
}
