/**
 * What the Repos & knowledge view shows.
 *
 * Pure functions over already-read file contents, so the freshness rules and
 * the repo/knowledge join are testable without touching disk.
 */

export interface RepoEntry {
  name: string;
  /** Path relative to the harness root, e.g. `repos/game-guide-ai`. */
  path: string;
  url: string | null;
  branch: string | null;
  /** Whether the working copy is present under `repos/`. */
  cloned: boolean;
  /** Knowledge YAML for this repo, if one exists. */
  knowledgeFile: string | null;
  /** Age of that YAML in days, or null when there is none. */
  knowledgeAgeDays: number | null;
  freshness: "current" | "aging" | "stale" | "missing";
}

export interface KnowledgeFile {
  path: string;
  ageDays: number | null;
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

interface RepoConfigEntry {
  name?: string;
  url?: string;
  branch?: string;
  path?: string;
}

/**
 * Parse `repos/repos.json`.
 *
 * Accepts both the `{ repos: [...] }` wrapper and a bare array, since the
 * committed example and hand-edited files differ.
 */
export function parseReposConfig(json: string | null): RepoConfigEntry[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { repos?: unknown }).repos)
        ? (parsed as { repos: unknown[] }).repos
        : [];
    return list.filter(
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

/**
 * Join the registered repos with what is on disk and how fresh their
 * knowledge files are.
 *
 * A repo that is cloned but unregistered still shows up — otherwise a
 * directory someone added by hand would be invisible here.
 */
export function buildRepoEntries(input: BuildReposInput): RepoEntry[] {
  const configured = parseReposConfig(input.reposJson);
  const names = new Set<string>();
  const entries: RepoEntry[] = [];

  const push = (name: string, config: RepoConfigEntry | null) => {
    if (!name || names.has(name)) return;
    names.add(name);
    const ageDays = input.knowledge.has(name)
      ? (input.knowledge.get(name) ?? null)
      : null;
    entries.push({
      name,
      path: config?.path ?? `repos/${name}`,
      url: config?.url ?? null,
      branch: config?.branch ?? null,
      cloned: input.clonedDirs.includes(name),
      knowledgeFile: input.knowledge.has(name)
        ? `knowledge/repos/${name}.yaml`
        : null,
      knowledgeAgeDays: ageDays,
      freshness: input.knowledge.has(name) ? freshnessFor(ageDays) : "missing",
    });
  };

  for (const config of configured) {
    push(String(config.name ?? "").trim(), config);
  }
  for (const dir of input.clonedDirs) {
    push(dir, null);
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}
