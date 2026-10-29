import { z } from "zod";
import type {
  KeeperBriefContent,
  KeeperBriefIntent,
  KeeperBriefIntentHistory,
  KeeperBriefIntentMetadata,
  KeeperBriefIntentReference,
  KeeperBriefIntentReserveRequest,
  KeeperBriefOriginBinding,
  KeeperBriefOriginRequest,
  KeeperBriefSelection,
  KeeperBriefSnapshot,
  KeeperBriefs,
} from "../../types/keeper-brief";

if (typeof window !== "undefined") z.config({ jitless: true });
export const MAX_BRIEF_SNAPSHOT_BYTES = 10_000;
export const MAX_KEEPER_BRIEF_INTENT_HISTORY = 32;
export const MAX_KEEPER_BRIEF_INTENT_BYTES = 300_000;
const count = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
export const briefRefreshSchema = z
  .object({ requestId: z.string().uuid(), expectedRevision: count })
  .strict();
const object = z
  .object({
    kind: z.enum(["bead", "session", "run", "event"]),
    id: z.string().min(1).max(200),
  })
  .strict();
export const keeperBriefOriginBindingSchema: z.ZodType<KeeperBriefOriginBinding> =
  z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("overview"),
        projectId: z.string().min(1).max(100),
        workspace: z.string().min(1).max(4096),
        catalogRevision: count,
      })
      .strict(),
    z
      .object({
        kind: z.literal("onboarding"),
        projectId: z.string().min(1).max(100),
        workspace: z.string().min(1).max(4096),
        catalogRevision: count,
        projectCreate: z
          .object({
            requestId: z.string().uuid(),
            hash: z.string().regex(/^[a-f0-9]{64}$/),
            scopeHash: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
            revision: count,
          })
          .strict(),
      })
      .strict(),
  ]);
export const keeperBriefSelectionSchema: z.ZodType<KeeperBriefSelection> = z
  .object({
    name: z.string().min(1).max(200),
    provider: z.string().min(1).max(200),
    model: z.string().min(1).max(200),
    effort: z.string().max(100),
    enabled: z.literal(true),
    tags: z.array(z.string().max(200)).max(100),
  })
  .strict();
export const keeperBriefIntentOriginRequestSchema: z.ZodType<KeeperBriefOriginRequest> =
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("overview") }).strict(),
    z
      .object({
        kind: z.literal("onboarding"),
        projectCreateRequestId: z.string().uuid(),
      })
      .strict(),
  ]);
export const keeperBriefIntentReserveRequestSchema: z.ZodType<KeeperBriefIntentReserveRequest> = z
  .object({
    expectedRevision: count,
    origin: keeperBriefIntentOriginRequestSchema,
  })
  .strict();
export const briefSnapshotSchema: z.ZodType<KeeperBriefSnapshot> = z
  .object({
    version: z.literal(1),
    projectId: z.string().max(100),
    projectName: z.string().max(120),
    workspace: z.string().max(4096),
    catalogRevision: count,
    asOf: z.iso.datetime(),
    since: z.iso.datetime(),
    scope: z
      .object({
        label: z.string().max(100),
        epicIds: z.array(z.string().max(200)).max(8),
        epicCount: count,
        repositoryCount: count,
      })
      .strict(),
    observed: z
      .object({
        beads: count.nullable(),
        queue: count.nullable(),
        sessions: count.nullable(),
        runs: count.nullable(),
        activity: count.nullable(),
      })
      .strict(),
    complete: z.boolean(),
    limitations: z.array(z.string().max(500)).max(16),
    facts: z
      .array(
        z
          .object({
            section: z.enum(["moving", "waiting", "stuck", "context"]),
            object,
            title: z.string().max(140),
            state: z.string().max(120),
            at: z.iso.datetime().nullable(),
          })
          .strict(),
      )
      .max(40),
  })
  .strict()
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength <=
        MAX_BRIEF_SNAPSHOT_BYTES &&
      Date.parse(value.since) <= Date.parse(value.asOf),
  );
