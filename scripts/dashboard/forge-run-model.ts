/**
 * What the Forge run view shows, derived from local harness state.
 *
 * Pure functions — the plugin that reads files and runs `bd` lives in
 * `scripts/hearth/routes/dev-api.ts`, so the shape of the view and the rules for
 * recording a review are testable without a filesystem or a server.
 *
 * Checkpoints are not here: they come from the Beads snapshot the page already
 * holds (`docs/js/forge-checkpoints.ts`), the same source as every other view.
 */

import type { EvaluatorIdentity } from "../../types/hearth";
import { parseEvaluatorIdentity } from "../eval-verdict";
import {
  artifactPath,
  FORGE_PHASES,
  type ForgeMode,
  type ForgePhase,
  type ForgeState,
  type ReviewRound,
} from "../forge/phases";
import {
  byRecency,
  comparableCheckout,
  isValidSlug,
  parseState,
  summarizeRun,
} from "../forge/runs";
import {
  GATE_HOST_TEXT_FIELDS,
  GATE_LOG_SCHEMA_VERSION,
  type GateHostIdentity,
  hostText,
} from "../quality-gate-identity";
import { parseBeadsIssueId } from "../run-correlation";

export type PhaseState = "complete" | "active" | "locked";

export interface PhaseRow {
  id: ForgePhase;
  state: PhaseState;
  /** Repo-relative artifact this phase produces, if it has one. */
  artifact: string | null;
  /** True when the phase claims an artifact that is not on disk. */
  artifactMissing: boolean;
}

export interface GateCheck {
  name: string;
  passed: boolean;
  skipped: boolean;
  /** Skip reason, or the first line of the check's output. */
  detail: string | null;
}

/**
 * How a gate entry is tied to work.
 *
 * - `linked`: a schema 2 entry carrying the bead and run of the run
 *   correlation the gate was pointed at.
 * - `unlinked`: a schema 2 entry from a gate that was given no correlation.
 *   It belongs to its checkout and to no run.
 * - `legacy`: an entry written before entries had a schema version. It keeps
 *   the run it recorded then; its single task field was never a reliable
 *   Beads id and is not treated as one.
 */
export type GateLink = "linked" | "unlinked" | "legacy";

/**
 * The evaluator verdict a gate entry's strict check rested on.
 *
 * - `schema-2`: the entry carries the reference the gate records when it
 *   binds a schema 2 verdict: the file it read, the digest and size of those
 *   bytes, and the evaluator they name, for this entry's own bead and run.
 * - `legacy`: the check passed and the entry carries no such reference. That
 *   is an entry written when the check read a task-scoped schema 1 verdict,
 *   which named no run and no evaluator. It is shown; it is not evidence that
 *   this run was evaluated.
 */
export type GateEvaluatorVerdict =
  | {
      evidence: "schema-2";
      /** Relative to the checkout. */
      path: string;
      sha256: string;
      bytes: number;
      evaluator: EvaluatorIdentity;
    }
  | { evidence: "legacy" };

/**
 * One quality-gate run, as `.claude/hooks/quality-gate.ts` logs it.
 *
 * The log is shared by every checkout on the machine, so each entry records
 * where it ran. Entries written before the hook did that have no checkout and
 * are never attributed to one.
 */
export interface GateRun {
  event: string;
  timestamp: string;
  passed: boolean;
  checks: GateCheck[];
  checkout: string | null;
  branch: string | null;
  link: GateLink;
  /** From the entry's run correlation. Null unless the entry is linked. */
  beadsIssueId: string | null;
  /** From the entry's run correlation: the Forge run. Null unless linked. */
  executionRunId: string | null;
  /** Why an unlinked entry is unlinked, when it says. */
  unlinkedReason: string | null;
  /** What the host said about itself. For display; never a bead or a run. */
  host: GateHostIdentity | null;
  /** Legacy entries only: the old task field. Never shown as a bead. */
  taskId: string | null;
  /** Legacy entries only: the run the entry recorded. */
  forgeSlug: string | null;
  /** What the strict evaluator-verdict check rested on. Null when it did not run or bound nothing. */
  evaluatorVerdict: GateEvaluatorVerdict | null;
}

