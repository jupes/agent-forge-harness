import { expect, test } from "bun:test";
import type { BeadsIssue } from "../../types/beads";
import type { OwnedSessionRecord } from "../../types/owned-session";
import { summarizeProject } from "./summary";
import { projectFixture } from "./testing";

const project = projectFixture("/fixture");

test("explicit owned-session membership admits a bead-free session only to its recorded project and workspace", () => {
  const owned: OwnedSessionRecord = {
    id: "session-00000000-0000-4000-8000-000000000001",
    projectId: project.id,
    requestId: "00000000-0000-4000-8000-000000000002",
    requestHash: "a".repeat(64),
    createdAt: project.createdAt,
    workspace: "/fixture",
    repository: "/fixture",
    worktree: "/fixture",
    mode: "chat",
    provider: "claude",
    smith: "coding",
    requestedModel: "sonnet",
    requestedEffort: null,
  };
  const observed = {
    sessionId: owned.id,
    workspace: "/fixture",
    lastEventAt: project.createdAt,
  };
  const source = {
    workspace: "/fixture",
    asOf: project.createdAt,
    issues: [bead("alpha-epic")],
    queue: [],
    sessions: [observed, { ...observed, sessionId: "unregistered" }],
    sessionsComplete: true,
    problems: [],
    ownedSessions: [owned],
  };
  expect(summarizeProject(project, source).sessions).toEqual([observed]);
  expect(
    summarizeProject(project, {
      ...source,
      ownedSessions: [{ ...owned, projectId: "foreign" }],
    }).sessions,
  ).toEqual([]);
  expect(
    summarizeProject(project, {
      ...source,
      ownedSessions: [{ ...owned, workspace: "/elsewhere" }],
    }).sessions,
  ).toEqual([]);
  expect(
    summarizeProject(project, {
      ...source,
      ownedSessions: [{ ...owned, repository: "/elsewhere" }],
    }).sessions,
  ).toEqual([]);
  expect(
    summarizeProject(project, {
      ...source,
      sessions: [{ ...observed, beadId: "foreign" }],
    }).sessions,
  ).toEqual([]);
  expect(
    summarizeProject(project, {
      ...source,
      sessions: [{ ...observed, runId: "foreign-run" }],
    }).sessions,
  ).toEqual([]);
});
const bead = (id: string, parent?: string): BeadsIssue => ({
  id,
  title: id,
  type: parent ? "task" : "epic",
  status: "open",
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
  labels: ["project:alpha"],
  ...(parent ? { parent } : {}),
});

test("project summaries join only member beads and backed queue entries in this workspace", () => {
  const summary = summarizeProject(project, {
    workspace: "/fixture",
    asOf: project.createdAt,
    issues: [bead("alpha-epic"), bead("a", "alpha-epic"), bead("foreign")],
    queue: [
      {
        beadId: "a",
        title: "A",
        state: "proposed",
        status: "open",
        backed: true,
      },
      {
        beadId: "foreign",
        title: "F",
        state: "halted",
        status: "open",
        backed: true,
      },
      {
        beadId: "alpha-epic",
        title: "E",
        state: "running",
        status: "open",
        backed: false,
      },
    ],
    sessions: [],
    sessionsComplete: true,
    problems: [],
  });
  expect(summary.beads?.open).toBe(2);
  expect(summary.queue?.proposed).toBe(1);
  expect(summary.queue?.running).toBe(0);
  expect(summary.queue?.halted).toBe(0);
  expect(summary.needsYou.map((item) => item.beadId)).toEqual(["a"]);
  expect(summary.complete).toBe(true);
});

test("missing epics and unserved workspaces are unavailable, never empty totals", () => {
  const source = {
    workspace: "/fixture",
    asOf: project.createdAt,
    issues: [],
    queue: [],
    sessions: [],
    sessionsComplete: true,
    problems: [],
  };
  expect(summarizeProject(project, source).beads).toBeNull();
  expect(summarizeProject(project, source).complete).toBe(false);
  const multi = {
    ...project,
    workspaces: [
      ...project.workspaces,
      { root: "/elsewhere", repositories: ["/elsewhere"], epicIds: ["beta"] },
    ],
  };
  const summary = summarizeProject(multi, {
    ...source,
    issues: [bead("alpha-epic")],
  });
  expect(summary.queue).toBeNull();
  expect(summary.problems.join(" ")).toContain("Other project workspaces");
});

test("session membership needs both the workspace and a member bead, and retains observed identity", () => {
  const session = {
    sessionId: "own",
    workspace: "/fixture",
    beadId: "a",
    lastEventAt: "2026-10-22T00:00:00.000Z",
    executor: { provider: "codex", model: "fixture-model" },
  };
  const summary = summarizeProject(project, {
    workspace: "/fixture",
    asOf: session.lastEventAt,
    issues: [bead("alpha-epic"), bead("a", "alpha-epic")],
    queue: [],
    sessions: [
      session,
      { ...session, sessionId: "foreign", workspace: "/elsewhere" },
      { ...session, sessionId: "unbound", beadId: "other" },
    ],
    sessionsComplete: false,
    problems: [],
  });
  expect(summary.sessions).toEqual([session]);
  expect(summary.sessionsComplete).toBe(false);
  expect(summary.lastActivity).toBe(session.lastEventAt);
});