export const keeperBriefIntentReserveSchema = z
  .object({
    expectedRevision: count,
    origin: keeperBriefOriginBindingSchema,
    selection: keeperBriefSelectionSchema,
    text: z
      .string()
      .min(1)
      .max(16_384)
      .refine((value) => !!value.trim() && !value.includes("\0")),
    about: z.array(object).max(16),
    snapshot: briefSnapshotSchema,
  })
  .strict();
export const keeperBriefIntentReferenceSchema: z.ZodType<KeeperBriefIntentReference> = z
  .object({
    requestId: z.string().uuid(),
    expectedRevision: count,
    intentHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const keeperBriefIntentRetireSchema = z
  .object({
    requestId: z.string().uuid(),
    intentHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const section = z
  .array(
    z
      .object({
        text: z.string().trim().min(1).max(480),
        facts: z.array(z.number().int().nonnegative().max(39)).min(1).max(6),
      })
      .strict(),
  )
  .max(4);
export const briefContentSchema: z.ZodType<KeeperBriefContent> = z
  .object({
    summary: z.string().trim().min(1).max(800),
    moving: section,
    waiting: section,
    stuck: section,
  })
  .strict();
export const keeperBriefIntentOriginalSchema: z.ZodType<KeeperBriefIntent> = z
  .object({
    version: z.literal(1),
    requestId: z.string().uuid(),
    projectId: z.string().min(1).max(100),
    conversationId: z.string().min(1).max(200),
    expectedRevision: count,
    origin: keeperBriefOriginBindingSchema,
    selection: keeperBriefSelectionSchema,
    purpose: z.literal("brief"),
    intentHash: z.string().regex(/^[a-f0-9]{64}$/),
    text: z
      .string()
      .min(1)
      .max(16_384)
      .refine((value) => !!value.trim() && !value.includes("\0")),
    about: z.array(object).max(16),
    snapshot: briefSnapshotSchema,
    createdAt: z.iso.datetime(),
    state: z.enum(["reserved", "admitted", "retired"]),
    preparedTurnHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const keeperBriefIntentMetadataSchema: z.ZodType<KeeperBriefIntentMetadata> =
  z
    .object({
      version: z.literal(1),
      requestId: z.string().uuid(),
      projectId: z.string().min(1).max(100),
      conversationId: z.string().min(1).max(200),
      expectedRevision: count,
      origin: keeperBriefOriginBindingSchema,
      selection: keeperBriefSelectionSchema,
      purpose: z.literal("brief"),
      intentHash: z.string().regex(/^[a-f0-9]{64}$/),
      createdAt: z.iso.datetime(),
      state: z.enum(["reserved", "admitted", "retired"]),
      preparedTurnHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict();
export const keeperBriefIntentHistorySchema: z.ZodType<KeeperBriefIntentHistory> =
  z
    .object({
      version: z.literal(1),
      active: keeperBriefIntentOriginalSchema.nullable(),
      history: z
        .array(keeperBriefIntentOriginalSchema)
        .max(MAX_KEEPER_BRIEF_INTENT_HISTORY),
    })
    .strict()
    .refine(
      (value) =>
        (!value.active || value.active.state !== "retired") &&
        value.history.every((item) => item.state !== "reserved") &&
        new Set([
          ...(value.active ? [value.active.requestId] : []),
          ...value.history.map((item) => item.requestId),
        ]).size ===
          value.history.length + (value.active ? 1 : 0) &&
        new TextEncoder().encode(JSON.stringify(value)).byteLength <=
          MAX_KEEPER_BRIEF_INTENT_BYTES,
    );
const brief = z
  .object({
    requestId: z.string().uuid(),
    createdAt: z.iso.datetime(),
    snapshot: briefSnapshotSchema,
    content: briefContentSchema,
  })
  .strict();
export const briefsSchema: z.ZodType<KeeperBriefs> = z
  .object({
    projectId: z.string().max(100),
    revision: count,
    latest: brief.nullable(),
    earlier: z.array(brief).max(10),
    refresh: z
      .object({
        requestId: z.string().uuid(),
        phase: z.enum([
          "accepted",
          "running",
          "cancelling",
          "completed",
          "cancelled",
          "failed",
          "unknown",
        ]),
        problem: z.string().max(1000).nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
