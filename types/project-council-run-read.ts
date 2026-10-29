import { z } from "zod";
import type { CouncilServiceJob } from "../scripts/council/service";
import { parseCouncilProfileJson } from "../scripts/council/types";
import {
  type ProjectCouncilReceipt,
  projectCouncilReceiptSchema,
} from "./project-council";

if (typeof window !== "undefined") z.config({ jitless: true });

export const MAX_PROJECT_COUNCIL_RUN_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_PUBLIC_TEXT = 1_048_576;
const MAX_SHORT_TEXT = 16_384;
const MAX_LIST = 4_096;

const text = z.string().max(MAX_PUBLIC_TEXT);
const shortText = z.string().max(MAX_SHORT_TEXT);
const nonempty = z.string().min(1).max(MAX_SHORT_TEXT);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const date = z.iso.datetime();
const finite = z.number().finite();
const nonnegative = finite.nonnegative();
const integer = z.number().int().nonnegative();
const stringList = z.array(text).max(MAX_LIST);
const severity = z.enum(["blocker", "high", "medium", "low"]);
const stage = z.enum(["independent", "peer", "revision", "chair"]);

const usageSchema = z
  .object({ inputTokens: integer, outputTokens: integer })
  .strict();
const routingSchema = z
  .object({
    responseId: shortText.optional(),
    model: shortText.optional(),
    provider: shortText.optional(),
    byok: z.boolean().optional(),
    gatewayCostUsd: nonnegative.optional(),
    upstreamCostUsd: nonnegative.optional(),
  })
  .strict();

