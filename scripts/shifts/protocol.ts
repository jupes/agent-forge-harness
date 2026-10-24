import { z } from "zod";
import type {
  ProjectShiftIntent,
  ProjectShiftOptions,
  ProjectShiftReceipt,
  ProjectShiftStartOptions,
  ProjectShiftStartRequest,
  ProjectShiftsPage,
} from "../../types/project-shifts";
import { SHIFT_LIMITS, SHIFT_MAX_USD } from "../config/defaults";
import { parseDuration } from "../config/duration";
import { isBaseBranch } from "../scheduler/shift-base";

if (typeof window !== "undefined") z.config({ jitless: true });
export const ATTENDED_SHIFT_UNAVAILABLE =
  "Start is unavailable until attended shift runs have a verified private transcript. No shift was started.";
const word = z
  .string()
  .min(1)
  .max(1024)
  .refine((text) => !/[\p{Cc}\p{Cs}]/u.test(text));
const id = word.max(200);
const count = z.number().int().nonnegative();
const range = z.tuple([count, count]);
const sourced = <T extends z.ZodType>(value: T) =>
  z.object({ value, source: word }).strict();

export const shiftHostSnapshotSchema = z
  .object({
    asOf: z.iso.datetime(),
    cpu: z.number().finite().min(0).max(1).nullable(),
    memory: z.number().finite().min(0).max(1).nullable(),
    busy: z.boolean(),
  })
  .strict();

export const shiftRequestIdSchema = z
  .uuid()
  .refine((value) => value === value.toLowerCase());
export const projectShiftStartOptionsSchema: z.ZodType<ProjectShiftStartOptions> =
  z
    .object({
      for: word.max(20).refine((text) => {
        const ms = parseDuration(text);
        return (
          ms !== null &&
          ms >= SHIFT_LIMITS.forMs[0] &&
          ms <= SHIFT_LIMITS.forMs[1]
        );
      }),
      concurrency: z
        .number()
        .int()
        .min(SHIFT_LIMITS.concurrency[0])
        .max(SHIFT_LIMITS.concurrency[1]),
      maxBeads: z
        .number()
        .int()
        .min(SHIFT_LIMITS.maxBeads[0])
        .max(SHIFT_LIMITS.maxBeads[1]),
      maxUsd: z.number().finite().positive().max(SHIFT_MAX_USD),
      repairs: z
        .number()
        .int()
        .min(SHIFT_LIMITS.repairs[0])
        .max(SHIFT_LIMITS.repairs[1]),
      base: word.refine(isBaseBranch),
      epic: id.optional(),
      smith: word
        .max(64)
        .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
        .optional(),
      runTimeout: word
        .max(20)
        .regex(/^[1-9]\d{0,5}[smh]$/)
        .optional(),
    })
    .strict();
export const projectShiftStartSchema: z.ZodType<ProjectShiftStartRequest> = z
  .object({
    requestId: shiftRequestIdSchema,
    expectedCatalogRevision: count,
    options: projectShiftStartOptionsSchema,
  })
  .strict();

export const projectShiftIntentSchema: z.ZodType<ProjectShiftIntent> = z
  .object({
    projectId: word.regex(
      /^project-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ),
    workspace: word,
    shiftId: word.regex(/^shift-\d{8}-\d{6}-[0-9a-f]{4}$/),
    request: projectShiftStartSchema,
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.iso.datetime(),
    attemptedAt: z.iso.datetime().nullable(),
    executionStartedAt: z.iso.datetime().nullable().optional(),
    startupStop: z
      .object({
        requestedAt: z.iso.datetime(),
        completedAt: z.iso.datetime().nullable(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (intent) =>
      !intent.startupStop ||
      (intent.attemptedAt !== null &&
        Date.parse(intent.startupStop.requestedAt) >=
          Date.parse(intent.attemptedAt) &&
        (intent.startupStop.completedAt === null ||
          Date.parse(intent.startupStop.completedAt) >=
            Date.parse(intent.startupStop.requestedAt))),
  );
export const projectShiftReceiptSchema: z.ZodType<ProjectShiftReceipt> = z
  .object({
    intent: projectShiftIntentSchema,
    observation: z
      .object({
        shiftId: word,
        requestId: shiftRequestIdSchema,
        phase: z.enum([
          "reserved",
          "unknown",
          "starting",
          "failed",
          "running",
          "throttled",
          "stopping",
          "stopped",
          "needs-recovery",
        ]),
        reason: word.nullable(),
        actual: z
          .object({
            startedAt: z.iso.datetime(),
            endedAt: z.iso.datetime().nullable(),
            deadline: z.iso.datetime(),
            concurrency: count,
            forMs: count,
            maxBeads: count,
            maxUsd: z.number().finite().positive(),
            repairs: count,
            throttle: z.number().finite().min(0.1).max(1).nullable(),
            base: word,
            epic: id.nullable(),
            smith: word.nullable(),
            runTimeoutMs: count.nullable(),
            spentUsd: z.number().finite().nonnegative(),
            unpriced: count,
            admitted: count.nullable(),
            reviewed: count,
            running: count,
            halted: count,
            host: shiftHostSnapshotSchema.nullable().optional(),
          })
          .strict()
          .nullable(),
      })
      .strict(),
  })
  .strict()
  .refine(
    (value) =>
      value.intent.shiftId === value.observation.shiftId &&
      value.intent.request.requestId === value.observation.requestId &&
      (value.observation.actual === null
        ? ["reserved", "unknown", "starting", "failed"].includes(
            value.observation.phase,
          ) ||
          (value.observation.phase === "stopping" &&
            value.intent.startupStop?.completedAt === null) ||
          (value.observation.phase === "stopped" &&
            typeof value.intent.startupStop?.completedAt === "string")
        : !["reserved", "unknown", "starting", "failed"].includes(
            value.observation.phase,
          )),
  );
export const projectShiftsPageSchema: z.ZodType<ProjectShiftsPage> = z
  .object({
    projectId: word,
    asOf: z.iso.datetime(),
    items: z.array(projectShiftReceiptSchema).max(1000),
  })
  .strict()
  .refine(
    (page) =>
      page.items.every((item) => item.intent.projectId === page.projectId) &&
      new Set(page.items.map((item) => item.intent.request.requestId)).size ===
        page.items.length &&
      new Set(page.items.map((item) => item.intent.shiftId)).size ===
        page.items.length,
  );

/** This module is renderer-safe; no private store or native runtime imports. */
export const projectShiftOptionsSchema: z.ZodType<ProjectShiftOptions> = z
  .object({
    projectId: word.max(100),
    workspace: word,
    catalogRevision: count,
    asOf: z.iso.datetime(),
    defaults: z
      .object({
        for: sourced(word),
        concurrency: sourced(count),
        maxBeads: sourced(count),
        maxUsd: sourced(z.number().finite().positive()),
        repairs: sourced(count),
        base: sourced(word),
        runTimeout: sourced(z.null()),
      })
      .strict(),
    limits: z
      .object({
        durationMs: range,
        concurrency: range,
        maxBeads: range,
        maxUsd: z.number().finite().positive(),
        repairs: range,
      })
      .strict(),
    epics: z.array(z.object({ id, title: word }).strict()).max(1000),
    smiths: z
      .object({ names: z.array(id).max(200), defaultSmith: id.nullable() })
      .strict(),
    availability: z
      .object({ start: z.boolean(), reason: word.nullable() })
      .strict(),
  })
  .strict();
