#!/usr/bin/env bun

/**
 * Give issues the `repo:<name>` label their repository calls for.
 *
 * The dashboard already shows each issue's repository without labels
 * (`./issue-repo.ts`: the repository map in `repos/issue-repos.json`, a
 * leading `[name]` in the title, the parent's repository). A label makes the
 * same answer visible to `bd list --label repo:<name>` and to any reader of
 * the tracker that does not have this machine's map.
 *
 * A dry run by default: it reads the tracker (one `bd export`) and prints the
 * plan and the `bd update` commands it would run, and writes nothing. With
 * `--apply` it runs them, one `bd update <id> --add-label repo:<name>` per
 * issue, and only from the live tracker, never from `.beads/issues.jsonl`.
 *
 * Planned: an issue with no `repo:` label whose repository comes from the
 * map, a title prefix or a parent. Never planned: an issue that has a
 * `repo:` label already, or whose repository is only the host prefix. An
 * issue whose label differs from its own map entry is listed as a conflict
 * and left alone.
 *
 * Usage (from the main checkout, where `bd` finds the tracker):
 *   bun run beads:backfill-repo-labels            # dry run
 *   bun run beads:backfill-repo-labels --apply    # write the labels
 *
 * Emits `{ ok, data: { apply, source, add, conflicts, commands, applied, failed }, error }`.
 */

import type { SnapshotSource } from "../../types/beads";
import type { BdExportRow } from "../beads-dashboard";
import { isMain } from "../is-main";
import {
  type RepoContext,
  type RepoSource,
  repoFromLabels,
  resolveIssueRepos,
} from "./issue-repo";
import {
  type BdRunner,
  FALLBACK_FILE,
  readTrackerRows,
  runBdOnPath,
} from "./live-tracker";
import { readRepoContext } from "./repo-context";

export interface LabelPlan {
  add: { id: string; title: string; repo: string; from: RepoSource }[];
  conflicts: { id: string; title: string; label: string; mapped: string }[];
}

/** The sources a label is written for: the ones a reader without the map cannot see. */
const LABELLED_FROM: ReadonlySet<RepoSource> = new Set([
  "map",
  "title",
  "parent",
]);

export function planRepoLabels(
  rows: readonly BdExportRow[],
  context: RepoContext,
): LabelPlan {
  const resolved = resolveIssueRepos(rows, context);
  const plan: LabelPlan = { add: [], conflicts: [] };
  for (const row of rows) {
    const label = repoFromLabels(row.labels);
    const found = resolved.get(row.id);
    if (label) {
      if (
        found?.from === "map" &&
        found.repo !== undefined &&
        found.repo.toLowerCase() !== label.toLowerCase()
      )
        plan.conflicts.push({
          id: row.id,
          title: row.title,
          label,
          mapped: found.repo,
        });
      continue;
    }
    if (found?.repo !== undefined && LABELLED_FROM.has(found.from))
      plan.add.push({
        id: row.id,
        title: row.title,
        repo: found.repo,
        from: found.from,
      });
  }
  return plan;
}

const updateArgs = (id: string, repo: string): string[] => [
  "update",
  id,
  "--add-label",
  `repo:${repo}`,
];

export interface BackfillResult {
  ok: boolean;
  data: {
    apply: boolean;
    source: SnapshotSource;
    add: LabelPlan["add"];
    conflicts: LabelPlan["conflicts"];
    /** The commands the plan stands for, as they would be typed. */
    commands: string[];
    /** Issues labelled by this run (empty on a dry run). */
    applied: string[];
    failed: { id: string; error: string }[];
  } | null;
  error: string | null;
}

export async function backfillRepoLabels(options: {
  /** The checkout whose `repos/` files and fallback file are read. */
  cwd: string;
  runBd: BdRunner;
  apply: boolean;
}): Promise<BackfillResult> {
  const read = await readTrackerRows(options);
  if (!read.ok)
    return {
      ok: false,
      data: null,
      error: `\`bd export\` did not answer (${read.reason}), and there are no issues in ${FALLBACK_FILE} to fall back to.`,
    };
  if (options.apply && read.source.kind !== "tracker")
    return {
      ok: false,
      data: null,
      error: `refusing to write labels planned from the fallback file ${FALLBACK_FILE}: \`bd export\` did not answer (${read.source.reason}). Start the tracker and run again.`,
    };

  const { context, warnings } = readRepoContext(options.cwd);
  if (options.apply && warnings.length > 0)
    return {
      ok: false,
      data: null,
      error: `refusing to write labels while the repository files have problems: ${warnings.join("; ")}`,
    };

  const plan = planRepoLabels(read.rows, context);
  const commands = plan.add.map(({ id, repo }) =>
    ["bd", ...updateArgs(id, repo)].join(" "),
  );
  const applied: string[] = [];
  const failed: { id: string; error: string }[] = [];
  if (options.apply) {
    for (const { id, repo } of plan.add) {
      try {
        await options.runBd(updateArgs(id, repo));
        applied.push(id);
      } catch (error) {
        failed.push({
          id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return {
    ok: failed.length === 0,
    data: {
      apply: options.apply,
      source: read.source,
      add: plan.add,
      conflicts: plan.conflicts,
      commands,
      applied,
      failed,
    },
    error:
      failed.length === 0
        ? null
        : `${failed.length} of ${plan.add.length} label(s) were not written`,
  };
}

if (isMain(import.meta)) {
  const apply = process.argv.slice(2).includes("--apply");
  const result = await backfillRepoLabels({
    cwd: process.cwd(),
    runBd: runBdOnPath,
    apply,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}
