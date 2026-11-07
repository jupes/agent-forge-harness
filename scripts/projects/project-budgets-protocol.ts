import { z } from "zod";

const usd = z.number().finite().positive().max(1_000_000).refine(value => Math.abs(value * 1_000_000 - Math.round(value * 1_000_000)) < 0.00001, "Use at most six decimal places.");
export const projectBudgetsSchema = z.object({shiftSpendCapUsd: usd.nullable(), dailyApiKeyCapUsd: usd.nullable()}).strict();
export type ProjectBudgets = z.infer<typeof projectBudgetsSchema>;
export const NO_PROJECT_BUDGETS: Readonly<ProjectBudgets> = Object.freeze({shiftSpendCapUsd: null, dailyApiKeyCapUsd: null});
export const projectBudgetsRequestSchema = z.object({expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1), budgets: projectBudgetsSchema}).strict();
export const projectBudgetStatusSchema = z.object({projectId: z.string(), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), dailyCapUsd: usd.nullable(), reportedUsd: z.number().finite().nonnegative(), estimatedUsd: z.number().finite().nonnegative(), reservedUsd: z.number().finite().nonnegative(), unknownCount: z.number().int().nonnegative()}).strict();
export type ProjectBudgetStatus = z.infer<typeof projectBudgetStatusSchema>;
/** Council injects this runtime-neutral seam; it must never import private-home/ledger storage. */
export interface ProjectCouncilBudget {
  reserve(projectId: string, requestId: string, hash: string, allocationUsd: number): Promise<void>;
  settle(projectId: string, requestId: string, hash: string, result: {actualCostUsd: number | null; usageEstimatedCostUsd: number | null; costIsEstimate: boolean} | null): Promise<void>;
}
