import { type LedgerEvent, PROVIDER_USAGE_COUNTS } from "../../../types/hearth";
import type {
  ProjectActivityEvent,
  ProjectActivityFilters,
} from "../../../types/project-activity";
import { queryEventPage } from "../../ledger/query";
import {
  activityRowAssignments,
  activitySessionMembership,
  hasActivitySessionMembership,
} from "../../projects/activity-membership";
import {
  MAX_ACTIVITY_PAGE_EVENTS,
  projectActivityDetailSchema,
  projectActivityFiltersSchema,
  projectActivityPageSchema,
} from "../../projects/activity-protocol";
import { selectProjectBeads, workspaceKey } from "../../projects/scope";
import { isProjectId, ProjectStoreError } from "../../projects/store";
import { summarizeProject } from "../../projects/summary";
import type { ReadRoute, RouteReply, RouteRequest } from "../api";
import { safeMessage } from "../api";
import type { ValidationResult } from "../validate";
import { fail, hearthLedger, type ReadDeps } from "./operator-reads";
import type { ProjectSnapshot } from "./project-summaries";

class ActivityReadError extends Error {
  constructor(
    readonly status: 404 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}

/** Explicit allowlist: never spread ledger payloads (some kinds contain opt-in bodies). */
function eventMetadata(event: LedgerEvent): ProjectActivityEvent {
  const metadata: ProjectActivityEvent["metadata"] = [];
  const add = (key: string, value: string | number | boolean | undefined) => {
    if (value !== undefined) metadata.push({ key, value });
  };
  let summary: string = event.kind;
  switch (event.kind) {
    case "session.started":
      summary = "Session started";
      add("kind", event.payload.kind);
      break;
    case "session.ended":
      summary = "Session ended";
      add("reason", event.payload.reason);
      add("durationMs", event.payload.durationMs);
      for (const key of PROVIDER_USAGE_COUNTS)
        add(key, event.payload.usage?.[key]);
      add("costUsd", event.payload.usage?.costUsd);
      break;
    case "prompt.submitted":
      summary = "Prompt submitted";
      add("length", event.payload.length);
      add("hash", event.payload.hash);
      break;
    case "tool.called":
      summary = event.payload.tool;
      add("tool", event.payload.tool);
      add("durationMs", event.payload.durationMs);
      add("exitCode", event.payload.exitCode);
      break;
    case "gate.ran":
      summary = `Gate ${event.payload.passed ? "passed" : "failed"}: ${event.payload.gate}`;
      add("gate", event.payload.gate);
      add("passed", event.payload.passed);
      add("durationMs", event.payload.durationMs);
      add("exitCode", event.payload.exitCode);
      add("trigger", event.payload.trigger);
      break;
    case "verdict.bound":
      summary = `Verdict: ${event.payload.verdict}`;
      add("verdict", event.payload.verdict);
      if (event.payload.verdictArtifact) {
        add("artifactPath", event.payload.verdictArtifact.path);
        add("artifactHash", event.payload.verdictArtifact.sha256);
        add("artifactBytes", event.payload.verdictArtifact.bytes);
      }
      break;
    case "run.phase.entered":
    case "run.phase.completed":
      summary = `Phase ${event.kind === "run.phase.entered" ? "started" : "completed"}: ${event.payload.phase}`;
      add("phase", event.payload.phase);
      if (event.kind === "run.phase.completed")
        add("artifact", event.payload.artifact);
      break;
    case "review.recorded":
      summary = `Review ${event.payload.verdict}: ${event.payload.phase}`;
      add("phase", event.payload.phase);
      add("round", event.payload.round);
      add("verdict", event.payload.verdict);
      for (const key of ["blocker", "high", "medium", "low"] as const)
        add(key, event.payload.findings[key]);
      add("action", event.payload.action);
      break;
    case "bead.transitioned":
      if ("action" in event.payload && event.payload.action !== undefined) {
        summary = `Bead ${event.payload.action} recorded`;
        add("action", event.payload.action);
        add("hash", event.payload.hash);
        add("length", event.payload.length);
        add("smith", event.payload.smith);
      } else {
        summary = `Queue: ${event.payload.from ?? "none"} → ${event.payload.to}`;
        if (event.payload.from) add("from", event.payload.from);
        add("to", event.payload.to);
        add("reason", event.payload.reason);
      }
      break;
    case "reservation.acquired":
    case "reservation.released":
      summary =
        event.kind === "reservation.acquired"
          ? "Reservation acquired"
          : "Reservation released";
      add("worktree", event.payload.worktree);
      add("globsCount", event.payload.globs.length);
      if (event.payload.globs.length)
        add("globs", event.payload.globs.join(", "));
      break;
    case "shift.started":
      summary = "Shift start recorded";
      add("shiftId", event.payload.shiftId);
      add("concurrency", event.payload.concurrency);
      add("durationMs", event.payload.durationMs);
      add("maxBeads", event.payload.maxBeads);
      add("maxUsd", event.payload.maxUsd);
      break;
    case "shift.stopped":
      summary = `Shift stopped: ${event.payload.reason}`;
      add("shiftId", event.payload.shiftId);
      add("reason", event.payload.reason);
      break;
    case "council.run.started":
      summary = "Council start recorded";
      add("councilRunId", event.payload.councilRunId);
      add("profile", event.payload.profile);
      add("budgetUsd", event.payload.budgetUsd);
      break;
    case "council.run.finished":
      summary = `Council finished: ${event.payload.outcome}`;
      add("councilRunId", event.payload.councilRunId);
      add("outcome", event.payload.outcome);
      add("costUsd", event.payload.costUsd);
      if (event.payload.findings)
        for (const key of ["blocker", "high", "medium", "low"] as const)
          add(key, event.payload.findings[key]);
      break;
    case "council.verdict.comment":
      summary = `Council comment: ${event.payload.status}`;
      add("councilRunId", event.payload.councilRunId);
      add("status", event.payload.status);
      break;
    case "friction.recorded":
      summary = "Friction recorded";
      add("frictionBeadId", event.payload.frictionBeadId);
      add("causeEventUlid", event.payload.causeEventUlid);
      break;
    case "operator.action":
      summary = `Operator action: ${event.payload.action}`;
      add("action", event.payload.action);
      add("surface", event.payload.surface);
      add("target", event.payload.target);
      break;
  }
  return {
    id: event.id,
    ulid: event.ulid,
    at: event.ts,
    kind: event.kind,
    actor: event.executor
      ? {
          provider: event.executor.provider,
          model: event.executor.model,
          effort: event.executor.effort ?? null,
          smith: event.executor.smith ?? null,
        }
      : null,
    beadId: event.beadId ?? null,
    sessionId: event.sessionId ?? null,
    runId: event.runId ?? null,
    summary,
    metadata,
  };
}

type PageQuery = {
  projectId: string;
  after: number;
  limit: number;
  filters: ProjectActivityFilters;
};
function pageQuery(request: RouteRequest): ValidationResult<PageQuery> {
  const projectId = request.params["id"];
  if (!isProjectId(projectId)) return fail("Expected a project id.");
  const params = new Map<string, string>();
  const allowed = [
    "after",
    "limit",
    "kind",
    "provider",
    "bead",
    "session",
    "run",
    "shift",
    "since",
    "until",
  ];
  for (const [key, value] of request.query) {
    if (!allowed.includes(key) || params.has(key))
      return fail("Activity parameters must be known and given once.");
    params.set(key, value);
  }
  const after = params.get("after") ?? "0";
  const limit = params.get("limit") ?? "100";
  if (
    !/^\d{1,15}$/.test(after) ||
    !Number.isSafeInteger(Number(after)) ||
    !/^\d{1,3}$/.test(limit) ||
    Number(limit) < 1 ||
    Number(limit) > MAX_ACTIVITY_PAGE_EVENTS
  )
    return fail("Expected a valid Activity cursor and limit from 1 to 200.");
  const filters = projectActivityFiltersSchema.safeParse({
    kinds: params.has("kind") ? params.get("kind")?.split(",") : [],
    provider: params.get("provider") ?? null,
    beadId: params.get("bead") ?? null,
    sessionId: params.get("session") ?? null,
    runId: params.get("run") ?? null,
    shiftId: params.get("shift") ?? null,
    since: params.get("since") ?? null,
    until: params.get("until") ?? null,
  });
  return filters.success
    ? {
        ok: true,
        value: {
          projectId,
          after: Number(after),
          limit: Number(limit),
          filters: filters.data,
        },
      }
    : fail("Activity filters or time range are invalid.");
}

async function answer(
  work: () => unknown | Promise<unknown>,
): Promise<RouteReply> {
  try {
    return { status: 200, data: await work() };
  } catch (error) {
    if (
      error instanceof ActivityReadError ||
      error instanceof ProjectStoreError
    )
      return { status: error.status, error: error.message };
    return {
      status: 503,
      error: `Activity could not be read: ${safeMessage(error)}. Earlier saved events remain available; refresh to check again.`,
    };
  }
}

/** Protected project metadata. This module cannot load a private journal or dispatch a provider. */
export function createProjectActivityRoutes(
  deps: ReadDeps,
  load: () => Promise<ProjectSnapshot>,
  query: typeof queryEventPage = queryEventPage,
) {
  const membership = async (projectId: string) => {
    const snapshot = await load();
    const project = snapshot.catalog.projects.find(
      (item) => item.id === projectId,
    );
    if (!project)
      throw new ActivityReadError(
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
      throw new ActivityReadError(
        409,
        "This hearth does not serve this project's workspace.",
      );
    if (
      snapshot.source.issues === null ||
      scope.epicIds.some(
        (id) =>
          !snapshot.source.issues?.some(
            (issue) => issue.id === id && issue.type === "epic",
          ),
      )
    )
      throw new ActivityReadError(
        503,
        "Project membership is unavailable or incomplete. Refresh Activity after the tracker can be read.",
      );
    const beads = new Set(
      selectProjectBeads(project, deps.workspace, snapshot.source.issues).map(
        (issue) => issue.id,
      ),
    );
    const summary = summarizeProject(project, snapshot.source);
    const sessions = new Set(
      summary.sessions.map((session) => session.sessionId),
    );
    hearthLedger(deps.ledgerPath);
    const linked = activitySessionMembership(
      deps.workspace,
      [...beads],
      deps.ledgerPath,
    );
    for (const sessionId of linked.sessions) sessions.add(sessionId);
    const owned = new Map<string, string | null>();
    for (const record of snapshot.source.ownedSessions ?? []) {
      if (
        record.projectId === projectId &&
        workspaceKey(record.workspace) === workspaceKey(deps.workspace) &&
        scope.repositories.some(
          (repo) => workspaceKey(repo) === workspaceKey(record.repository),
        )
      ) {
        sessions.add(record.id);
        owned.set(record.id, record.beadId ?? null);
      }
    }
    const runs = new Set(summary.runs.map((run) => run.slug));
    const eligible = (
      rows: readonly LedgerEvent[],
      beadFilter: string | null = null,
    ) => {
      const assignments = activityRowAssignments(
        deps.workspace,
        rows.flatMap((event) =>
          event.beadId === undefined &&
          event.sessionId !== undefined &&
          !owned.has(event.sessionId)
            ? [{ id: event.id, sessionId: event.sessionId }]
            : [],
        ),
        deps.ledgerPath,
      );
      return rows.filter((event) => {
        if (workspaceKey(event.workspace) !== workspaceKey(deps.workspace))
          return false;
        if (event.beadId !== undefined)
          return (
            beads.has(event.beadId) &&
            (!beadFilter || event.beadId === beadFilter)
          );
        if (event.sessionId !== undefined && owned.has(event.sessionId))
          return !beadFilter || owned.get(event.sessionId) === beadFilter;
        const assignment = assignments.get(event.id);
        if (assignment !== undefined && assignment !== null)
          return (
            beads.has(assignment) && (!beadFilter || assignment === beadFilter)
          );
        if (event.sessionId !== undefined) return false;
        return (
          !beadFilter && event.runId !== undefined && runs.has(event.runId)
        );
      });
    };
    return {
      snapshot,
      eligible,
      beads,
      sessions,
      runs,
      runsComplete: snapshot.source.runs !== undefined && summary.complete,
      complete:
        summary.complete &&
        summary.sessionsComplete &&
        snapshot.source.ownedSessions !== undefined &&
        linked.complete,
    };
  };
  const list: ReadRoute<PageQuery> = {
    kind: "read",
    operatorOnly: true,
    method: "GET",
    path: "/projects/:id/activity",
    validate: pageQuery,
    read: ({ projectId, after, limit, filters }) =>
      answer(async () => {
        const scope = await membership(projectId);
        if (filters.beadId && !scope.beads.has(filters.beadId))
          throw new ActivityReadError(
            404,
            "This bead is not in the current project membership.",
          );
        if (
          filters.sessionId &&
          !scope.sessions.has(filters.sessionId) &&
          !hasActivitySessionMembership(
            deps.workspace,
            [...scope.beads],
            filters.sessionId,
            deps.ledgerPath,
          )
        )
          throw new ActivityReadError(
            scope.complete ? 404 : 503,
            scope.complete
              ? "This session is not in the current project membership."
              : "Session membership is incomplete. This address could not be verified; refresh after its sources are available.",
          );
        if (filters.runId && !scope.runs.has(filters.runId))
          throw new ActivityReadError(
            scope.runsComplete ? 404 : 503,
            scope.runsComplete
              ? "This run is not in the current project membership."
              : "Run membership is incomplete. This run could not be verified; refresh after its source is available.",
          );
        const page = query(
          {
            workspace: deps.workspace,
            afterId: after,
            limit,
            ...(filters.sessionId ? { sessionId: filters.sessionId } : {}),
            ...(filters.runId ? { runId: filters.runId } : {}),
            ...(filters.kinds.length ? { kinds: filters.kinds } : {}),
            ...(filters.since ? { since: filters.since } : {}),
          },
          hearthLedger(deps.ledgerPath),
        );
        const events = scope
          .eligible(page.events, filters.beadId)
          .filter(
            (event) =>
              (!filters.provider ||
                event.executor?.provider === filters.provider) &&
              (!filters.sessionId || event.sessionId === filters.sessionId) &&
              (!filters.runId || event.runId === filters.runId) &&
              (!filters.shiftId ||
                ("shiftId" in event.payload &&
                  event.payload.shiftId === filters.shiftId)) &&
              (!filters.until ||
                Date.parse(event.ts) <= Date.parse(filters.until)),
          )
          .map(eventMetadata);
        const parsed = projectActivityPageSchema.safeParse({
          projectId,
          workspace: deps.workspace,
          asOf: scope.snapshot.source.asOf,
          filters,
          after,
          nextAfter: page.events.at(-1)?.id ?? after,
          more: page.more,
          events,
          membershipComplete: scope.complete,
          problems: scope.snapshot.source.problems,
        });
        if (!parsed.success)
          throw new ActivityReadError(
            503,
            "Activity metadata is invalid or exceeds its safe read limit. Earlier events were retained; narrow the filters and refresh.",
          );
        return parsed.data;
      }),
  };
  const detail: ReadRoute<{ projectId: string; eventId: number }> = {
    kind: "read",
    operatorOnly: true,
    method: "GET",
    path: "/projects/:id/activity/:eventId",
    validate: (request) => {
      const projectId = request.params["id"];
      const id = request.params["eventId"] ?? "";
      if (
        !isProjectId(projectId) ||
        !/^\d{1,15}$/.test(id) ||
        Number(id) < 1 ||
        !Number.isSafeInteger(Number(id)) ||
        [...request.query].length
      )
        return fail("Expected one Activity event id and no query parameters.");
      return { ok: true, value: { projectId, eventId: Number(id) } };
    },
    read: ({ projectId, eventId }) =>
      answer(async () => {
        const scope = await membership(projectId);
        const event = query(
          { workspace: deps.workspace, afterId: eventId - 1, limit: 1 },
          hearthLedger(deps.ledgerPath),
        ).events[0];
        if (
          !event ||
          event.id !== eventId ||
          scope.eligible([event]).length !== 1
        )
          throw new ActivityReadError(
            404,
            "This event is unavailable in the current project Activity.",
          );
        const parsed = projectActivityDetailSchema.safeParse({
          projectId,
          workspace: deps.workspace,
          asOf: scope.snapshot.source.asOf,
          event: eventMetadata(event),
        });
        if (!parsed.success)
          throw new ActivityReadError(
            503,
            "The selected event metadata is invalid or too large.",
          );
        return parsed.data;
      }),
  };
  return { list, detail };
}
