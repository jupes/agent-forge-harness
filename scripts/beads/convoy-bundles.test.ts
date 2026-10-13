import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BeadsDependency, BeadsIssue } from "../../types/beads";
import { collectSubtree, planBundles, runBundles } from "./convoy-bundles";
import type { BdRunner } from "./live-tracker";

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
    const out = collectSubtree(issues, "epic")
      .map((i) => i.id)
      .sort();
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

// ── Where the graph comes from ──────────────────────────────────────────────

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const jsonl = (rows: object[]): string =>
  `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

/** A checkout with an optional `.beads/issues.jsonl` holding these rows. */
function checkout(fileRows?: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "af-convoy-bundles-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".beads"));
  if (fileRows)
    writeFileSync(join(dir, ".beads", "issues.jsonl"), jsonl(fileRows));
  return dir;
}

/** Stands in for `bd`: records every call; never the real tracker. */
function fakeBd(answer: () => string | Error): {
  run: BdRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args) => {
      calls.push(args);
      const out = answer();
      if (out instanceof Error) throw out;
      return out;
    },
  };
}

/**
 * One `bd export` line, in the shape bd prints and `.beads/issues.jsonl`
 * holds: the parent and the blockers are only in `dependencies`.
 */
function exportRow(
  id: string,
  status: string,
  dependsOn: Array<[type: string, on: string]> = [],
): object {
  return {
    _type: "issue",
    id,
    title: `title of ${id}`,
    status,
    priority: 2,
    issue_type: id === "e" ? "epic" : "task",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-10T00:00:00Z",
    dependencies: dependsOn.map(([type, on]) => ({
      issue_id: id,
      depends_on_id: on,
      type,
    })),
  };
}

/** Epic `e` with `e.1`, and `e.2` blocked by `e.1`; both open. */
const LIVE = [
  exportRow("e", "open"),
  exportRow("e.1", "open", [["parent-child", "e"]]),
  exportRow("e.2", "open", [
    ["parent-child", "e"],
    ["blocks", "e.1"],
  ]),
];

describe("runBundles: where the graph comes from", () => {
  test("when bd answers, the plan comes from the tracker's rows in one bd export call, not from an existing .beads/issues.jsonl", async () => {
    const cwd = checkout([
      exportRow("e", "open"),
      exportRow("e.1", "closed", [["parent-child", "e"]]),
      exportRow("e.2", "open", [["parent-child", "e"]]),
    ]);
    const bd = fakeBd(() => jsonl(LIVE));

    const result = await runBundles({ cwd, runBd: bd.run, epicId: "e" });

    if (!result.ok) throw new Error(result.error);
    expect(result.data.batches).toEqual([["e.1"], ["e.2"]]);
    expect(result.data.closed).toEqual([]);
    expect(result.data.source).toEqual({ kind: "tracker" });
    expect(bd.calls).toEqual([["export", "--no-memories"]]);
  });

  test("when bd does not answer, .beads/issues.jsonl is used with parent and blockers read from its rows' dependencies, and a warning and the envelope's source say so", async () => {
    const cwd = checkout(LIVE);
    const bd = fakeBd(() => new Error("spawn bd ENOENT"));
    const warnings: string[] = [];

    const result = await runBundles({
      cwd,
      runBd: bd.run,
      epicId: "e",
      warn: (line) => warnings.push(line),
    });

    if (!result.ok) throw new Error(result.error);
    expect(result.data.batches).toEqual([["e.1"], ["e.2"]]);
    expect(result.data.source).toMatchObject({
      kind: "file",
      path: ".beads/issues.jsonl",
      reason: "spawn bd ENOENT",
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(".beads/issues.jsonl");
  });

  test("a .beads/deps.jsonl is not read: blockers come from the rows alone", async () => {
    const cwd = checkout();
    // Read, this edge would close a cycle with the rows' own and batch nothing.
    writeFileSync(
      join(cwd, ".beads", "deps.jsonl"),
      jsonl([{ from: "e.1", to: "e.2", type: "blocks" }]),
    );
    const bd = fakeBd(() => jsonl(LIVE));

    const result = await runBundles({ cwd, runBd: bd.run, epicId: "e" });

    if (!result.ok) throw new Error(result.error);
    expect(result.data.batches).toEqual([["e.1"], ["e.2"]]);
    expect(result.data.unbatched).toEqual([]);
  });

  test("when bd does not answer and there is no .beads/issues.jsonl, the error names bd's failure and the file", async () => {
    const cwd = checkout();
    const bd = fakeBd(() => new Error("dolt server not running"));

    const result = await runBundles({ cwd, runBd: bd.run, epicId: "e" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("dolt server not running");
    expect(result.error).toContain(".beads/issues.jsonl");
  });
});
