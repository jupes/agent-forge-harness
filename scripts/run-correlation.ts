/**
 * Which Beads issue and which Forge run a piece of work belongs to.
 *
 * A launcher writes one `RunCorrelation` per run and hands the quality gate a
 * pointer to it. The gate takes its Beads id and its run id from that file and
 * from nowhere else: not from the host's hook payload, whose `task_id` belongs
 * to the host's own task lists, and not from an environment variable.
 *
 * `executionRunId` is the Forge run id: the value a run's state file calls
 * `slug` and the ledger calls `runId`.
 *
 * Nothing here touches disk: the dashboard bundles this module into the
 * browser. The file half is `run-correlation-store.ts`.
 */

import { comparableCheckout, isValidSlug } from "./forge/runs";

const RUN_CORRELATION_SCHEMA_VERSION = 1 as const;

/** Repo-relative directory holding one correlation file per run. */
export const RUN_CORRELATIONS_DIR = ".tmp/work/run-correlations";

/** The variable a launcher sets to the path of the run's correlation file. */
export const RUN_CORRELATION_ENV = "AGENT_FORGE_RUN_CORRELATION";

/** A Beads id. Must start alphanumeric so `bd` can never read it as a flag. */
const BEADS_ISSUE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

declare const beadsIssueId: unique symbol;

/** A string that has passed `parseBeadsIssueId`: the only kind `bd` is ever given. */
export type BeadsIssueId = string & { readonly [beadsIssueId]: true };

/** `value` as a Beads id, trimmed, or null when it is not one. */
export function parseBeadsIssueId(value: unknown): BeadsIssueId | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  // justification: the pattern is the whole definition of the branded type.
  return BEADS_ISSUE_ID.test(id) ? (id as BeadsIssueId) : null;
}

export interface RunCorrelation {
  schemaVersion: typeof RUN_CORRELATION_SCHEMA_VERSION;
  executionRunId: string;
  beadsIssueId: BeadsIssueId;
  /** Top level of the checkout the run builds in, in comparable form. */
  checkout: string;
  /** ISO 8601. */
  createdAt: string;
}

export type RunCorrelationResult =
  | { ok: true; value: RunCorrelation }
  | { ok: false; error: string };

function refuse(error: string): RunCorrelationResult {
  return { ok: false, error };
}

/** The contract's fields, checked and normalized; anything else on `raw` is dropped. */
function correlationFrom(raw: Record<string, unknown>): RunCorrelationResult {
  const runId =
    typeof raw.executionRunId === "string" ? raw.executionRunId.trim() : "";
  if (!isValidSlug(runId)) {
    return refuse("executionRunId must be a Forge run id");
  }
  const bead = parseBeadsIssueId(raw.beadsIssueId);
  if (bead === null) return refuse("beadsIssueId must be a Beads issue id");
  const checkout =
    typeof raw.checkout === "string" ? comparableCheckout(raw.checkout) : "";
  if (checkout.length === 0) {
    return refuse("checkout must be the path of a checkout");
  }
  if (
    typeof raw.createdAt !== "string" ||
    Number.isNaN(Date.parse(raw.createdAt))
  ) {
    return refuse("createdAt must be an ISO 8601 timestamp");
  }
  return {
    ok: true,
    value: {
      schemaVersion: RUN_CORRELATION_SCHEMA_VERSION,
      executionRunId: runId,
      beadsIssueId: bead,
      checkout,
      createdAt: raw.createdAt,
    },
  };
}

/** A new correlation from what a launcher knows. Ids are trimmed, the checkout made comparable. */
export function createRunCorrelation(input: {
  executionRunId: string;
  beadsIssueId: string;
  checkout: string;
  now?: () => string;
}): RunCorrelationResult {
  return correlationFrom({
    executionRunId: input.executionRunId,
    beadsIssueId: input.beadsIssueId,
    checkout: input.checkout,
    createdAt: (input.now ?? (() => new Date().toISOString()))(),
  });
}

/** A stored correlation. Only schema version 1 is read. */
export function parseRunCorrelation(text: string): RunCorrelationResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return refuse("not valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return refuse("root must be an object");
  }
  // justification: a non-null, non-array object is a record of unknown fields.
  const fields = raw as Record<string, unknown>;
  if (fields.schemaVersion !== RUN_CORRELATION_SCHEMA_VERSION) {
    return refuse(`schemaVersion must be ${RUN_CORRELATION_SCHEMA_VERSION}`);
  }
  return correlationFrom(fields);
}

/** Repo-relative file for a run's correlation, or null when the id cannot name a run. */
export function runCorrelationPath(executionRunId: string): string | null {
  return isValidSlug(executionRunId)
    ? `${RUN_CORRELATIONS_DIR}/${executionRunId}.json`
    : null;
}

/** The flag that hands the quality gate a pointer on its command line. */
export const RUN_CORRELATION_FLAG = "--correlation";

export interface CorrelationPointer {
  /** A path, absolute or relative to the checkout, trimmed. Empty when the flag had no value. */
  path: string;
  source: "flag" | "env";
}

/**
 * Where the caller says the run's correlation is: the flag, in either
 * spelling, else the environment variable. Nothing else points at one.
 */
export function correlationPointer(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): CorrelationPointer | null {
  for (const [index, arg] of argv.entries()) {
    if (arg === RUN_CORRELATION_FLAG) {
      return { path: (argv[index + 1] ?? "").trim(), source: "flag" };
    }
    if (arg.startsWith(`${RUN_CORRELATION_FLAG}=`)) {
      return {
        path: arg.slice(RUN_CORRELATION_FLAG.length + 1).trim(),
        source: "flag",
      };
    }
  }
  const fromEnv = env[RUN_CORRELATION_ENV]?.trim();
  return fromEnv !== undefined && fromEnv.length > 0
    ? { path: fromEnv, source: "env" }
    : null;
}
