import { z } from "zod";
import { LEDGER_EVENT_KINDS } from "../../types/hearth";
import type {
  ProjectActivityDetail,
  ProjectActivityEvent,
  ProjectActivityFilters,
  ProjectActivityPage,
} from "../../types/project-activity";
import { sessionProjectIdSchema } from "../sessions/identity-protocol";

if (typeof window !== "undefined") z.config({ jitless: true });

export const MAX_ACTIVITY_PAGE_BYTES = 512 * 1024;
export const MAX_ACTIVITY_PAGE_EVENTS = 200;
const text = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value));
export const activityObjectIdSchema = text.max(256);
export const activitySequenceSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export const projectActivityFiltersSchema: z.ZodType<ProjectActivityFilters> = z
  .object({
    kinds: z.array(z.enum(LEDGER_EVENT_KINDS)).max(LEDGER_EVENT_KINDS.length),
    provider: text.max(200).nullable(),
    beadId: activityObjectIdSchema.nullable(),
    sessionId: activityObjectIdSchema.nullable(),
    runId: activityObjectIdSchema.nullable(),
    shiftId: activityObjectIdSchema.nullable(),
    since: z.iso.datetime().nullable(),
    until: z.iso.datetime().nullable(),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.kinds).size === value.kinds.length &&
      (!value.since ||
        !value.until ||
        Date.parse(value.since) <= Date.parse(value.until)),
  );

export const projectActivityEventSchema: z.ZodType<ProjectActivityEvent> = z
  .object({
    id: activitySequenceSchema.refine((value) => value > 0),
    ulid: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
    at: z.iso.datetime(),
    kind: z.enum(LEDGER_EVENT_KINDS),
    actor: z
      .object({
        provider: text.max(200),
        model: text.max(200),
        effort: text.max(200).nullable(),
        smith: text.max(200).nullable(),
      })
      .strict()
      .nullable(),
    beadId: activityObjectIdSchema.nullable(),
    sessionId: activityObjectIdSchema.nullable(),
    runId: activityObjectIdSchema.nullable(),
    summary: text,
    metadata: z
      .array(
        z
          .object({
            key: text.max(80),
            value: z.union([text, z.number().finite(), z.boolean()]),
          })
          .strict(),
      )
      .max(32),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.metadata.map((item) => item.key)).size ===
      value.metadata.length,
  );

const source = {
  projectId: sessionProjectIdSchema,
  workspace: text,
  asOf: z.iso.datetime(),
};
export const projectActivityPageSchema: z.ZodType<ProjectActivityPage> = z
  .object({
    ...source,
    filters: projectActivityFiltersSchema,
    after: activitySequenceSchema,
    nextAfter: activitySequenceSchema,
    more: z.boolean(),
    events: z.array(projectActivityEventSchema).max(MAX_ACTIVITY_PAGE_EVENTS),
    membershipComplete: z.boolean(),
    problems: z.array(text.max(2048)).max(30),
  })
  .strict()
  .refine(
    (value) =>
      value.nextAfter >= value.after &&
      (!value.more || value.nextAfter > value.after) &&
      value.events.every(
        (event, index) =>
          event.id > (value.events[index - 1]?.id ?? value.after) &&
          event.id <= value.nextAfter,
      ) &&
      new TextEncoder().encode(JSON.stringify(value)).length <=
        MAX_ACTIVITY_PAGE_BYTES,
  );

export const projectActivityDetailSchema: z.ZodType<ProjectActivityDetail> = z
  .object({
    ...source,
    event: projectActivityEventSchema,
  })
  .strict();