/** The gate runs that belong on this page: this checkout's, for this run. */
export interface GateScope {
  checkout: string;
  /** The active forge run's slug, or null when none is in flight. */
  slug: string | null;
}

/** One forge run as the dashboard shows it. */
export interface ForgeRunView {
  slug: string;
  feature: string | null;
  epic: string | null;
  mode: ForgeMode;
  complete: boolean;
  updatedAt: string | null;
  phases: PhaseRow[];
  /** Subagent review rounds, oldest first. Empty for a run nobody reviewed. */
  reviews: ReviewRound[];
  /** The newest quality-gate run within `gateScope`, or null if there is none. */
  gate: GateRun | null;
  gateScope: GateScope;
}

export interface ForgeRunSnapshot {
  /** Every run this checkout knows about, newest first. Runs are concurrent. */
  runs: ForgeRunView[];
  /** Slug to show first: the newest run still in flight, else the newest. */
  selected: string | null;
  checkout: string;
  /** This checkout's newest gate run whatever it belongs to, for when no run does. */
  gate: GateRun | null;
  /**
   * This checkout's newest gate run that no run's card shows: an unlinked one,
   * or one linked to a run with no state here. Null when every entry read
   * belongs to a run.
   */
  unattributedGate: GateRun | null;
}

/**
 * The four pipeline phases with their status.
 *
 * A phase is complete when the run recorded it. The active phase is the first
 * one not yet complete — reading it from `state.phase` instead would show the
 * last *finished* phase as active, one step behind the work.
 */
export function phaseRows(
  state: ForgeState | null,
  artifactExists: (path: string) => boolean = () => true,
): PhaseRow[] {
  const active =
    state === null
      ? null
      : (FORGE_PHASES.find((phase) => !state.completed.includes(phase)) ??
        null);

  return FORGE_PHASES.map((phase) => {
    const completed = state?.completed.includes(phase) ?? false;
    const artifact = state?.slug ? artifactPath(phase, state.slug) : null;
    return {
      id: phase,
      state: completed ? "complete" : phase === active ? "active" : "locked",
      artifact,
      artifactMissing:
        completed && artifact !== null ? !artifactExists(artifact) : false,
    };
  });
}

/** One reader for run state, so the dashboard never drifts from the registry. */
function parseForgeState(json: string | null): ForgeState | null {
  return json ? parseState(json) : null;
}

const DETAIL_LIMIT = 200;

function detailFor(check: {
  skipped?: unknown;
  skipReason?: unknown;
  output?: unknown;
}): string | null {
  if (check.skipped === true && typeof check.skipReason === "string") {
    return check.skipReason;
  }
  if (typeof check.output === "string" && check.output.trim()) {
    const first = check.output.trim().split(/\r?\n/)[0] ?? "";
    return first.length > DETAIL_LIMIT
      ? `${first.slice(0, DETAIL_LIMIT - 1)}…`
      : first;
  }
  return null;
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/** The host object of an entry, with only the fields that are short plain text. */
function hostFrom(value: unknown): GateHostIdentity | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  // justification: a non-null, non-array object is a record of unknown fields.
  const raw = value as Record<string, unknown>;
  const host: GateHostIdentity = {};
  const scope = raw["hostTaskScope"] as
    | { kind?: unknown; id?: unknown }
    | null
    | undefined;
  const team = scope?.kind === "agent-team" ? hostText(scope.id) : undefined;
  if (team !== undefined) host.hostTaskScope = { kind: "agent-team", id: team };
  for (const field of GATE_HOST_TEXT_FIELDS) {
    const text = hostText(raw[field]);
    if (text !== undefined) host[field] = text;
  }
  return Object.keys(host).length > 0 ? host : null;
}

