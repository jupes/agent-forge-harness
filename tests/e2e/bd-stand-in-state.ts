/**
 * The `bd` stand-in's issues, as one file both the stand-in and the suite's
 * helpers read and write.
 *
 * A write goes to a temporary file that then replaces the state, so a reader
 * never sees half of one. On Windows, replacing or opening a file another
 * process has open fails now and then with `EPERM`, `EBUSY` or `EACCES`
 * (measured: most renames fail while a reader loops), so each read and each
 * replace is tried again, a bounded number of times, before it fails.
 */

import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { BdIssue } from "../../scripts/hearth/bd-answers";

/** An issue the stand-in keeps: as bd prints it, and the beads that block it. */
export interface StandInIssue extends BdIssue {
  blockedBy?: string[];
}

/** Every issue the stand-in knows, by id. */
export type StandInState = Record<string, StandInIssue>;

const RETRIABLE = new Set(["EPERM", "EBUSY", "EACCES"]);

export interface RetryOptions {
  tries?: number;
  waitMs?: number;
}

const pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Run `work`, again after a short wait while it fails with a sharing error,
 * at most `tries` times in all; any other error, or the last sharing error,
 * is thrown.
 */
export function withRetries<T>(
  work: () => T,
  { tries = 40, waitMs = 25 }: RetryOptions = {},
): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return work();
    } catch (error) {
      const code = String((error as { code?: unknown } | null)?.code ?? "");
      if (!RETRIABLE.has(code) || attempt >= tries) throw error;
      pause(waitMs);
    }
  }
}

export const stateFile = (dir: string): string => join(dir, "issues.json");

/** The stand-in's issues; none when it has written none yet. */
export function readState(dir: string, options?: RetryOptions): StandInState {
  const file = stateFile(dir);
  if (!existsSync(file)) return {};
  return JSON.parse(
    withRetries(() => readFileSync(file, "utf8"), options),
  ) as StandInState;
}

/** Replace the stand-in's issues whole. */
export function writeState(
  dir: string,
  state: StandInState,
  options?: RetryOptions,
): void {
  const file = stateFile(dir);
  const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2));
  try {
    withRetries(() => renameSync(temporary, file), options);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
