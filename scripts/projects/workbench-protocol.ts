import { z } from "zod";
import { BENCH_NAMES, QUEUE_STATES, type QueueEntry } from "../../types/hearth";
import type { ProjectWorkbenchPage } from "../../types/project-workbench";

if (typeof window !== "undefined") z.config({ jitless: true });
const word = z
  .string()
  .min(1)
  .max(1024)
  .refine((text) => !/[\p{Cc}\p{Cs}]/u.test(text));
export const workbenchHostSchema = z
  .object({
    busy: z.boolean(),
    cpu: z.number().finite().min(0).max(1).nullable(),
    memory: z.number().finite().min(0).max(1),
    threshold: z.number().finite().min(0.1).max(1),
    reason: word.optional(),
  })
  .strict();
export const projectWorkbenchPageSchema: z.ZodType<ProjectWorkbenchPage> = z
  .object({
    projectId: word.max(100),
    workspace: word,
    asOf: z.string().max(100),
    complete: z.boolean(),
    problems: z.array(z.string().max(2048)).max(100),
    host: workbenchHostSchema.nullable(),
    smiths: z
      .object({ names: z.array(word).max(200), defaultSmith: word.nullable() })
      .strict()
      .nullable(),
    cards: z
      .array(
        z
          .object({
            entry: z
              .object({
                beadId: word.max(200),
                title: word,
                state: z.enum(QUEUE_STATES),
                status: word.max(80),
                priority: z.number().int().min(0).max(4).optional(),
                type: word.max(80).optional(),
                backed: z.boolean().optional(),
                smith: word.optional(),
                resume: z.enum(QUEUE_STATES).optional(),
              })
              .strict()
              .transform((entry): QueueEntry => {
                const value: QueueEntry = {
                  beadId: entry.beadId,
                  title: entry.title,
                  state: entry.state,
                  status: entry.status,
                };
                if (entry.priority !== undefined)
                  value.priority = entry.priority;
                if (entry.type !== undefined) value.type = entry.type;
                if (entry.backed !== undefined) value.backed = entry.backed;
                if (entry.smith !== undefined) value.smith = entry.smith;
                if (entry.resume !== undefined) value.resume = entry.resume;
                return value;
              }),
            moves: z
              .array(
                z.enum([
                  "propose",
                  "approve",
                  "queue",
                  "pause",
                  "resume",
                  "reassign",
                ]),
              )
              .max(6),
            complexity: z.enum(BENCH_NAMES).nullable(),
            smith: z
              .object({
                name: word.nullable(),
                via: z.enum(["bead", "bench", "default"]).nullable(),
                reason: z.string().max(2048).nullable(),
              })
              .strict(),
            updatedAt: z.string().max(100),
            note: z.string().max(2048).nullable(),
            eligibility: z
              .object({
                may: z.boolean().nullable(),
                reason: z.string().min(1).max(2048),
                waitsOn: word.max(200).nullable(),
              })
              .strict()
              .nullable(),
            session: z
              .object({
                id: word.max(200),
                provider: word.max(80).nullable(),
                worktree: word.nullable(),
                startedAt: z.string().max(100).nullable(),
              })
              .strict()
              .nullable(),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();