type GateLinkage = Pick<
  GateRun,
  | "link"
  | "beadsIssueId"
  | "executionRunId"
  | "unlinkedReason"
  | "host"
  | "taskId"
  | "forgeSlug"
>;

/**
 * How an entry is tied to work, or null for an entry that cannot be trusted
 * to say: a schema this reader does not know, or a schema 2 entry whose two
 * ids are not both valid or both null. Such an entry is skipped; it is never
 * read as a legacy one, which would let it join a run by another field.
 */
function linkageFrom(raw: Record<string, unknown>): GateLinkage | null {
  const version = raw["schemaVersion"];
  if (version === undefined) {
    return {
      link: "legacy",
      beadsIssueId: null,
      executionRunId: null,
      unlinkedReason: null,
      host: null,
      taskId: text(raw["taskId"]),
      forgeSlug: text(raw["forgeSlug"]),
    };
  }
  if (version !== GATE_LOG_SCHEMA_VERSION) return null;
  const rest = { host: hostFrom(raw["host"]), taskId: null, forgeSlug: null };
  if (raw["beadsIssueId"] === null && raw["executionRunId"] === null) {
    return {
      link: "unlinked",
      beadsIssueId: null,
      executionRunId: null,
      unlinkedReason: text(raw["unlinkedReason"]),
      ...rest,
    };
  }
  const bead = parseBeadsIssueId(raw["beadsIssueId"]);
  const run = text(raw["executionRunId"]);
  if (bead === null || run === null || !isValidSlug(run)) return null;
  return {
    link: "linked",
    beadsIssueId: bead,
    executionRunId: run,
    unlinkedReason: null,
    ...rest,
  };
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The shape of the path the gate reads a run's verdict from. */
const DECLARED_VERDICT_PATH =
  /^\.tmp\/work\/evaluations\/[0-9a-f]{64}\/verdict\.json$/;

/** The most bytes the gate reads as a verdict. */
const MAX_VERDICT_BYTES = 64 * 1024;

/** True for an evaluator the gate binds: a human, or a model that was observed and not rejected. */
function bindable(evaluator: EvaluatorIdentity): boolean {
  return (
    evaluator.kind === "human" ||
    (evaluator.observedProvider !== undefined &&
      evaluator.observedModel !== undefined &&
      evaluator.rankPolicyDecision === "allowed")
  );
}

/** The name of the gate's strict evaluator-verdict check. */
const VERDICT_CHECK = "eval-verdict";

/**
 * What an entry's evaluator-verdict check rested on. The reference on the
 * entry counts only when it is one the gate could have written: whole, for the
 * entry's own bead and run, at a declared verdict path, no larger than a
 * verdict, by an evaluator the gate binds. Anything less leaves a passed check
 * as a legacy verdict. (The reader cannot hash a run id in the browser, so it
 * checks the path's shape, not that it is this run's.)
 */
function evaluatorVerdictFrom(
  raw: Record<string, unknown>,
  linkage: GateLinkage,
  checks: readonly GateCheck[],
): GateEvaluatorVerdict | null {
  const check = checks.find((entry) => entry.name === VERDICT_CHECK);
  if (check === undefined || check.skipped) return null;
  const artifact = raw["evaluatorArtifact"];
  if (
    linkage.link === "linked" &&
    typeof artifact === "object" &&
    artifact !== null &&
    !Array.isArray(artifact)
  ) {
    // justification: a non-null, non-array object is a record of unknown fields.
    const reference = artifact as Record<string, unknown>;
    const path = text(reference["path"]);
    const sha256 = reference["sha256"];
    const bytes = reference["bytes"];
    const evaluator = parseEvaluatorIdentity(reference["evaluator"]);
    if (
      reference["kind"] === "evaluator-verdict" &&
      reference["verdictSchemaVersion"] === 2 &&
      reference["executionRunId"] === linkage.executionRunId &&
      reference["beadsIssueId"] === linkage.beadsIssueId &&
      path !== null &&
      DECLARED_VERDICT_PATH.test(path) &&
      typeof sha256 === "string" &&
      SHA256_HEX.test(sha256) &&
      typeof bytes === "number" &&
      Number.isInteger(bytes) &&
      bytes >= 0 &&
      bytes <= MAX_VERDICT_BYTES &&
      evaluator.ok &&
      bindable(evaluator.value)
    ) {
      return {
        evidence: "schema-2",
        path,
        sha256,
        bytes,
        evaluator: evaluator.value,
      };
    }
  }
  return check.passed ? { evidence: "legacy" } : null;
}

function gateRunFrom(line: string): GateRun | null {
  try {
    const raw = JSON.parse(line) as Record<string, unknown>;
    if (typeof raw["passed"] !== "boolean" || !Array.isArray(raw["checks"])) {
      return null;
    }
    const linkage = linkageFrom(raw);
    if (linkage === null) return null;
    const checks = raw["checks"].flatMap((entry): GateCheck[] => {
      const check = entry as {
        name?: unknown;
        passed?: unknown;
        skipped?: unknown;
        skipReason?: unknown;
        output?: unknown;
      };
      if (typeof check.name !== "string") return [];
      return [
        {
          name: check.name,
          passed: check.passed === true,
          skipped: check.skipped === true,
          detail: detailFor(check),
        },
      ];
    });
    return {
      event: text(raw["event"]) ?? "",
      timestamp: text(raw["timestamp"]) ?? "",
      passed: raw["passed"],
      checks,
      checkout: text(raw["checkout"]),
      branch: text(raw["branch"]),
      ...linkage,
      evaluatorVerdict: evaluatorVerdictFrom(raw, linkage, checks),
    };
  } catch {
    return null;
  }
}

/**
 * The run whose card shows an entry: the run a linked entry's correlation
 * names, or the run a legacy entry recorded. An unlinked entry has none.
 */
function gateRunScope(run: GateRun): string | null {
  switch (run.link) {
    case "linked":
      return run.executionRunId;
    case "legacy":
      return run.forgeSlug;
    case "unlinked":
      return null;
  }
}

/** Re-exported: the quality-gate hook compares checkouts without the dashboard. */
export { comparableCheckout } from "../forge/runs";

export function gateRunBelongsTo(run: GateRun, scope: GateScope): boolean {
  return (
    run.checkout !== null &&
    comparableCheckout(run.checkout) === comparableCheckout(scope.checkout) &&
    gateRunScope(run) === scope.slug
  );
}

/**
 * The newest gate run that belongs to `scope`.
 *
 * `logs` are whole `quality-gate.jsonl` files, newest first. Iteration stops at
 * the first match, so older files are read only when newer ones have none.
 */
export function latestGateRun(
  logs: Iterable<string | null>,
  scope: GateScope,
): GateRun | null {
  for (const jsonl of logs) {
    if (!jsonl) continue;
    const lines = jsonl.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]?.trim();
      if (!line) continue;
      const run = gateRunFrom(line);
      if (run && gateRunBelongsTo(run, scope)) return run;
    }
  }
  return null;
}

