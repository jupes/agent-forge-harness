#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reserveCouncilRun, writeCouncilArtifacts } from "./artifacts";
import { loadCouncilProfile } from "./cli";
import { buildContextPack, hashText } from "./context";
import {
  independentPrompt,
  independentSystem,
  reserveRequestCost,
  runCouncil,
  runIndependentReview,
} from "./engine";
import {
  assertProvidersReady,
  createProviderResolver,
  providerReadiness,
} from "./providers";
import { safeCouncilError } from "./service";
import {
  type ContextPack,
  type CouncilProfile,
  type CouncilRun,
  type CouncilSeat,
  estimateCouncilCost,
  type FindingSeverity,
  type ModelRequest,
  type ModelTransport,
  type ProposedFinding,
} from "./types";

export const GOLDEN_CASES = [
  {
    id: "pr",
    targets: [
      {
        id: "tenant-isolation",
        terms: ["tenant", "authoriz", "access control"],
        severity: "high",
      },
      { id: "cross-tenant-test", terms: ["test"], severity: "medium" },
    ],
  },
  {
    id: "plan",
    targets: [
      {
        id: "rolling-compatibility",
        terms: ["old", "rolling", "compatib"],
        severity: "high",
      },
      {
        id: "data-loss",
        terms: ["data loss", "backfill", "copy", "existing data"],
        severity: "high",
      },
    ],
  },
  {
    id: "research",
    targets: [
      {
        id: "causality",
        terms: ["causal", "control", "confound"],
        severity: "high",
      },
      {
        id: "generalization",
        terms: ["region", "generaliz", "english", "sample"],
        severity: "medium",
      },
    ],
  },
] as const;

// Keyword scores are transparent triage aids, not semantic ground truth. Human
// adjudication must confirm false positives, severity and practical usefulness.
export function scoreFindings(
  caseId: string,
  findings: Pick<ProposedFinding, "title" | "claim" | "severity">[],
) {
  const fixture = GOLDEN_CASES.find((item) => item.id === caseId);
  if (!fixture) throw new Error("Unknown calibration fixture");
  const text = findings.map((finding) =>
    `${finding.title} ${finding.claim}`.toLowerCase(),
  );
  const matches = fixture.targets.map((target) => {
    const indexes = text.flatMap((value, index) =>
      target.terms.some((term) => value.includes(term)) ? [index] : [],
    );
    return {
      id: target.id,
      expectedSeverity: target.severity,
      indexes,
      severityMatches: indexes.some(
        (index) => findings[index]?.severity === target.severity,
      ),
    };
  });
  const hit = matches.filter((match) => match.indexes.length > 0);
  return {
    keywordRecall: hit.length / fixture.targets.length,
    unmatchedFindings: text.filter(
      (_, index) => !matches.some((match) => match.indexes.includes(index)),
    ).length,
    keywordSeverityAgreement: hit.length
      ? hit.filter((match) => match.severityMatches).length / hit.length
      : null,
    matches,
    humanFalsePositives: null,
    humanUsefulness1to5: null,
    humanDissentPreserved: null,
  };
}

export function calibrationProfiles(base: CouncilProfile): CouncilProfile[] {
  const { maxDiscussionRounds: _, ...common } = base;
  return (["quick", "balanced", "deep"] as const).map((depth) => ({
    ...common,
    id: `${base.id}-${depth}`,
    depth,
    ...(depth === "deep"
      ? { maxDiscussionRounds: base.maxDiscussionRounds ?? 1 }
      : {}),
    minPeerBallots: depth === "quick" ? 0 : Math.min(2, base.seats.length - 1),
  }));
}

type CalibrationMode = "single" | "quick" | "balanced" | "deep";
export type CalibrationSettings = {
  baselineSeat?: string;
  rotateChair?: boolean;
  repetitions?: number;
  seed?: string;
};

