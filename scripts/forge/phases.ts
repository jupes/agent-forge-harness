/**
 * The Forge pipeline's phases and artifact paths.
 *
 * Split out of `phase-gate.ts` because that file carries a `#!/usr/bin/env bun`
 * shebang: esbuild rejects it when the Vite config imports the module graph, so
 * anything the dashboard needs has to live in a plain module.
 */

export type ForgePhase = "research" | "plan" | "implement" | "ship";

/**
 * How a run advances between phases.
 *
 * `gated` runs stop at every boundary for a human (`/forgemaster`); `auto` runs
 * review their own output with a subagent and advance themselves
 * (`/forgemaster-auto`).
 */
export type ForgeMode = "gated" | "auto";

export const FORGE_MODES: readonly ForgeMode[] = ["gated", "auto"] as const;

export function isForgeMode(value: string): value is ForgeMode {
  return (FORGE_MODES as readonly string[]).includes(value);
}

export interface ReviewFindings {
  blocker: number;
  high: number;
  medium: number;
  low: number;
}

/**
 * One review round: what a fresh evaluator said about a phase's output.
 *
 * Lives here with the rest of the run's shape; the rules that read it are in
 * `auto-loop.ts`. `UNREADABLE` is not an evaluator verdict — it is what the
 * harness records when a review produced no parseable verdict at all.
 */
export interface ReviewRound {
  phase: ForgePhase;
  /** 1-based within the phase. Round 1 reviews the first attempt. */
  round: number;
  verdict: "PASS" | "FAIL" | "UNREADABLE";
  findings: ReviewFindings;
  /** The model tier that graded, for the grader-≥-subject audit. */
  tier?: string;
  summary?: string;
  at: string;
}

export const FORGE_PHASES: readonly ForgePhase[] = [
  "research",
  "plan",
  "implement",
  "ship",
] as const;

export interface ForgeState {
  slug: string;
  feature?: string;
  /** The most recently completed (or active) phase. */
  phase: ForgePhase;
  /** Phases whose exit artifact has been validated. */
  completed: ForgePhase[];
  /** Beads epic id grouping the work, if any. */
  epic?: string;
  /** Map of phase -> repo-relative artifact path. */
  artifacts: Partial<Record<ForgePhase, string>>;
  /**
   * Every subagent review round, oldest first. An unattended run reviews its
   * own output at each phase; this ledger is how that stays auditable.
   */
  reviews?: ReviewRound[];
  /** Last phase announced by the Stop hook (noise control). */
  announcedPhase?: ForgePhase;
  /** How the run advances between phases. Absent means `gated`. */
  mode?: ForgeMode;
  /**
   * The checkout (worktree) this run builds in. Concurrent runs that touch code
   * need separate worktrees, so a run records where its work lives.
   */
  checkout?: string;
  updatedAt: string;
}

export function isForgePhase(value: string): value is ForgePhase {
  return (FORGE_PHASES as readonly string[]).includes(value);
}

/** Repo-relative path of the document a phase produces, or null if it has none. */
export function artifactPath(phase: ForgePhase, slug: string): string | null {
  switch (phase) {
    case "research":
      return `plans/research/${slug}.md`;
    case "plan":
      return `plans/drafts/${slug}.md`;
    case "implement":
      // Implementation has no single doc artifact — it is tracked by Beads + git.
      return null;
    case "ship":
      return `reports/${slug}-ship.md`;
  }
}
