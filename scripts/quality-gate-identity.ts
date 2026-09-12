/**
 * Which checkout and run a quality-gate result belongs to.
 *
 * `.claude/hooks/quality-gate.ts` appends every run to one user-global log
 * that every checkout and worktree on the machine shares. Recording this with
 * each entry is what lets a reader — the dashboard's Forge run view — show a
 * result only where it applies.
 */

export interface GateIdentity {
  /** Top level of the checkout the gate ran in. */
  checkout: string;
  /** Branch checked out at the time, or null for a detached HEAD. */
  branch: string | null;
  /** `CLAUDE_TASK_ID`, when the hook event carried one. */
  taskId: string | null;
  /** Slug of the forge run recorded in that checkout, if one exists. */
  forgeSlug: string | null;
}

export function gateIdentity(input: {
  cwd: string;
  /** `git rev-parse --show-toplevel`, or null outside a git checkout. */
  gitToplevel: string | null;
  /** `git rev-parse --abbrev-ref HEAD`, or null if it failed. */
  gitBranch: string | null;
  taskId: string | undefined;
  /** Contents of `<checkout>/.tmp/work/forge-state.json`, if present. */
  forgeStateJson: string | null;
}): GateIdentity {
  const branch = input.gitBranch?.trim() || null;
  return {
    checkout: input.gitToplevel?.trim() || input.cwd,
    branch: branch === "HEAD" ? null : branch,
    taskId: input.taskId?.trim() || null,
    forgeSlug: slugFrom(input.forgeStateJson),
  };
}

function slugFrom(json: string | null): string | null {
  if (!json) return null;
  try {
    const slug = (JSON.parse(json) as { slug?: unknown }).slug;
    return typeof slug === "string" && slug.trim() ? slug.trim() : null;
  } catch {
    return null;
  }
}
