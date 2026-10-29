import {
  checkpointsForEpic,
  type CheckpointSummary,
} from "../../../docs/js/forge-checkpoints";
import type { BeadsIssue, IssueStatus } from "../../../types/beads";
import type { ProjectBeadsPage } from "../../../types/project-beads";
import type { ProjectRunsView } from "./project-runs-client";

const ISSUE_STATUSES = ["open", "in_progress", "closed", "blocked"] as const;
function isIssueStatus(value: string): value is IssueStatus {
  return ISSUE_STATUSES.some((status) => status === value);
}

export type ProjectRunCheckpointResult =
  | { kind: "loading" }
  | { kind: "unavailable"; reason: string }
  | { kind: "no-epic" }
  | { kind: "ready"; workspace: string; epicId: string; summary: CheckpointSummary };

export function deriveProjectRunCheckpoints(input: {
  projectId: string;
  workspace: string | null;
  runs: Pick<
    ProjectRunsView,
    | "page"
    | "loading"
    | "error"
    | "selectedSlug"
    | "detail"
    | "detailLoading"
    | "detailError"
    | "detailStale"
  > | null;
  beads: {
    page: ProjectBeadsPage | null;
    loading: boolean;
    error: string | null;
  };
}): ProjectRunCheckpointResult {
  const { runs, beads, projectId, workspace } = input;
  if (!workspace) return { kind: "unavailable", reason: "The served workspace is not verified." };
  if (!runs) return { kind: "loading" };
  if (runs.error || runs.detailError || beads.error)
    return {
      kind: "unavailable",
      reason: runs.error || runs.detailError || beads.error || "A source could not be read.",
    };
  if (runs.loading || runs.detailLoading || beads.loading)
    return { kind: "loading" };
  const list = runs.page,
    detail = runs.detail,
    beadPage = beads.page,
    slug = runs.selectedSlug;
  if (!list || !detail || !beadPage || !slug)
    return { kind: "unavailable", reason: "Select a run and refresh its current sources." };
  if (
    runs.detailStale ||
    list.projectId !== projectId ||
    detail.projectId !== projectId ||
    beadPage.projectId !== projectId ||
    list.workspace !== workspace ||
    detail.workspace !== workspace ||
    beadPage.workspace !== workspace ||
    list.checkout !== detail.checkout ||
    list.coverage !== detail.coverage ||
    detail.run.slug !== slug
  )
    return { kind: "unavailable", reason: "The selected run and project sources do not match the current scope." };
  const listedRun = list.runs.find((run) => run.slug === slug);
  if (!listedRun || JSON.stringify(listedRun) !== JSON.stringify(detail.run))
    return { kind: "unavailable", reason: "The selected run changed; refresh Runs before using its checkpoints." };
  if (!beadPage.complete || beadPage.problems.length > 0)
    return { kind: "unavailable", reason: beadPage.problems[0] ?? "The current project Beads graph is incomplete." };
  const epicId = detail.run.epic;
  if (epicId === null) return { kind: "no-epic" };
  const epic = beadPage.beads.find((bead) => bead.id === epicId);
  if (!epic || epic.type !== "epic")
    return { kind: "unavailable", reason: "The run's recorded epic is missing from the current project graph." };

  const children = new Map<string, string[]>();
  for (const bead of beadPage.beads) {
    if (bead.parent === null) continue;
    const siblings = children.get(bead.parent) ?? [];
    siblings.push(bead.id);
    children.set(bead.parent, siblings);
  }
  const relevant = new Set<string>([epicId]);
  const queue = [epicId];
  while (queue.length) {
    const parent = queue.shift();
    if (!parent) continue;
    for (const id of children.get(parent) ?? []) {
      if (relevant.has(id)) continue;
      relevant.add(id);
      queue.push(id);
    }
  }
  for (const dependency of beadPage.dependencies) {
    if (relevant.has(dependency.from) && dependency.type !== "relates")
      relevant.add(dependency.to);
  }
  const issues: Pick<BeadsIssue, "id" | "title" | "status" | "parent">[] = [];
  for (const bead of beadPage.beads) {
    if (!relevant.has(bead.id)) continue;
    if (!isIssueStatus(bead.status))
      return { kind: "unavailable", reason: "A checkpoint or its blocker has an unknown status." };
    issues.push({
      id: bead.id,
      title: bead.title,
      status: bead.status,
      ...(bead.parent !== null ? { parent: bead.parent } : {}),
    });
  }
  return {
    kind: "ready",
    workspace,
    epicId,
    summary: checkpointsForEpic({ issues, deps: beadPage.dependencies }, epicId),
  };
}
