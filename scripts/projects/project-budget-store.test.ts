import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectStore } from "./store";
import { createProjectBudgetStore } from "./project-budget-store";
import { projectFixture } from "./testing";
import { projectBudgetsSchema } from "./project-budgets-protocol";

test("daily project allocations serialize, survive restart, retain unknown liabilities across UTC rollover, and report overages", async () => {
  const home = mkdtempSync(join(tmpdir(), "forge-project-budgets-"));
  let at = new Date("2026-11-07T12:00:00.000Z");
  try {
    const projects = createProjectStore(home), {slug,name,description,icon,workspaces} = projectFixture(home);
    const created = await projects.create({slug,name,description,icon,workspaces}, 0), id = created.projects[0]!.id;
    const saved = await projects.updateBudgets(id, 1, {shiftSpendCapUsd: 10, dailyApiKeyCapUsd: 5});
    expect(saved.projects[0]?.budgets?.dailyApiKeyCapUsd).toBe(5);
    const budget = createProjectBudgetStore(home, () => at);
    const request = "00000000-0000-4000-8000-000000000001", other = "00000000-0000-4000-8000-000000000002", hash = "a".repeat(64);
    const results = await Promise.allSettled([budget.reserve(id,request,hash,3), budget.reserve(id,other,hash,3)]);
    expect(results.filter(item => item.status === "fulfilled")).toHaveLength(1);
    const admitted = results[0]?.status === "fulfilled" ? request : other;
    await budget.reserve(id,admitted,hash,3);
    expect(budget.status(id)).toMatchObject({reservedUsd: 3, reportedUsd: 0, unknownCount: 0});
    await expect(budget.reserve(id,admitted,"b".repeat(64),3)).rejects.toThrow("original");
    await budget.settle(id,admitted,hash,{actualCostUsd: null, usageEstimatedCostUsd: 0.5, costIsEstimate:true});
    at = new Date("2026-11-08T00:00:00.000Z");
    const restarted = createProjectBudgetStore(home, () => at);
    expect(restarted.status(id)).toMatchObject({day:"2026-11-08",reservedUsd:3, estimatedUsd:0.5,unknownCount:1});
    await expect(restarted.reserve(id,"00000000-0000-4000-8000-000000000003",hash,1)).rejects.toThrow("unreported");
    await restarted.settle(id,admitted,hash,{actualCostUsd:6,usageEstimatedCostUsd:null,costIsEstimate:false});
    // A later actual receipt belongs to its original admission day, and is never clipped.
    at = new Date("2026-11-07T23:59:00.000Z");
    expect(restarted.status(id)).toMatchObject({reportedUsd:6,reservedUsd:0,unknownCount:0});
    await expect(restarted.reserve(id,"00000000-0000-4000-8000-000000000003",hash,1)).rejects.toThrow("exhausted");
    await restarted.settle(id,admitted,hash,{actualCostUsd:0,usageEstimatedCostUsd:null,costIsEstimate:false});
    expect(restarted.status(id).reportedUsd).toBe(6);
    await expect(projects.updateBudgets(id,1,{shiftSpendCapUsd:null,dailyApiKeyCapUsd:null})).rejects.toThrow();
    expect(projectBudgetsSchema.safeParse({shiftSpendCapUsd:0,dailyApiKeyCapUsd:null}).success).toBe(false);
    expect(projectBudgetsSchema.safeParse({shiftSpendCapUsd:0.0000001,dailyApiKeyCapUsd:null}).success).toBe(false);
  } finally {rmSync(home,{recursive:true,force:true});}
});
