/**
 * Where a shift is known outside its own process: one record per shift and a
 * stop request beside it, in `<home>/shifts/`.
 *
 * The record (`<id>.json`) is written by the shift as it goes: what it was
 * asked to do, each bead it took and how that ended, and why it stopped. It is
 * a report, never read back by the shift to decide anything: Beads holds each
 * bead's state and the ledger the history. A recovery (`shift-recover.ts`)
 * reads it to know which beads to look at, and closes it. The stop request
 * (`<id>.stop`) is an empty file: `forge:shift stop` and
 * `POST /shifts/:id/stop` write it through `requestStop`, and a running shift
 * looks for it on every tick. Both go in the harness home, so the hearth and a
 * shift started with the same home see the same files. `recover-lock.db`
 * beside them is the recoveries' lock.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ShiftHostSnapshot } from "../../types/shift-host";
import { comparableCheckout } from "../forge/runs";

/** The directory under the harness home (`AGENT_FORGE_HOME`) that holds the shift records. */
export const SHIFTS_DIR = "shifts";

const SHIFT_ID = /^shift-\d{8}-\d{6}-[0-9a-f]{4}$/;

export function isShiftId(value: unknown): value is string {
  return typeof value === "string" && SHIFT_ID.test(value);
}

/** A shift's worktree directory: `<shift-id>-<n>`, nothing after the digits. */
const SHIFT_WORKTREE = /^(shift-\d{8}-\d{6}-[0-9a-f]{4})-[0-9]+$/;

/**
 * The shift a worktree was made for, by its place and name, or null: a shift
 * makes each of its worktrees at `<main>/trees/<shift-id>-<n>` (`runShift`).
 * `trees` is `<main>/trees` and `worktree` the path, both already in one
 * spelling (`comparablePath`, which this module does not import: the ledger's
 * queries import it).
 */
export function shiftOfWorktree(
  trees: string,
  worktree: string,
): string | null {
  if (!worktree.startsWith(`${trees}/`)) return null;
  return SHIFT_WORKTREE.exec(worktree.slice(trees.length + 1))?.[1] ?? null;
}

/**
 * How a shift stands, as a reader outside its process can tell:
 * - `live`: its record says running and its process is running (a pid the
 *   system gave to another program after the shift ended reads as live too,
 *   as it does for recovery);
 * - `dead`: its record says running and its process has ended without
 *   stopping it (`forge:shift recover` is the way back);
 * - `stopped`: its record says it stopped, which it writes only once every
 *   run it started has ended;
 * - `unknown`: no record of it for this workspace can be read here (another
 *   harness home, a record removed, or a pid that is no process id).
 */
export type ShiftStanding = "live" | "dead" | "stopped" | "unknown";

/** How the shift `id` of `workspace` stands, from its record in `dir`. Reads only. */
export function shiftStanding(
  dir: string,
  id: string,
  workspace: string,
): ShiftStanding {
  const record = readShiftRecord(dir, id);
  if (
    record === null ||
    typeof record.workspace !== "string" ||
    comparableCheckout(record.workspace) !== comparableCheckout(workspace)
  )
    return "unknown";
  if (record.state === "stopped") return "stopped";
  if (!isProcessId(record.pid)) return "unknown";
  return processAlive(record.pid) ? "live" : "dead";
}

const pad = (value: number, width = 2): string =>
  String(value).padStart(width, "0");

/** `shift-YYYYMMDD-HHMMSS-xxxx`: the UTC second the shift started and four hex digits. */
export function mintShiftId(
  now: Date,
  random: () => string = () =>
    crypto.getRandomValues(new Uint16Array(1))[0]?.toString(16) ?? "0",
): string {
  const day = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const time = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `shift-${day}-${time}-${random().toLowerCase().padStart(4, "0").slice(-4)}`;
}

/**
 * How a bead the shift took ended, so far:
 * - `running`: its run is in flight.
 * - `review`: a run succeeded and the bead was submitted; its draft pull
 *   request is `prUrl`, or `error` says why none was opened.
 * - `released`: the shift stopped it (the deadline, a stop) and put it back in
 *   `queued`, or a recovery did after the shift's process ended (`error` then
 *   says `recovered: …`).
 * - `halted`: its runs failed past the repairs, and it was halted.
 * - `left`: the shift let it go in another state: the operator paused or
 *   halted it while it ran, or a queue move after the run did not go through,
 *   or a recovery found it moved since and left it (`error` says which).
 * - `set-aside`: it never ran: the claim was refused, or its smith, its
 *   reservation or its worktree could not be had.
 */
export const SHIFT_BEAD_OUTCOMES = [
  "running",
  "review",
  "released",
  "halted",
  "left",
  "set-aside",
] as const;

export type ShiftBeadOutcome = (typeof SHIFT_BEAD_OUTCOMES)[number];

export interface ShiftBeadRecord {
  beadId: string;
  /** The Forge run id its events carry. */
  runId: string;
  outcome: ShiftBeadOutcome;
  /** Runs made: the first, then each repair. */
  attempts: number;
  smith?: string;
  worktree?: string;
  branch?: string;
  /** What its runs reported spending, when they reported it. */
  costUsd?: number;
  /**
   * Why it ended as it did, when that was not a success; for a bead in
   * `review`, why its pull request was not opened (`pull request: <kind>: …`).
   */
  error?: string;
  /** Its draft pull request, once opened. */
  prUrl?: string;
  /** Whose body the pull request step used: the run's, or one the shift wrote. */
  prBody?: "run" | "shift";
  /** Its `worklog:` comments that bd did not take (they stop nothing). */
  commentError?: string;
}

