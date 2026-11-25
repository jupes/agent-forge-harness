import { expect, test } from "bun:test";
import type { CodexOwnedSessionRecord } from "../../types/codex-owned-task";
import type { SessionSummary } from "../../types/hearth";
import type { ProjectCatalog } from "../../types/projects";
import {
  type BdExportRow,
  issuesAndDepsFromExportRows,
} from "../beads-dashboard";
import { projectWorkMap } from "./project-work-map";
import { projectWorkMapSchema } from "./project-work-map-protocol";
import type { ProjectSources } from "./summary";
import { projectFixture } from "./testing";

const project = projectFixture("/fixture");
const baseCatalog: ProjectCatalog = {
  version: 1,
  revision: 0,
  projects: [project],
};
const at = "2026-11-25T12:00:00Z";

function bead(
  id: string,
  parent: string | null,
  fields: Partial<BdExportRow> & { notes?: string } = {},
): BdExportRow {
  return {
    id,
    title: id,
    status: "open",
    issue_type: parent ? "task" : "epic",
    updated_at: at,
    created_at: at,
    labels: ["project:alpha"],
    dependencies: parent
      ? [{ issue_id: id, depends_on_id: parent, type: "parent-child" }]
      : [],
    ...fields,
  };
}

function fromRows(beadRows: BdExportRow[]): ProjectSources {
  const { issues, deps } = issuesAndDepsFromExportRows(beadRows);
  return {
    workspace: "/fixture",
    asOf: at,
    issues,
    dependencies: deps,
    beadRows,
    queue: [],
    sessions: [],
    sessionsComplete: true,
    problems: [],
  };
}

test("working now needs a live, identity-bound turn and observation from that turn", () => {
  const beadId = "task-a";
  const owned: CodexOwnedSessionRecord = {
    id: "session-00000000-0000-4000-8000-000000000001",
    projectId: project.id,
    requestId: "00000000-0000-4000-8000-000000000002",
    requestHash: "a".repeat(64),
    createdAt: at,
    workspace: "/fixture",
    repository: "/fixture",
    worktree: "/fixture/tree",
    beadId,
    mode: "task",
    provider: "codex",
    smith: "coding",
    requestedModel: "model",
    requestedEffort: null,
  };
  const observation: SessionSummary = {
    sessionId: owned.id,
    workspace: owned.workspace,
    worktree: owned.worktree,
    beadId,
    startedAt: at,
    lastEventAt: at,
  };
  const source: ProjectSources = {
    ...fromRows([
      bead("alpha-epic", null),
      bead(beadId, "alpha-epic", { status: "in_progress" }),
    ]),
    ownedSessions: [owned],
    sessions: [observation],
    queue: [
      {
        beadId,
        title: "Task",
        status: "in_progress",
        state: "running",
        backed: true,
      },
    ],
  };
  const phase = (input: ProjectSources, since?: number) =>
    projectWorkMap(baseCatalog, input, () => since).beads.find(
      (node) => node.id === beadId,
    )?.workState;
  const time = Date.parse(at);
  expect(phase(source, time)).toBe("working");
  expect(phase(source)).toBe("in_progress");
  expect(phase(source, time + 1)).toBe("in_progress");
  expect(
    phase({ ...source, sessions: [{ ...observation, endedAt: at }] }, time),
  ).toBe("in_progress");
  expect(
    phase(
      { ...source, sessions: [{ ...observation, worktree: "/foreign-tree" }] },
      time,
    ),
  ).toBe("in_progress");
  expect(phase({ ...source, ownedSessions: [] }, time)).toBe("in_progress");
  expect(
    phase(
      { ...source, ownedSessions: [{ ...owned, repository: "/foreign" }] },
      time,
    ),
  ).toBe("in_progress");
});

test("epic anchors and exact memberships retain a full shared graph beyond the old per-project cap", () => {
  const second = {
    ...project,
    id: "project-00000000-0000-4000-8000-000000000003",
    slug: "beta",
    name: "Beta",
  };
  const catalog = { ...baseCatalog, projects: [project, second] };
  const children = Array.from({ length: 1200 }, (_, index) =>
    bead(`task-${index}`, "nested", {
      labels:
        index === 0 ? ["project:alpha", "project:beta"] : ["project:alpha"],
    }),
  );
  const source = fromRows([
    bead("alpha-epic", null, { labels: [] }),
    bead("private-intermediary", "alpha-epic", { labels: [] }),
    bead("nested", "private-intermediary", { issue_type: "epic" }),
    ...children,
  ]);
  const map = projectWorkMap(catalog, source, () => undefined);
  expect(projectWorkMapSchema.safeParse(map).success).toBe(true);
  expect(map.beads).toHaveLength(1201);
  expect(map.epics).toContainEqual({
    id: "nested",
    parentId: "alpha-epic",
    title: "nested",
    projectId: project.id,
  });
  expect(map.epics.filter((epic) => epic.id === "alpha-epic")).toHaveLength(2);
  expect(map.beads.find((item) => item.id === "task-0")?.memberships).toEqual([
    { projectId: project.id, epicId: "nested" },
    { projectId: second.id, epicId: "alpha-epic" },
  ]);
  expect(JSON.stringify(map)).not.toContain("private-intermediary");
});

test("source loss keeps the catalog and delivery only comes from explicit, safe completed outcomes", () => {
  const source = fromRows([
    bead("alpha-epic", null),
    bead("done", "alpha-epic", {
      status: "closed",
      notes: "Private detail\nDelivered: Added keyboard navigation.",
    }),
    bead("planned", "alpha-epic", { notes: "Delivered: Not finished." }),
    bead("private-path", "alpha-epic", {
      status: "closed",
      notes: "Delivered: Built at C:\\Private\\build.",
    }),
    bead("deferred", "alpha-epic", { status: "deferred" }),
  ]);
  const map = projectWorkMap(baseCatalog, source, () => undefined);
  expect(
    map.beads.map(({ id, status, workState, delivery }) => [
      id,
      status,
      workState,
      delivery,
    ]),
  ).toEqual([
    ["alpha-epic", "open", "ready", null],
    ["done", "closed", "completed", "Added keyboard navigation."],
    ["planned", "open", "ready", null],
    ["private-path", "closed", "completed", null],
    ["deferred", "deferred", "other", null],
  ]);
  expect(JSON.stringify(map)).not.toContain("Private detail");
  const unavailable = projectWorkMap(
    baseCatalog,
    { ...source, issues: null },
    () => undefined,
  );
  expect(unavailable.trackerAvailable).toBe(false);
  expect(unavailable.projects).toEqual([
    {
      id: project.id,
      name: project.name,
      archived: project.archived,
      availability: "unavailable",
    },
  ]);
  expect(unavailable.beads).toEqual([]);
  expect(unavailable.epics).toEqual([]);
});
