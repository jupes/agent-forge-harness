import { expect, test } from "bun:test";
import {
  buildBeadWorkMap,
  visibleBeadOutline,
} from "../../apps/desktop/src/beads-work-map-model";
import { projectBeadSchema } from "../projects/beads-protocol";

const bead = (id: string, extra: Record<string, unknown> = {}) =>
  projectBeadSchema.parse({
    id,
    title: id,
    type: "task",
    status: "open",
    priority: 2,
    parent: null,
    assignee: null,
    owner: null,
    labels: [],
    createdAt: "2026-11-07T00:00:00Z",
    updatedAt: "2026-11-07T00:00:00Z",
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
    commentsComplete: false,
    detailsLoaded: false,
    ...extra,
  });
test("dependency arrows point from prerequisite to blocked work, while relates stays undirected", () => {
  const map = buildBeadWorkMap(
    [bead("a"), bead("b"), bead("c")],
    [
      { from: "b", to: "a", type: "blocks" },
      { from: "c", to: "b", type: "requires" },
      { from: "c", to: "a", type: "relates" },
    ],
  );
  expect(map.graph.edges).toContainEqual({
    from: "a",
    to: "b",
    type: "blocks",
    cyclic: false,
  });
  expect(map.graph.edges).toContainEqual({
    from: "b",
    to: "c",
    type: "requires",
    cyclic: false,
  });
  expect(map.graph.nodes.find((node) => node.id === "a")!.x).toBeLessThan(
    map.graph.nodes.find((node) => node.id === "b")!.x,
  );
  expect(map.graph.nodes.find((node) => node.id === "b")!.x).toBeLessThan(
    map.graph.nodes.find((node) => node.id === "c")!.x,
  );
  expect(map.nodes.get("b")?.prerequisites).toEqual(["a"]);
  expect(map.nodes.get("a")?.related).toEqual(["c"]);
});
test("tree retains ancestors of matches and reports actual descendant progress independently of filters", () => {
  const rows = [
    bead("epic", { type: "epic" }),
    bead("feature", { parent: "epic", type: "feature" }),
    bead("done", { parent: "feature", status: "closed" }),
    bead("todo", { parent: "feature" }),
  ];
  const map = buildBeadWorkMap(rows, [], new Set(["todo"]));
  expect(map.outline.map((row) => [row.id, row.depth, row.context])).toEqual([
    ["epic", 0, true],
    ["feature", 1, true],
    ["todo", 2, false],
  ]);
  expect(map.nodes.get("epic")?.progress).toEqual({ total: 3, closed: 1 });
  expect(
    visibleBeadOutline(map, new Set(["feature"])).map((row) => row.id),
  ).toEqual(["epic", "feature"]);
});

test("rootless hierarchy and dependency cycles retain every node, flag self-loops and remain deterministic", () => {
  const rows = [
    bead("a", { parent: "b" }),
    bead("b", { parent: "a", status: "closed" }),
    bead("c", { parent: "b" }),
    bead("self", { parent: "self" }),
  ];
  const edges = [
    { from: "a", to: "b", type: "blocks" as const },
    { from: "b", to: "a", type: "requires" as const },
    { from: "self", to: "self", type: "blocks" as const },
  ];
  const map = buildBeadWorkMap(rows, edges);
  expect(new Set(map.outline.map((row) => row.id))).toEqual(
    new Set(rows.map((row) => row.id)),
  );
  expect(map.nodes.get("a")?.hierarchyCycle).toBe(true);
  expect(map.nodes.get("a")?.dependencyCycle).toBe(true);
  expect(map.nodes.get("self")?.dependencyCycle).toBe(true);
  expect(map.nodes.get("a")?.progress).toEqual({ total: 2, closed: 1 });
  expect(map.nodes.get("a")?.progress.total).toBeLessThan(rows.length);
  expect(
    buildBeadWorkMap(rows.slice().reverse(), edges.slice().reverse()).graph,
  ).toEqual(map.graph);
});

test("graph cutoffs retain the full deep outline, relationships, progress and cycle evidence", () => {
  const rows = Array.from({ length: 1000 }, (_, index) =>
    bead(`n${String(index).padStart(4, "0")}`, {
      parent: index ? `n${String(index - 1).padStart(4, "0")}` : null,
      status: index === 999 ? "closed" : "open",
    }),
  );
  const edges = rows.map((row, index) => ({
    from: row.id,
    to: rows[(index + 1) % rows.length]!.id,
    type: "blocks" as const,
  }));
  const map = buildBeadWorkMap(rows, edges);
  expect(map.graph.available).toBe(false);
  expect(map.outline).toHaveLength(1000);
  expect(map.outline.at(-1)?.depth).toBe(999);
  expect(map.nodes.get("n0000")?.progress).toEqual({ total: 999, closed: 1 });
  expect(map.nodes.get("n0999")?.dependencyCycle).toBe(true);
  expect(map.nodes.get("n0000")?.prerequisites).toEqual(["n0001"]);
  const dense = buildBeadWorkMap(
    rows.slice(0, 100),
    Array.from({ length: 10000 }, (_, index) => ({
      from: rows[Math.floor(index / 100)]!.id,
      to: rows[index % 100]!.id,
      type: "requires" as const,
    })),
  );
  expect(dense.graph.available).toBe(false);
  expect(dense.graph.edgeCount).toBe(10000);
  expect(dense.outline).toHaveLength(100);
});

test("filtered context, unavailable blockers and invalid outside endpoints remain separate", () => {
  const rows = [
    bead("a"),
    bead("b", { unavailableBlockers: 2 }),
    bead("c"),
    bead("d"),
  ];
  const map = buildBeadWorkMap(
    rows,
    [
      { from: "b", to: "a", type: "blocks" },
      { from: "d", to: "c", type: "requires" },
      { from: "b", to: "foreign-secret", type: "blocks" },
    ],
    new Set(["b"]),
  );
  expect(map.graph.nodes.map((row) => [row.id, row.context])).toEqual([
    ["a", true],
    ["b", false],
  ]);
  expect(map.graph.filteredEdges).toBe(1);
  expect(map.graphOutline.map((row) => row.id)).toEqual(["a", "b"]);
  expect(map.unavailableBlockers).toBe(2);
  expect(map.problems.join(" ")).toContain("unavailable endpoints");
  expect(JSON.stringify(map.graph) + map.problems.join(" ")).not.toContain(
    "foreign-secret",
  );
  expect(rows[1]!.unavailableBlockers).toBe(2);
});
