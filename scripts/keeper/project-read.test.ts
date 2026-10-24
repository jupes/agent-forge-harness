import { expect, test } from "bun:test";
import type { BeadsIssue } from "../../types/beads";
import type { LedgerEvent } from "../../types/hearth";
import type { ProjectSources } from "../projects/summary";
import { projectFixture } from "../projects/testing";
import { MAX_KEEPER_READ_BYTES, readKeeperProject } from "./project-read";

const project = projectFixture("/served");
const bead = (
  id: string,
  parent?: string,
  label = "project:alpha",
): BeadsIssue => ({
  id,
  title: id,
  type: parent ? "task" : "epic",
  status: "open",
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
  labels: [label],
  ...(parent ? { parent } : {}),
  description: `Full details for ${id}`,
});
const source: ProjectSources = {
  workspace: "/served",
  asOf: "2026-10-22T12:00:00.000Z",
  issues: [
    bead("alpha-epic"),
    bead("member", "alpha-epic"),
    bead("foreign", "alpha-epic", "project:beta"),
    bead("unrelated", "another-epic"),
  ],
  queue: [],
  sessions: [],
  sessionsComplete: true,
  problems: [],
};

test("the Keeper reads a scoped index and details without label-only or foreign access", () => {
  const index = readKeeperProject(
    project,
    4,
    source,
    { events: [], more: false },
    { kind: "beads", limit: 1 },
  );
  expect(index.scope.projectId).toBe(project.id);
  expect(index.scope.catalogRevision).toBe(4);
  expect(index.records.map((row) => row.id)).toEqual(["alpha-epic"]);
  expect(index.mode).toBe("index");
  expect(index.nextCursor).toBe(1);
  expect(JSON.stringify(index.records)).not.toContain("Full details");
  const detail = readKeeperProject(
    project,
    4,
    source,
    { events: [], more: false },
    { kind: "beads", id: "member" },
  );
  expect(detail.mode).toBe("detail");
  expect(detail.records[0]?.data).toMatchObject({
    description: "Full details for member",
  });
  expect(() =>
    readKeeperProject(
      project,
      4,
      source,
      { events: [], more: false },
      { kind: "beads", id: "foreign" },
    ),
  ).toThrow("unavailable");
  expect(() =>
    readKeeperProject(
      project,
      4,
      source,
      { events: [], more: false },
      { kind: "beads", id: "unrelated" },
    ),
  ).toThrow("unavailable");
});

test("each activity event needs its own workspace and member-bead binding", () => {
  const event = (
    id: number,
    beadId?: string,
    workspace = "/served",
  ): LedgerEvent => ({
    id,
    ulid: `fixture-${id}`,
    kind: "prompt.submitted",
    workspace,
    ts: source.asOf,
    sessionId: "reused-session",
    ...(beadId ? { beadId } : {}),
    payload: { hash: "fixture-hash", length: 5 },
  });
  const result = readKeeperProject(
    project,
    4,
    source,
    {
      events: [
        event(1, "member"),
        event(2, "foreign"),
        event(3),
        event(4, "member", "/other"),
      ],
      more: true,
    },
    { kind: "activity" },
  );
  expect(result.records.map((row) => row.id)).toEqual(["1"]);
  expect(result.complete).toBe(false);
  expect(result.reason).toContain("10,000");
});

test("large scope metadata and details stay bounded and missing tracker data never becomes an empty complete project", () => {
  const firstScope = project.workspaces[0];
  if (!firstScope) throw new Error("Missing fixture scope");
  const largeProject = {
    ...project,
    workspaces: [
      {
        ...firstScope,
        repositories: Array.from(
          { length: 32 },
          (_, index) => `/repo-${index}/${"漢".repeat(525)}`,
        ),
      },
    ],
  };
  const largeSource = {
    ...source,
    issues: [
      bead("alpha-epic"),
      { ...bead("member", "alpha-epic"), description: "🌱".repeat(15_000) },
    ],
  };
  const bounded = readKeeperProject(
    largeProject,
    4,
    largeSource,
    { events: [], more: false },
    { kind: "beads", id: "member" },
  );
  expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(
    MAX_KEEPER_READ_BYTES,
  );
  expect(bounded.scope.detailsComplete).toBe(false);
  expect(bounded.records[0]?.truncated).toBe(true);
  expect(bounded.complete).toBe(false);
  const unavailable = readKeeperProject(
    project,
    4,
    { ...source, issues: null, problems: ["Tracker unavailable."] },
    { events: [], more: false },
    { kind: "beads" },
  );
  expect(unavailable.complete).toBe(false);
  expect(unavailable.totalKnown).toBeNull();
  expect(unavailable.reason).toContain("Tracker unavailable");
});

test("page pressure advances the cursor without discarding records that fit on a fresh page", () => {
  const many = {
    ...source,
    issues: [
      bead("alpha-epic"),
      ...Array.from({ length: 40 }, (_, index) => ({
        ...bead(`member-${index}`, "alpha-epic"),
        title: "Long title ".repeat(180),
      })),
    ],
  };
  const seen: string[] = [];
  let cursor: number | null = 0;
  do {
    const page = readKeeperProject(
      project,
      4,
      many,
      { events: [], more: false },
      { kind: "beads", after: cursor, limit: 100 },
    );
    expect(page.complete).toBe(true);
    expect(page.records.every((row) => !row.truncated)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
      MAX_KEEPER_READ_BYTES,
    );
    seen.push(...page.records.map((row) => row.id));
    cursor = page.nextCursor;
  } while (cursor !== null);
  expect(new Set(seen).size).toBe(41);
  expect(seen).toHaveLength(41);
});
