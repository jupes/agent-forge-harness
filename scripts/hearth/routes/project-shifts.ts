import { loadConfig } from "../../config/load";
import { ConversationError } from "../../conversations/error";
import { projectShiftOptions } from "../../projects/shift-options";
import { isProjectId, ProjectStoreError } from "../../projects/store";
import { isShiftId } from "../../scheduler/shift-store";
import {
  projectShiftStartSchema,
  shiftRequestIdSchema,
} from "../../shifts/protocol";
import { createProjectShiftService } from "../../shifts/service";
import type { ActionRoute, ApiRoute, ReadRoute, RouteReply } from "../api";
import type { ValidationResult } from "../validate";
import { localStateRoot } from "./dev-api";
import type { OperatorDeps } from "./operator";
import { bodyFields, fail, type ReadDeps } from "./operator-reads";
import type { ProjectSnapshot } from "./project-summaries";
import { shiftRoutes } from "./shifts";

/** Project-scoped defaults are read-only and cannot reserve or dispatch a shift. */
export function projectShiftOptionsRoute(
  deps: ReadDeps,
  load: () => Promise<ProjectSnapshot>,
): ReadRoute<string> {
  return {
    kind: "read",
    method: "GET",
    path: "/projects/:id/shifts/options",
    operatorOnly: true,
    validate(request) {
      if ([...request.query.keys()].length)
        return fail("Shift options take no query parameters.");
      const id = request.params["id"];
      return isProjectId(id)
        ? { ok: true, value: id }
        : fail("Expected a project id.");
    },
    async read(id) {
      try {
        const snapshot = await load();
        const project = snapshot.catalog.projects.find(
          (item) => item.id === id,
        );
        if (!project)
          return {
            status: 404,
            error: "This project is not in the hearth catalog.",
          };
        let loaded: ReturnType<typeof loadConfig>;
        try {
          loaded = loadConfig({
            harnessRoot: deps.root,
            env: {},
            ...(deps.configHome !== undefined ? { home: deps.configHome } : {}),
          });
        } catch {
          throw new ConversationError(
            503,
            "Current shift defaults could not be verified. Refresh before starting a shift.",
          );
        }
        return {
          status: 200,
          data: projectShiftOptions(
            project,
            snapshot.source,
            loaded,
            snapshot.catalog.revision,
          ),
        };
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
}

/** Project facade over the existing audited shift effects. A registry reservation is never a running shift. */
export function projectShiftRoutes(
  deps: OperatorDeps,
  load: () => Promise<ProjectSnapshot>,
) {
  const service = createProjectShiftService({
    home: deps.projectHome,
    root: deps.root,
    async validateStart(projectId, request) {
      const snapshot = await load(),
        project = snapshot.catalog.projects.find(
          (item) => item.id === projectId,
        );
      if (!project)
        throw new ConversationError(
          404,
          "This project is not in the hearth catalog.",
        );
      if (project.archived)
        throw new ConversationError(
          409,
          "This project is archived. Existing owned shift controls remain available.",
        );
      if (request.expectedCatalogRevision !== snapshot.catalog.revision)
        throw new ConversationError(
          409,
          "The project catalog changed. Review the current shift options before starting.",
        );
      const loaded = loadConfig({
        harnessRoot: deps.root,
        env: {},
        ...(deps.configHome !== undefined ? { home: deps.configHome } : {}),
      });
      const choices = projectShiftOptions(
        project,
        snapshot.source,
        loaded,
        snapshot.catalog.revision,
      );
      if (
        request.options.epic !== undefined &&
        !choices.epics.some((epic) => epic.id === request.options.epic)
      )
        throw new ConversationError(
          409,
          "The reviewed epic is not an epic in the current project scope.",
        );
      if (
        request.options.smith !== undefined &&
        !choices.smiths.names.includes(request.options.smith)
      )
        throw new ConversationError(
          409,
          "The reviewed smith is no longer enabled.",
        );
    },
  });
  const canonical = shiftRoutes({
    workspace: deps.workspace,
    shiftsDir: deps.shiftsDir,
    runBd: deps.runBd,
    ledgerPath: deps.ledgerPath,
    appendEvent: deps.appendEvent,
    lockFile: deps.queueLockFile,
    mainCheckout: localStateRoot(deps.root),
    starts: deps.shiftStarts,
  });
  const reply = async (
    work: () => RouteReply | Promise<RouteReply>,
  ): Promise<RouteReply> => {
    try {
      return await work();
    } catch (error) {
      if (
        error instanceof ConversationError ||
        error instanceof ProjectStoreError
      )
        return { status: error.status, error: error.message };
      return {
        status: 503,
        error:
          "The original project shift outcome could not be verified. Check the original request before trying anything else.",
      };
    }
  };
  const projectId = (
    request: Parameters<ReadRoute["validate"]>[0],
  ): ValidationResult<string> => {
    if ([...request.query.keys()].length)
      return fail("Project shift reads take no query parameters.");
    return isProjectId(request.params["id"])
      ? { ok: true, value: request.params["id"] }
      : fail("Expected a project id.");
  };
  const list: ReadRoute<string> = {
    kind: "read",
    method: "GET",
    path: "/projects/:id/shifts",
    operatorOnly: true,
    validate: projectId,
    read: (id) => reply(() => ({ status: 200, data: service.list(id) })),
  };
  const original: ReadRoute<{ projectId: string; requestId: string }> = {
    kind: "read",
    method: "GET",
    path: "/projects/:id/shifts/requests/:requestId",
    operatorOnly: true,
    validate(request) {
      const id = projectId(request);
      if (!id.ok) return id;
      const uuid = shiftRequestIdSchema.safeParse(request.params["requestId"]);
      return uuid.success
        ? { ok: true, value: { projectId: id.value, requestId: uuid.data } }
        : fail("Expected the original Start request UUID.");
    },
    read: ({ projectId, requestId }) =>
      reply(() => ({ status: 200, data: service.read(projectId, requestId) })),
  };
  const start: ActionRoute<{
    projectId: string;
    request: import("../../../types/project-shifts").ProjectShiftStartRequest;
  }> = {
    kind: "action",
    method: "POST",
    path: "/projects/:id/shifts",
    action: "shift.start",
    validate(request) {
      const id = projectId(request);
      if (!id.ok) return id;
      const parsed = projectShiftStartSchema.safeParse(request.body);
      return parsed.success
        ? { ok: true, value: { projectId: id.value, request: parsed.data } }
        : fail("Expected a strict full reviewed shift Start request.");
    },
    subject: (input) => ({ target: input.request.requestId }),
    effect: ({ projectId, request }) =>
      reply(async () => ({
        status: 202,
        data: await service.start(projectId, request),
      })),
  };
  const controls = (["stop", "recover"] as const).map(
    (control): ActionRoute<{ projectId: string; shiftId: string }> => {
      const route = canonical.find(
        (row) => row.kind === "action" && row.path === `/shifts/:id/${control}`,
      );
      if (!route || route.kind !== "action")
        throw Error("Missing canonical shift control");
      return {
        kind: "action",
        method: "POST",
        path: `/projects/:id/shifts/:shiftId/${control}`,
        action: route.action,
        validate(request) {
          const id = projectId(request),
            body = bodyFields(request, []);
          if (!id.ok) return id;
          if (!body.ok) return body;
          const shiftId = request.params["shiftId"];
          return isShiftId(shiftId)
            ? { ok: true, value: { projectId: id.value, shiftId } }
            : fail("Expected a shift id.");
        },
        subject: ({ shiftId }) => ({ target: shiftId }),
        effect: (input, context) =>
          reply(async () => {
            const original = service.authorizeControl(
              input.projectId,
              input.shiftId,
            );
            const result = await route.effect(input.shiftId, context);
            if ("error" in result)
              return {
                status: result.status,
                error: `The original shift ${control} did not complete. Read this original request to check its current state; no new launch will be made.`,
              };
            // Recovery's legacy response contains its full record. Only the correlated, bounded metadata crosses this facade.
            return {
              status: result.status,
              data: service.read(
                input.projectId,
                original.intent.request.requestId,
              ),
            };
          }),
      };
    },
  );
  return {
    routes: [list, original, start, ...controls] as ApiRoute[],
    close: () => service.close(),
  };
}
