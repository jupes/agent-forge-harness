/**
 * The repository an issue belongs to: the dashboard's Repo column.
 *
 * Every issue lives in this tracker, sub-repository work included, so the
 * prefix of an issue id only ever names the host. An issue names its
 * repository itself, in this order:
 * 1. a `repo:<name>` label;
 * 2. a leading `[name]` in its title, when `name` is a known repository. The
 *    documents ask for the repository at the start of the title, but the same
 *    brackets also carry area tags (`[dashboard]`, `[forge]`), so a tag that
 *    names no known repository names nothing;
 * 3. the `repo` field of the export row, which bd does not print today.
 * With none of those, the host prefix of its id.
 *
 * The known repositories are those registered in `repos/repos.json` (passed
 * in), those any issue's `repo:` label names, and the host.
 */

import type { BdExportRow } from "../beads-dashboard";

/** What the rows alone cannot say. */
export interface RepoContext {
  /** Registered repositories (`repos/repos.json`): names a title prefix may give. */
  knownRepos?: readonly string[];
}

const REPO_LABEL = /^repo:(.*)$/i;
const TITLE_PREFIX = /^\s*\[([^\]]+)\]/;
const HOST_ID = /^([a-z0-9]+(?:-[a-z0-9]+)+)-[a-z0-9]+(?:\.[a-z0-9]+)*$/;

/** The value of the first `repo:<name>` label with a name; key in any case, value trimmed. */
export function repoFromLabels(
  labels: readonly unknown[] | undefined,
): string | undefined {
  for (const label of labels ?? []) {
    if (typeof label !== "string") continue;
    const value = REPO_LABEL.exec(label.trim())?.[1]?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * The host prefix of an issue id: `agent-forge-harness` for
 * `agent-forge-harness-5an.65`. It names the tracker, not a sub-repository.
 */
export function hostOfIssueId(issueId: string): string | undefined {
  return HOST_ID.exec(issueId)?.[1];
}

/** Known repository names by their lower-case spelling, first spelling kept. */
type KnownRepos = Map<string, string>;

function knownReposOf(
  rows: readonly BdExportRow[],
  context: RepoContext,
): KnownRepos {
  const known: KnownRepos = new Map();
  const add = (name: string | undefined) => {
    const trimmed = name?.trim();
    if (trimmed && !known.has(trimmed.toLowerCase()))
      known.set(trimmed.toLowerCase(), trimmed);
  };
  for (const name of context.knownRepos ?? []) add(name);
  for (const row of rows) {
    add(repoFromLabels(row.labels));
    add(hostOfIssueId(row.id));
  }
  return known;
}

/** The known repository a leading `[name]` in the title names, in its known spelling. */
function repoFromTitle(title: unknown, known: KnownRepos): string | undefined {
  if (typeof title !== "string") return undefined;
  const tag = TITLE_PREFIX.exec(title)?.[1]?.trim();
  return tag ? known.get(tag.toLowerCase()) : undefined;
}

/** Each row's repository by issue id; undefined where nothing names one. */
export function issueRepos(
  rows: readonly BdExportRow[],
  context: RepoContext = {},
): Map<string, string | undefined> {
  const known = knownReposOf(rows, context);
  const repos = new Map<string, string | undefined>();
  for (const row of rows) {
    repos.set(
      row.id,
      repoFromLabels(row.labels) ??
        repoFromTitle(row.title, known) ??
        row.repo ??
        hostOfIssueId(row.id),
    );
  }
  return repos;
}
