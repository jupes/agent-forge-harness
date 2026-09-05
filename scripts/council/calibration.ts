#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reserveCouncilRun, writeCouncilArtifacts } from "./artifacts";
import { loadCouncilProfile } from "./cli";
import { buildContextPack } from "./context";
import {
  independentPrompt,
  independentSystem,
  parseIndependentOutput,
  runCouncil,
} from "./engine";
import {
  assertProvidersReady,
  createProviderResolver,
  providerReadiness,
} from "./providers";
import { safeCouncilError } from "./service";
import {
  type CouncilProfile,
  estimateCouncilCost,
  type FindingSeverity,
  type ModelRequest,
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

export function calibrationProfiles(base: CouncilProfile) {
  return (["quick", "balanced", "deep"] as const).map((depth) => ({
    ...base,
    id: `${base.id}-${depth}`,
    depth,
    maxDiscussionRounds: depth === "deep" ? 1 : 0,
    minPeerBallots: depth === "quick" ? 0 : Math.min(2, base.seats.length - 1),
  }));
}

export async function runCalibration(
  args: string[],
): Promise<Record<string, unknown>> {
  const harnessRoot = fileURLToPath(new URL("../../", import.meta.url));
  let profilePath = join(harnessRoot, "councils/default.json");
  let maxUsd = 0;
  let live = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--live") {
      live = true;
      continue;
    }
    if (arg === "--profile" || arg === "--max-usd") {
      const value = args[++index];
      if (!value || value.startsWith("--"))
        throw new Error(`${arg} needs a value`);
      if (arg === "--profile") profilePath = resolve(value);
      else {
        maxUsd = Number(value);
        if (!Number.isFinite(maxUsd) || maxUsd < 0)
          throw new Error("max-usd must be finite and nonnegative");
      }
    } else throw new Error(`Unknown calibration option: ${arg}`);
  }
  const base = loadCouncilProfile(profilePath);
  const profiles = calibrationProfiles(base);
  const single = base.seats[0]!;
  const estimate =
    GOLDEN_CASES.length *
    (single.estimatedCostUsd +
      profiles.reduce((sum, profile) => sum + estimateCouncilCost(profile), 0));
  const plan = {
    mode: live ? "execution" : "dry-run",
    fixtures: GOLDEN_CASES.map((item) => item.id),
    comparisons: ["single", ...profiles.map((profile) => profile.depth)],
    estimatedCostUsd: estimate,
    providerReadiness: providerReadiness(base),
    note: "Keyword metrics require human adjudication; simulation is not evidence of model review quality.",
  };
  if (!live) return plan;
  assertProvidersReady(base);
  if (estimate > maxUsd)
    throw new Error(
      `Calibration estimate ${estimate.toFixed(4)} exceeds total budget ${maxUsd.toFixed(4)}; explicitly set --max-usd`,
    );
  const root = resolve(
    "reports/council-calibration",
    `evaluation-${Date.now()}-${randomUUID().slice(0, 8)}`,
  );
  mkdirSync(root, { recursive: true });
  const rows: Record<string, unknown>[] = [];
  let accounted = 0;
  const resolver = createProviderResolver();
  for (const fixture of GOLDEN_CASES) {
    const context = buildContextPack({
      kind: "stdin",
      text: readFileSync(
        join(harnessRoot, `scripts/council/fixtures/${fixture.id}.md`),
        "utf8",
      ),
      displayName: `${fixture.id} calibration fixture`,
    });
    for (const mode of ["single", "quick", "balanced", "deep"] as const) {
      const started = performance.now();
      const runId = `${fixture.id}-${mode}`;
      let findings: Pick<ProposedFinding, "title" | "claim" | "severity">[] =
        [];
      let row: Record<string, unknown>;
      if (mode === "single") {
        const request: ModelRequest = {
          runId,
          stage: "independent",
          seat: single,
          context,
          system: independentSystem(single),
          prompt: independentPrompt(context),
        };
        const rates = single.tokenRatesUsdPerMillion;
        const reserve = Math.max(
          single.estimatedCostUsd,
          rates
            ? ((Buffer.byteLength(request.system + request.prompt) + 4096) *
                rates.input +
                single.maxOutputTokens * rates.output) /
                1_000_000
            : 0,
        );
        if (accounted + reserve > maxUsd)
          throw new Error(
            "Calibration exhausted its total budget before the single evaluator",
          );
        const result = await resolver(single).generate(
          request,
          AbortSignal.timeout(single.timeoutMs),
        );
        const output = parseIndependentOutput(
          result.output,
          new Set(context.evidence.map((item) => item.id)),
        );
        accounted +=
          result.costUsd ??
          Math.max(reserve, result.estimatedUsageCostUsd ?? 0);
        findings = output.findings;
        row = {
          output,
          usage: result.usage ?? null,
          actualCostUsd: result.costUsd ?? null,
          usageEstimatedCostUsd: result.estimatedUsageCostUsd ?? null,
          dissentCount: null,
        };
      } else {
        const selected = profiles.find((profile) => profile.depth === mode)!;
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
        findings = result.run.aggregatedFindings;
        row = {
          status: result.run.status,
          error: result.run.error ?? null,
          artifacts,
          verdict: result.run.chair?.verdict ?? null,
          usage: {
            inputTokens: result.run.records.reduce(
              (sum, record) => sum + (record.usage?.inputTokens ?? 0),
              0,
            ),
            outputTokens: result.run.records.reduce(
              (sum, record) => sum + (record.usage?.outputTokens ?? 0),
              0,
            ),
          },
          actualCostUsd: result.run.actualCostUsd,
          usageEstimatedCostUsd: result.run.usageEstimatedCostUsd,
          dissentCount: result.run.aggregatedFindings.filter(
            (finding) => finding.contested,
          ).length,
        };
      }
      rows.push({
        fixture: fixture.id,
        mode,
        latencyMs: Math.round(performance.now() - started),
        accountedSoFarUsd: accounted,
        ...scoreFindings(fixture.id, findings),
        ...row,
      });
      writeFileSync(
        join(root, `${runId}.json`),
        JSON.stringify(rows.at(-1), null, 2),
        { flag: "wx", mode: 0o600 },
      );
      if (accounted > maxUsd)
        throw new Error(
          `Calibration stopped at total budget; partial results preserved in ${root}`,
        );
    }
  }
  return { ...plan, directory: root, accountedCostUsd: accounted, rows };
}

if (import.meta.main) {
  try {
    process.stdout.write(
      `${JSON.stringify({ ok: true, data: await runCalibration(process.argv.slice(2)), error: null }, null, 2)}\n`,
    );
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, data: null, error: safeCouncilError(error) })}\n`,
    );
    process.exitCode = 1;
  }
}
