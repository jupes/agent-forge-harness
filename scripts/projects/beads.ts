import { z } from "zod";
import type { ProjectBead, ProjectBeadsPage } from "../../types/project-beads";
import type { ProjectRecord } from "../../types/projects";
import { ConversationError } from "../conversations/error";
import { projectBeadSchema, projectBeadsPageSchema } from "./beads-protocol";
import { selectProjectBeads, workspaceKey } from "./scope";
import type { ProjectSources } from "./summary";

const rawDetails = z.object({
  priority: z.number().int().min(0).max(4).optional(),
  status: z.string().min(1).max(80),
  description: z.string().max(65_536).optional(),
  acceptance_criteria: z.string().max(32_768).optional(),
  comment_count: z.number().int().nonnegative().optional(),
  comments: z
    .array(
      z.object({
        issue_id: z.string().optional(),
        text: z.string().max(16_384).optional(),
        author: z.string().max(1024).optional(),
        created_at: z.string().max(100).optional(),
      }),
    )
    .max(100)
    .optional(),
});
function problem(message: string): never {
  throw new ConversationError(503, message);
}
const amount = (value: unknown): number | null => {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

/** Project ancestry+label scope is established before any raw field is exposed. */
export function projectBeads(
  project: ProjectRecord,
  source: ProjectSources,
): ProjectBeadsPage {
  const scope = project.workspaces.find(
    (item) => workspaceKey(item.root) === workspaceKey(source.workspace),
  );
  if (!scope)
    throw new ConversationError(
      409,
      "This hearth does not serve the selected project workspace.",
    );
  if (!source.issues || !source.beadRows)
    problem(
      "The live tracker read is unavailable. Refresh to check the project beads again.",
    );
  const members = selectProjectBeads(project, source.workspace, source.issues),
    ids = new Set(members.map((item) => item.id));
  const all = new Map(source.beadRows.map((row) => [row.id, row]));
  const edges = source.dependencies ?? [];
  const beads: ProjectBead[] = members.map((issue) => {
    const raw = all.get(issue.id),
      parsed = rawDetails.safeParse(raw);
    if (!raw || !parsed.success)
      problem(
        "A live tracker bead has unsupported details or priority. The read has not been presented as complete.",
      );
    const data = parsed.data;
    const active = [
      ...new Set(
        edges
          .filter(
            (edge) =>
              edge.from === issue.id &&
              (edge.type === "blocks" || edge.type === "requires") &&
              all.get(edge.to)?.status !== "closed",
          )
          .map((edge) => edge.to),
      ),
    ];
    const blockers = active.filter((id) => ids.has(id));
    const blocked = data.status === "blocked" || active.length > 0;
    const queue = source.queue?.find(
      (item) => item.beadId === issue.id && item.backed,
    );
    const comments = (data.comments ?? [])
      .filter(
        (comment) =>
          comment.issue_id === undefined || comment.issue_id === issue.id,
      )
      .map((comment) => ({
        body: comment.text ?? "",
        author: comment.author ?? "",
        createdAt: comment.created_at ?? "",
      }));
    const candidate = projectBeadSchema.safeParse({
      id: issue.id,
      title: issue.title,
      type: issue.type,
      status: data.status,
      priority: data.priority ?? null,
      parent: issue.parent && ids.has(issue.parent) ? issue.parent : null,
      assignee: issue.assignee?.trim() || null,
      owner: issue.owner ?? null,
      labels: issue.labels ?? [],
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      due: issue.due ?? null,
      description: data.description ?? "",
      acceptanceCriteria: data.acceptance_criteria ?? "",
      estimate: amount(raw.estimate),
      spent: amount(raw.spent),
      ready: data.status === "open" && !issue.assignee?.trim() && !blocked,
      blocked,
      blockers,
      unavailableBlockers: active.length - blockers.length,
      queue: queue?.state ?? null,
      smith: queue?.smith ?? null,
      comments,
      commentsComplete:
        data.comment_count !== undefined &&
        data.comment_count === comments.length,
    });
    if (!candidate.success)
      problem(
        "The live tracker bead fields could not be verified. Refresh to check again.",
      );
    return candidate.data;
  });
  const page: ProjectBeadsPage = {
    projectId: project.id,
    workspace: source.workspace,
    asOf: source.asOf,
    complete: project.workspaces.length === 1,
    problems: [],
    beads,
    dependencies: edges.filter(
      (edge) => ids.has(edge.from) && ids.has(edge.to),
    ),
  };
  if (project.workspaces.length > 1)
    page.problems.push(
      "Other project workspaces are unavailable from this hearth.",
    );
  if (scope.epicIds.some((id) => !all.has(id))) {
    page.complete = false;
    page.problems.push(
      "One or more saved epics are absent from the tracker read.",
    );
  }
  if (source.queue === null)
    page.problems.push(
      "Queue state is unavailable; a dash does not mean Open.",
    );
  if (
    beads.length > 1000 ||
    Buffer.byteLength(JSON.stringify(page)) > 1_000_000
  )
    problem(
      "This project's live bead read exceeds the supported bound. Narrow the saved project scope before browsing it.",
    );
  const checked = projectBeadsPageSchema.safeParse(page);
  if (!checked.success) problem("The scoped bead graph could not be verified.");
  return checked.data;
}
