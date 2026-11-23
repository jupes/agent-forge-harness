import { z } from "zod";
import type {
  KeeperProposal,
  KeeperProposalDraft,
  KeeperProposalExecution,
  KeeperProposalJournal,
  KeeperProposalMessage,
  KeeperProposalPage,
  KeeperProposalReceipt,
  KeeperProposalRecord,
} from "../../types/keeper-proposal";

if (typeof window !== "undefined") z.config({ jitless: true });
export const MAX_KEEPER_PROPOSAL_BYTES = 24_000;
const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const name = z.string().trim().min(1).max(80);
const text = (max: number) => z.string().trim().min(1).max(max);
const action = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("approve-beads"),
      beadIds: z
        .array(id)
        .min(1)
        .max(16)
        .refine((ids) => new Set(ids).size === ids.length),
    })
    .strict(),
  z
    .object({
      kind: z.literal("start-session"),
      provider: z.enum(["claude", "codex", "gemini", "grok"]),
      smith: name,
      beadId: id,
      repository: text(4096).refine((value) => !/[\0\r\n]/.test(value)),
      worktree: z.enum(["current", "new"]),
      prompt: text(4000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("start-shift"),
      durationMinutes: z.number().int().min(1).max(1440),
      concurrency: z.number().int().min(1).max(8),
      beadLimit: z.number().int().min(1).max(100),
      spendLimitUsd: z.number().positive().max(1000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("send-to-council"),
      beadId: id,
      profile: name,
      question: text(2000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("create-beads"),
      beads: z
        .array(
          z
            .object({
              title: text(200),
              type: z.enum(["task", "feature", "bug", "chore", "epic"]),
              priority: z.union([
                z.literal(0),
                z.literal(1),
                z.literal(2),
                z.literal(3),
                z.literal(4),
              ]),
              parentId: id,
              description: text(6000),
            })
            .strict(),
        )
        .min(1)
        .max(8),
    })
    .strict(),
  z
    .object({
      kind: z.literal("manage-bead"),
      beadId: id,
      operation: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("pause") }).strict(),
        z.object({ kind: z.literal("resume") }).strict(),
        z.object({ kind: z.literal("reassign"), smith: name }).strict(),
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("record-decision"),
      beadId: id,
      decision: text(3000),
    })
    .strict(),
]);
export const keeperProposalDraftSchema: z.ZodType<KeeperProposalDraft> = z
  .object({ title: text(120), detail: text(1000), action })
  .strict();
export const keeperProposalMessageSchema: z.ZodType<KeeperProposalMessage> = z
  .object({
    kind: z.literal("keeper.proposals.v1"),
    message: text(4000),
    proposals: z.array(keeperProposalDraftSchema).min(1).max(7),
  })
  .strict();

