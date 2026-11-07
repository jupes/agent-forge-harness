import { Database, constants as sqlite } from "bun:sqlite";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Reservation } from "../../types/hearth";
import { windowsConfigLeafKind } from "../config/transaction-windows";
import { comparableCheckout } from "../forge/runs";
import { nativeWindowsAcl } from "../hearth/acl-windows";
import {
  posixWriteFinding,
  readHomeFile,
  windowsWriteFinding,
} from "../hearth/home-guard";
import { hasDuplicateObjectKeys } from "../json-object-keys";
import { parseBeadsIssueId } from "../run-correlation";
import { canonicalTrustedDirectory } from "../trusted-directory";
import { LEDGER_SCHEMA_VERSION } from "./db";
import { foldReservations, type ReservationFact } from "./reservation-fold";

const LIMIT = 4096,
  PAYLOAD_BYTES = 16384,
  TOTAL_BYTES = 2 * 1024 * 1024;
const key = (path: string) =>
  process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
const unknown = () => ({
  state: "unknown" as const,
  reservations: null,
  reason:
    "Reservation history could not be completely verified. No worktree cleanup is authorized by this read.",
});
type Pin = { path: string; identity: string; ceiling: number };
interface Metadata {
  id: number;
  ts: string;
  kind: string;
  workspace: string;
  bead_id: string | null;
  session_id: string | null;
  bytes: number;
  storage: string;
}

/**
 * SELECT-only snapshot, no migrations or application writes. SQLite may coordinate through WAL/SHM.
 * Permission/path identity checks are best effort, not a claim that SQLite shares an ACL-checked handle.
 * The synchronous time checks refuse an overlong read; they cannot preempt a SQLite statement.
 */
