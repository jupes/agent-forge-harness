import { ConversationError } from "../../conversations/error";
import { selectProjectBeads, workspaceKey } from "../../projects/scope";
import {
  createProjectStore,
  isProjectId,
  ProjectStoreError,
} from "../../projects/store";
import type { ActionRoute, ApiRoute, RouteReply } from "../api";
import { isBeadId } from "../tracker-write";
import { fail, isRecord } from "./operator-reads";
import type { ProjectSnapshot } from "./project-summaries";

interface ScopedWrite {
  projectId: string;
  input: unknown;
  body: unknown;
}

/** Project authority wraps the canonical write rows; no second bd implementation. */
export function projectBeadWriteRoutes(options: {
  home: string;
  workspace: string;
  load(): Promise<ProjectSnapshot>;
  routes: readonly ApiRoute[];
}): ActionRoute<ScopedWrite>[] {
  const current = async (id: string) => {
    const snapshot = await options.load();
    const catalog = createProjectStore(options.home).read();
    if (catalog.revision !== snapshot.catalog.revision)
      throw new ConversationError(
        409,
        "Project scope changed. Refresh before writing.",
      );
    const project = catalog.projects.find((item) => item.id === id);
    if (!project)
      throw new ConversationError(
        404,
        "This project is not in the hearth catalog.",
      );
    if (project.archived)
      throw new ConversationError(
        409,
        "This project is archived. Unarchive it before writing.",
      );
    if (
      workspaceKey(snapshot.source.workspace) !==
        workspaceKey(options.workspace) ||
      !project.workspaces.some(
        (scope) => workspaceKey(scope.root) === workspaceKey(options.workspace),
      )
    )
      throw new ConversationError(
        409,
        "This hearth does not serve this project's workspace.",
      );
    if (snapshot.source.issues === null)
      throw new ConversationError(
        503,
        "The current project bead scope is unavailable. Refresh before writing.",
      );
    return {
      project,
      members: selectProjectBeads(
        project,
        options.workspace,
        snapshot.source.issues,
      ),
    };
  };
  const chosen = options.routes.filter(
    (row): row is ActionRoute =>
      row.kind === "action" &&
      [
        "bead.create",
        "bead.claim",
        "bead.comment",
        "bead.close",
        "queue.propose",
      ].includes(row.action),
  );
  return chosen.map((row) => {
    const create = row.action === "bead.create";
    return {
      kind: "action",
      method: "POST",
      path: `/projects/:id${row.path.replace(":id", ":beadId").replace("/queue/", "/beads/")}`,
      action: row.action,
      ...(row.maxBodyBytes !== undefined
        ? { maxBodyBytes: row.maxBodyBytes }
        : {}),
      validate(request) {
        const projectId = request.params["id"];
        if (!isProjectId(projectId)) return fail("Expected a project id.");
        const parsed = row.validate({
          ...request,
          params: { id: request.params["beadId"] ?? "" },
        });
        return parsed.ok
          ? {
              ok: true,
              value: { projectId, input: parsed.value, body: request.body },
            }
          : parsed;
      },
      subject: ({ input }) => row.subject(input),
      async effect({ projectId, input, body }, context): Promise<RouteReply> {
        try {
          const { project, members } = await current(projectId);
          const target = row.subject(input).beadId;
          if (create) {
            if (
              !target ||
              !members.some(
                (item) => item.id === target && item.type === "epic",
              )
            )
              return {
                status: 409,
                error:
                  "Choose a parent epic in this project's current scope before creating a bead.",
              };
            if (!isRecord(body))
              return { status: 400, error: "Expected create fields." };
            const labels = Array.isArray(body["labels"])
              ? body["labels"].filter(
                  (item): item is string => typeof item === "string",
                )
              : [];
            const projectLabel = `project:${project.slug}`;
            if (
              labels.some(
                (label) =>
                  label.startsWith("project:") && label !== projectLabel,
              )
            )
              return {
                status: 409,
                error:
                  "A new bead cannot carry another project's membership label.",
              };
            const prepared = row.validate({
              params: {},
              query: new URLSearchParams(),
              headers: {},
              body: {
                ...body,
                labels: [...new Set([...labels, projectLabel])],
              },
            });
            if (!prepared.ok) return { status: 400, error: prepared.error };
            input = prepared.value;
          } else if (!target || !members.some((item) => item.id === target)) {
            return {
              status: 404,
              error: "This bead is outside the current project scope.",
            };
          }
          const answer = await row.effect(input, context);
          if ("error" in answer) return answer;
          if (
            !isRecord(answer.data) ||
            !isBeadId(answer.data["id"]) ||
            (!create && answer.data["id"] !== target)
          )
            return {
              status: 504,
              error:
                "The tracker did not confirm the selected bead and action. Check the bead before trying again.",
            };
          if (create) {
            const id = answer.data["id"];
            try {
              const after = await current(projectId);
              if (
                !after.members.some(
                  (item) => item.id === id && item.parent === target,
                )
              )
                throw Error("Unconfirmed ancestry");
            } catch {
              return {
                status: 504,
                error: `Created ${id}, but its current project ancestry and membership could not be confirmed. Check this bead before doing anything else; do not create it again.`,
              };
            }
          }
          return answer;
        } catch (error) {
          if (
            error instanceof ConversationError ||
            error instanceof ProjectStoreError
          )
            return { status: error.status, error: error.message };
          throw error;
        }
      },
    };
  });
}