/**
 * The newest gate run for each of `slugs`, plus this checkout's newest overall
 * and its newest that belongs to none of `slugs`, in **one** pass over the logs.
 *
 * Several runs can be in flight, and `gateLogs` is a generator that reads files
 * lazily — running `latestGateRun` once per run would consume it on the first
 * one. Iteration stops as soon as every run has its gate, so `unattributed` is
 * the newest such entry among those read, not among all that exist.
 */
export function latestGateRunsFor(
  logs: Iterable<string | null>,
  checkout: string,
  slugs: readonly string[],
): {
  byRun: Map<string, GateRun>;
  checkoutLatest: GateRun | null;
  unattributed: GateRun | null;
} {
  const here = comparableCheckout(checkout);
  const wanted = new Set(slugs);
  const byRun = new Map<string, GateRun>();
  let checkoutLatest: GateRun | null = null;
  let unattributed: GateRun | null = null;

  for (const jsonl of logs) {
    if (!jsonl) continue;
    const lines = jsonl.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]?.trim();
      if (!line) continue;
      const run = gateRunFrom(line);
      if (
        run === null ||
        run.checkout === null ||
        comparableCheckout(run.checkout) !== here
      ) {
        continue;
      }
      checkoutLatest ??= run;
      const scope = gateRunScope(run);
      if (scope === null || !wanted.has(scope)) {
        unattributed ??= run;
      } else if (!byRun.has(scope)) {
        byRun.set(scope, run);
        if (byRun.size === wanted.size) {
          return { byRun, checkoutLatest, unattributed };
        }
      }
    }
  }
  return { byRun, checkoutLatest, unattributed };
}