export function readReservationInventory(options: {
  home: string;
  path: string;
  workspace: string;
}):
  | { state: "complete"; reservations: Reservation[] }
  | ReturnType<typeof unknown> {
  let db: Database | undefined, descriptor: number | undefined;
  const started = performance.now();
  const bounded = () => {
    if (performance.now() - started > 2000)
      throw Error("Inventory read cutoff");
  };
  try {
    const { home, path, workspace } = options;
    if (
      key(dirname(path)) !== key(home) ||
      readHomeFile(home).problem !== null ||
      key(canonicalTrustedDirectory(home)) !== key(home)
    )
      return unknown();
    const parent = lstatSync(home),
      parentIdentity = `${parent.dev}:${parent.ino}`;
    const acl = process.platform === "win32" ? nativeWindowsAcl() : null;
    const user = acl?.userSid();
    const guard = (
      file: string,
      ceiling: number,
      required = true,
    ): Pin | null => {
      bounded();
      try {
        const found = lstatSync(file);
        if (
          !found.isFile() ||
          found.isSymbolicLink() ||
          found.nlink !== 1 ||
          found.size > ceiling ||
          (acl
            ? windowsConfigLeafKind(file) !== "plain" ||
              windowsWriteFinding(acl.read(file), "file", user!) !== null
            : posixWriteFinding(found, process.getuid?.() ?? -1) !== null)
        )
          throw Error("Unsafe inventory file");
        const again = lstatSync(file);
        if (
          found.dev !== again.dev ||
          found.ino !== again.ino ||
          !again.isFile() ||
          again.nlink !== 1
        )
          throw Error("Changed inventory file");
        return { path: file, ceiling, identity: `${found.dev}:${found.ino}` };
      } catch (error) {
        if (!required && (error as NodeJS.ErrnoException).code === "ENOENT")
          return null;
        throw error;
      }
    };
    const main = guard(path, 64 * 1024 * 1024)!;
    // Never open a database that may need rollback-journal recovery.
    if (guard(`${path}-journal`, 1024 * 1024, false)) return unknown();
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = fstatSync(descriptor),
      header = Buffer.alloc(100);
    if (
      `${opened.dev}:${opened.ino}` !== main.identity ||
      readSync(descriptor, header, 0, header.length, 0) !== header.length ||
      header.subarray(0, 16).toString("binary") !== "SQLite format 3\0"
    )
      return unknown();
    const mode = header[18];
    if ((mode !== 1 && mode !== 2) || header[19] !== mode) return unknown();
    closeSync(descriptor);
    descriptor = undefined;
    const wal = guard(`${path}-wal`, 16 * 1024 * 1024, mode === 2),
      shm = guard(`${path}-shm`, 1024 * 1024, mode === 2);
    if (mode === 1 && (wal || shm)) return unknown();
    const pins = [main, ...(wal ? [wal] : []), ...(shm ? [shm] : [])];
    const unchanged = () => {
      bounded();
      if (key(canonicalTrustedDirectory(home)) !== key(home))
        throw Error("Changed inventory home");
      const found = lstatSync(home);
      if (`${found.dev}:${found.ino}` !== parentIdentity)
        throw Error("Changed inventory home");
      for (const pin of pins)
        if (guard(pin.path, pin.ceiling)?.identity !== pin.identity)
          throw Error("Changed inventory identity");
      if (guard(`${path}-journal`, 1024 * 1024, false))
        throw Error("Unsettled rollback journal");
      if (
        mode === 1 &&
        (guard(`${path}-wal`, 16 * 1024 * 1024, false) ||
          guard(`${path}-shm`, 1024 * 1024, false))
      )
        throw Error("Journal mode changed");
    };
    db = new Database(
      path,
      sqlite.SQLITE_OPEN_READONLY |
        sqlite.SQLITE_OPEN_NOFOLLOW |
        sqlite.SQLITE_OPEN_PRIVATECACHE,
    );
    db.exec(
      "PRAGMA busy_timeout=0; PRAGMA query_only=ON; PRAGMA temp_store=MEMORY; PRAGMA trusted_schema=OFF; BEGIN",
    );
    if (
      db.query<{ user_version: number }, []>("PRAGMA user_version").get()
        ?.user_version !== LEDGER_SCHEMA_VERSION
    )
      return unknown();
    const table = db
      .query<{ type: string; sql: string }, []>(
        "SELECT type, sql FROM sqlite_master WHERE name='events'",
      )
      .get();
    if (
      table?.type !== "table" ||
      !/^CREATE TABLE events\s*\(/i.test(table.sql)
    )
      return unknown();
    const columns = db
      .query<{ name: string; type: string }, []>("PRAGMA table_info(events)")
      .all();
    if (
      columns.map((row) => `${row.name}:${row.type}`).join(",") !==
      "id:INTEGER,ulid:TEXT,ts:TEXT,kind:TEXT,workspace:TEXT,bead_id:TEXT,run_id:TEXT,session_id:TEXT,provider:TEXT,model:TEXT,effort:TEXT,smith:TEXT,payload:TEXT"
    )
      return unknown();
    if (
      db
        .query<{ name: string }, []>("PRAGMA index_info(events_kind)")
        .all()
        .map((row) => row.name)
        .join(",") !== "kind,id"
    )
      return unknown();
    const where =
      "FROM events INDEXED BY events_kind WHERE kind IN ('reservation.acquired','reservation.released') AND workspace=? ORDER BY id LIMIT 4097";
    const scoped = comparableCheckout(workspace);
    const metadata = db
      .query<Metadata, [string]>(
        `SELECT id,ts,kind,workspace,bead_id,session_id,length(CAST(payload AS BLOB)) AS bytes,typeof(payload) AS storage ${where}`,
      )
      .all(scoped);
    if (metadata.length > LIMIT) return unknown();
    let total = 0,
      previous = 0;
    for (const row of metadata) {
      bounded();
      total += row.bytes;
      if (
        !Number.isSafeInteger(row.id) ||
        row.id <= previous ||
        !["reservation.acquired", "reservation.released"].includes(row.kind) ||
        row.workspace !== scoped ||
        typeof row.ts !== "string" ||
        !Number.isFinite(Date.parse(row.ts)) ||
        typeof row.bead_id !== "string" ||
        parseBeadsIssueId(row.bead_id) !== row.bead_id ||
        (row.session_id !== null &&
          (typeof row.session_id !== "string" ||
            row.session_id.length > 128)) ||
        row.storage !== "text" ||
        !Number.isSafeInteger(row.bytes) ||
        row.bytes < 1 ||
        row.bytes > PAYLOAD_BYTES ||
        total > TOTAL_BYTES
      )
        return unknown();
      previous = row.id;
    }
    const payloads = db
      .query<{ id: number; payload: string }, [string]>(
        `SELECT id,payload ${where}`,
      )
      .all(scoped);
    if (payloads.length !== metadata.length) return unknown();
    const facts: ReservationFact[] = [];
    for (let index = 0; index < metadata.length; index++) {
      bounded();
      const row = metadata[index]!,
        raw = payloads[index]!;
      if (
        raw.id !== row.id ||
        typeof raw.payload !== "string" ||
        Buffer.byteLength(raw.payload) !== row.bytes
      )
        return unknown();
      const payload: unknown = JSON.parse(raw.payload);
      if (
        hasDuplicateObjectKeys(raw.payload) ||
        !payload ||
        typeof payload !== "object" ||
        Array.isArray(payload) ||
        Object.keys(payload).sort().join(",") !== "globs,worktree"
      )
        return unknown();
      const p = payload as { worktree: unknown; globs: unknown };
      if (
        typeof p.worktree !== "string" ||
        !p.worktree ||
        p.worktree.length > 4096 ||
        !Array.isArray(p.globs) ||
        p.globs.length > 4096 ||
        p.globs.some((glob) => typeof glob !== "string" || glob.length > 4096)
      )
        return unknown();
      facts.push({
        kind: row.kind as ReservationFact["kind"],
        beadId: row.bead_id!,
        ...(row.session_id === null ? {} : { sessionId: row.session_id }),
        workspace: row.workspace,
        ts: row.ts,
        payload: { worktree: p.worktree, globs: p.globs },
      });
    }
    unchanged();
    const reservations = foldReservations(facts);
    db.exec("ROLLBACK");
    db.close();
    db = undefined;
    unchanged();
    return { state: "complete", reservations };
  } catch {
    return unknown();
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        /* No authority returned on a read error. */
      }
    }
    try {
      db?.close();
    } catch {
      /* Readonly connection owns no application write. */
    }
  }
}