export interface ShiftOptionsRecord {
  concurrency: number;
  forMs: number;
  maxBeads: number;
  maxUsd: number;
  repairs: number;
  /** The host threshold it sampled against (`[shift] throttle`); absent on a record written before x1gs.5.4.7. */
  throttle?: number;
  /** The branch on origin its worktrees start from and its pull requests go into. */
  base?: string;
  epic?: string;
  smith?: string;
  /** Explicit per-run limit; absent means the shift's remaining time. */
  runTimeoutMs?: number;
}

export interface ShiftRecord {
  shiftId: string;
  /** The process running the shift. */
  pid: number;
  /** The workspace its events are recorded under. */
  workspace: string;
  /** ISO 8601. */
  startedAt: string;
  deadline: string;
  state: "running" | "stopped";
  reason?: string;
  endedAt?: string;
  /** What stopped the shift, when it failed rather than ending as asked. */
  error?: string;
  options: ShiftOptionsRecord;
  /** The commit origin's base named when the shift fetched it: every worktree started there. */
  baseSha?: string;
  /** The sum of the cost its runs reported. */
  spentUsd: number;
  /** Runs that reported no cost (a provider that does not report one). */
  unpriced: number;
  /** Admissions that reached a worktree; absent on older records, never inferred from outcomes. */
  admitted?: number;
  /** Latest attended admission sample; old or ordinary shifts may have none. */
  host?: ShiftHostSnapshot;
  beads: ShiftBeadRecord[];
}

/** A record as listed: whether its process is running now. */
export type ListedShift = ShiftRecord & { alive: boolean };

const recordPath = (dir: string, id: string): string => join(dir, `${id}.json`);
const stopPath = (dir: string, id: string): string => join(dir, `${id}.stop`);

/** Write the record whole, through a file beside it, so a reader never sees half of one. */
export function writeShiftRecord(dir: string, record: ShiftRecord): void {
  if (!isShiftId(record.shiftId))
    throw new Error(`not a shift id: ${record.shiftId}`);
  mkdirSync(dir, { recursive: true });
  const path = recordPath(dir, record.shiftId);
  const draft = `${path}.${process.pid}.tmp`;
  writeFileSync(draft, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(draft, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The shift's record, or null when there is none that names it. */
export function readShiftRecord(dir: string, id: string): ShiftRecord | null {
  if (!isShiftId(id)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(recordPath(dir, id), "utf8"));
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    value["shiftId"] !== id ||
    (value["state"] !== "running" && value["state"] !== "stopped") ||
    typeof value["pid"] !== "number" ||
    typeof value["startedAt"] !== "string" ||
    !Array.isArray(value["beads"])
  )
    return null;
  // justification: the fields every reader relies on are checked above; the record is the shift's own writing.
  return value as unknown as ShiftRecord;
}

/**
 * Whether `value` is a process id `processAlive` can ask about: a whole number
 * from 1 to 2^31 - 1. `process.kill` takes a signed 32-bit pid and throws for
 * a larger or a fractional one, which `processAlive` reads as "not running";
 * 0 and -1 name a process group or every process, not one process.
 */
export function isProcessId(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    Number(value) >= 1 &&
    Number(value) <= 2 ** 31 - 1
  );
}

/** Whether a process with this id is running (on Windows as elsewhere: signal 0 only asks). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it is there, and someone else's.
    return (error as { code?: unknown }).code === "EPERM";
  }
}

/** Every record in the directory, newest first, at most `limit`. */
export function listShiftRecords(dir: string, limit = 50): ListedShift[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => readShiftRecord(dir, name.slice(0, -".json".length)))
    .filter((record): record is ShiftRecord => record !== null)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit)
    .map((record) => ({ ...record, alive: processAlive(record.pid) }));
}

export type StopOutcome =
  | { ok: true; value: { shiftId: string; already: boolean } }
  | {
      ok: false;
      kind: "invalid" | "not-found" | "stopped";
      error: string;
    };

/**
 * Ask a running shift to stop. The shift finds the request on its next tick,
 * stops every child it runs, puts their beads back in `queued`, releases
 * their reservations and records `shift.stopped`. Writes nothing for a shift
 * that has no record or has stopped already.
 */
export function requestStop(dir: string, id: string): StopOutcome {
  if (!isShiftId(id))
    return {
      ok: false,
      kind: "invalid",
      error: "id: expected a shift id (shift-YYYYMMDD-HHMMSS-xxxx)",
    };
  const record = readShiftRecord(dir, id);
  if (record === null)
    return {
      ok: false,
      kind: "not-found",
      error: `No shift has the id ${id}.`,
    };
  if (record.state === "stopped")
    return {
      ok: false,
      kind: "stopped",
      error: `${id} has stopped already (${record.reason ?? "no reason recorded"}).`,
    };
  const path = stopPath(dir, id);
  if (existsSync(path))
    return { ok: true, value: { shiftId: id, already: true } };
  writeFileSync(path, "");
  return { ok: true, value: { shiftId: id, already: false } };
}

/** Whether a stop was asked for this shift. */
export function stopRequested(dir: string, id: string): boolean {
  return isShiftId(id) && existsSync(stopPath(dir, id));
}

/**
 * Whether a shift may not be given this id: it is not a shift id, or a record
 * (readable or not) or a stop request already has it. A new shift with the id
 * of an old one would overwrite its record, and would stop at its first tick
 * on a stop request left for another.
 */
export function shiftIdInUse(dir: string, id: string): boolean {
  return (
    !isShiftId(id) ||
    existsSync(recordPath(dir, id)) ||
    existsSync(stopPath(dir, id))
  );
}
