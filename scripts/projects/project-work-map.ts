import type { BeadsIssue } from "../../types/beads";
import type { QueueState } from "../../types/hearth";
import type {
  ProjectWorkMap,
  ProjectWorkMapBead,
  WorkMapState,
} from "../../types/project-work-map";
import type { ProjectCatalog, ProjectWorkspace } from "../../types/projects";
import type { BdExportRow } from "../beads-dashboard";
import { isBeadId } from "../hearth/tracker-write";
import { redactShown } from "../secret-patterns";
import { MAX_WORK_MAP_MEMBERSHIPS } from "./project-work-map-protocol";
import {
  selectProjectAnchors,
  selectProjectBeads,
  workspaceKey,
} from "./scope";
import type { ProjectSources } from "./summary";

export class ProjectWorkMapLimitError extends Error {
  constructor() {
    super(
      "The Work Map exceeds the local read limit. No project totals are reported from a partial map.",
    );
  }
}

function nearestEpic(
  parentId: string | undefined,
  epics: ReadonlyMap<string, BeadsIssue>,
  issues: ReadonlyMap<string, BeadsIssue>,
): string | null {
  const visited = new Set<string>();
  let id = parentId;
  while (id && !visited.has(id)) {
    if (epics.has(id)) return id;
    visited.add(id);
    id = issues.get(id)?.parent;
  }
  return null;
}

function display(value: string, fallback: string): string {
  return redactShown(value).text.trim() || fallback;
}

