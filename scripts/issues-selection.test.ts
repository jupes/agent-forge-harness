import { describe, expect, test } from "bun:test";
import { applyInitiativeFilter, computeInitiativeMembers, listEpics } from "../docs/js/issues-selection.mjs";
import type { BeadsIssue } from "../types/beads";

const issues: BeadsIssue[] = [
  {
    id: "epic-1",
    type: "epic",
    title: "E",
    status: "open",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
  {
    id: "task-1",
    type: "task",
    title: "T",
    status: "open",
    parent: "epic-1",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
  {
    id: "task-2",
    type: "task",
    title: "Other",
    status: "open",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
];

describe("issues-selection", () => {
  test("listEpics returns only epics sorted by title", () => {
    const epics = listEpics(issues);
    expect(epics.map((e) => e.id)).toEqual(["epic-1"]);
  });

  test("computeInitiativeMembers includes epic and descendants", () => {
    const m = computeInitiativeMembers(issues, "epic-1");
    expect(m.has("epic-1")).toBe(true);
    expect(m.has("task-1")).toBe(true);
    expect(m.has("task-2")).toBe(false);
  });

  test("applyInitiativeFilter narrows to initiative members", () => {
    const f = applyInitiativeFilter(issues, "epic-1");
    expect(f.map((i) => i.id).sort()).toEqual(["epic-1", "task-1"]);
  });

  test("applyInitiativeFilter all returns input", () => {
    expect(applyInitiativeFilter(issues, "all")).toEqual(issues);
  });
});
