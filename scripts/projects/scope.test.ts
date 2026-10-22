import { expect, test } from "bun:test";
import type { BeadsIssue } from "../../types/beads";
import type { ProjectRecord } from "../../types/projects";
import { selectProjectBeads } from "./scope";

const workspace =
  process.platform === "win32" ? "C:/fixture/harness" : "/fixture/harness";
const project: ProjectRecord = {
  id: "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
  slug: "alpha",
  name: "Alpha",
  description: "",
  icon: "A",
  pinned: false,
  archived: false,
  createdAt: "2026-10-21T00:00:00.000Z",
  updatedAt: "2026-10-21T00:00:00.000Z",
  workspaces: [
    {
      root: workspace,
      repositories: [`${workspace}/repos/one`, `${workspace}/repos/two`],
      epicIds: ["alpha", "alpha-feature"],
    },
  ],
};
const bead = (
  id: string,
  parent?: string,
  label = "project:alpha",
  repo = "one",
): BeadsIssue => ({
  id,
  title: id,
  type: id === "alpha" ? "epic" : "task",
  status: "open",
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
  labels: [label],
  repo,
  ...(parent ? { parent } : {}),
});

test("membership requires the workspace, explicit epic ancestry AND the project's exact label", () => {
  const issues = [
    bead("alpha"),
    bead("alpha-feature", "alpha"),
    bead("unrelated-id", "alpha-feature", "project:alpha", "two"),
    bead("alpha-prefix-is-not-parent"),
    bead("label-only"),
    bead("no-label", "alpha", ""),
    bead("other", "alpha", "project:beta"),
  ];
  expect(
    selectProjectBeads(project, workspace, issues).map((item) => item.id),
  ).toEqual(["alpha", "alpha-feature", "unrelated-id"]);
  expect(selectProjectBeads(project, `${workspace}/elsewhere`, issues)).toEqual(
    [],
  );
  const beta = {
    ...project,
    slug: "beta",
    workspaces: [
      {
        ...project.workspaces[0]!,
        root: workspace,
        repositories: [workspace],
        epicIds: ["beta"],
      },
    ],
  };
  expect(selectProjectBeads(beta, workspace, issues)).toEqual([]);
});

test("overlapping epics and duplicate rows count once; missing parents and cycles grant no membership", () => {
  const leaf = bead("leaf", "alpha-feature");
  const issues = [
    bead("alpha"),
    bead("alpha-feature", "alpha"),
    leaf,
    leaf,
    bead("cycle-a", "cycle-b"),
    bead("cycle-b", "cycle-a"),
    bead("orphan", "missing"),
  ];
  expect(
    selectProjectBeads(project, workspace, issues).map((item) => item.id),
  ).toEqual(["alpha", "alpha-feature", "leaf"]);
});

test("two disjoint projects keep two repositories in one project without leaking into the other", () => {
  const beta = {
    ...project,
    slug: "beta",
    workspaces: [
      { root: workspace, repositories: [workspace], epicIds: ["beta"] },
    ],
  };
  const issues = [
    bead("alpha"),
    bead("one", "alpha", "project:alpha", "one"),
    bead("two", "alpha", "project:alpha", "two"),
    { ...bead("beta", undefined, "project:beta"), type: "epic" as const },
    bead("beta-task", "beta", "project:beta", "one"),
  ];
  expect(
    selectProjectBeads(project, workspace, issues).map((item) => item.id),
  ).toEqual(["alpha", "one", "two"]);
  expect(
    selectProjectBeads(beta, workspace, issues).map((item) => item.id),
  ).toEqual(["beta", "beta-task"]);
});

test("conflicting duplicate ancestry cannot borrow another row's membership", () => {
  const issues = [
    bead("alpha"),
    bead("ambiguous", "alpha"),
    bead("ambiguous", "elsewhere"),
    bead("child", "ambiguous"),
  ];
  expect(
    selectProjectBeads(project, workspace, issues).map((item) => item.id),
  ).toEqual(["alpha"]);
});
