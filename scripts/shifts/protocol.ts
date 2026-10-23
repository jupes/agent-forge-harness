import { z } from "zod";
import type {
  ProjectShiftOptions,
  ProjectShiftStartRequest,
} from "../../types/project-shifts";
import { SHIFT_LIMITS, SHIFT_MAX_USD } from "../config/defaults";

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

export const shiftRequestIdSchema = z
  .uuid()
  .refine((value) => value === value.toLowerCase());
export const projectShiftStartSchema: z.ZodType<ProjectShiftStartRequest> = z
  .object({
    requestId: shiftRequestIdSchema,
    expectedCatalogRevision: count,
    options: z
      .object({
        for: word.max(20).regex(/^[1-9]\d{0,5}[smh]$/),
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
        base: word.max(200),
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
      .strict(),
  })
  .strict();

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
