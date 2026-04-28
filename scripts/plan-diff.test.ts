import { describe, expect, test } from "bun:test";
import { diffPlanLines, planDiffToSideBySide, splitLines, type PlanDiffRow } from "../docs/js/plan-diff";

describe("plan-diff", () => {
  test("splitLines normalizes CRLF", () => {
    expect(splitLines("a\r\nb")).toEqual(["a", "b"]);
  });

  test("identical inputs are all same", () => {
    const t = "x\ny\nz";
    const d = diffPlanLines(t, t);
    expect(d).toEqual([
      { kind: "same", line: "x" },
      { kind: "same", line: "y" },
      { kind: "same", line: "z" },
    ]);
  });

  test("inserts a line in the middle", () => {
    const d = diffPlanLines("A\nB", "A\nC\nB");
    const kinds = d.map((r: PlanDiffRow) => r.kind);
    expect(kinds).toContain("add");
    const text = d
      .filter((r: PlanDiffRow) => r.kind !== "same")
      .map((r: PlanDiffRow) => r.line)
      .join("\n");
    expect(text).toContain("C");
  });

  test("planDiffToSideBySide pairs deletions on left, additions on right", () => {
    const d = diffPlanLines("A\nB", "A\nC");
    const s = planDiffToSideBySide(d);
    // Last row: B deleted, C added — expect split columns (order depends on LCS; at least one pair has del left / add right)
    const hasDel = s.some(
      (r) => r.left?.role === "del" && r.right === null && (r.left?.line === "B" || r.left?.line === "C"),
    );
    const hasAdd = s.some(
      (r) => r.right?.role === "add" && r.left === null && (r.right?.line === "B" || r.right?.line === "C"),
    );
    expect(hasDel).toBe(true);
    expect(hasAdd).toBe(true);
  });

  test("planDiffToSideBySide duplicates context on both columns", () => {
    const s = planDiffToSideBySide(diffPlanLines("one\ntwo", "one\ntwo"));
    expect(s).toEqual([
      { left: { line: "one", role: "ctx" }, right: { line: "one", role: "ctx" } },
      { left: { line: "two", role: "ctx" }, right: { line: "two", role: "ctx" } },
    ]);
  });
});