export function calibrationMatrix(
  base: CouncilProfile,
  settings: CalibrationSettings = {},
) {
  const baselineId = settings.baselineSeat ?? base.chair.id;
  const selected = [...base.seats, base.chair].find(
    (seat) => seat.id === baselineId,
  );
  if (!selected) throw new Error(`Unknown baseline seat: ${baselineId}`);
  const single = {
    ...selected,
    role: `General reviewer covering all council concerns: ${base.seats.map((seat) => seat.role).join("; ")}`,
  };
  const repetitions = settings.repetitions ?? 1;
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10)
    throw new Error("repetitions must be between 1 and 10");
  const seed = settings.seed ?? "council-calibration-v1";
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(seed))
    throw new Error(
      "seed must be 1–80 letters, numbers, dots, underscores or hyphens",
    );
  const chairs = (
    settings.rotateChair ? [base.chair, ...base.seats] : [base.chair]
  ).filter(
    (seat, index, seats) =>
      seats.findIndex(
        (other) =>
          other.provider === seat.provider &&
          other.model === seat.model &&
          JSON.stringify(other.openRouter) === JSON.stringify(seat.openRouter),
      ) === index,
  );
  const profiles = chairs.flatMap((chair) =>
    calibrationProfiles({
      ...base,
      chair: { ...chair, id: base.chair.id, role: base.chair.role },
    }).map((profile) => ({ chairSource: chair.id, profile })),
  );
  const cases: {
    id: string;
    fixture: string;
    repetition: number;
    mode: CalibrationMode;
    chairSource: string | null;
    profile?: CouncilProfile;
  }[] = [];
  for (const fixture of GOLDEN_CASES) {
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      cases.push({
        id: `${fixture.id}-r${repetition}-single`,
        fixture: fixture.id,
        repetition,
        mode: "single",
        chairSource: null,
      });
      for (const [index, entry] of profiles.entries())
        cases.push({
          id: `${fixture.id}-r${repetition}-c${Math.floor(index / 3) + 1}-${entry.profile.depth}`,
          fixture: fixture.id,
          repetition,
          mode: entry.profile.depth,
          chairSource: entry.chairSource,
          profile: entry.profile,
        });
    }
  }
  // Counterbalance execution order reproducibly, independent of provider speed.
  cases.sort((left, right) =>
    hashText(`${seed}:${left.id}`).localeCompare(
      hashText(`${seed}:${right.id}`),
    ),
  );
  const estimatedCostUsd = cases.reduce(
    (sum, item) =>
      sum +
      (item.profile
        ? estimateCouncilCost(item.profile)
        : single.estimatedCostUsd),
    0,
  );
  return {
    single,
    baselineSeat: baselineId,
    chairs,
    profiles,
    repetitions,
    seed,
    cases,
    estimatedCostUsd: Number(estimatedCostUsd.toFixed(6)),
  };
}

type ReviewFinding = Pick<
  ProposedFinding,
  "title" | "claim" | "severity" | "consequence" | "evidenceIds"
>;
export function calibrationFindings(run: CouncilRun): ReviewFinding[] {
  // Rejected claims are not successes. Keep contested/unreviewed findings for
  // human adjudication because the delivered review still surfaces them.
  return run.aggregatedFindings
    .filter((finding) => finding.resolution !== "rejected")
    .map(({ title, claim, severity, consequence, evidenceIds }) => ({
      title,
      claim,
      severity,
      consequence,
      evidenceIds,
    }));
}

type CalibrationOptions = {
  outputRoot?: string;
  environment?: Record<string, string | undefined>;
  resolveTransport?: (seat: CouncilSeat) => ModelTransport;
};

