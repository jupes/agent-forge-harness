import { z } from "zod";
import type { ProjectShiftOptions } from "../../types/project-shifts";

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