/** Whole structured messages only; quoted examples and partial streams are never actionable. */
export function parseKeeperProposalMessage(
  text: string,
): KeeperProposalMessage | null {
  if (new TextEncoder().encode(text).byteLength > MAX_KEEPER_PROPOSAL_BYTES)
    return null;
  let raw: unknown;
  try {
    raw = JSON.parse(
      text.trim().replace(/^```json\s*\n([\s\S]*)\n```$/i, "$1"),
    );
  } catch {
    return null;
  }
  const parsed = keeperProposalMessageSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const count = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const keeperProposalApprovalSchema = z
  .object({
    id: z.string().min(1).max(100),
    sourceHash: hash,
    requestId: z.string().uuid(),
    expectedRevision: count,
    draft: keeperProposalDraftSchema,
  })
  .strict();
export const keeperProposalDismissalSchema = keeperProposalApprovalSchema
  .omit({ draft: true })
  .strict();
export const keeperProposalSchema: z.ZodType<KeeperProposal> = z
  .object({
    id: z.string().max(100),
    projectId: z.string().max(100),
    sourceRequestId: z.string().uuid(),
    sourceHash: hash,
    createdAt: z.iso.datetime(),
    draft: keeperProposalDraftSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.id.startsWith(`proposal-${value.sourceRequestId}-`) &&
      /^[0-6]$/.test(value.id.slice(-1)) &&
      value.id.length === `proposal-${value.sourceRequestId}-0`.length,
  );
const object = z
  .object({
    kind: z.enum(["bead", "session", "run", "event"]),
    id: z.string().min(1).max(200),
  })
  .strict();
export const keeperProposalExecutionSchema: z.ZodType<KeeperProposalExecution> =
  z
    .object({
      phase: z.enum(["approved", "done", "failed", "unknown"]),
      message: text(1000),
      objects: z.array(object).max(16),
    })
    .strict();
export const keeperProposalRecordSchema: z.ZodType<KeeperProposalRecord> = z
  .object({
    id: z.string().max(100),
    projectId: z.string().max(100),
    sourceRequestId: z.string().uuid(),
    sourceHash: hash,
    createdAt: z.iso.datetime(),
    draft: keeperProposalDraftSchema,
    requestId: z.string().uuid(),
    requestHash: hash,
    operation: z.enum(["approve", "dismiss"]),
    auditEventId: count.min(1),
    phase: z.enum(["approved", "done", "failed", "unknown", "dismissed"]),
    pending: z.boolean(),
    updatedAt: z.iso.datetime(),
    message: text(1000),
    objects: z.array(object).max(16),
  })
  .strict()
  .refine(
    (value) =>
      (!value.pending || value.phase === "approved") &&
      (value.operation !== "dismiss" || value.phase === "dismissed") &&
      keeperProposalSchema.safeParse({
        id: value.id,
        projectId: value.projectId,
        sourceRequestId: value.sourceRequestId,
        sourceHash: value.sourceHash,
        createdAt: value.createdAt,
        draft: value.draft,
      }).success,
  );
export const keeperProposalJournalSchema: z.ZodType<KeeperProposalJournal> = z
  .object({
    version: z.literal(1),
    projectId: z.string().max(100),
    revision: count,
    records: z.array(keeperProposalRecordSchema).max(1000),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.records.map((record) => record.id)).size ===
        value.records.length &&
      new Set(value.records.map((record) => record.requestId)).size ===
        value.records.length &&
      value.records.every((record) => record.projectId === value.projectId),
  );
export const keeperProposalReceiptSchema: z.ZodType<KeeperProposalReceipt> = z
  .object({
    projectId: z.string().max(100),
    revision: count,
    record: keeperProposalRecordSchema,
  })
  .strict()
  .refine((value) => value.record.projectId === value.projectId);
export const keeperProposalPageSchema: z.ZodType<KeeperProposalPage> = z
  .object({
    projectId: z.string().max(100),
    revision: count,
    conversationRevision: count,
    request: keeperProposalRecordSchema.nullable(),
    asOf: z.iso.datetime(),
    complete: z.boolean(),
    problems: z.array(z.string().max(1000)).max(16),
    proposals: z
      .array(
        z
          .object({
            proposal: keeperProposalSchema,
            record: keeperProposalRecordSchema.nullable(),
            available: z.boolean(),
            destinationAvailable: z.boolean(),
            reason: z.string().max(1000).nullable(),
            activity: z
              .object({
                id: count.min(1),
                at: z.iso.datetime(),
                action: z.enum([
                  "keeper.proposal.approve",
                  "keeper.proposal.dismiss",
                  "keeper.proposal.session.start",
                ]),
                surface: z.string().min(1).max(40),
                target: z.string().max(100),
              })
              .strict()
              .nullable(),
          })
          .strict(),
      )
      .max(40),
  })
  .strict()
  .refine(
    (value) =>
      (!value.request || value.request.projectId === value.projectId) &&
      value.proposals.every(
        (card) =>
          card.proposal.projectId === value.projectId &&
          (!card.record ||
            (card.record.id === card.proposal.id &&
              card.record.projectId === value.projectId &&
              card.record.sourceHash === card.proposal.sourceHash)) &&
          (!card.activity ||
            (card.activity.id === card.record?.auditEventId &&
              card.activity.target === card.proposal.id)),
      ),
  );