const seatSchema = z
  .object({
    id: nonempty,
    role: nonempty,
    provider: nonempty,
    model: nonempty,
    timeoutMs: z.number().int().positive().max(600_000),
    maxOutputTokens: z.number().int().positive(),
    estimatedCostUsd: nonnegative,
    tokenRatesUsdPerMillion: z
      .object({ input: nonnegative, output: nonnegative })
      .strict()
      .optional(),
    openRouter: z
      .object({
        only: z.array(nonempty).max(64).optional(),
        allowFallbacks: z.boolean().optional(),
        dataCollection: z.enum(["deny", "allow"]).optional(),
        zeroDataRetention: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const profileSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: nonempty,
    title: nonempty,
    depth: z.enum(["quick", "balanced", "deep"]),
    maxDiscussionRounds: z.number().int().positive().max(3).optional(),
    minQuorum: z.number().int().positive().max(100),
    minPeerBallots: z.number().int().nonnegative().max(100),
    maxEstimatedUsd: nonnegative,
    seats: z.array(seatSchema).min(2).max(100),
    chair: seatSchema,
  })
  .strict()
  .superRefine((profile, context) => {
    if (profile.minQuorum > profile.seats.length)
      context.addIssue({
        code: "custom",
        message: "profile quorum exceeds seats",
      });
    if (profile.minPeerBallots > profile.seats.length)
      context.addIssue({
        code: "custom",
        message: "profile peer quorum exceeds seats",
      });
    const ids = new Set(profile.seats.map((seat) => seat.id));
    if (ids.size !== profile.seats.length || ids.has(profile.chair.id))
      context.addIssue({
        code: "custom",
        message: "profile seat ids are not unique",
      });
    const parsed = parseCouncilProfileJson(JSON.stringify(profile));
    if (!parsed.ok)
      context.addIssue({
        code: "custom",
        message: "profile is not a valid canonical Council profile",
      });
  });

const proposedFindingSchema = z
  .object({
    localId: nonempty,
    title: nonempty,
    severity,
    claim: nonempty,
    consequence: nonempty,
    evidenceIds: z.array(nonempty).max(512),
    confidence: z.number().min(0).max(1),
  })
  .strict();
const independentOutputSchema = z
  .object({
    verdict: z.enum(["pass", "needs_changes", "uncertain"]),
    findings: z.array(proposedFindingSchema).max(4_096),
    strengths: stringList,
    unknowns: stringList,
  })
  .strict();
const peerBallotSchema = z
  .object({
    candidateId: nonempty,
    stance: z.enum(["support", "oppose", "uncertain"]),
    reason: nonempty,
    evidenceIds: z.array(nonempty).max(512),
    suggestedSeverity: severity.optional(),
  })
  .strict();
const peerOutputSchema = z
  .object({
    ballots: z.array(peerBallotSchema).max(4_096),
    missingFindings: z.array(proposedFindingSchema).max(4_096),
    equivalentCandidateGroups: z.array(z.array(nonempty).max(4_096)).max(4_096),
  })
  .strict();
const chairOutputSchema = z
  .object({
    verdict: z.enum(["pass", "needs_changes", "insufficient_evidence"]),
    summary: nonempty,
    recommendations: stringList,
    consensusFindingKeys: z.array(nonempty).max(4_096),
    dissentFindingKeys: z.array(nonempty).max(4_096),
  })
  .strict();
const seatOutputSchema = z.union([
  independentOutputSchema,
  peerOutputSchema,
  chairOutputSchema,
]);

const rationaleSchema = z
  .object({
    reviewerLabel: nonempty,
    stance: z.enum(["support", "oppose", "uncertain"]),
    reason: nonempty,
    evidenceIds: z.array(nonempty).max(512),
    suggestedSeverity: severity.optional(),
  })
  .strict();
const aggregatedFindingSchema = z
  .object({
    key: nonempty,
    title: nonempty,
    claim: nonempty,
    consequence: nonempty,
    severity,
    evidenceIds: z.array(nonempty).max(512),
    confidence: z.number().min(0).max(1),
    proposedBy: integer,
    support: integer,
    oppose: integer,
    uncertain: integer,
    contested: z.boolean(),
    reviewed: z.boolean(),
    consensusEligible: z.boolean(),
    resolution: z.enum(["consensus", "contested", "unreviewed", "rejected"]),
    independentProposers: integer,
    severityDisputed: z.boolean(),
    rationales: z.array(rationaleSchema).max(4_096),
  })
  .strict();
const seatRecordSchema = z
  .object({
    stage,
    round: z.number().int().nonnegative().max(8).optional(),
    seatId: nonempty,
    provider: nonempty,
    model: nonempty,
    status: z.enum(["completed", "failed", "cancelled"]),
    latencyMs: integer,
    output: seatOutputSchema.optional(),
    usage: usageSchema.optional(),
    costUsd: nonnegative.optional(),
    estimatedUsageCostUsd: nonnegative.optional(),
    routing: routingSchema.optional(),
    accountedCostUsd: nonnegative,
    error: shortText.optional(),
  })
  .strict();
const discussionRoundSchema = z
  .object({
    stage: z.enum(["independent", "peer", "revision"]),
    round: z.number().int().nonnegative().max(8).optional(),
    completedAt: date,
    records: z.array(seatRecordSchema).max(1_000),
    findings: z.array(aggregatedFindingSchema).max(4_096),
    candidateTitles: z
      .record(z.string().max(256), text)
      .refine((value) => Object.keys(value).length <= 4_096),
  })
  .strict();

const sourceMetadataSchema = z
  .record(
    z.string().max(128),
    z.union([shortText, finite, z.boolean(), z.array(shortText).max(128)]),
  )
  .refine((value) => Object.keys(value).length <= 128);
const contextSourceSchema = z
  .object({
    kind: z.enum(["file", "plan", "pr", "stdin", "bead"]),
    displayName: nonempty,
    locator: nonempty,
    metadata: sourceMetadataSchema.optional(),
  })
  .strict();
const evidenceItemSchema = z
  .object({
    id: nonempty,
    title: nonempty,
    content: text,
    contentHash: digest,
    byteLength: integer.max(1_048_576),
    truncated: z.boolean(),
  })
  .strict();
const redactionSchema = z.object({ kind: nonempty, count: integer }).strict();
const runContextSchema = z
  .object({
    source: contextSourceSchema,
    contentHash: digest,
    byteLength: integer.max(1_048_576),
    truncated: z.boolean(),
    redactions: z.array(redactionSchema).max(128),
    evidence: z.array(evidenceItemSchema).max(512).optional(),
  })
  .strict();

const eventFields = {
  schemaVersion: z.literal(1),
  runId: nonempty,
  seq: integer,
  at: date,
};
const eventPayload = {
  "run.started": z
    .object({
      profileId: nonempty,
      sourceKind: z.enum(["file", "plan", "pr", "stdin", "bead"]),
      estimatedCostUsd: nonnegative,
      listing: z.array(shortText).max(512),
    })
    .strict(),
  "run.failed": z.object({ error: shortText }).strict(),
  "run.cancelled": z.object({ error: shortText }).strict(),
  "run.completed": z
    .object({
      verdict: z.enum(["pass", "needs_changes", "insufficient_evidence"]),
      findingCount: integer,
    })
    .strict(),
  "stage.started": z
    .object({ stage, seatCount: integer, round: integer.optional() })
    .strict(),
  "stage.completed": z
    .object({
      stage,
      completed: integer,
      failed: integer,
      round: integer.optional(),
    })
    .strict(),
  "seat.started": z
    .object({ stage, seatId: nonempty, provider: nonempty, model: nonempty })
    .strict(),
  "seat.completed": z
    .object({ stage, seatId: nonempty, latencyMs: integer })
    .strict(),
  "seat.failed": z
    .object({ stage, seatId: nonempty, error: shortText })
    .strict(),
  "seat.cancelled": z
    .object({ stage, seatId: nonempty, error: shortText })
    .strict(),
  "findings.aggregated": z
    .object({ count: integer, contested: integer })
    .strict(),
  "verdict.corrected": z
    .object({
      proposed: z.enum(["pass", "needs_changes", "insufficient_evidence"]),
      verdict: z.enum(["pass", "needs_changes", "insufficient_evidence"]),
      limitations: stringList,
    })
    .strict(),
} as const;
const event = <T extends keyof typeof eventPayload>(type: T) =>
  z
    .object({
      ...eventFields,
      type: z.literal(type),
      payload: eventPayload[type],
    })
    .strict();
const councilEventSchema = z.discriminatedUnion("type", [
  event("run.started"),
  event("run.failed"),
  event("run.cancelled"),
  event("run.completed"),
  event("stage.started"),
  event("stage.completed"),
  event("seat.started"),
  event("seat.completed"),
  event("seat.failed"),
  event("seat.cancelled"),
  event("findings.aggregated"),
  event("verdict.corrected"),
]);

const councilRunSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: nonempty,
    status: z.enum(["completed", "failed", "cancelled"]),
    startedAt: date,
    finishedAt: date,
    profile: profileSchema,
    context: runContextSchema,
    estimatedCostUsd: nonnegative,
    actualCostUsd: nonnegative.nullable(),
    usageEstimatedCostUsd: nonnegative.nullable(),
    accountedCostUsd: nonnegative,
    costIsEstimate: z.boolean(),
    limitations: stringList,
    records: z.array(seatRecordSchema).max(1_000),
    discussion: z.array(discussionRoundSchema).max(32).optional(),
    aggregatedFindings: z.array(aggregatedFindingSchema).max(4_096),
    chair: chairOutputSchema.optional(),
    failures: z
      .array(z.object({ stage, seatId: nonempty, error: shortText }).strict())
      .max(1_000),
    error: shortText.optional(),
    events: z.array(councilEventSchema).max(20_000),
  })
  .strict()
  .superRefine((run, context) => {
    if (run.events.some((event) => event.runId !== run.runId))
      context.addIssue({
        code: "custom",
        message: "run event belongs to another run",
      });
    const terminalEvent =
      run.status === "completed"
        ? "run.completed"
        : run.status === "failed"
          ? "run.failed"
          : "run.cancelled";
    if (!run.events.some((event) => event.type === terminalEvent))
      context.addIssue({
        code: "custom",
        message: "run lacks its matching terminal event",
      });
    if ((run.status === "completed") !== (run.chair !== undefined))
      context.addIssue({
        code: "custom",
        message: "recommendation does not match completed run status",
      });
  });

