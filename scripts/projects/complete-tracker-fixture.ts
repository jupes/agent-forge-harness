import type {
  CompleteBeadRow,
  TrackerIdentity,
} from "./complete-tracker-source";

/** An intentionally complete simulated tracker, never a production export adapter. */
export function completeTrackerFixture(
  identity: TrackerIdentity,
  issues: readonly CompleteBeadRow[],
  wispIds: readonly string[] = [],
): string {
  const parts: Array<{
    part: string;
    payload: string;
    created_at: string | null;
    updated_at: string | null;
    due_at: string | null;
  }> = [];
  const counts = {
    issues: 0,
    wisps: 0,
    labels: 0,
    wisp_labels: 0,
    dependencies: 0,
    wisp_dependencies: 0,
  };
  const family = (id: string) => (wispIds.includes(id) ? "wisps" : "issues");
  let edge = 0;
  for (const issue of issues) {
    const table = family(issue.id),
      labels = table === "issues" ? "labels" : "wisp_labels",
      deps = table === "issues" ? "dependencies" : "wisp_dependencies";
    counts[table]++;
    parts.push({
      part: table,
      payload: JSON.stringify({
        id: issue.id,
        title: issue.title,
        status: issue.status,
        issue_type: issue.issue_type,
        priority: issue.priority,
        description: issue.description,
        acceptance_criteria: issue.acceptance_criteria,
        notes: issue.notes,
        comment_count: issue.comment_count ?? issue.comments?.length ?? 0,
        comments: (issue.comments ?? []).map((comment) => ({
          issue_id: comment.issue_id ?? issue.id,
          text: comment.text ?? "",
          author: comment.author ?? "",
          created_at: comment.created_at ?? "2026-01-01T00:00:00Z",
        })),
        owner: issue.owner ?? null,
        assignee: issue.assignee ?? null,
        estimated_minutes: issue.estimate ?? null,
        metadata: {
          queue_state: issue.metadata.queue_state ?? null,
          queue_resume: issue.metadata.queue_resume ?? null,
          smith: issue.metadata.smith ?? null,
        },
      }),
      created_at: issue.created_at ?? null,
      updated_at: issue.updated_at ?? null,
      due_at: issue.due_at ?? null,
    });
    for (const label of issue.labels) {
      counts[labels]++;
      parts.push({
        part: labels,
        payload: JSON.stringify({ issue_id: issue.id, label }),
        created_at: null,
        updated_at: null,
        due_at: null,
      });
    }
    for (const dependency of issue.dependencies) {
      counts[deps]++;
      parts.push({
        part: deps,
        payload: JSON.stringify({
          id: `00000000-0000-4000-8000-${String(++edge).padStart(12, "0")}`,
          issue_id: dependency.issue_id,
          type: dependency.type,
          depends_on_issue_id:
            !dependency.depends_on_id.startsWith("external:") &&
            family(dependency.depends_on_id) === "issues"
              ? dependency.depends_on_id
              : null,
          depends_on_wisp_id:
            family(dependency.depends_on_id) === "wisps"
              ? dependency.depends_on_id
              : null,
          depends_on_external: dependency.depends_on_id.startsWith("external:")
            ? dependency.depends_on_id
            : null,
        }),
        created_at: null,
        updated_at: null,
        due_at: null,
      });
    }
  }
  return JSON.stringify([
    {
      part: "manifest",
      payload: JSON.stringify({ version: 1, ...identity, counts }),
      created_at: null,
      updated_at: null,
      due_at: null,
    },
    ...parts,
  ]);
}
