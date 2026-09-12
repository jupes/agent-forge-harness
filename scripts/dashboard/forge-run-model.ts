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

/** One quality-gate run, as `.claude/hooks/quality-gate.ts` logs it. */
export interface GateRun {
  event: string;
  timestamp: string;
  passed: boolean;
  checks: GateCheck[];
}

export interface ForgeRunSnapshot {
  slug: string | null;
  feature: string | null;
  epic: string | null;
  updatedAt: string | null;
  phases: PhaseRow[];
  /** The most recent quality-gate run, or null when none has been logged. */
  gate: GateRun | null;
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

function gateRunFrom(line: string): GateRun | null {
  try {
    const raw = JSON.parse(line) as {
      event?: unknown;
      timestamp?: unknown;
      passed?: unknown;
      checks?: unknown;
    };
    if (typeof raw.passed !== "boolean" || !Array.isArray(raw.checks)) {
      return null;
    }
    return {
      event: typeof raw.event === "string" ? raw.event : "",
      timestamp: typeof raw.timestamp === "string" ? raw.timestamp : "",
      passed: raw.passed,
      checks: raw.checks.flatMap((entry): GateCheck[] => {
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
    };
  } catch {
    return null;
  }
}

/** The last well-formed run in a `quality-gate.jsonl` log. */
export function parseLatestGateRun(jsonl: string | null): GateRun | null {
  if (!jsonl) return null;
  const lines = jsonl.split(/\r?\n/).filter((line) => line.trim());
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const run = gateRunFrom(lines[index] as string);
    if (run) return run;
  }
  return null;
}

export function forgeRunSnapshot(input: {
  stateJson: string | null;
  gateJsonl: string | null;
  artifactExists: (path: string) => boolean;
}): ForgeRunSnapshot {
  const state = parseForgeState(input.stateJson);
  return {
    slug: state?.slug ?? null,
    feature: state?.feature ?? null,
    epic: state?.epic ?? null,
    updatedAt: state?.updatedAt || null,
    phases: phaseRows(state, input.artifactExists),
    gate: parseLatestGateRun(input.gateJsonl),
  };
}

export type ReviewDecision = "approve" | "request-changes";

export const REVIEW_NOTE_LIMIT = 2000;

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
