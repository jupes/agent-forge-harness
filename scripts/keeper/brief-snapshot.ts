import type { LedgerEvent } from "../../types/hearth";
import type { KeeperBriefSnapshot } from "../../types/keeper-brief";
import type { ProjectRecord } from "../../types/projects";
import { buildDerivedFromIssuesAndDeps } from "../beads-dashboard";
import { ConversationError } from "../conversations/error";
import { selectProjectBeads, workspaceKey } from "../projects/scope";
import { type ProjectSources, summarizeProject } from "../projects/summary";
import {
  briefSnapshotSchema,
  MAX_BRIEF_SNAPSHOT_BYTES,
} from "./brief-protocol";

export { MAX_BRIEF_SNAPSHOT_BYTES } from "./brief-protocol";

type Fact = KeeperBriefSnapshot["facts"][number];
const time = (value: string | undefined): string | null =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;

/** Facts are selected before entering a prompt; titles and ids confer no authority. */
export function buildKeeperBriefSnapshot(
  project: ProjectRecord,
  catalogRevision: number,
  source: ProjectSources,
  history: { events: LedgerEvent[] | null; more: boolean },
  since?: string,
): KeeperBriefSnapshot {
  const scope = project.workspaces.find(
    (item) => workspaceKey(item.root) === workspaceKey(source.workspace),
  );
  if (!scope)
    throw new ConversationError(
      409,
      "This hearth does not serve this project's scope. No brief was accepted.",
    );
  const end = Date.parse(source.asOf);
  if (!Number.isFinite(end))
    throw new ConversationError(503, "The brief source time is unavailable.");
  const start =
    since && Number.isFinite(Date.parse(since))
      ? Math.min(end, Math.max(end - 30 * 86_400_000, Date.parse(since)))
      : end - 86_400_000;
  const summary = summarizeProject(project, source);
  const members = selectProjectBeads(
    project,
    source.workspace,
    source.issues ?? [],
  );
  const ids = new Set(members.map((item) => item.id));
  const queue = (source.queue ?? []).filter(
    (item) => item.backed && ids.has(item.beadId),
  );
  const events = (history.events ?? [])
    .filter(
      (item) =>
        workspaceKey(item.workspace) === workspaceKey(source.workspace) &&
        item.beadId !== undefined &&
        ids.has(item.beadId) &&
        Date.parse(item.ts) >= start &&
        Date.parse(item.ts) <= end,
    )
    .sort((a, b) => b.id - a.id);
  const blocked = new Set(
    buildDerivedFromIssuesAndDeps(
      source.issues ?? [],
      source.dependencies ?? [],
    ).blocked.map((item) => item.id),
  );
  const limitations = [
    ...summary.problems.map((item) => item.slice(0, 500)),
    "Runs are observations from this checkout only; other worktrees are not searched.",
  ];
  if (!source.sessionsComplete)
    limitations.push(
      "Session observations are unavailable or limited to the newest 500 workspace sessions. Running state is not established by an observation.",
    );
  if (source.queue === null)
    limitations.push("The backed queue source is unavailable.");
  if (history.events === null)
    limitations.push("Recorded activity is unavailable.");
  if (history.more)
    limitations.push(
      "Activity is bounded to the newest 10,000 workspace events; older movement may be omitted.",
    );
  if (scope.epicIds.length > 8)
    limitations.push(
      "Only eight epic ids are displayed; the full saved epic scope still controls membership.",
    );
  if (since && Date.parse(since) < start)
    limitations.push(
      "Movement history is limited to thirty days after the previous brief.",
    );
  const snapshot: KeeperBriefSnapshot = {
    version: 1,
    projectId: project.id,
    projectName: project.name,
    workspace: source.workspace,
    catalogRevision,
    asOf: new Date(end).toISOString(),
    since: new Date(start).toISOString(),
    scope: {
      label: `project:${project.slug}`,
      epicIds: scope.epicIds.slice(0, 8),
      epicCount: scope.epicIds.length,
      repositoryCount: scope.repositories.length,
    },
    observed: {
      beads: source.issues === null ? null : members.length,
      queue: source.queue === null ? null : queue.length,
      sessions:
        !source.sessionsComplete && !summary.sessions.length
          ? null
          : summary.sessions.length,
      runs: source.runs === undefined ? null : summary.runs.length,
      activity: history.events === null ? null : events.length,
    },
    complete: false,
    limitations: [...new Set(limitations)].slice(0, 15),
    facts: [],
  };
  const candidates: Fact[] = [
    ...queue
      .filter((item) => item.state === "review" || item.state === "proposed")
      .map((item) => ({
        section: "waiting" as const,
        object: { kind: "bead" as const, id: item.beadId },
        title: item.title,
        state: `queue:${item.state}`,
        at: null,
      })),
    ...queue
      .filter((item) => item.state === "halted")
      .map((item) => ({
        section: "stuck" as const,
        object: { kind: "bead" as const, id: item.beadId },
        title: item.title,
        state: "queue:halted",
        at: null,
      })),
    ...members
      .filter(
        (item) =>
          item.status !== "closed" &&
          (item.status === "blocked" || blocked.has(item.id)),
      )
      .map((item) => ({
        section: "stuck" as const,
        object: { kind: "bead" as const, id: item.id },
        title: item.title,
        state: "bead:blocked",
        at: time(item.updatedAt),
      })),
    ...events
      .filter(
        (item) =>
          item.kind === "bead.transitioned" ||
          item.kind === "run.phase.completed" ||
          item.kind === "session.started" ||
          item.kind === "session.ended",
      )
      .map((item) => ({
        section: "moving" as const,
        object: { kind: "event" as const, id: String(item.id) },
        title: `${item.kind} · ${item.beadId}`,
        state:
          item.kind === "bead.transitioned" && "action" in item.payload
            ? `bead:${item.payload.action}`
            : item.kind,
        at: time(item.ts),
      })),
    ...summary.runs.map((item) => ({
      section: item.halted
        ? ("stuck" as const)
        : item.reviewPending
          ? ("waiting" as const)
          : ("context" as const),
      object: { kind: "run" as const, id: item.slug },
      title: item.feature ?? item.slug,
      state: item.halted
        ? "run:halted"
        : item.reviewPending
          ? `run:review:${item.reviewPending}`
          : `run:${item.phase}`,
      at: time(item.updatedAt),
    })),
    ...summary.sessions.slice(0, 8).map((item) => ({
      section: "context" as const,
      object: { kind: "session" as const, id: item.sessionId },
      title: item.beadId ?? item.sessionId,
      state: item.endedAt
        ? "session:ended-observation"
        : "session:observation-running-unknown",
      at: time(item.lastEventAt),
    })),
    ...members
      .sort(
        (a, b) =>
          b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
      )
      .map((item) => ({
        section: "context" as const,
        object: { kind: "bead" as const, id: item.id },
        title: item.title,
        state: `bead:${item.status}`,
        at: time(item.updatedAt),
      })),
  ];
  for (const item of candidates) {
    const fact = {
      ...item,
      title: item.title.slice(0, 140),
      state: item.state.slice(0, 120),
    };
    snapshot.facts.push(fact);
    if (
      snapshot.facts.length > 40 ||
      Buffer.byteLength(JSON.stringify(snapshot)) >
        MAX_BRIEF_SNAPSHOT_BYTES - 180
    ) {
      snapshot.facts.pop();
      snapshot.limitations.push(
        "Brief facts are bounded by count and bytes; additional records were omitted.",
      );
      break;
    }
  }
  const parsed = briefSnapshotSchema.safeParse(snapshot);
  if (!parsed.success)
    throw new ConversationError(
      503,
      "The scoped brief snapshot is unavailable or exceeds its size limit. No turn was accepted.",
    );
  return parsed.data;
}