export const projectCouncilJobReadSchema = z
  .object({
    runId: nonempty,
    status: z.enum([
      "running",
      "cancelling",
      "completed",
      "failed",
      "cancelled",
    ]),
    startedAt: date,
    updatedAt: date,
    events: z.array(councilEventSchema).max(20_000),
    discussion: z.array(discussionRoundSchema).max(32).optional(),
    profile: profileSchema.optional(),
    run: councilRunSchema.optional(),
    error: shortText.optional(),
    persistenceStatus: z.enum(["pending", "saved", "failed"]).optional(),
    persistenceError: shortText.optional(),
  })
  .strict()
  .superRefine((job, context) => {
    if (
      job.run &&
      (job.run.runId !== job.runId || job.run.status !== job.status)
    )
      context.addIssue({
        code: "custom",
        message: "job and run identity/status disagree",
      });
    if (
      job.run &&
      job.profile &&
      JSON.stringify(job.profile) !== JSON.stringify(job.run.profile)
    )
      context.addIssue({
        code: "custom",
        message: "job profile does not match completed run profile",
      });
    if (job.status === "completed" && job.run === undefined)
      context.addIssue({
        code: "custom",
        message: "completed job lacks its result",
      });
    if (job.events.some((event) => event.runId !== job.runId))
      context.addIssue({
        code: "custom",
        message: "job event belongs to another run",
      });
  });

export type ProjectCouncilJobRead = z.infer<typeof projectCouncilJobReadSchema>;

