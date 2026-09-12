/**
 * What the Forge run view shows, derived from local harness state.
 *
 * Pure functions — the plugin that reads files and runs `bd` lives in
 * `scripts/dashboard/dev-api.ts`, so the shape of the view and the rules for
 * recording a review are testable without a filesystem or a server.
 *
 * Checkpoints are not here: they come from the Beads snapshot the page already
 * holds (`docs/js/forge-checkpoints.ts`), the same source as every other view.
 */

import {
  artifactPath,
  FORGE_PHASES,
  type ForgePhase,
  type ForgeState,
} from "../forge/phases";

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
 * One quality-gate run, as `.claude/hooks/quality-gate.ts` logs it.
 *
 * The log is shared by every checkout on the machine, so each entry records
 * where it ran. Entries written before the hook did that have no identity and
 * are never attributed to a run.
 */
export interface GateRun {
  event: string;
  timestamp: string;
  passed: boolean;
  checks: GateCheck[];
  checkout: string | null;
  branch: string | null;
  taskId: string | null;
  forgeSlug: string | null;
}

/** The gate runs that belong on this page: this checkout's, for this run. */
export interface GateScope {
  checkout: string;
  /** The active forge run's slug, or null when none is in flight. */
  slug: string | null;
}

export interface ForgeRunSnapshot {
  slug: string | null;
  feature: string | null;
  epic: string | null;
  updatedAt: string | null;
  phases: PhaseRow[];
  /** The newest quality-gate run within `gateScope`, or null if there is none. */
  gate: GateRun | null;
  gateScope: GateScope;
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

function parseForgeState(json: string | null): ForgeState | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Partial<ForgeState>;
    if (typeof parsed.slug !== "string" || typeof parsed.phase !== "string") {
      return null;
    }
    return {
      slug: parsed.slug,
      phase: parsed.phase as ForgePhase,
      completed: Array.isArray(parsed.completed)
        ? (parsed.completed as ForgePhase[])
        : [],
      artifacts: parsed.artifacts ?? {},
      ...(parsed.feature ? { feature: parsed.feature } : {}),
      ...(parsed.epic ? { epic: parsed.epic } : {}),
      updatedAt: parsed.updatedAt ?? "",
    };
  } catch {
    return null;
  }
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

function gateRunFrom(line: string): GateRun | null {
  try {
    const raw = JSON.parse(line) as Record<string, unknown>;
    if (typeof raw["passed"] !== "boolean" || !Array.isArray(raw["checks"])) {
      return null;
    }
    return {
      event: text(raw["event"]) ?? "",
      timestamp: text(raw["timestamp"]) ?? "",
      passed: raw["passed"],
      checks: raw["checks"].flatMap((entry): GateCheck[] => {
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
      }),
      checkout: text(raw["checkout"]),
      branch: text(raw["branch"]),
      taskId: text(raw["taskId"]),
      forgeSlug: text(raw["forgeSlug"]),
    };
  } catch {
    return null;
  }
}

/**
 * A checkout path in comparable form. Git reports `C:/Users/...` where Node
 * reports `C:\Users\...`, and Windows drive paths compare case-insensitively.
 */
export function comparableCheckout(path: string): string {
  const slashed = path.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(slashed) ? slashed.toLowerCase() : slashed;
}

export function gateRunBelongsTo(run: GateRun, scope: GateScope): boolean {
  return (
    run.checkout !== null &&
    comparableCheckout(run.checkout) === comparableCheckout(scope.checkout) &&
    run.forgeSlug === scope.slug
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

export function forgeRunSnapshot(input: {
  stateJson: string | null;
  /** The checkout this dashboard serves. */
  checkout: string;
  /** `quality-gate.jsonl` contents, newest first. */
  gateLogs: Iterable<string | null>;
  artifactExists: (path: string) => boolean;
}): ForgeRunSnapshot {
  const state = parseForgeState(input.stateJson);
  const gateScope: GateScope = {
    checkout: input.checkout,
    slug: state?.slug ?? null,
  };
  return {
    slug: state?.slug ?? null,
    feature: state?.feature ?? null,
    epic: state?.epic ?? null,
    updatedAt: state?.updatedAt || null,
    phases: phaseRows(state, input.artifactExists),
    gate: latestGateRun(input.gateLogs, gateScope),
    gateScope,
  };
}

export type ReviewDecision = "approve" | "request-changes";

export const REVIEW_NOTE_LIMIT = 2000;

/** The only Beads status a review can be recorded against. */
export const REVIEWABLE_STATUS = "in_progress";

/** A Beads id. Must start alphanumeric so `bd` can never read it as a flag. */
const ISSUE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

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
  const issueId = typeof raw.issueId === "string" ? raw.issueId.trim() : "";
  if (!ISSUE_ID.test(issueId)) {
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
