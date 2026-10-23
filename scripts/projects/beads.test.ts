import { expect, test } from "bun:test";
import type { BdExportRow } from "../beads-dashboard";
import { issuesAndDepsFromExportRows } from "../beads-dashboard";
import { projectBeads } from "./beads";
import { projectFixture } from "./testing";

const workspace = "/fixture/workspace";
function row(id: string, extra: Partial<BdExportRow> = {}): BdExportRow {
  return {
    id,
    title: id,
    issue_type: "task",
    status: "open",
    priority: 2,
    labels: ["project:alpha"],
    created_at: "2026-10-21T00:00:00.000Z",
    updated_at: "2026-10-21T00:00:00.000Z",
    dependencies:
      id === "alpha-epic"
        ? []
        : [{ issue_id: id, depends_on_id: "alpha-epic", type: "parent-child" }],
    ...extra,
  };
}
function page(rows: BdExportRow[]) {
  const normalized = issuesAndDepsFromExportRows(rows);
  return projectBeads(projectFixture(workspace), {
    workspace,
    asOf: "2026-10-23T00:00:00.000Z",
    issues: normalized.issues,
    dependencies: normalized.deps,
    beadRows: rows,
    queue: [],
    sessions: [],
    sessionsComplete: true,
    problems: [],
  });
}
const epic = row("alpha-epic", { issue_type: "epic" });
test("live project beads preserve P0–P4 and raw deferred status without treating creator as a claim", () => {
  const value = page([
    epic,
    ...[0, 1, 2, 3, 4].map((priority) =>
      row(`p${priority}`, { priority, owner: "creator" }),
    ),
    row("deferred", { status: "deferred" }),
    row("claimed", { assignee: "worker" }),
  ]);
  expect(
    value.beads
      .filter((item) => item.id.startsWith("p"))
      .map((item) => item.priority),
  ).toEqual([0, 1, 2, 3, 4]);
  expect(value.beads.find((item) => item.id === "p4")?.ready).toBe(true);
  expect(value.beads.find((item) => item.id === "deferred")).toMatchObject({
    status: "deferred",
    ready: false,
  });
  expect(value.beads.find((item) => item.id === "claimed")?.ready).toBe(false);
});
test("parent and related edges do not block, active blockers follow dependent→prerequisite direction", () => {
  const value = page([
    epic,
    row("ready", {
      dependencies: [
        {
          issue_id: "ready",
          depends_on_id: "alpha-epic",
          type: "parent-child",
        },
        { issue_id: "ready", depends_on_id: "closed", type: "requires" },
        { issue_id: "ready", depends_on_id: "active", type: "relates" },
      ],
    }),
    row("closed", { status: "closed" }),
    row("active"),
    row("blocked", {
      dependencies: [
        {
          issue_id: "blocked",
          depends_on_id: "alpha-epic",
          type: "parent-child",
        },
        { issue_id: "blocked", depends_on_id: "active", type: "blocks" },
      ],
    }),
  ]);
  expect(value.beads.find((item) => item.id === "ready")?.ready).toBe(true);
  expect(value.beads.find((item) => item.id === "blocked")).toMatchObject({
    ready: false,
    blockers: ["active"],
  });
  expect(value.beads.find((item) => item.id === "active")?.ready).toBe(true);
});
test("scope precedes projection; foreign blocker content is hidden and missing blockers are conservative", () => {
  const deps = (id: string, target: string) => [
    { issue_id: id, depends_on_id: "alpha-epic", type: "parent-child" },
    { issue_id: id, depends_on_id: target, type: "blocks" },
  ];
  const value = page([
    epic,
    row("foreign-secret", {
      title: "PRIVATE FOREIGN TITLE",
      labels: ["project:beta"],
    }),
    row("foreign-closed", { labels: ["project:beta"], status: "closed" }),
    row("blocked", { dependencies: deps("blocked", "foreign-secret") }),
    row("ready", { dependencies: deps("ready", "foreign-closed") }),
    row("missing", { dependencies: deps("missing", "not-in-export") }),
  ]);
  expect(value.beads.map((item) => item.id)).not.toContain("foreign-secret");
  expect(JSON.stringify(value)).not.toContain("PRIVATE FOREIGN TITLE");
  expect(JSON.stringify(value)).not.toContain("foreign-secret");
  expect(value.beads.find((item) => item.id === "blocked")).toMatchObject({
    ready: false,
    blockers: [],
    unavailableBlockers: 1,
  });
  expect(value.beads.find((item) => item.id === "ready")?.ready).toBe(true);
  expect(value.beads.find((item) => item.id === "missing")).toMatchObject({
    ready: false,
    unavailableBlockers: 1,
  });
});
test("details keep description and acceptance criteria separate and bound embedded comments", () => {
  const value = page([
    epic,
    row("detail", {
      description: "Exact description",
      acceptance_criteria: "- [ ] First\n- [x] Second",
      comment_count: 2,
      comments: [
        {
          text: "worklog: checked",
          author: "worker",
          created_at: "2026-10-22T00:00:00Z",
        },
      ],
    }),
  ]);
  expect(value.beads.find((item) => item.id === "detail")).toMatchObject({
    description: "Exact description",
    acceptanceCriteria: "- [ ] First\n- [x] Second",
    commentsComplete: false,
    comments: [
      {
        body: "worklog: checked",
        author: "worker",
        createdAt: "2026-10-22T00:00:00Z",
      },
    ],
  });
});
test("an unavailable tracker is refused instead of an empty project", () => {
  expect(() =>
    projectBeads(projectFixture(workspace), {
      workspace,
      asOf: "2026-10-23T00:00:00Z",
      issues: null,
      queue: null,
      sessions: [],
      sessionsComplete: false,
      problems: ["Tracker unavailable"],
    }),
  ).toThrow("tracker");
});
