import { describe, expect, test } from "bun:test";
import type { BeadsIssue, BeadsDependency } from "../../types/beads";
import { collectSubtree, planBundles } from "./convoy-bundles";

const mk = (id: string, over: Partial<BeadsIssue> = {}): BeadsIssue => ({
  id,
  type: "task",
  title: id,
  status: "open",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  ...over,
});

describe("collectSubtree", () => {
  test("includes transitive children", () => {
    const issues = [
      mk("epic", { type: "epic" }),
      mk("a", { parent: "epic" }),
      mk("b", { parent: "a" }),
      mk("c"),
    ];
    const out = collectSubtree(issues, "epic").map((i) => i.id).sort();
    expect(out).toEqual(["a", "b"]);
  });
});

describe("planBundles", () => {
  test("tasks without deps form batch 1, closed deps do not block", () => {
    const sub = [mk("a"), mk("b"), mk("c")];
    const deps: BeadsDependency[] = [];
    const p = planBundles("e", sub, deps);
    expect(p.batches.length).toBe(1);
    expect(p.batches[0]?.sort()).toEqual(["a", "b", "c"]);
    expect(p.unbatched).toEqual([]);
  });

  test("open blocker pushes dependent into later batch", () => {
    const sub = [mk("a"), mk("b")];
    const deps: BeadsDependency[] = [{ from: "b", to: "a", type: "blocks" }];
    const p = planBundles("e", sub, deps);
    expect(p.batches).toEqual([["a"], ["b"]]);
  });

  test("closed blocker is ignored", () => {
    const sub = [mk("a", { status: "closed" }), mk("b")];
    const deps: BeadsDependency[] = [{ from: "b", to: "a", type: "blocks" }];
    const p = planBundles("e", sub, deps);
    expect(p.batches).toEqual([["b"]]);
    expect(p.closed).toEqual(["a"]);
  });

  test("cycle yields unbatched", () => {
    const sub = [mk("a"), mk("b")];
    const deps: BeadsDependency[] = [
      { from: "a", to: "b", type: "blocks" },
      { from: "b", to: "a", type: "blocks" },
    ];
    const p = planBundles("e", sub, deps);
    expect(p.batches.length).toBe(0);
    expect(p.unbatched.sort()).toEqual(["a", "b"]);
  });
});
