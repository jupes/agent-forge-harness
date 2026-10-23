import { expect, test } from "bun:test";
import {
  beadGroups,
  epicProgress,
  filterBeads,
  newBeadFilters,
} from "../../apps/desktop/src/beads-model";
import { projectBeadSchema } from "../projects/beads-protocol";

const bead = (id: string, extra: Record<string, unknown> = {}) =>
  projectBeadSchema.parse({
    id,
    title: id,
    type: "task",
    status: "open",
    priority: 4,
    parent: "epic",
    assignee: null,
    owner: "creator",
    labels: ["project:alpha"],
    createdAt: "2026-10-21T00:00:00Z",
    updatedAt: "2026-10-22T00:00:00Z",
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
    ...extra,
  });
test("saved views and combined filters preserve P4, explicit claim and tracker Ready authority", () => {
  const rows = [
    bead("epic", { type: "epic", parent: null }),
    bead("ready"),
    bead("claimed", {
      assignee: "worker",
      ready: false,
      status: "in_progress",
      priority: 0,
    }),
    bead("blocked", { blocked: true, ready: false }),
    bead("closed", { status: "closed", ready: false }),
    bead("deferred", { status: "deferred", ready: false }),
  ];
  expect(filterBeads(rows, newBeadFilters()).map((row) => row.id)).toEqual([
    "epic",
    "ready",
  ]);
  expect(
    filterBeads(rows, {
      ...newBeadFilters(),
      view: "all",
      priority: "4",
      query: "ready",
      epic: "epic",
    }).map((row) => row.id),
  ).toEqual(["ready"]);
  expect(
    filterBeads(rows, { ...newBeadFilters(), view: "in_progress" }).map(
      (row) => row.id,
    ),
  ).toEqual(["claimed"]);
  expect(
    filterBeads(rows, { ...newBeadFilters(), view: "blocked" }).map(
      (row) => row.id,
    ),
  ).toEqual(["blocked"]);
  expect(
    filterBeads(rows, { ...newBeadFilters(), view: "closed" }).map(
      (row) => row.id,
    ),
  ).toEqual(["closed"]);
  expect(
    filterBeads(rows, {
      ...newBeadFilters(),
      view: "all",
      assignee: "creator",
    }),
  ).toEqual([]);
});
test("epic ancestry and progress are cycle safe, grouping does not lose unparented beads", () => {
  const rows = [
    bead("epic", { type: "epic", parent: null }),
    bead("feature", { type: "feature" }),
    bead("nested", { parent: "feature", status: "closed", ready: false }),
    bead("other", { parent: null }),
    bead("cycle-a", { parent: "cycle-b" }),
    bead("cycle-b", { parent: "cycle-a" }),
  ];
  expect(epicProgress(rows, "epic")).toMatchObject({
    total: 2,
    closed: 1,
    blocked: 0,
  });
  expect(
    filterBeads(rows, { ...newBeadFilters(), view: "all", epic: "epic" }).map(
      (row) => row.id,
    ),
  ).toEqual(["epic", "feature", "nested"]);
  expect(beadGroups(rows, "epic").flatMap((group) => group.beads)).toHaveLength(
    rows.length,
  );
});
