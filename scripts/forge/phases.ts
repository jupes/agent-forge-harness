/**
 * The Forge pipeline's phases and artifact paths.
 *
 * Split out of `phase-gate.ts` because that file carries a `#!/usr/bin/env bun`
 * shebang: esbuild rejects it when the Vite config imports the module graph, so
 * anything the dashboard needs has to live in a plain module.
 */

export type ForgePhase = "research" | "plan" | "implement" | "ship";

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
  /** Last phase announced by the Stop hook (noise control). */
  announcedPhase?: ForgePhase;
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
