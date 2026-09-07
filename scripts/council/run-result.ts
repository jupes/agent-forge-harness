import { anonymizeText, type IndependentSuccess } from "./deliberation";
import { reportedCost } from "./model-call";
import {
  type AggregatedFinding,
  type ChairOutput,
  COUNCIL_SCHEMA_VERSION,
  type ContextPack,
  type CouncilEvent,
  type CouncilProfile,
  type CouncilRun,
  type SeatRecord,
} from "./types";

export function reviewLimitations(
  context: ContextPack,
  profile: CouncilProfile,
  independent: IndependentSuccess[],
  records: SeatRecord[],
  findings: AggregatedFinding[],
): string[] {
  const limitations = new Set<string>();
  if (context.truncated)
    limitations.add("The supplied evidence was truncated.");
  if (independent.length < profile.seats.length)
    limitations.add("Independent review completed with a reduced roster.");
  if (records.some((record) => record.status !== "completed"))
    limitations.add("One or more council calls failed or were cancelled.");
  for (const record of independent) {
    if (record.output.verdict === "uncertain")
      limitations.add(
        "An independent reviewer could not reach a supported verdict.",
      );
    for (const unknown of record.output.unknowns)
      limitations.add(anonymizeText(unknown, profile));
    if (
      record.output.verdict === "needs_changes" &&
      record.output.findings.length === 0
    )
      limitations.add(
        "An independent reviewer requested changes without a verifiable finding.",
      );
  }
  for (const finding of findings) {
    if (
      finding.resolution === "unreviewed" ||
      finding.resolution === "contested"
    )
      limitations.add(
        `${finding.resolution === "unreviewed" ? "Insufficient independent review" : "Unresolved disagreement"}: ${finding.title}`,
      );
  }
  return [...limitations];
}

export function finalRun(
  status: CouncilRun["status"],
  startedAt: string,
  profile: CouncilProfile,
  context: ContextPack,
  runId: string,
  estimatedCostUsd: number,
  records: SeatRecord[],
  aggregatedFindings: AggregatedFinding[],
  events: CouncilEvent[],
  now: () => Date,
  chair: ChairOutput | undefined,
  error: string | undefined,
  limitations: string[] = [],
): CouncilRun {
  const run: CouncilRun = {
    schemaVersion: COUNCIL_SCHEMA_VERSION,
    runId,
    status,
    startedAt,
    finishedAt: now().toISOString(),
    profile,
    context: {
      source: context.source,
      contentHash: context.contentHash,
      byteLength: context.byteLength,
      truncated: context.truncated,
      redactions: context.redactions,
      evidence: context.evidence,
    },
    estimatedCostUsd,
    actualCostUsd: records.every((record) => record.costUsd !== undefined)
      ? Number(
          records
            .reduce((sum, record) => sum + (record.costUsd ?? 0), 0)
            .toFixed(6),
        )
      : null,
    usageEstimatedCostUsd: records.some(
      (record) => record.estimatedUsageCostUsd !== undefined,
    )
      ? Number(
          records
            .reduce(
              (sum, record) => sum + (record.estimatedUsageCostUsd ?? 0),
              0,
            )
            .toFixed(6),
        )
      : null,
    accountedCostUsd: reportedCost(records),
    costIsEstimate: records.some((record) => record.costUsd === undefined),
    limitations,
    records,
    aggregatedFindings,
    failures: records
      .filter((record) => record.status !== "completed")
      .map((record) => ({
        stage: record.stage,
        seatId: record.seatId,
        error: record.error ?? record.status,
      })),
    events,
  };
  if (chair) run.chair = chair;
  if (error) run.error = error;
  return run;
}
