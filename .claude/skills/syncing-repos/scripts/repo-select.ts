/**
 * Which entries of `repos/repos.json` a command acts on.
 *
 * An entry with `"archived": true` stays registered (and cloned, if it is)
 * but is left out of every all-repos run: init, status, refresh, reset and the
 * branch commands. Naming it with `--repo <name>` still acts on it, and
 * `--include-archived` brings every archived entry back in.
 */

export interface RepoConfig {
  name: string;
  url: string;
  defaultBranch: string;
  /** Only `true` archives; a missing or any other value is an active repository. */
  archived?: boolean;
}

export interface RepoSelection {
  targets: RepoConfig[];
  /** Names of the archived entries left out of this run. */
  skipped: string[];
}

export function selectRepos(
  repos: readonly RepoConfig[],
  options: { repo?: string | undefined; includeArchived: boolean },
): RepoSelection {
  if (options.repo !== undefined)
    return {
      targets: repos.filter((r) => r.name === options.repo),
      skipped: [],
    };
  if (options.includeArchived) return { targets: [...repos], skipped: [] };
  return {
    targets: repos.filter((r) => r.archived !== true),
    skipped: repos.filter((r) => r.archived === true).map((r) => r.name),
  };
}