function delivered(row: BdExportRow | undefined): string | null {
  if (
    row?.status !== "closed" ||
    !("notes" in row) ||
    typeof row.notes !== "string"
  )
    return null;
  let delivery: string | null = null;
  for (const match of row.notes.matchAll(
    /^Delivered:[ \t]*([^\r\n]{1,280})$/gim,
  )) {
    const summary = match[1]?.trim();
    if (
      !summary ||
      /(?:^|[\s("'`])(?:[a-z]:[\\/]|\\\\|\/(?!\/))/i.test(summary)
    )
      continue;
    const clean = redactShown(summary);
    if (clean.redactions.length === 0) delivery = clean.text.trim() || null;
  }
  return delivery;
}

function workState(
  status: string,
  assignee: string | undefined,
  blocked: boolean,
  working: boolean,
): WorkMapState {
  if (status === "closed") return "completed";
  if (working) return "working";
  if (
    status === "blocked" ||
    (blocked && (status === "open" || status === "in_progress"))
  )
    return "blocked";
  if (status === "in_progress") return "in_progress";
  if (status === "open") return assignee?.trim() ? "not_started" : "ready";
  return "other";
}

function workingBeads(
  source: ProjectSources,
  scopes: ReadonlyMap<string, ProjectWorkspace>,
  membership: ReadonlyMap<string, ProjectWorkMapBead["memberships"]>,
  workingSince: (sessionId: string) => number | undefined,
): Set<string> {
  const workspace = workspaceKey(source.workspace);
  const owners = new Map(
    source.ownedSessions?.map((record) => [record.id, record]),
  );
  const working = new Set<string>();
  for (const session of source.sessions) {
    const {
      sessionId,
      beadId,
      startedAt,
      endedAt,
      runId,
      worktree,
      lastEventAt,
    } = session;
    if (
      !beadId ||
      !startedAt ||
      endedAt ||
      runId !== undefined ||
      !worktree ||
      workspaceKey(session.workspace) !== workspace
    )
      continue;
    const since = workingSince(sessionId);
    const seenAt = Date.parse(lastEventAt);
    if (since === undefined || !Number.isFinite(seenAt) || seenAt < since)
      continue;
    const owned = owners.get(sessionId);
    if (
      !owned ||
      owned.beadId !== beadId ||
      workspaceKey(owned.workspace) !== workspace ||
      workspaceKey(owned.worktree) !== workspaceKey(worktree) ||
      !membership
        .get(beadId)
        ?.some((member) => member.projectId === owned.projectId)
    )
      continue;
    const scope = scopes.get(owned.projectId);
    if (
      scope?.repositories.some(
        (repository) =>
          workspaceKey(repository) === workspaceKey(owned.repository),
      )
    )
      working.add(beadId);
  }
  return working;
}

/** Keep catalog nodes on source loss. Only current local memberships can contribute bead fields. */
export function projectWorkMap(
  catalog: ProjectCatalog,
  source: ProjectSources,
  workingSince: (sessionId: string) => number | undefined,
): ProjectWorkMap {
  const map: ProjectWorkMap = {
    asOf: source.asOf,
    trackerAvailable:
      source.issues !== null &&
      source.beadRows !== undefined &&
      source.dependencies !== undefined,
    sessionsComplete: source.sessionsComplete,
    projects: [],
    epics: [],
    beads: [],
    dependencies: [],
  };
  const workspace = workspaceKey(source.workspace);
  const issues = source.issues ?? [];
  const issueById = new Map(issues.map((issue) => [issue.id, issue]));
  const scopes = new Map<string, ProjectWorkspace>();
  const memberships = new Map<string, ProjectWorkMapBead["memberships"]>();
  const admittedEpicIds = new Set<string>();
  let membershipCount = 0;
  for (const { id, name, archived, ...project } of catalog.projects) {
    const entry: ProjectWorkMap["projects"][number] = {
      id,
      name: display(name, "Unnamed project"),
      archived,
      availability: "unavailable",
    };
    map.projects.push(entry);
    const scope = project.workspaces.find(
      (item) => workspaceKey(item.root) === workspace,
    );
    if (!map.trackerAvailable || !scope) continue;
    const anchors = selectProjectAnchors(project, source.workspace, issues);
    if (!anchors.length) continue;
    const anchorIds = new Set(anchors.map((anchor) => anchor.id));
    const selected = selectProjectBeads(project, source.workspace, issues);
    const members = selected.filter((issue) => isBeadId(issue.id));
    entry.availability =
      project.workspaces.length === 1 &&
      anchors.length === scope.epicIds.length &&
      members.length === selected.length
        ? "available"
        : "partial";
    scopes.set(id, scope);
    const epics = new Map(anchors.map((epic) => [epic.id, epic]));
    for (const member of members)
      if (member.type === "epic") epics.set(member.id, member);
    if (
      membershipCount + members.length > MAX_WORK_MAP_MEMBERSHIPS ||
      map.epics.length + epics.size > MAX_WORK_MAP_MEMBERSHIPS
    )
      throw new ProjectWorkMapLimitError();
    membershipCount += members.length;
    for (const epic of epics.values()) {
      admittedEpicIds.add(epic.id);
      map.epics.push({
        id: epic.id,
        projectId: id,
        title: display(epic.title, "Untitled epic"),
        parentId: anchorIds.has(epic.id)
          ? null
          : nearestEpic(epic.parent, epics, issueById),
      });
    }
    for (const member of members) {
      const membership = memberships.get(member.id) ?? [];
      membership.push({
        projectId: id,
        epicId: nearestEpic(member.id, epics, issueById),
      });
      memberships.set(member.id, membership);
    }
  }
  const raw = new Map(source.beadRows?.map((row) => [row.id, row]));
  const blocked = new Set<string>();
  for (const edge of source.dependencies ?? []) {
    if (!memberships.has(edge.from)) continue;
    if (edge.type !== "relates" && raw.get(edge.to)?.status !== "closed")
      blocked.add(edge.from);
    if (memberships.has(edge.to)) map.dependencies.push(edge);
  }
  const queue = new Map<string, QueueState>();
  for (const entry of source.queue ?? [])
    if (entry.backed) queue.set(entry.beadId, entry.state);
  const working = workingBeads(source, scopes, memberships, workingSince);
  for (const issue of issues) {
    const membership = memberships.get(issue.id);
    if (!membership) continue;
    const row = raw.get(issue.id);
    const status = row?.status ?? issue.status;
    map.beads.push({
      id: issue.id,
      title: display(issue.title, "Untitled bead"),
      type: issue.type,
      status: display(status, "unknown"),
      workState: workState(
        status,
        issue.assignee,
        blocked.has(issue.id),
        working.has(issue.id),
      ),
      memberships: membership,
      parentId:
        issue.parent &&
        (memberships.has(issue.parent) || admittedEpicIds.has(issue.parent))
          ? issue.parent
          : null,
      updatedAt: issue.updatedAt,
      delivery: delivered(row),
      queue: queue.get(issue.id) ?? null,
    });
  }
  return map;
}
