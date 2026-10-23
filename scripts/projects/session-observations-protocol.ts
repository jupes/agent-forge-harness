import { z } from "zod";
import { SESSION_KINDS, type SessionSummary } from "../../types/hearth";
import type {
  ProjectSessionObservations,
  SessionObservationDetail,
  SessionObservedActivity,
  SessionOwnershipMetadata,
} from "../../types/session-observations";
import { ownedCodingSessionSchema } from "../sessions/codex-owned-wire-protocol";
import { sessionProjectIdSchema } from "../sessions/identity-protocol";
import { projectShiftAttemptOriginSchema } from "../sessions/shift-origin-protocol";

if (typeof window !== "undefined") z.config({ jitless: true });

export const MAX_OBSERVATION_INDEX_BYTES = 4 * 1024 * 1024;
export const MAX_OBSERVATION_DETAIL_BYTES = 256 * 1024;
const text = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value));
export const observationSessionIdSchema = text.max(256);
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const sessionOwnershipMetadataSchema: z.ZodType<SessionOwnershipMetadata> =
  z
    .object({
      record: ownedCodingSessionSchema,
      origin: projectShiftAttemptOriginSchema.nullable(),
    })
    .strict()
    .refine(
      (value) =>
        !value.origin ||
        (value.origin.projectId === value.record.projectId &&
          value.origin.beadId === value.record.beadId),
    );

export const sessionObservationSummarySchema: z.ZodType<SessionSummary> = z
  .object({
    sessionId: observationSessionIdSchema,
    workspace: text,
    kind: z.enum(SESSION_KINDS).optional(),
    worktree: text.optional(),
    parentSessionId: observationSessionIdSchema.optional(),
    executor: z
      .object({
        provider: text.max(200),
        model: text.max(200),
        effort: text.max(200).optional(),
        smith: text.max(200).optional(),
        sessionId: observationSessionIdSchema.optional(),
      })
      .strict()
      .optional(),
    beadId: text.max(200).optional(),
    runId: text.max(200).optional(),
    startedAt: z.iso.datetime().optional(),
    lastEventAt: z.iso.datetime(),
    endedAt: z.iso.datetime().optional(),
  })
  .strict()
  .transform((value) => ({
    sessionId: value.sessionId,
    workspace: value.workspace,
    lastEventAt: value.lastEventAt,
    ...(value.kind !== undefined ? { kind: value.kind } : {}),
    ...(value.worktree !== undefined ? { worktree: value.worktree } : {}),
    ...(value.parentSessionId !== undefined
      ? { parentSessionId: value.parentSessionId }
      : {}),
    ...(value.beadId !== undefined ? { beadId: value.beadId } : {}),
    ...(value.runId !== undefined ? { runId: value.runId } : {}),
    ...(value.startedAt !== undefined ? { startedAt: value.startedAt } : {}),
    ...(value.endedAt !== undefined ? { endedAt: value.endedAt } : {}),
    ...(value.executor
      ? {
          executor: {
            provider: value.executor.provider,
            model: value.executor.model,
            ...(value.executor.effort !== undefined
              ? { effort: value.executor.effort }
              : {}),
            ...(value.executor.smith !== undefined
              ? { smith: value.executor.smith }
              : {}),
            ...(value.executor.sessionId !== undefined
              ? { sessionId: value.executor.sessionId }
              : {}),
          },
        }
      : {}),
  }));

const source = {
  projectId: sessionProjectIdSchema,
  workspace: text,
  asOf: z.iso.datetime(),
};
export const projectSessionObservationsSchema: z.ZodType<ProjectSessionObservations> =
  z
    .object({
      ...source,
      observations: z.array(sessionObservationSummarySchema).max(500),
      observationsComplete: z.boolean(),
      ownership: z.discriminatedUnion("available", [
        z
          .object({
            available: z.literal(true),
            records: z.array(sessionOwnershipMetadataSchema).max(1000),
            reason: z.null(),
          })
          .strict(),
        z
          .object({
            available: z.literal(false),
            records: z.tuple([]),
            reason: text.max(2048),
          })
          .strict(),
      ]),
      problems: z.array(text.max(2048)).max(30),
    })
    .strict()
    .refine(
      (value) =>
        new Set(value.observations.map((row) => row.sessionId)).size ===
          value.observations.length &&
        value.observations.every((row) => row.workspace === value.workspace) &&
        new Set(value.ownership.records.map((row) => row.record.id)).size ===
          value.ownership.records.length &&
        value.ownership.records.every(
          (row) =>
            row.record.projectId === value.projectId &&
            row.record.workspace === value.workspace,
        ) &&
        new TextEncoder().encode(JSON.stringify(value)).byteLength <=
          MAX_OBSERVATION_INDEX_BYTES,
    );

const eventBase = { id: sequence.positive(), at: z.iso.datetime() };
export const sessionObservedActivitySchema: z.ZodType<SessionObservedActivity> =
  z.discriminatedUnion("kind", [
    z.object({ ...eventBase, kind: z.literal("session.started") }).strict(),
    z
      .object({
        ...eventBase,
        kind: z.literal("session.ended"),
        reason: text.nullable(),
        durationMs: z.number().finite().nonnegative().nullable(),
      })
      .strict(),
    z
      .object({
        ...eventBase,
        kind: z.literal("prompt.submitted"),
        length: sequence,
      })
      .strict(),
    z
      .object({
        ...eventBase,
        kind: z.literal("tool.called"),
        tool: text.max(200),
        durationMs: z.number().finite().nonnegative().nullable(),
        exitCode: z.number().int().finite().nullable(),
      })
      .strict(),
  ]);

export const sessionObservationDetailSchema: z.ZodType<SessionObservationDetail> =
  z
    .object({
      ...source,
      sessionId: observationSessionIdSchema,
      observation: sessionObservationSummarySchema.nullable(),
      owner: sessionOwnershipMetadataSchema.nullable(),
      ownershipAvailable: z.boolean(),
      ownershipReason: text.max(2048).nullable(),
      parent: z
        .object({ id: observationSessionIdSchema, available: z.boolean() })
        .strict()
        .nullable(),
      after: sequence,
      nextAfter: sequence,
      more: z.boolean(),
      activity: z.array(sessionObservedActivitySchema).max(100),
      problems: z.array(text.max(2048)).max(30),
    })
    .strict()
    .refine(
      (value) =>
        !!(value.observation || value.owner) &&
        (!value.observation ||
          (value.observation.sessionId === value.sessionId &&
            value.observation.workspace === value.workspace)) &&
        (!value.owner ||
          (value.owner.record.id === value.sessionId &&
            value.owner.record.projectId === value.projectId &&
            value.owner.record.workspace === value.workspace)) &&
        (value.ownershipAvailable
          ? value.ownershipReason === null
          : !!value.ownershipReason && value.owner === null) &&
        (!value.parent || value.parent.id !== value.sessionId) &&
        value.nextAfter >= value.after &&
        value.activity.every(
          (event, index) =>
            event.id > (index ? value.activity[index - 1]!.id : value.after) &&
            event.id <= value.nextAfter,
        ) &&
        new TextEncoder().encode(JSON.stringify(value)).byteLength <=
          MAX_OBSERVATION_DETAIL_BYTES,
    );
