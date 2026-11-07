import { z } from "zod";

/** Decimal conversion avoids binary multiplication rounding below a reviewed liability. */
export function usdMicros(value: number, exact = false): number {
  if (!Number.isFinite(value) || value < 0) throw Error("Invalid USD value");
  const [mantissa = "", exponent = "0"] = value
    .toString()
    .toLowerCase()
    .split("e");
  const [whole = "0", fraction = ""] = mantissa.split(".");
  let amount = BigInt(whole + fraction);
  const power = Number(exponent) + 6 - fraction.length;
  if (power >= 0) amount *= 10n ** BigInt(power);
  else {
    const divisor = 10n ** BigInt(-power),
      remainder = amount % divisor;
    if (exact && remainder !== 0n)
      throw Error("Use at most six decimal places");
    amount = amount / divisor + (remainder === 0n ? 0n : 1n);
  }
  if (amount > BigInt(Number.MAX_SAFE_INTEGER))
    throw Error("USD amount exceeds the accounting bound");
  return Number(amount);
}
const usd = z
  .number()
  .finite()
  .positive()
  .max(1_000_000)
  .refine((value) => {
    try {
      usdMicros(value, true);
      return true;
    } catch {
      return false;
    }
  }, "Use at most six decimal places.");
export const projectBudgetsSchema = z
  .object({
    shiftSpendCapUsd: usd.nullable(),
    dailyApiKeyCapUsd: usd.nullable(),
  })
  .strict();
export type ProjectBudgets = z.infer<typeof projectBudgetsSchema>;
export const NO_PROJECT_BUDGETS: Readonly<ProjectBudgets> = Object.freeze({
  shiftSpendCapUsd: null,
  dailyApiKeyCapUsd: null,
});
export const projectBudgetsRequestSchema = z
  .object({
    expectedRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1),
    budgets: projectBudgetsSchema,
  })
  .strict();
export const projectBudgetStatusSchema = z
  .object({
    projectId: z.string(),
    asOf: z.iso.datetime(),
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dailyCapUsd: usd.nullable(),
    reportedUsd: z.number().finite().nonnegative(),
    estimatedUsd: z.number().finite().nonnegative(),
    reservedUsd: z.number().finite().nonnegative(),
    unknownCount: z.number().int().nonnegative(),
  })
  .strict();
export type ProjectBudgetStatus = z.infer<typeof projectBudgetStatusSchema>;
/** Council injects this runtime-neutral seam; it must never import private-home/ledger storage. */
export interface ProjectCouncilBudget {
  reserve(
    projectId: string,
    requestId: string,
    hash: string,
    allocationUsd: number,
  ): Promise<void>;
  settle(
    projectId: string,
    requestId: string,
    hash: string,
    result: {
      actualCostUsd: number | null;
      usageEstimatedCostUsd: number | null;
      costIsEstimate: boolean;
    } | null,
  ): Promise<void>;
}