export function forgeRunSnapshot(input: {
  /** Every run's state file contents, in any order. */
  runStates: readonly (string | null)[];
  /** The checkout this dashboard serves. */
  checkout: string;
  /** `quality-gate.jsonl` contents, newest first. */
  gateLogs: Iterable<string | null>;
  artifactExists: (path: string) => boolean;
}): ForgeRunSnapshot {
  const states = input.runStates.flatMap((json) => {
    const state = parseForgeState(json);
    return state === null ? [] : [state];
  });
  const summaries = byRecency(states.map(summarizeRun));
  const { byRun, checkoutLatest, unattributed } = latestGateRunsFor(
    input.gateLogs,
    input.checkout,
    summaries.map((run) => run.slug),
  );

  const runs: ForgeRunView[] = summaries.map((summary) => {
    const state = states.find((candidate) => candidate.slug === summary.slug);
    const gateScope: GateScope = {
      checkout: input.checkout,
      slug: summary.slug,
    };
    return {
      slug: summary.slug,
      feature: summary.feature,
      epic: summary.epic,
      mode: summary.mode,
      complete: summary.complete,
      updatedAt: summary.updatedAt || null,
      phases: phaseRows(state ?? null, input.artifactExists),
      reviews: state?.reviews ?? [],
      gate: byRun.get(summary.slug) ?? null,
      gateScope,
    };
  });

  // In-flight work is what a reader came for; a shipped run is only the answer
  // when nothing is still moving.
  const selected =
    runs.find((run) => !run.complete)?.slug ?? runs[0]?.slug ?? null;

  return {
    runs,
    selected,
    checkout: input.checkout,
    gate: checkoutLatest,
    unattributedGate: unattributed,
  };
}

// ── The runs board ───────────────────────────────────────────────────────────

/**
 * How a run reads at a glance.
 *
 * Deliberately three states, not five: the board exists so a reader can sweep
 * several runs and see which one needs them. Anything finer belongs in the
 * run's own panel.
 */
export type RunHealth = "shipped" | "attention" | "running";

/**
 * Whether the run's gate passed, counting only a gate that was correlated to
 * the run. A legacy entry stays on the run's card, labelled, but an old result
 * that nothing newer can replace must not decide how the run reads.
 */
function countedGate(run: ForgeRunView): boolean | null {
  return run.gate !== null && run.gate.link === "linked"
    ? run.gate.passed
    : null;
}

/** The newest review round, whatever phase it graded, or null if none. */
function latestReview(run: ForgeRunView): ReviewRound | null {
  return run.reviews[run.reviews.length - 1] ?? null;
}

export function runHealth(run: ForgeRunView): RunHealth {
  // A shipped run is done being judged — a stale failing gate from mid-run
  // should not make a finished run look broken.
  if (run.complete) return "shipped";

  if (countedGate(run) === false) return "attention";
  if (run.phases.some((phase) => phase.artifactMissing)) return "attention";

  const review = latestReview(run);
  if (review !== null && review.verdict !== "PASS") return "attention";

  return "running";
}

