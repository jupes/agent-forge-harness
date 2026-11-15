import { expect, test } from "bun:test";
import { resolveDeepLink } from "./deep-link";
import { readDeepLinkIndex } from "./deep-link-reader";

const alpha = "project-015821b4-4b38-4bf3-9326-71ce9c09ff46";
const beta = "project-f05a117f-8d19-4906-80f0-75d72835f3e8";
const workspace = "/workspace",
  stamp = "2026-10-23T17:00:00.000Z";
const project = (id = alpha) => ({
  id,
  archived: false,
  workspaces: [
    { root: workspace, repositories: [workspace], epicIds: ["epic"] },
  ],
});
const home = (projects = [project()], revision = 7) => ({
  catalog: { version: 1, revision, projects },
});

test("project activation reads and rechecks only the protected catalog", async () => {
  const reads: string[] = [];
  const target = { kind: "project", id: alpha } as const;
  const data = await readDeepLinkIndex({
    target,
    workspace,
    signal: new AbortController().signal,
    read: async (path) => {
      reads.push(path);
      return home();
    },
  });
  expect(reads).toEqual(["/projects/summary", "/projects/summary"]);
  expect(resolveDeepLink(target, data)).toEqual({
    state: "ready",
    route: { projectId: alpha, destination: "overview", selection: null },
  });
});

const bead = (id: string) => ({
  id,
  title: id,
  type: "task",
  status: "open",
  priority: 2,
  parent: null,
  assignee: null,
  owner: null,
  labels: [],
  createdAt: stamp,
  updatedAt: stamp,
  due: null,
  description: "",
  acceptanceCriteria: "",
  estimate: null,
  spent: null,
  ready: true,
  blocked: false,
  blockers: [],
  unavailableBlockers: 0,
  queue: null,
  smith: null,
  comments: [],
  commentsComplete: true,
  detailsLoaded: false,
});
const beads = (projectId = alpha, ids = ["actual-child"]) => ({
  projectId,
  workspace,
  asOf: stamp,
  complete: true,
  problems: [],
  beads: ids.map(bead),
  dependencies: [],
});
const sessions = (projectId = alpha) => ({
  projectId,
  workspace,
  asOf: stamp,
  observations: [{ sessionId: "observed", workspace, lastEventAt: stamp }],
  observationsComplete: true,
  ownership: {
    available: true,
    reason: null,
    records: [
      {
        origin: null,
        record: {
          projectId,
          id: "session-78d55e8f-4521-40bc-a45a-cd8e68e575ae",
          requestId: "825f49e8-14b5-46d2-80f5-a143ae120bed",
          requestHash: "a".repeat(64),
          createdAt: stamp,
          workspace,
          repository: workspace,
          worktree: workspace,
          provider: "claude",
          mode: "chat",
          smith: "claude-journeyman",
          requestedModel: "sonnet",
          requestedEffort: null,
        },
      },
    ],
  },
  problems: [],
});

test("bead links use complete scoped pages, never an id prefix or unrelated session read", async () => {
  const paths: string[] = [];
  const target = { kind: "bead", id: "actual-child" } as const;
  const data = await readDeepLinkIndex({
    target,
    workspace,
    signal: new AbortController().signal,
    read: async (path) => {
      paths.push(path);
      return path === "/projects/summary" ? home() : beads();
    },
  });
  expect(paths).toEqual([
    "/projects/summary",
    "/projects/" + alpha + "/beads",
    "/projects/summary",
  ]);
  expect(resolveDeepLink(target, data)).toEqual({
    state: "ready",
    route: {
      projectId: alpha,
      destination: "beads",
      selection: { kind: "bead", id: "actual-child" },
    },
  });
});

test("session links union actual owned and observed metadata without reading private activity", async () => {
  const paths: string[] = [];
  const data = await readDeepLinkIndex({
    target: { kind: "session", id: "observed" },
    workspace,
    signal: new AbortController().signal,
    read: async (path) => {
      paths.push(path);
      return path === "/projects/summary" ? home() : sessions();
    },
  });
  expect(paths).toEqual([
    "/projects/summary",
    "/projects/" + alpha + "/session-observations",
    "/projects/summary",
  ]);
  expect(data.projects[0]?.sessions.ids).toEqual([
    "observed",
    "session-78d55e8f-4521-40bc-a45a-cd8e68e575ae",
  ]);
  expect(resolveDeepLink({ kind: "session", id: "observed" }, data).state).toBe(
    "ready",
  );
  expect(
    resolveDeepLink(
      { kind: "session", id: "session-78d55e8f-4521-40bc-a45a-cd8e68e575ae" },
      data,
    ).state,
  ).toBe("ready");
});