export async function runCalibration(
  args: string[],
  options: CalibrationOptions = {},
): Promise<Record<string, unknown>> {
  const harnessRoot = fileURLToPath(new URL("../../", import.meta.url));
  let profilePath = join(harnessRoot, "councils/default.json");
  let maxUsd = 0;
  let live = false;
  let budgetProvided = false;
  const settings: CalibrationSettings = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--live") {
      live = true;
      continue;
    }
    if (arg === "--rotate-chair") {
      settings.rotateChair = true;
      continue;
    }
    if (
      [
        "--profile",
        "--max-usd",
        "--baseline-seat",
        "--repetitions",
        "--seed",
      ].includes(arg!)
    ) {
      const value = args[++index];
      if (!value || value.startsWith("--"))
        throw new Error(`${arg} needs a value`);
      if (arg === "--profile") profilePath = resolve(value);
      else if (arg === "--baseline-seat") settings.baselineSeat = value;
      else if (arg === "--repetitions") settings.repetitions = Number(value);
      else if (arg === "--seed") settings.seed = value;
      else {
        budgetProvided = true;
        maxUsd = Number(value);
        if (!Number.isFinite(maxUsd) || maxUsd < 0)
          throw new Error("max-usd must be finite and nonnegative");
      }
    } else throw new Error(`Unknown calibration option: ${arg}`);
  }
  const base = loadCouncilProfile(profilePath);
  const matrix = calibrationMatrix(base, settings);
  const { single, estimatedCostUsd: estimate } = matrix;
  const environment = options.environment ?? process.env;
  const contexts = new Map<string, ContextPack>(
    GOLDEN_CASES.map((fixture) => [
      fixture.id,
      buildContextPack({
        kind: "stdin",
        text: readFileSync(
          join(harnessRoot, `scripts/council/fixtures/${fixture.id}.md`),
          "utf8",
        ),
        displayName: `${fixture.id} calibration fixture`,
      }),
    ]),
  );
  const simulated = [...base.seats, base.chair].every(
    (seat) => seat.provider === "fake",
  );
  const plan = {
    mode: live ? "execution" : "dry-run",
    fixtures: GOLDEN_CASES.map((item) => item.id),
    comparisons: ["single", "quick", "balanced", "deep"],
    simulated,
    baseline: { seatId: matrix.baselineSeat, seat: single },
    chairs: matrix.chairs,
    roster: base.seats,
    repetitions: matrix.repetitions,
    seed: matrix.seed,
    reviewCount: matrix.cases.length,
    executionOrder: matrix.cases.map(({ profile, ...item }) => ({
      ...item,
      profile: profile?.id ?? null,
    })),
    fixtureHashes: Object.fromEntries(
      [...contexts].map(([id, context]) => [id, context.contentHash]),
    ),
    estimatedCostUsd: estimate,
    providerReadiness: providerReadiness(base, environment),
    note: "Per-call estimate, not a guaranteed cap; token-aware round guards run before dispatch. Compare matched fixtures and roster. The chair model is the default single baseline, not a proven best model; select your strongest with --baseline-seat. Keyword metrics require human adjudication; simulation is not evidence of model review quality.",
  };
  if (!live) return plan;
  if (!budgetProvided || (!simulated && maxUsd <= 0))
    throw new Error(
      "Execution requires an explicit --max-usd budget (positive for hosted providers)",
    );
  assertProvidersReady(base, environment);
  if (estimate > maxUsd)
    throw new Error(
      `Calibration estimate ${estimate.toFixed(4)} exceeds total budget ${maxUsd.toFixed(4)}; explicitly set --max-usd`,
    );
  const root = resolve(
    options.outputRoot ?? "reports/council-calibration",
    `evaluation-${Date.now()}-${randomUUID().slice(0, 8)}`,
  );
  mkdirSync(root, { recursive: true });
  const blindRoot = join(root, "blind");
  mkdirSync(blindRoot);
  const writeJson = (path: string, value: unknown) =>
    writeFileSync(path, JSON.stringify(value, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
  writeJson(join(root, "plan.json"), { ...plan, profile: base, maxUsd });
  writeJson(
    join(blindRoot, "fixtures.json"),
    Object.fromEntries(
      [...contexts].map(([id, context]) => [id, context.evidence]),
    ),
  );
  const rows: Record<string, unknown>[] = [];
  writeJson(join(blindRoot, "rubric.json"), {
    instructions:
      "Score samples in sample-ID order using fixtures.json. Do not consult answer-key.json, results.json or model transcripts until scores are locked. Use null when evidence is insufficient. Incomplete samples are operational failures, not quality scores.",
    falsePositiveCount:
      "Count findings not supported by the supplied evidence; do not count a clearly labeled uncertainty as an asserted defect.",
    missedCriticalCount:
      "Count material safety/correctness omissions after independently reading the fixture.",
    severityAccuracy1to5:
      "1 = misleading severity throughout; 3 = mixed; 5 = proportionate, evidence-backed severity.",
    usefulness1to5:
      "1 = unusable or harmful; 3 = some actionable feedback; 5 = accurate, specific feedback sufficient to improve the work.",
    dissentPreserved:
      "Second pass only: after locking quality scores, use full transcripts to check whether material objections and uncertainty survived the final review. Null for a single review or no assessable dissent.",
  });
  const answerKey: Record<string, unknown>[] = [];
  const ratings: Record<string, unknown>[] = [];
  let accounted = 0;
  const resolver =
    options.resolveTransport ?? createProviderResolver({ environment });
  let stopReason: string | null = null;
  try {
    for (const item of matrix.cases) {
      const { mode, id: runId } = item;
      const context = contexts.get(item.fixture)!;
      const started = performance.now();
      const beforeCost = accounted;
      let findings: ReviewFinding[] = [];
      let row: Record<string, unknown>;
      let review: Record<string, unknown> = {};
      if (mode === "single") {
        const request: ModelRequest = {
          runId,
          stage: "independent",
          seat: single,
          context,
          system: independentSystem(single),
          prompt: independentPrompt(context),
        };
        const reserve = reserveRequestCost(request);
        if (accounted + reserve > maxUsd)
          throw new Error(
            "Calibration exhausted its total budget before the single evaluator",
          );
        const result = await runIndependentReview(request, resolver);
        accounted += result.accountedCostUsd;
        const output =
          result.output && "findings" in result.output
            ? result.output
            : undefined;
        findings = (output?.findings ?? []).map(
          ({ title, claim, severity, consequence, evidenceIds }) => ({
            title,
            claim,
            severity,
            consequence,
            evidenceIds,
          }),
        );
        review = {
          verdict: output?.verdict ?? "unavailable",
          findings,
          notes: [...(output?.strengths ?? []), ...(output?.unknowns ?? [])],
        };
        row = {
          status: result.status,
          error: result.error ?? null,
          record: result,
          usage: result.usage ?? null,
          actualCostUsd: result.costUsd ?? null,
          usageEstimatedCostUsd: result.estimatedUsageCostUsd ?? null,
          dissentCount: null,
        };
      } else {
        const selected = item.profile!;
        const reservation = reserveCouncilRun(runId, root);
        const result = await runCouncil({
          runId,
          profile: selected,
          context,
          resolveTransport: resolver,
          maxUsd: Math.max(0, maxUsd - accounted),
        });
        const artifacts = writeCouncilArtifacts(result.run, root, reservation);
        accounted += result.run.accountedCostUsd;
        findings = calibrationFindings(result.run);
        review = {
          verdict: result.run.chair?.verdict ?? "unavailable",
          findings,
          notes: [
            result.run.chair?.summary ?? "",
            ...(result.run.chair?.recommendations ?? []),
            ...result.run.limitations,
          ].filter(Boolean),
        };
        row = {
          status: result.run.status,
          error: result.run.error ?? null,
          artifacts,
          verdict: result.run.chair?.verdict ?? null,
          usage:
            result.run.records.length > 0 &&
            result.run.records.every((record) => record.usage)
              ? {
                  inputTokens: result.run.records.reduce(
                    (sum, record) => sum + (record.usage?.inputTokens ?? 0),
                    0,
                  ),
                  outputTokens: result.run.records.reduce(
                    (sum, record) => sum + (record.usage?.outputTokens ?? 0),
                    0,
                  ),
                }
              : null,
          usageReportedCalls: result.run.records.filter(
            (record) => record.usage,
          ).length,
          actualCostUsd: result.run.actualCostUsd,
          usageEstimatedCostUsd: result.run.usageEstimatedCostUsd,
          dissentCount: result.run.aggregatedFindings.filter(
            (finding) =>
              finding.resolution === "contested" ||
              finding.resolution === "unreviewed",
          ).length,
          rejectedCount: result.run.aggregatedFindings.filter(
            (finding) => finding.resolution === "rejected",
          ).length,
        };
      }
      const sampleId = `sample-${randomUUID()}`;
      rows.push({
        runId,
        sampleId,
        fixture: item.fixture,
        contextHash: context.contentHash,
        repetition: item.repetition,
        chairSource: item.chairSource,
        mode,
        latencyMs: Math.round(performance.now() - started),
        accountedSoFarUsd: accounted,
        accountedCostUsd: accounted - beforeCost,
        ...(row.status === "completed"
          ? scoreFindings(item.fixture, findings)
          : {
              keywordRecall: null,
              unmatchedFindings: null,
              keywordSeverityAgreement: null,
              matches: [],
              humanFalsePositives: null,
              humanUsefulness1to5: null,
              humanDissentPreserved: null,
            }),
        ...row,
      });
      writeJson(join(root, `${runId}.json`), rows.at(-1));
      // Identities, timing, costs, protocol names and proxy scores stay outside
      // the blind folder. Text can still hint at architecture: human blinding
      // is best-effort, never a claim of perfect experimental concealment.
      writeJson(join(blindRoot, `${sampleId}.json`), {
        sampleId,
        fixture: item.fixture,
        complete: row.status === "completed",
        review,
      });
      answerKey.push({
        sampleId,
        runId,
        mode,
        fixture: item.fixture,
        repetition: item.repetition,
        chairSource: item.chairSource,
      });
      ratings.push({
        sampleId,
        fixture: item.fixture,
        falsePositiveCount: null,
        missedCriticalCount: null,
        severityAccuracy1to5: null,
        usefulness1to5: null,
        dissentPreserved: null,
        notes: "",
      });
      if (accounted > maxUsd)
        throw new Error(
          `Calibration stopped at total budget; partial results preserved in ${root}`,
        );
      // A failed comparison is operational evidence, not a low quality score.
      // Stop to avoid repeatedly billing a broken configuration.
      if (row.status !== "completed")
        throw new Error(
          `Comparison ${runId} failed; inspect its saved record before retrying`,
        );
    }
  } catch (error) {
    stopReason = safeCouncilError(error);
  } finally {
    const sortSamples = (
      a: Record<string, unknown>,
      b: Record<string, unknown>,
    ) => String(a.sampleId).localeCompare(String(b.sampleId));
    writeJson(join(root, "answer-key.json"), answerKey.sort(sortSamples));
    writeJson(join(blindRoot, "ratings.json"), ratings.sort(sortSamples));
    writeJson(join(root, "results.json"), {
      status: stopReason ? "incomplete" : "completed",
      stopReason,
      accountedCostUsd: accounted,
      rows,
    });
  }
  return {
    ...plan,
    status: stopReason ? "incomplete" : "completed",
    stopReason,
    directory: root,
    accountedCostUsd: accounted,
    rows,
  };
}

if (import.meta.main) {
  try {
    const data = await runCalibration(process.argv.slice(2));
    const ok = data.status !== "incomplete";
    process.stdout.write(
      `${JSON.stringify({ ok, data, error: ok ? null : data.stopReason }, null, 2)}\n`,
    );
    if (!ok) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, data: null, error: safeCouncilError(error) })}\n`,
    );
    process.exitCode = 1;
  }
}