/** One line of the board: a whole run, small enough to scan. */
export interface RunBoardRow {
  slug: string;
  feature: string | null;
  epic: string | null;
  mode: ForgeMode;
  health: RunHealth;
  /** The phase cells, in pipeline order. */
  phases: PhaseRow[];
  /** What the run is doing now: the active phase id, or "shipped". */
  status: string;
  completedCount: number;
  totalPhases: number;
  /** The run's correlated gate's verdict, or null when no linked gate run belongs to it. */
  gatePassed: boolean | null;
  reviewRounds: number;
  latestVerdict: ReviewRound["verdict"] | null;
  updatedAt: string | null;
}

/**
 * The board, one row per run, in the order given.
 *
 * Ordering is the caller's (the snapshot already sorts newest first) so the
 * board never disagrees with the list it was built from.
 */
export function boardRows(runs: readonly ForgeRunView[]): RunBoardRow[] {
  return runs.map((run) => {
    const active = run.phases.find((phase) => phase.state === "active");
    const review = latestReview(run);
    return {
      slug: run.slug,
      feature: run.feature,
      epic: run.epic,
      mode: run.mode,
      health: runHealth(run),
      phases: run.phases,
      status: run.complete ? "shipped" : (active?.id ?? "shipped"),
      completedCount: run.phases.filter((phase) => phase.state === "complete")
        .length,
      totalPhases: run.phases.length,
      gatePassed: countedGate(run),
      reviewRounds: run.reviews.length,
      latestVerdict: review?.verdict ?? null,
      updatedAt: run.updatedAt,
    };
  });
}

export type ReviewDecision = "approve" | "request-changes";

export const REVIEW_NOTE_LIMIT = 2000;

/** The only Beads status a review can be recorded against. */
export const REVIEWABLE_STATUS = "in_progress";

export type ReviewComment =
  | { ok: true; issueId: string; body: string }
  | { ok: false; error: string };

/**
 * The `review:` comment a checkpoint decision records in Beads.
 *
 * `review:` is the harness's documented prefix for review iterations, so the
 * decision lands where agents already look. Requesting changes without saying
 * what to change is rejected rather than recorded as noise.
 */
export function reviewCommentFor(input: unknown): ReviewComment {
  const raw = (input ?? {}) as {
    issueId?: unknown;
    decision?: unknown;
    note?: unknown;
  };
  const issueId = parseBeadsIssueId(raw.issueId);
  if (issueId === null) {
    return { ok: false, error: "issueId must be a Beads issue id" };
  }
  if (raw.decision !== "approve" && raw.decision !== "request-changes") {
    return {
      ok: false,
      error: "decision must be approve or request-changes",
    };
  }
  const note = typeof raw.note === "string" ? raw.note.trim() : "";
  if (note.length > REVIEW_NOTE_LIMIT) {
    return {
      ok: false,
      error: `note must be ${REVIEW_NOTE_LIMIT} characters or fewer`,
    };
  }
  if (raw.decision === "request-changes" && !note) {
    return {
      ok: false,
      error: "Requesting changes needs a note saying what to change",
    };
  }
  const verdict =
    raw.decision === "approve" ? "checkpoint APPROVED" : "CHANGES REQUESTED";
  return {
    ok: true,
    issueId,
    body: `review: ${verdict} via Forge run dashboard${note ? ` — ${note}` : ""}`,
  };
}

/** The status in `bd show <id> --json` output, or null if it has none. */
export function issueStatusFromBdShow(output: string): string | null {
  try {
    const parsed = JSON.parse(output) as unknown;
    const row: unknown = Array.isArray(parsed)
      ? (parsed as unknown[])[0]
      : parsed;
    const status = (row as { status?: unknown } | null | undefined)?.status;
    return typeof status === "string" ? status : null;
  } catch {
    return null;
  }
}
