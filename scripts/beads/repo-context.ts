/**
 * What `./issue-repo.ts` needs beyond the export rows, read from the
 * machine-local files under `repos/`:
 *
 * - `repos/repos.json`: the registered repositories. Their names are the ones
 *   a leading `[name]` in a title may give. Archived entries count: an
 *   archived repository is still registered.
 * - `repos/issue-repos.json`: the repository map, `{ "issues": { "<issue id>":
 *   "<repo>" }, "titleTags": { "<tag>": "<repo>" } }`. An `issues` entry covers
 *   the issue and everything under it; a `titleTags` entry lets a `[tag]` that
 *   is not the repository's own name stand for it. `repos/issue-repos.json.example`
 *   is the committed template.
 *
 * Both are gitignored, like everything under `repos/`, so a linked worktree
 * reads the main checkout's copies. Neither is required, and a file that
 * cannot be used is reported as a warning: the dashboard is still built.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseReposConfig } from "../dashboard/repos-knowledge-model";
import { localStateRoot } from "../hearth/routes/dev-api";
import type { IssueRepoMap, RepoContext } from "./issue-repo";

export const REPOS_FILE = "repos/repos.json";
export const ISSUE_REPOS_FILE = "repos/issue-repos.json";

const MAP_KEYS = ["issues", "titleTags"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Parse the repository map; what cannot be used is left out and warned about. */
export function parseIssueRepoMap(
  text: string,
  source: string = ISSUE_REPOS_FILE,
): { map: IssueRepoMap; warnings: string[] } {
  const warnings: string[] = [];
  const map = { issues: {}, titleTags: {} } satisfies IssueRepoMap;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    warnings.push(
      `${source} is not valid JSON (${reason}); the repository map is not used`,
    );
    return { map, warnings };
  }
  if (!isRecord(parsed)) {
    warnings.push(
      `${source} must be an object with "issues" and "titleTags"; the repository map is not used`,
    );
    return { map, warnings };
  }
  for (const key of Object.keys(parsed)) {
    if (!(MAP_KEYS as readonly string[]).includes(key))
      warnings.push(
        `${source}: unknown key "${key}" ignored (the keys are "issues" and "titleTags")`,
      );
  }
  for (const key of MAP_KEYS) {
    const section = parsed[key];
    if (section === undefined) continue;
    if (!isRecord(section)) {
      warnings.push(`${source}: "${key}" is not an object; left out`);
      continue;
    }
    const entries: Record<string, string> = {};
    for (const [name, repo] of Object.entries(section)) {
      if (typeof repo === "string" && repo.trim()) entries[name] = repo.trim();
      else
        warnings.push(
          `${source}: ${key}["${name}"] is not a repository name; left out`,
        );
    }
    map[key] = entries;
  }
  return { map, warnings };
}

function readIfPresent(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

/** The registered repository names and the repository map for the checkout at `root`. */
export function readRepoContext(
  root: string,
  registryRoot?: string,
): {
  context: RepoContext;
  warnings: string[];
} {
  const local = registryRoot ?? localStateRoot(root);
  const knownRepos: string[] = [];
  for (const entry of parseReposConfig(
    readIfPresent(join(local, REPOS_FILE)),
  )) {
    if (typeof entry.name === "string" && entry.name.trim())
      knownRepos.push(entry.name.trim());
  }
  const mapText = readIfPresent(join(local, ISSUE_REPOS_FILE));
  if (mapText === null) return { context: { knownRepos }, warnings: [] };
  const { map, warnings } = parseIssueRepoMap(mapText);
  return { context: { knownRepos, map }, warnings };
}
