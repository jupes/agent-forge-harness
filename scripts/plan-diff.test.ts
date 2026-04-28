import { describe, expect, test } from "bun:test";
import { diffPlanLines, splitLines, type PlanDiffRow } from "../docs/js/plan-diff";

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
});
