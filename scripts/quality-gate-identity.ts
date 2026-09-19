/**
 * Which checkout and run a quality-gate result belongs to.
 *
 * `.claude/hooks/quality-gate.ts` appends every run to one user-global log
 * that every checkout and worktree on the machine shares. Recording this with
 * each entry is what lets a reader — the dashboard's Forge run view — show a
 * result only where it applies.
 *
 * Several forge runs can be in flight at once, so the run a gate belongs to is
 * no longer simply "the" active one: it is named outright, matched by checkout,
 * or left null rather than guessed.
 */

import { comparableCheckout } from "./forge/runs";

export interface GateIdentity {
  /** Top level of the checkout the gate ran in. */
  checkout: string;
  /** Branch checked out at the time, or null for a detached HEAD. */
  branch: string | null;
  /** `CLAUDE_TASK_ID`, when the hook event carried one. */
  taskId: string | null;
  /** Slug of the forge run this gate belongs to, if it can be established. */
  forgeSlug: string | null;
}

/** The little a gate needs to know about a run to attribute itself to one. */
export interface RunIdentity {
  slug: string;
  /** True once the run has shipped — a finished run claims no new gate runs. */
  complete: boolean;
  /** The checkout the run builds in, when it recorded one. */
  checkout: string | null;
}

/**
 * The run a gate result belongs to.
 *
 * `FORGE_SLUG` wins: the agent driving a run knows which one it is, and a run's
 * state file does not exist until its first phase completes. Otherwise the run
 * is inferred from the checkout — unambiguous while one run builds in one
 * worktree. When several in-flight runs share a checkout, the gate records no
 * run at all: a mislabelled result is worse than an unlabelled one.
 */
export function forgeSlugFor(input: {
  envSlug: string | null | undefined;
  checkout: string;
  runs: readonly RunIdentity[];
}): string | null {
  const named = input.envSlug?.trim();
  if (named) return named;

  const here = comparableCheckout(input.checkout);
  const live = input.runs.filter((run) => !run.complete);
  const mine = live.filter(
    (run) => run.checkout !== null && comparableCheckout(run.checkout) === here,
  );
  if (mine.length === 1) return mine[0]?.slug ?? null;
  if (mine.length > 1) return null;

  // No run claims this checkout. One in-flight run is still unambiguous.
  return live.length === 1 ? (live[0]?.slug ?? null) : null;
}

export function gateIdentity(input: {
  cwd: string;
  /** `git rev-parse --show-toplevel`, or null outside a git checkout. */
  gitToplevel: string | null;
  /** `git rev-parse --abbrev-ref HEAD`, or null if it failed. */
  gitBranch: string | null;
  taskId: string | undefined;
  /** `FORGE_SLUG` — the run the agent says this work belongs to. */
  forgeSlugEnv: string | null | undefined;
  /** Every forge run the harness knows about in this checkout. */
  runs: readonly RunIdentity[];
}): GateIdentity {
  const branch = input.gitBranch?.trim() || null;
  const checkout = input.gitToplevel?.trim() || input.cwd;
  return {
    checkout,
    branch: branch === "HEAD" ? null : branch,
    taskId: input.taskId?.trim() || null,
    forgeSlug: forgeSlugFor({
      envSlug: input.forgeSlugEnv,
      checkout,
      runs: input.runs,
    }),
  };
}
