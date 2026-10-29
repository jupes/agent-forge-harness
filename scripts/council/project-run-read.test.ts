import { describe, expect, it } from "bun:test";
import type {
  ProjectCouncilMetadata,
  ProjectCouncilReceipt,
} from "../../types/project-council";
import {
  MAX_PROJECT_COUNCIL_RUN_RESPONSE_BYTES,
  type ProjectCouncilRunProvenance,
  projectCouncilJobReadSchema,
  projectCouncilRunRead,
  projectCouncilRunReadSchema,
} from "../../types/project-council-run-read";
import type { CouncilServiceJob } from "./service";
import type { CouncilProfile, CouncilRun } from "./types";

const at = "2026-10-29T12:00:00.000Z";
const hash = "a".repeat(64);
const projectId = "project-11111111-1111-4111-8111-111111111111";
const requestId = "11111111-1111-4111-8111-111111111111";
const runId = `council-${requestId}`;
const seat = {
  id: "reviewer-one",
  role: "Architect",
  provider: "claude",
  model: "claude-sonnet",
  timeoutMs: 60_000,
  maxOutputTokens: 4_000,
  estimatedCostUsd: 0.1,
};
const profile: CouncilProfile = {
  schemaVersion: 1,
  id: "balanced",
  title: "Balanced",
  depth: "balanced",
  minQuorum: 2,
  minPeerBallots: 1,
  maxEstimatedUsd: 4,
  seats: [seat, { ...seat, id: "reviewer-two", role: "Tester" }],
  chair: { ...seat, id: "chair", role: "Chair" },
};
const finding = {
  key: "finding-1",
  title: "Missing check",
  claim: "The input is not checked.",
  consequence: "Invalid input reaches the operation.",
  severity: "high" as const,
  evidenceIds: ["evidence-1"],
  confidence: 0.9,
  proposedBy: 1,
  support: 2,
  oppose: 0,
  uncertain: 0,
  contested: false,
  reviewed: true,
  consensusEligible: true,
  resolution: "consensus" as const,
  independentProposers: 1,
  severityDisputed: false,
  rationales: [
    {
      reviewerLabel: "Tester",
      stance: "support" as const,
      reason: "The public entry point accepts the unchecked value.",
      evidenceIds: ["evidence-1"],
    },
  ],
};
const run: CouncilRun = {
  schemaVersion: 1,
  runId,
  status: "completed",
  startedAt: at,
  finishedAt: at,
  profile,
  context: {
    source: {
      kind: "stdin",
      displayName: "pasted review text",
      locator: "stdin",
    },
    contentHash: hash,
    byteLength: 42,
    truncated: false,
    redactions: [],
    evidence: [
      {
        id: "evidence-1",
        title: "Input handling",
        content: "The handler forwards an unchecked value.",
        contentHash: hash,
        byteLength: 42,
        truncated: false,
      },
    ],
  },
  estimatedCostUsd: 1,
  actualCostUsd: 0.8,
  usageEstimatedCostUsd: null,
  accountedCostUsd: 0.8,
  costIsEstimate: false,
  limitations: ["The review covers only the supplied source."],
  records: [
    {
      stage: "independent",
      seatId: "reviewer-one",
      provider: "claude",
      model: "claude-sonnet",
      status: "completed",
      latencyMs: 400,
      output: {
        verdict: "needs_changes",
        findings: [
          {
            localId: "finding-1",
            title: "Missing check",
            severity: "high",
            claim: "The input is not checked.",
            consequence: "Invalid input reaches the operation.",
            evidenceIds: ["evidence-1"],
            confidence: 0.9,
          },
        ],
        strengths: ["The operation is small."],
        unknowns: ["Other callers were not supplied."],
      },
      accountedCostUsd: 0.2,
    },
  ],
  discussion: [
    {
      stage: "peer",
      round: 0,
      completedAt: at,
      records: [],
      findings: [finding],
      candidateTitles: { "finding-1": "Missing check" },
    },
  ],
  aggregatedFindings: [finding],
  chair: {
    verdict: "needs_changes",
    summary: "Add validation before the operation.",
    recommendations: ["Validate the value at the public boundary."],
    consensusFindingKeys: ["finding-1"],
    dissentFindingKeys: [],
  },
  failures: [],
  events: [
    {
      schemaVersion: 1,
      runId,
      seq: 0,
      at,
      type: "run.started",
      payload: {
        profileId: "balanced",
        sourceKind: "stdin",
        estimatedCostUsd: 1,
        listing: ["pasted review text"],
      },
    },
    {
      schemaVersion: 1,
      runId,
      seq: 1,
      at,
      type: "run.completed",
      payload: { verdict: "needs_changes", findingCount: 1 },
    },
  ],
};
const job: CouncilServiceJob = {
  runId,
  status: "completed",
  startedAt: at,
  updatedAt: at,
  events: run.events,
  discussion: run.discussion,
  profile,
  run,
  persistenceStatus: "saved",
  artifacts: {
    directory: "C:\\private\\council-runs\\run-1",
    manifest: "C:\\private\\council-runs\\run-1\\manifest.json",
    events: "C:\\private\\council-runs\\run-1\\events.ndjson",
    report: "C:\\private\\council-runs\\run-1\\report.md",
  },
};
const metadata: ProjectCouncilMetadata = {
  requestId,
  runId,
  intentHash: hash,
  projectId,
  state: "completed",
  sourceType: "text",
  sourceName: "pasted review text",
  listing: ["pasted review text"],
  byteLength: 42,
  truncated: false,
  redactions: [],
  profileId: "balanced",
  profileTitle: "Balanced",
  maxUsd: 4,
  maxBytes: 42,
  redactSecrets: true,
  createdAt: at,
  updatedAt: at,
};
const receipt: ProjectCouncilReceipt = { metadata, phase: "completed" };
const provenance: ProjectCouncilRunProvenance = {
  version: 1,
  requestId,
  intentHash: hash,
  runId,
  projectId,
  workspace: "C:\\workspace\\repo",
  catalogRevision: 3,
  scopeHash: "b".repeat(64),
};
describe("project Council run read contract", () => {
  it("projects the full public result while omitting artifact paths", () => {
    const read = projectCouncilRunRead(
      provenance,
      receipt,
      job,
      "review: COUNCIL needs_changes — add boundary validation",
    );
    expect(projectCouncilRunReadSchema.safeParse(read).success).toBe(true);
    expect(read.job?.run?.context.evidence?.[0]?.content).toContain(
      "unchecked value",
    );
    expect(read.job?.run?.records[0]?.output).toMatchObject({
      strengths: ["The operation is small."],
      unknowns: ["Other callers were not supplied."],
    });
    expect(
      read.job?.run?.discussion?.[0]?.findings[0]?.rationales,
    ).toHaveLength(1);
    expect(JSON.stringify(read)).not.toContain("C:\\\\private\\\\council-runs");
    expect(read.job?.run?.actualCostUsd).toBe(0.8);
  });

  it("keeps identity mismatches and unknown event payload fields invalid", () => {
    const foreign: CouncilServiceJob = { ...job, runId: "council-foreign" };
    expect(() =>
      projectCouncilRunRead(provenance, receipt, foreign, null),
    ).toThrow();

    const malformed: unknown = {
      runId,
      status: "completed",
      startedAt: at,
      updatedAt: at,
      events: [
        {
          ...run.events[0],
          payload: { ...run.events[0]?.payload, prompt: "provider prompt" },
        },
      ],
    };
    expect(projectCouncilJobReadSchema.safeParse(malformed).success).toBe(
      false,
    );

    const crossedRun: CouncilRun = {
      ...run,
      events: [{ ...run.events[0]!, runId: "council-foreign" }],
    };
    expect(() =>
      projectCouncilRunRead(
        provenance,
        receipt,
        { ...job, run: crossedRun },
        null,
      ),
    ).toThrow();
    const { run: _run, artifacts: _artifacts, ...completedWithoutResult } = job;
    expect(
      projectCouncilJobReadSchema.safeParse(completedWithoutResult).success,
    ).toBe(false);
  });

  it("keeps unknown dispatch outcomes held without attaching a job", () => {
    const reservedReceipt: ProjectCouncilReceipt = {
      metadata: { ...metadata, state: "reserved" },
      phase: "reserved",
    };
    const runningReceipt: ProjectCouncilReceipt = {
      metadata: { ...metadata, state: "running" },
      phase: "running",
    };
    const failedReceipt: ProjectCouncilReceipt = {
      metadata: { ...metadata, state: "failed" },
      phase: "failed",
    };
    expect(() =>
      projectCouncilRunRead(provenance, reservedReceipt, job, null),
    ).toThrow();
    expect(() =>
      projectCouncilRunRead(provenance, runningReceipt, null, null),
    ).toThrow();
    expect(() =>
      projectCouncilRunRead(provenance, failedReceipt, job, null),
    ).toThrow();
    const unknownReceipt: ProjectCouncilReceipt = {
      metadata: { ...metadata, state: "dispatch-claimed" },
      phase: "unknown",
    };
    expect(
      projectCouncilRunRead(provenance, unknownReceipt, null, null).job,
    ).toBeNull();
    expect(() =>
      projectCouncilRunRead(provenance, unknownReceipt, job, null),
    ).toThrow();
  });

  it("rejects oversize complete results instead of truncating them", () => {
    const evidence = Array.from({ length: 9 }, (_, index) => ({
      id: `large-${index}`,
      title: "Large evidence",
      content: "x".repeat(950_000),
      contentHash: hash,
      byteLength: 950_000,
      truncated: false,
    }));
    const largeRun: CouncilRun = {
      ...run,
      context: { ...run.context, evidence },
    };
    const largeJob: CouncilServiceJob = { ...job, run: largeRun };
    expect(MAX_PROJECT_COUNCIL_RUN_RESPONSE_BYTES).toBe(8 * 1024 * 1024);
    expect(() =>
      projectCouncilRunRead(provenance, receipt, largeJob, null),
    ).toThrow(/8 MiB/);
  });

  it("preserves an absent job without inventing costs or a recommendation", () => {
    const pendingReceipt: ProjectCouncilReceipt = {
      metadata: { ...metadata, state: "reserved" },
      phase: "reserved",
    };
    const read = projectCouncilRunRead(provenance, pendingReceipt, null, null);
    expect(read.job).toBeNull();
    expect(read.verdictCommentPreview).toBeNull();
    expect(read.receipt.phase).toBe("reserved");
  });
});
