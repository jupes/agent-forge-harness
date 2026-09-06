import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  calibrationFindings,
  calibrationMatrix,
  calibrationProfiles,
  runCalibration,
  scoreFindings,
} from "./calibration";
import { loadCouncilProfile } from "./cli";
import { FakeCouncilTransport } from "./engine";
import {
  type CouncilRun,
  ModelTransportError,
  parseCouncilProfileJson,
} from "./types";

const roots: string[] = [];
const profile = () =>
  loadCouncilProfile(`${import.meta.dir}/../../councils/default.json`);
function temp() {
  const root = mkdtempSync(join(tmpdir(), "council-eval-"));
  roots.push(root);
  return root;
}
function readJson(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Expected valid evaluation artifact");
  }
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("calibration defaults to a no-call plan across all artifact types and depths", async () => {
  const plan = await runCalibration([]);
  expect(plan.mode).toBe("dry-run");
  expect(plan.fixtures).toEqual(["pr", "plan", "research"]);
  expect(plan.comparisons).toEqual(["single", "quick", "balanced", "deep"]);
  expect(plan.estimatedCostUsd).toBe(0);
  expect(plan.baseline).toMatchObject({
    seatId: "chair",
    seat: { model: "deterministic-chair" },
  });
  expect(plan.reviewCount).toBe(12);
});

test("calibration preserves matched roles and roster, rotates chairs and repeats without multiplying the single baseline", () => {
  const base = profile();
  const matrix = calibrationMatrix(base, {
    rotateChair: true,
    repetitions: 2,
    baselineSeat: "security",
    seed: "matched",
  });
  expect(matrix.single.model).toBe("deterministic-security");
  expect(matrix.single.role).toContain(base.seats[0]!.role);
  expect(matrix.single.role).toContain(base.seats[3]!.role);
  expect(matrix.cases).toHaveLength(96); // 3 fixtures × 2 repeats × (1 + 5 chairs × 3 depths)
  expect(matrix.cases.filter((item) => item.mode === "single")).toHaveLength(6);
  for (const entry of matrix.profiles) {
    expect(entry.profile.seats).toEqual(base.seats);
    expect(entry.profile.chair.role).toBe(base.chair.role);
    expect(parseCouncilProfileJson(JSON.stringify(entry.profile)).ok).toBe(
      true,
    );
  }
  expect(
    calibrationMatrix(base, {
      rotateChair: true,
      repetitions: 2,
      seed: "matched",
    }).cases.map((item) => item.id),
  ).toEqual(matrix.cases.map((item) => item.id));
  expect(
    calibrationMatrix(base, { seed: "changed" }).cases.map((item) => item.id),
  ).not.toEqual(calibrationMatrix(base).cases.map((item) => item.id));
  for (const entry of calibrationProfiles(base))
    expect(parseCouncilProfileJson(JSON.stringify(entry)).ok).toBe(true);
});

test("invalid evaluation choices and missing budget fail before any provider calls", async () => {
  let calls = 0;
  const options = {
    environment: {},
    outputRoot: temp(),
    resolveTransport: () => {
      calls++;
      return new FakeCouncilTransport();
    },
  };
  for (const args of [
    ["--repetitions", "0"],
    ["--repetitions", "11"],
    ["--baseline-seat", "absent"],
    ["--seed", "../bad"],
    ["--live"],
  ])
    await expect(runCalibration(args, options)).rejects.toThrow();
  const hosted = `${import.meta.dir}/../../councils/openrouter.example.json`;
  await expect(
    runCalibration(["--profile", hosted, "--live", "--max-usd", "0"], options),
  ).rejects.toThrow("positive for hosted");
  expect(calls).toBe(0);
  expect(readdirSync(options.outputRoot)).toHaveLength(0);
});

test("simulation completes a repeatable matrix with blind review packets and separate answer key", async () => {
  const plan = await runCalibration(
    ["--live", "--max-usd", "0", "--repetitions", "2"],
    { environment: {}, outputRoot: temp() },
  );
  expect(plan.status).toBe("completed");
  expect(plan.simulated).toBe(true);
  const rows = plan.rows as Record<string, unknown>[];
  expect(rows).toHaveLength(24);
  expect(plan.accountedCostUsd).toBe(0);
  const root = String(plan.directory);
  const results = readJson(join(root, "results.json"));
  expect(results.status).toBe("completed");
  const key = readJson(join(root, "answer-key.json"));
  expect(Array.isArray(key)).toBe(true);
  const packet = readJson(join(root, "blind", `${rows[0]!.sampleId}.json`));
  expect(Object.keys(packet).sort()).toEqual([
    "complete",
    "fixture",
    "review",
    "sampleId",
  ]);
  expect(packet.complete).toBe(true);
  const ratings = readFileSync(join(root, "blind", "ratings.json"), "utf8");
  expect(ratings).not.toContain('"mode"');
  expect(ratings).not.toContain('"provider"');
  expect(ratings).toContain('"usefulness1to5": null');
  expect(
    rows.every(
      (row) =>
        row.contextHash ===
        (plan.fixtureHashes as Record<string, string>)[String(row.fixture)],
    ),
  ).toBe(true);
});

test("failed evaluation retains its billed record and stops before charging another comparison", async () => {
  let calls = 0;
  const result = await runCalibration(["--live", "--max-usd", "1"], {
    environment: {},
    outputRoot: temp(),
    resolveTransport: () => ({
      async generate() {
        calls++;
        throw new ModelTransportError("Contract refused", {
          usage: { inputTokens: 10, outputTokens: 2 },
          costUsd: 0.1,
        });
      },
    }),
  });
  expect(result.status).toBe("incomplete");
  expect(result.stopReason).toContain("failed");
  expect((result.rows as unknown[]).length).toBe(1);
  expect(
    (result.rows as Record<string, unknown>[])[0]?.keywordRecall,
  ).toBeNull();
  expect(calls).toBeLessThanOrEqual(4);
  expect(result.accountedCostUsd).toBeCloseTo(calls * 0.1);
  expect(readJson(join(String(result.directory), "results.json")).status).toBe(
    "incomplete",
  );
});

test("rejected council claims cannot improve calibration recall", () => {
  const findings = calibrationFindings({
    aggregatedFindings: [
      {
        title: "Tenant risk",
        claim: "tenant access",
        severity: "high",
        consequence: "disclosure",
        evidenceIds: ["E1"],
        resolution: "rejected",
      },
    ],
  } as CouncilRun);
  expect(findings).toEqual([]);
  expect(scoreFindings("pr", findings).keywordRecall).toBe(0);
});

test("calibration distinguishes proxy recall from human usefulness and false positives", () => {
  const score = scoreFindings("pr", [
    {
      title: "Cross-tenant access",
      claim: "The tenant predicate is missing",
      severity: "high",
    },
    { title: "Missing test", claim: "Add an isolation test", severity: "low" },
    { title: "Invented bug", claim: "Unrelated claim", severity: "low" },
  ]);
  expect(score.keywordRecall).toBe(1);
  expect(score.keywordSeverityAgreement).toBe(0.5);
  expect(score.unmatchedFindings).toBe(1);
  expect(score.humanFalsePositives).toBeNull();
  expect(score.humanUsefulness1to5).toBeNull();
});
