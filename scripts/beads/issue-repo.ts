/**
 * The repository an issue belongs to: the dashboard's Repo column.
 *
 * Every issue lives in this tracker, sub-repository work included, so the
 * prefix of an issue id only ever names the host. An issue's repository is
 * the first of:
 * 1. an entry for the issue's own id in the repository map
 *    (`repos/issue-repos.json`, read by `./repo-context.ts`);
 * 2. a `repo:<name>` label on the issue;
 * 3. a leading `[name]` in its title, when `name` is a known repository or a
 *    title tag the map lists. The documents ask for the repository at the
 *    start of the title, but the same brackets also carry area tags
 *    (`[dashboard]`, `[forge]`), so a tag that names no known repository
 *    names nothing;
 * 4. the `repo` field of the export row, which bd does not print today;
 * 5. the first of 1–4 for its parent, then the parent's parent, and so on:
 *    a map entry for an epic covers everything under it;
 * 6. the host prefix of its id.
 *
 * The known repositories are those registered in `repos/repos.json` (passed
 * in), those the map names, those any issue's `repo:` label names, and the
 * host.
 */

import type { BdExportRow } from "../beads-dashboard";

/** The repository map (`repos/issue-repos.json`). */
export interface IssueRepoMap {
  /** Issue id to repository. An entry covers the issue and its descendants. */
  issues: Readonly<Record<string, string>>;
  /** Title tag to repository, for a `[tag]` that is not the repository's own name. */
  titleTags: Readonly<Record<string, string>>;
}

/** What the rows alone cannot say. */
export interface RepoContext {
  /** Registered repositories (`repos/repos.json`): names a title prefix may give. */
  knownRepos?: readonly string[];
  map?: IssueRepoMap;
}

/** Which rule decided an issue's repository. */
export type RepoSource =
  | "map"
  | "label"
  | "title"
  | "field"
  | "parent"
  | "host";

export interface ResolvedRepo {
  /** Undefined only when the id has no host prefix either. */
  repo: string | undefined;
  from: RepoSource;
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

/** A record's own entry, trimmed; never one inherited from Object. */
function entryOf(
  record: Readonly<Record<string, string>> | undefined,
  key: string,
): string | undefined {
  if (!record || !Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** What a leading `[tag]` may stand for, by the tag's lower-case spelling. */
type KnownTags = Map<string, string>;

function knownTagsOf(
  rows: readonly BdExportRow[],
  context: RepoContext,
): KnownTags {
  const known: KnownTags = new Map();
  const add = (name: string | undefined) => {
    const trimmed = name?.trim();
    if (trimmed && !known.has(trimmed.toLowerCase()))
      known.set(trimmed.toLowerCase(), trimmed);
  };
  for (const name of context.knownRepos ?? []) add(name);
  for (const name of Object.values(context.map?.issues ?? {})) add(name);
  for (const name of Object.values(context.map?.titleTags ?? {})) add(name);
  for (const row of rows) {
    add(repoFromLabels(row.labels));
    add(hostOfIssueId(row.id));
  }
  for (const tag of Object.keys(context.map?.titleTags ?? {})) {
    const repo = entryOf(context.map?.titleTags, tag);
    if (repo && tag.trim()) known.set(tag.trim().toLowerCase(), repo);
  }
  return known;
}

/** The repository a leading `[tag]` in the title stands for, if any. */
function repoFromTitle(title: unknown, known: KnownTags): string | undefined {
  if (typeof title !== "string") return undefined;
  const tag = TITLE_PREFIX.exec(title)?.[1]?.trim();
  return tag ? known.get(tag.toLowerCase()) : undefined;
}

function parentOf(row: BdExportRow | undefined): string | undefined {
  for (const d of row?.dependencies ?? []) {
    if (d.type === "parent-child" && d.issue_id === row?.id)
      return d.depends_on_id;
  }
  return undefined;
}

/** Each row's repository and the rule that decided it, by issue id. */
export function resolveIssueRepos(
  rows: readonly BdExportRow[],
  context: RepoContext = {},
): Map<string, ResolvedRepo> {
  const known = knownTagsOf(rows, context);
  const byId = new Map(rows.map((row) => [row.id, row]));

  /** Rules 1–4: what the issue says itself (an absent row can still have a map entry). */
  const ownRepo = (id: string): ResolvedRepo | undefined => {
    const mapped = entryOf(context.map?.issues, id);
    if (mapped) return { repo: mapped, from: "map" };
    const row = byId.get(id);
    if (!row) return undefined;
    const label = repoFromLabels(row.labels);
    if (label) return { repo: label, from: "label" };
    const title = repoFromTitle(row.title, known);
    if (title) return { repo: title, from: "title" };
    if (row.repo) return { repo: row.repo, from: "field" };
    return undefined;
  };

  const resolved = new Map<string, ResolvedRepo>();
  for (const row of rows) {
    let found = ownRepo(row.id);
    const seen = new Set([row.id]);
    for (
      let parent = parentOf(row);
      !found && parent !== undefined && !seen.has(parent);
      parent = parentOf(byId.get(parent))
    ) {
      seen.add(parent);
      const inherited = ownRepo(parent);
      if (inherited) found = { repo: inherited.repo, from: "parent" };
    }
    resolved.set(
      row.id,
      found ?? { repo: hostOfIssueId(row.id), from: "host" },
    );
  }
  return resolved;
}

/** Each row's repository by issue id; undefined where nothing names one. */
export function issueRepos(
  rows: readonly BdExportRow[],
  context: RepoContext = {},
): Map<string, string | undefined> {
  const repos = new Map<string, string | undefined>();
  for (const [id, { repo }] of resolveIssueRepos(rows, context))
    repos.set(id, repo);
  return repos;
}
