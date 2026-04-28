/** Line-oriented plan diff (LCS DP on lines) for plan review UI and unit tests. */

export type PlanDiffKind = "same" | "add" | "del";

export type PlanDiffRow = {
  kind: PlanDiffKind;
  line: string;
};

export function splitLines(a: string): string[] {
  return String(a ?? "").replace(/\r\n/g, "\n").split("\n");
}

/** Myers-style diff built via LCS DP on lines (stable for typical markdown sizes). */
export function diffPlanLines(oldText: string, newText: string): PlanDiffRow[] {
  const A = splitLines(oldText);
  const B = splitLines(newText);
  const n = A.length;
  const m = B.length;

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const aLine = A[i - 1];
      const bLine = B[j - 1];
      if (aLine !== undefined && bLine !== undefined && aLine === bLine) {
        dp[i]![j] = (dp[i - 1]?.[j - 1] ?? 0) + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]?.[j] ?? 0, dp[i]?.[j - 1] ?? 0);
      }
    }
  }

  const stack: PlanDiffRow[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const aLine = i > 0 ? A[i - 1] : undefined;
    const bLine = j > 0 ? B[j - 1] : undefined;
    if (i > 0 && j > 0 && aLine !== undefined && bLine !== undefined && aLine === bLine) {
      stack.push({ kind: "same", line: aLine });
      i -= 1;
      j -= 1;
    } else if (i > 0 && (j === 0 || (dp[i - 1]?.[j] ?? 0) >= (dp[i]?.[j - 1] ?? 0))) {
      if (aLine === undefined) break;
      stack.push({ kind: "del", line: aLine });
      i -= 1;
    } else if (j > 0) {
      if (bLine === undefined) break;
      stack.push({ kind: "add", line: bLine });
      j -= 1;
    } else {
      break;
    }
  }
  return stack.reverse();
}

/** One row for side-by-side view: old (left) vs new (right). */
export type PlanSideBySideRow = {
  left: { line: string; role: "del" | "ctx" } | null;
  right: { line: string; role: "add" | "ctx" } | null;
};

/** Map unified line diff to paired columns (left = old, right = new). */
export function planDiffToSideBySide(rows: PlanDiffRow[]): PlanSideBySideRow[] {
  const out: PlanSideBySideRow[] = [];
  for (const r of rows) {
    if (r.kind === "same") {
      out.push({ left: { line: r.line, role: "ctx" }, right: { line: r.line, role: "ctx" } });
    } else if (r.kind === "del") {
      out.push({ left: { line: r.line, role: "del" }, right: null });
    } else {
      out.push({ left: null, right: { line: r.line, role: "add" } });
    }
  }
  return out;
}
