/**
 * What the Repos & knowledge view shows.
 *
 * Pure functions over already-read file contents, so the freshness rules, the
 * repo/knowledge join and the conventions extraction are testable without
 * touching disk.
 */

import { parse } from "yaml";
import type { WorktreeRecord } from "../../types/beads";

export interface RepoEntry {
  name: string;
  /** Path relative to the harness root: `repos/<name>`. */
  path: string;
  url: string | null;
  /** `defaultBranch` from repos.json — the canonical field. */
  defaultBranch: string | null;
  /** Whether the working copy is present under `repos/`. */
  cloned: boolean;
  /** Knowledge YAML for this repo, if one exists. */
  knowledgeFile: string | null;
  /** Age of that YAML in days, or null when there is none. */
  knowledgeAgeDays: number | null;
  freshness: "current" | "aging" | "stale" | "missing";
}

/** Freshness bands for knowledge YAML, in days since last modification. */
export function freshnessFor(ageDays: number | null): RepoEntry["freshness"] {
  if (ageDays === null) return "missing";
  if (ageDays <= 14) return "current";
  if (ageDays <= 30) return "aging";
  return "stale";
}

export function ageInDays(mtimeMs: number | null, now: number): number | null {
  if (mtimeMs === null) return null;
  return Math.max(0, Math.floor((now - mtimeMs) / 86_400_000));
}

/**
 * One entry of `repos/repos.json`, as `scripts/setup.ts` writes it and the
 * syncing-repos skill reads it: `{ name, url, defaultBranch }`.
 */
interface RepoConfigEntry {
  name?: unknown;
  url?: unknown;
  defaultBranch?: unknown;
}

/** Parse `repos/repos.json` (`{ "repos": [...] }`). */
export function parseReposConfig(json: string | null): RepoConfigEntry[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as { repos?: unknown };
    if (!Array.isArray(parsed.repos)) return [];
    return parsed.repos.filter(
      (entry): entry is RepoConfigEntry =>
        typeof entry === "object" && entry !== null,
    );
  } catch {
    return [];
  }
}

export interface BuildReposInput {
  reposJson: string | null;
  /** Directory names actually present under `repos/`. */
  clonedDirs: string[];
  /** Knowledge YAML basenames (without extension) and their age in days. */
  knowledge: Map<string, number | null>;
  now: number;
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/**
 * Join the registered repos with what is on disk and how fresh their
 * knowledge files are.
 *
 * A repo that is cloned but unregistered still shows up — otherwise a
 * directory someone added by hand would be invisible here.
 */
export function buildRepoEntries(input: BuildReposInput): RepoEntry[] {
  const names = new Set<string>();
  const entries: RepoEntry[] = [];

  const push = (name: string, config: RepoConfigEntry | null) => {
    if (!name || names.has(name)) return;
    names.add(name);
    const hasKnowledge = input.knowledge.has(name);
    const ageDays = hasKnowledge ? (input.knowledge.get(name) ?? null) : null;
    entries.push({
      name,
      path: `repos/${name}`,
      url: text(config?.url),
      defaultBranch: text(config?.defaultBranch),
      cloned: input.clonedDirs.includes(name),
      knowledgeFile: hasKnowledge ? `knowledge/repos/${name}.yaml` : null,
      knowledgeAgeDays: ageDays,
      freshness: hasKnowledge ? freshnessFor(ageDays) : "missing",
    });
  };

  for (const config of parseReposConfig(input.reposJson)) {
    push(text(config.name) ?? "", config);
  }
  for (const dir of input.clonedDirs) push(dir, null);

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/** Worktree records written by `scripts/worktree.ts` to `trees/.state.json`. */
export function parseWorktreeState(json: string | null): WorktreeRecord[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as { worktrees?: unknown };
    if (!Array.isArray(parsed.worktrees)) return [];
    return parsed.worktrees.filter((entry): entry is WorktreeRecord => {
      const record = entry as Partial<WorktreeRecord>;
      return (
        typeof record.id === "string" &&
        typeof record.path === "string" &&
        typeof record.branch === "string" &&
        typeof record.createdAt === "string"
      );
    });
  } catch {
    return [];
  }
}

export interface WorktreeView extends WorktreeRecord {
  /** False when the record outlived its directory — safe to clean up. */
  pathExists: boolean;
}

/** Worktrees newest first, each checked against the filesystem. */
export function worktreeViews(
  records: WorktreeRecord[],
  pathExists: (path: string) => boolean,
): WorktreeView[] {
  return records
    .map((record) => ({ ...record, pathExists: pathExists(record.path) }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export interface ConventionEntry {
  /** Dotted path under `shared_conventions`, e.g. `commit_format.pattern`. */
  key: string;
  value: string;
}

export interface SharedConventions {
  source: string;
  entries: ConventionEntry[];
  /** Set when the YAML could not be parsed; entries is then empty. */
  error: string | null;
}

/** The Repos & knowledge API response. */
export interface ReposKnowledge {
  repos: RepoEntry[];
  worktrees: WorktreeView[];
  conventions: SharedConventions | null;
  /**
   * The main checkout, when the dashboard runs in a linked worktree and the
   * gitignored registries were read from there; null otherwise.
   */
  localStateFrom: string | null;
}

const isScalar = (value: unknown): value is string | number | boolean =>
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean";

function flatten(value: unknown, prefix: string, out: ConventionEntry[]): void {
  if (value === null || value === undefined) return;
  if (isScalar(value)) {
    out.push({ key: prefix, value: String(value) });
    return;
  }
  if (Array.isArray(value)) {
    // Lists of plain values read naturally as one line; lists of maps have no
    // single-line form and are left to the source file.
    if (value.every(isScalar)) {
      out.push({ key: prefix, value: value.map(String).join("; ") });
    }
    return;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, out);
    }
  }
}

/** The `shared_conventions` block of `knowledge/_shared.yaml`, flattened. */
export function sharedConventionsFrom(
  yamlText: string,
  source: string,
): SharedConventions {
  try {
    const document = parse(yamlText) as { shared_conventions?: unknown } | null;
    const entries: ConventionEntry[] = [];
    flatten(document?.shared_conventions, "", entries);
    return { source, entries, error: null };
  } catch (error) {
    return {
      source,
      entries: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
