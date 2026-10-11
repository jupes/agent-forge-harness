/**
 * What every write to the tracker shares, whoever makes it: the Beads write
 * rows (`routes/beads.ts`) and the queue (`../scheduler/queue.ts`).
 *
 * Reading what `bd` printed, telling a refusal from a call that never became
 * a process, and storing the outcome event. No runtime import from `routes/`,
 * so the scheduler can use it without loading the hearth's read rows.
 */

import type { LedgerEventInput } from "../../types/hearth";
import type { AppendResult } from "../ledger/append";
import { parseBeadsIssueId } from "../run-correlation";
import { redactSecrets } from "../secret-patterns";
import { safeMessage } from "./api";
import type { BdResult } from "./routes/dev-api";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A string that is a Beads id exactly as given, and that the ledger would
 * store: the ledger refuses a row whose id its secret scanner would change.
 */
export function isBeadId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    parseBeadsIssueId(value) === value &&
    redactSecrets(value).redactions.length === 0
  );
}

/** What `bd` printed, as JSON, or undefined when it is not JSON. */
export function parsed(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

/**
 * bd's error line out of what it printed on stderr: the last line that begins
 * `Error`, else the last line. Not the whole output: before it refuses, bd can
 * print a warning that repeats the title it was given.
 */
function errorLine(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const error =
    [...lines].reverse().find((line) => /^Error\b/.test(line)) ??
    lines.at(-1) ??
    "";
  return error.replace(/^Error:\s*/, "");
}

/**
 * Why bd refused, in bd's own words. With `--json` some commands print the
 * error on stdout and nothing on stderr; the runner then fills stderr with its
 * own line, `Command failed: bd <every argument>`, which repeats the text that
 * was sent and is never passed on.
 */
export function refusal(result: BdResult): string {
  const printed = parsed(result.stdout);
  if (isRecord(printed) && typeof printed["error"] === "string")
    return printed["error"].trim() || `exit ${result.status}`;
  const said = result.stderr.trim();
  return (
    (said.startsWith("Command failed:") ? "" : errorLine(said)) ||
    `exit ${result.status}`
  );
}

/** What the runtime itself says, in full, when there is no program named bd to start. */
const NO_SUCH_PROGRAM = [
  /^Executable not found in \$PATH: "bd"$/,
  /^spawn bd ENOENT$/,
];

/**
 * Whether a call with no exit status never became a process at all. Only the
 * runtime's own message, whole and alone, says so: a bd that started prints
 * warnings of its own, and a warning can hold any word, the title it was given
 * included. Anything else with no exit status is an outcome nobody knows.
 */
export function neverStarted(result: BdResult): boolean {
  const said = result.stderr.trim();
  return (
    result.stdout === "" &&
    NO_SUCH_PROGRAM.some((message) => message.test(said))
  );
}

/** A busy ledger is tried this many times, this far apart, before the answer says "not recorded". */
const RECORD_ATTEMPTS = 3;
const RECORD_RETRY_MS = 25;

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

/** Append an outcome event. Null when the ledger stored it, else why not. */
export async function storeEvent(
  appendEvent: (event: LedgerEventInput) => AppendResult,
  event: LedgerEventInput,
): Promise<string | null> {
  for (let attempt = 1; ; attempt++) {
    let result: unknown;
    try {
      result = appendEvent(event);
    } catch (error) {
      return safeMessage(error);
    }
    if (!isRecord(result)) return "the ledger did not answer";
    if (result["ok"] === true)
      return typeof result["id"] === "number" && result["id"] > 0
        ? null
        : "the ledger stored no row";
    const reason =
      typeof result["error"] === "string"
        ? result["error"]
        : "the ledger refused";
    if (!/busy|locked/i.test(reason) || attempt >= RECORD_ATTEMPTS)
      return safeMessage(reason);
    await sleep(RECORD_RETRY_MS);
  }
}