test("wrong project, wrong workspace and partial object replies cannot establish ownership", async () => {
  const target = { kind: "bead", id: "actual-child" } as const;
  for (const reply of [
    { ...beads(), projectId: beta },
    { ...beads(), workspace: "/foreign" },
    { ...beads(), complete: false },
    { ...beads(), problems: ["tracker unavailable"] },
  ]) {
    const data = await readDeepLinkIndex({
      target,
      workspace,
      signal: new AbortController().signal,
      read: async (path) => (path === "/projects/summary" ? home() : reply),
    });
    expect(resolveDeepLink(target, data)).toEqual({
      state: "blocked",
      reason: "unavailable",
    });
  }
});

test("unavailable ownership or ledger metadata is not a missing session", async () => {
  const target = { kind: "session", id: "observed" } as const;
  for (const reply of [
    { ...sessions(), observationsComplete: false },
    {
      ...sessions(),
      ownership: {
        available: false,
        records: [],
        reason: "registry unavailable",
      },
    },
    { ...sessions(), projectId: beta },
    { ...sessions(), workspace: "/foreign" },
  ]) {
    const data = await readDeepLinkIndex({
      target,
      workspace,
      signal: new AbortController().signal,
      read: async (path) => (path === "/projects/summary" ? home() : reply),
    });
    expect(resolveDeepLink(target, data)).toEqual({
      state: "blocked",
      reason: "unavailable",
    });
  }
});

test("foreign project metadata is not read and prevents a false unique object owner", async () => {
  const foreign = {
    ...project(beta),
    workspaces: [
      { root: "/foreign", repositories: ["/foreign"], epicIds: ["other"] },
    ],
  };
  const paths: string[] = [];
  const target = { kind: "bead", id: "actual-child" } as const;
  const data = await readDeepLinkIndex({
    target,
    workspace,
    signal: new AbortController().signal,
    read: async (path) => {
      paths.push(path);
      return path === "/projects/summary"
        ? home([project(), foreign])
        : beads();
    },
  });
  expect(paths).not.toContain("/projects/" + beta + "/beads");
  expect(resolveDeepLink(target, data)).toEqual({
    state: "blocked",
    reason: "unavailable",
  });
});

test("catalog revision or scope changes fence object results before navigation", async () => {
  const target = { kind: "bead", id: "actual-child" } as const;
  for (const changed of [
    home([project()], 8),
    home([{ ...project(), archived: true }]),
    home([
      {
        ...project(),
        workspaces: [
          { root: workspace, repositories: ["/other"], epicIds: ["epic"] },
        ],
      },
    ]),
  ]) {
    let catalogReads = 0;
    await expect(
      readDeepLinkIndex({
        target,
        workspace,
        signal: new AbortController().signal,
        read: async (path) =>
          path === "/projects/summary"
            ? ++catalogReads === 1
              ? home()
              : changed
            : beads(),
      }),
    ).rejects.toThrow("catalog changed");
  }
});

test("aborted activation issues no later object or catalog request", async () => {
  const controller = new AbortController();
  const paths: string[] = [];
  await expect(
    readDeepLinkIndex({
      target: { kind: "bead", id: "actual-child" },
      workspace,
      signal: controller.signal,
      read: async (path) => {
        paths.push(path);
        controller.abort();
        return home();
      },
    }),
  ).rejects.toThrow();
  expect(paths).toEqual(["/projects/summary"]);
});

test("object lookup never exceeds four concurrent reads and a failed source remains incomplete", async () => {
  const projects = Array.from({ length: 9 }, (_, n) =>
    project("project-00000000-0000-4000-8000-" + String(n).padStart(12, "0")),
  );
  let active = 0,
    maximum = 0,
    objects = 0;
  const target = { kind: "bead", id: "actual-child" } as const;
  const data = await readDeepLinkIndex({
    target,
    workspace,
    signal: new AbortController().signal,
    read: async (path) => {
      if (path === "/projects/summary") return home(projects);
      objects++;
      active++;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      await Promise.resolve();
      active--;
      const id = path.split("/")[2];
      if (!id || id === projects[1]?.id)
        throw Error("private source unavailable");
      return beads(id, id === projects[0]?.id ? ["actual-child"] : []);
    },
  });
  expect(maximum).toBe(4);
  expect(active).toBe(0);
  expect(objects).toBe(9);
  expect(resolveDeepLink(target, data)).toEqual({
    state: "blocked",
    reason: "unavailable",
  });
});
