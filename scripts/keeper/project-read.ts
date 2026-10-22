import type { LedgerEvent } from "../../types/hearth";
import type { KeeperReadQuery, KeeperReadResult } from "../../types/keeper";
import type { ProjectRecord } from "../../types/projects";
import { ConversationError } from "../conversations/error";
import { selectProjectBeads, workspaceKey } from "../projects/scope";
import { type ProjectSources, summarizeProject } from "../projects/summary";
import { parseKeeperReadQuery } from "./protocol";

export { parseKeeperReadQuery } from "./protocol";

export interface KeeperHistory {
  events: LedgerEvent[] | null;
  more: boolean;
}
export const MAX_KEEPER_READ_BYTES = 48_000;

/** Closed readonly queries. Neither paths nor session reuse can grant project membership. */
export function readKeeperProject(
  project: ProjectRecord,
  catalogRevision: number,
  source: ProjectSources,
  history: KeeperHistory,
  input: KeeperReadQuery,
): KeeperReadResult {
  const query = parseKeeperReadQuery(input);
  const summary = summarizeProject(project, source);
  const members = selectProjectBeads(
    project,
    source.workspace,
    source.issues ?? [],
  );
  const ids = new Set(members.map((bead) => bead.id));
  const scope = project.workspaces.find(
    (item) => workspaceKey(item.root) === workspaceKey(source.workspace),
  );
  let complete = summary.complete;
  let reason: string | null = complete
    ? null
    : summary.problems.join(" ") || "Project membership is unavailable.";
  let rows: { id: string; data: unknown }[];
  let sourceName: string;
  switch (query.kind) {
    case "beads":
      sourceName = query.id
        ? "Scoped tracker bead details"
        : "Scoped tracker bead index (metadata)";
      rows = members.map((bead) => ({
        id: bead.id,
        data: query.id
          ? bead
          : {
              id: bead.id,
              title: bead.title,
              type: bead.type,
              status: bead.status,
              parent: bead.parent,
              priority: bead.priority,
              labels: bead.labels,
              updatedAt: bead.updatedAt,
            },
      }));
      break;
    case "queue":
      sourceName = "Scoped backed queue metadata";
      complete &&= source.queue !== null;
      if (source.queue === null) reason = "The queue read is unavailable.";
      rows = (source.queue ?? [])
        .filter((row) => row.backed && ids.has(row.beadId))
        .map((row) => ({ id: row.beadId, data: row }));
      break;
    case "sessions":
      sourceName = "Scoped ledger session observations (metadata)";
      complete &&= source.sessionsComplete;
      if (!source.sessionsComplete)
        reason =
          "Only the newest 500 observations may be available, or the session source could not be read. Running state and transcript bodies are not supplied by this source.";
      rows = summary.sessions.map((row) => ({ id: row.sessionId, data: row }));
      break;
    case "runs":
      sourceName = "Scoped checkout run observations (metadata)";
      complete = false;
      reason =
        "Only the served checkout is observed. Other worktrees are not searched; artifact bodies are not included.";
      rows = summary.runs.map((row) => ({ id: row.slug, data: row }));
      break;
    case "activity":
      sourceName = "Hearth-recorded scoped activity (metadata)";
      complete &&= history.events !== null && !history.more;
      if (history.events === null) reason = "Recorded activity is unavailable.";
      else if (history.more)
        reason =
          "Only the newest 10,000 workspace events were read. Older project activity may be absent.";
      rows = (history.events ?? [])
        .filter(
          (event) =>
            workspaceKey(event.workspace) === workspaceKey(source.workspace) &&
            event.beadId !== undefined &&
            ids.has(event.beadId) &&
            Date.parse(event.ts) <= Date.parse(source.asOf),
        )
        .map((event) => ({ id: String(event.id), data: event }));
      break;
  }
  rows.sort((a, b) =>
    query.kind === "activity"
      ? Number(b.id) - Number(a.id)
      : a.id.localeCompare(b.id),
  );
  if (query.id) {
    rows = rows.filter((row) => row.id === query.id);
    if (!rows.length)
      throw new ConversationError(
        404,
        "This object is unavailable in this project's scoped read.",
      );
  }
  const after = query.after ?? 0;
  const scopeData: KeeperReadResult["scope"] = {
    projectId: project.id,
    name: project.name,
    slug: project.slug,
    catalogRevision,
    workspace: source.workspace,
    repositories: scope?.repositories ?? [],
    epicIds: scope?.epicIds ?? [],
    repositoryCount: scope?.repositories.length ?? 0,
    epicCount: scope?.epicIds.length ?? 0,
    detailsComplete: Boolean(scope),
    detailsReason: scope ? null : "This workspace's scope is unavailable.",
    label: `project:${project.slug}`,
    unavailableWorkspaces: project.workspaces.filter(
      (item) => workspaceKey(item.root) !== workspaceKey(source.workspace),
    ).length,
  };
  if (Buffer.byteLength(JSON.stringify(scopeData)) > 8000) {
    scopeData.repositories = [];
    scopeData.epicIds = [];
    scopeData.detailsComplete = false;
    scopeData.detailsReason =
      "Scope path/id details exceed the reader size limit and were omitted; the full saved scope still controls membership.";
  }
  if (!scopeData.detailsComplete) {
    complete = false;
    reason = [reason, scopeData.detailsReason].filter(Boolean).join(" ");
  }
  const header = {
    scope: scopeData,
    kind: query.kind,
    mode: query.id ? "detail" : "index",
    source: sourceName,
    asOf: source.asOf,
    complete,
    reason,
    records: [],
    totalKnown: complete ? rows.length : null,
    nextCursor: null,
  };
  const candidates = rows.slice(after, after + (query.limit ?? 50));
  const records: KeeperReadResult["records"] = [];
  let bytes = Buffer.byteLength(JSON.stringify(header)) + 1024;
  const recordCapacity = MAX_KEEPER_READ_BYTES - bytes;
  for (const row of candidates) {
    let record = { ...row, truncated: false };
    let size = Buffer.byteLength(JSON.stringify(record));
    if (size > recordCapacity) {
      record = {
        id: row.id,
        data: {
          unavailable:
            "This record exceeds the bounded reader size. Its details were omitted.",
        },
        truncated: true,
      };
      size = Buffer.byteLength(JSON.stringify(record));
    }
    if (records.length && bytes + size + 2 > MAX_KEEPER_READ_BYTES) break;
    bytes += size + 2;
    records.push(record);
  }
  if (records.some((row) => row.truncated)) {
    complete = false;
    reason = [
      reason,
      "One or more record details exceed the reader size limit and were omitted.",
    ]
      .filter(Boolean)
      .join(" ");
  }
  const next = after + records.length;
  return {
    scope: scopeData,
    kind: query.kind,
    mode: query.id ? "detail" : "index",
    source: sourceName,
    asOf: source.asOf,
    complete,
    reason,
    records,
    totalKnown: complete ? rows.length : null,
    nextCursor: next < rows.length ? next : null,
  };
}
