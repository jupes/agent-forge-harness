import type { LedgerEvent } from "../../../types/hearth";
import type { ProjectSessionObservations } from "../../../types/session-observations";
import { queryEventPage } from "../../ledger/query";
import { selectProjectBeads, workspaceKey } from "../../projects/scope";
import {
  observationSessionIdSchema,
  projectSessionObservationsSchema,
  sessionObservationDetailSchema,
  sessionObservedActivitySchema,
  sessionOwnershipMetadataSchema,
} from "../../projects/session-observations-protocol";
import { isProjectId, ProjectStoreError } from "../../projects/store";
import { summarizeProject } from "../../projects/summary";
import type { ReadRoute, RouteReply, RouteRequest } from "../api";
import type { ValidationResult } from "../validate";
import {
  fail,
  hearthLedger,
  noParameters,
  type ReadDeps,
} from "./operator-reads";
import type { ProjectSnapshot } from "./project-summaries";

class ObservationReadError extends Error {
  constructor(
    readonly status: 404 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}

const address = (request: RouteRequest): ValidationResult<string> => {
  const projectId = request.params["id"];
  return isProjectId(projectId)
    ? { ok: true as const, value: projectId }
    : fail("Expected a project id.");
};
async function answer(
  work: () => unknown | Promise<unknown>,
): Promise<RouteReply> {
  try {
    return { status: 200, data: await work() };
  } catch (error) {
    if (
      error instanceof ObservationReadError ||
      error instanceof ProjectStoreError
    )
      return { status: error.status, error: error.message };
    throw error;
  }
}

function activity(event: LedgerEvent) {
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new ObservationReadError(
      503,
      "The saved activity metadata is invalid. No conversation content was read.",
    );
  const base = { id: event.id, at: event.ts };
  let value: unknown;
  switch (event.kind) {
    case "session.started":
      value = { ...base, kind: event.kind };
      break;
    case "session.ended":
      value = {
        ...base,
        kind: event.kind,
        reason:
          "reason" in payload &&
          typeof payload.reason === "string" &&
          payload.reason
            ? payload.reason
            : null,
        durationMs: "durationMs" in payload ? payload.durationMs : null,
      };
      break;
    case "prompt.submitted":
      value = {
        ...base,
        kind: event.kind,
        length: "length" in payload ? payload.length : undefined,
      };
      break;
    case "tool.called":
      value = {
        ...base,
        kind: event.kind,
        tool: "tool" in payload ? payload.tool : undefined,
        durationMs: "durationMs" in payload ? payload.durationMs : null,
        exitCode: "exitCode" in payload ? payload.exitCode : null,
      };
      break;
    default:
      throw new ObservationReadError(
        503,
        "Unsupported activity metadata was returned. Refresh to check this session again.",
      );
  }
  const parsed = sessionObservedActivitySchema.safeParse(value);
  if (!parsed.success)
    throw new ObservationReadError(
      503,
      "The saved activity metadata is invalid or too large. No conversation content was read.",
    );
  return parsed.data;
}

/** Protected metadata only. This module has no journal, provider, process or mutation dependency. */
export function createSessionObservationRoutes(
  deps: ReadDeps,
  load: () => Promise<ProjectSnapshot>,
  query: typeof queryEventPage = queryEventPage,
) {
  const index = async (
    projectId: string,
  ): Promise<{
    metadata: ProjectSessionObservations;
    memberBeadIds: Set<string>;
  }> => {
    const snapshot = await load();
    const project = snapshot.catalog.projects.find(
      (item) => item.id === projectId,
    );
    if (!project)
      throw new ObservationReadError(
        404,
        "This project is not in the hearth catalog.",
      );
    const scope = project.workspaces.find(
      (item) => workspaceKey(item.root) === workspaceKey(deps.workspace),
    );
    if (
      !scope ||
      workspaceKey(snapshot.source.workspace) !== workspaceKey(deps.workspace)
    )
      throw new ObservationReadError(
        409,
        "This hearth does not serve this project's workspace.",
      );
    const summary = summarizeProject(project, snapshot.source);
    const available = snapshot.source.ownedSessions !== undefined;
    const owned = (snapshot.source.ownedSessions ?? []).filter(
      (record) =>
        record.projectId === projectId &&
        workspaceKey(record.workspace) === workspaceKey(deps.workspace) &&
        scope.repositories.some(
          (path) => workspaceKey(path) === workspaceKey(record.repository),
        ),
    );
    const records = owned.map((record) => {
      const parsed = sessionOwnershipMetadataSchema.safeParse({
        record: Object.fromEntries(
          Object.entries(record).filter(([key]) => key !== "origin"),
        ),
        origin: "origin" in record ? record.origin : null,
      });
      if (!parsed.success)
        throw new ObservationReadError(
          503,
          "The saved ownership metadata is unsupported. Its history has been kept.",
        );
      return parsed.data;
    });
    const problems = summary.problems
      .slice(0, 29)
      .map((problem) => problem.slice(0, 2048));
    if (summary.problems.length > 29)
      problems.push(
        `${summary.problems.length - 29} additional source notices are omitted.`,
      );
    const parsed = projectSessionObservationsSchema.safeParse({
      projectId,
      workspace: deps.workspace,
      asOf: snapshot.source.asOf,
      observations: summary.sessions,
      observationsComplete: summary.sessionsComplete,
      ownership: available
        ? { available: true, records, reason: null }
        : {
            available: false,
            records: [],
            reason:
              "The private ownership index is unavailable. Previously verified app-owned history remains owned; other ownership cannot be confirmed.",
          },
      problems,
    });
    if (!parsed.success)
      throw new ObservationReadError(
        503,
        "The session metadata is invalid, unsupported or exceeds this view's limit. No private conversation was read.",
      );
    return {
      metadata: parsed.data,
      memberBeadIds: new Set(
        selectProjectBeads(
          project,
          deps.workspace,
          snapshot.source.issues ?? [],
        ).map((bead) => bead.id),
      ),
    };
  };
  const list: ReadRoute<string> = {
    kind: "read",
    method: "GET",
    path: "/projects/:id/session-observations",
    operatorOnly: true,
    validate: (request) => {
      const project = address(request),
        query = noParameters(request);
      return !project.ok ? project : !query.ok ? query : project;
    },
    read: (projectId) => answer(async () => (await index(projectId)).metadata),
  };
  const detail: ReadRoute<{
    projectId: string;
    sessionId: string;
    after: number;
    limit: number;
  }> = {
    kind: "read",
    method: "GET",
    path: "/projects/:id/session-observations/:sessionId",
    operatorOnly: true,
    validate: (request) => {
      const project = address(request);
      if (!project.ok) return project;
      const session = observationSessionIdSchema.safeParse(
        request.params["sessionId"],
      );
      if (!session.success) return fail("Expected a bounded session identity.");
      if (
        [...request.query.keys()].some(
          (key) =>
            !["after", "limit"].includes(key) ||
            request.query.getAll(key).length !== 1,
        )
      )
        return fail("Unsupported observation query.");
      const after = request.query.get("after") ?? "0",
        limit = request.query.get("limit") ?? "100";
      if (
        !/^\d+$/.test(after) ||
        !Number.isSafeInteger(Number(after)) ||
        !/^\d+$/.test(limit) ||
        Number(limit) < 1 ||
        Number(limit) > 100
      )
        return fail(
          "Expected a nonnegative activity cursor and page size from 1 to 100.",
        );
      return {
        ok: true,
        value: {
          projectId: project.value,
          sessionId: session.data,
          after: Number(after),
          limit: Number(limit),
        },
      };
    },
    read: (input) =>
      answer(async () => {
        const { metadata, memberBeadIds } = await index(input.projectId);
        const observation =
          metadata.observations.find(
            (row) => row.sessionId === input.sessionId,
          ) ?? null;
        const owner =
          metadata.ownership.records.find(
            (row) => row.record.id === input.sessionId,
          ) ?? null;
        // Membership is decided before the exact event query. A failed/partial
        // source is never proof that a previously known session did not exist.
        if (!observation && !owner)
          throw new ObservationReadError(
            metadata.observationsComplete && metadata.ownership.available
              ? 404
              : 503,
            metadata.observationsComplete && metadata.ownership.available
              ? "This session is not in this project's verified metadata."
              : "This session's project membership could not be verified. Refresh the session index before opening it.",
          );
        let page: ReturnType<typeof queryEventPage>;
        try {
          page = query(
            {
              workspace: deps.workspace,
              sessionId: input.sessionId,
              kinds: [
                "session.started",
                "session.ended",
                "prompt.submitted",
                "tool.called",
              ],
              afterId: input.after,
              limit: input.limit,
            },
            hearthLedger(deps.ledgerPath),
          );
        } catch {
          throw new ObservationReadError(
            503,
            "The session activity could not be read. Saved metadata is kept; refresh to try again.",
          );
        }
        const parentId = observation?.parentSessionId;
        const parent =
          parentId && parentId !== input.sessionId
            ? {
                id: parentId,
                available:
                  metadata.observations.some(
                    (row) => row.sessionId === parentId,
                  ) ||
                  metadata.ownership.records.some(
                    (row) => row.record.id === parentId,
                  ),
              }
            : null;
        const parsed = sessionObservationDetailSchema.safeParse({
          projectId: input.projectId,
          workspace: deps.workspace,
          asOf: metadata.asOf,
          sessionId: input.sessionId,
          observation,
          owner,
          ownershipAvailable: metadata.ownership.available,
          ownershipReason: metadata.ownership.reason,
          parent,
          after: input.after,
          nextAfter: page.events.at(-1)?.id ?? input.after,
          more: page.more,
          // A session may move between projects. Its address admits selection,
          // not another project's explicitly tagged activity. Advance the raw
          // cursor even across a fully suppressed page and preserve raw more.
          activity: page.events
            .filter(
              (event) =>
                event.beadId === undefined || memberBeadIds.has(event.beadId),
            )
            .map(activity),
          problems: metadata.problems,
        });
        if (!parsed.success)
          throw new ObservationReadError(
            503,
            "The scoped activity page could not be verified. Previously saved metadata has been kept.",
          );
        return parsed.data;
      }),
  };
  return { list, detail };
}