const provenanceSchema = z
  .object({
    version: z.literal(1),
    requestId: z
      .string()
      .uuid()
      .refine((value) => value === value.toLowerCase()),
    intentHash: digest,
    runId: nonempty.max(120),
    projectId: z
      .string()
      .regex(
        /^project-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    workspace: nonempty.max(4096),
    catalogRevision: integer,
    scopeHash: digest,
  })
  .strict();

export const projectCouncilRunReadSchema = z
  .object({
    version: z.literal(1),
    provenance: provenanceSchema,
    receipt: projectCouncilReceiptSchema,
    job: projectCouncilJobReadSchema.nullable(),
    verdictCommentPreview: shortText.nullable(),
  })
  .strict()
  .superRefine((read, context) => {
    const { provenance, receipt, job } = read;
    if (
      receipt.metadata.requestId !== provenance.requestId ||
      receipt.metadata.intentHash !== provenance.intentHash ||
      receipt.metadata.runId !== provenance.runId ||
      receipt.metadata.projectId !== provenance.projectId
    )
      context.addIssue({
        code: "custom",
        message: "receipt does not match run provenance",
      });
    if (
      job &&
      (job.runId !== provenance.runId ||
        (job.run?.runId !== undefined && job.run.runId !== provenance.runId))
    )
      context.addIssue({
        code: "custom",
        message: "job does not match run provenance",
      });
    if (job?.events.some((event) => event.runId !== provenance.runId))
      context.addIssue({
        code: "custom",
        message: "event does not match run provenance",
      });
    if (receipt.phase === "completed" && job?.run?.status !== "completed")
      context.addIssue({
        code: "custom",
        message: "completed receipt lacks a completed result",
      });
    if (job?.run?.status === "completed" && receipt.phase !== "completed")
      context.addIssue({
        code: "custom",
        message: "completed result lacks a completed receipt",
      });
    if (["reserved", "retired"].includes(receipt.phase) && job !== null)
      context.addIssue({
        code: "custom",
        message: "unadmitted receipt cannot carry a job",
      });
    if (
      receipt.phase === "running" &&
      (!job || (job.status !== "running" && job.status !== "cancelling"))
    )
      context.addIssue({
        code: "custom",
        message: "running receipt requires a running job",
      });
    if (
      (receipt.phase === "failed" || receipt.phase === "cancelled") &&
      job !== null &&
      job.status !== receipt.phase
    )
      context.addIssue({
        code: "custom",
        message: "terminal receipt and job status disagree",
      });
    if (receipt.phase === "unknown" && job !== null)
      context.addIssue({
        code: "custom",
        message: "unknown receipt cannot carry an unverified job",
      });
    if (
      read.verdictCommentPreview !== null &&
      (receipt.phase !== "completed" || job?.run?.status !== "completed")
    )
      context.addIssue({
        code: "custom",
        message: "verdict preview requires a completed result",
      });
    try {
      if (
        new TextEncoder().encode(JSON.stringify(read)).byteLength >
        MAX_PROJECT_COUNCIL_RUN_RESPONSE_BYTES
      )
        context.addIssue({
          code: "custom",
          message: "Council run response exceeds 8 MiB",
        });
    } catch {
      context.addIssue({
        code: "custom",
        message: "Council run response is not serializable",
      });
    }
  });

export type ProjectCouncilRunProvenance = z.infer<typeof provenanceSchema>;
export type ProjectCouncilRunRead = z.infer<typeof projectCouncilRunReadSchema>;

/** Browser-safe projection; provider prompts and artifact paths are excluded. */
export function projectCouncilRunRead(
  provenance: ProjectCouncilRunProvenance,
  receipt: ProjectCouncilReceipt,
  job: CouncilServiceJob | null,
  verdictCommentPreview: string | null,
): ProjectCouncilRunRead {
  const publicJob = job
    ? {
        runId: job.runId,
        status: job.status,
        startedAt: job.startedAt,
        updatedAt: job.updatedAt,
        events: job.events,
        ...(job.discussion === undefined ? {} : { discussion: job.discussion }),
        ...(job.profile === undefined ? {} : { profile: job.profile }),
        ...(job.run === undefined ? {} : { run: job.run }),
        ...(job.error === undefined ? {} : { error: job.error }),
        ...(job.persistenceStatus === undefined
          ? {}
          : { persistenceStatus: job.persistenceStatus }),
        ...(job.persistenceError === undefined
          ? {}
          : { persistenceError: job.persistenceError }),
      }
    : null;
  return projectCouncilRunReadSchema.parse({
    version: 1,
    provenance,
    receipt,
    job: publicJob,
    verdictCommentPreview,
  });
}
