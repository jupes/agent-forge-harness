import { z } from "zod";

export const terminalHandoffRequestSchema = z
  .object({ requestId: z.uuid() })
  .strict();

export const terminalHandoffAttemptSchema = z
  .object({
    projectId: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(200),
    turnRequestId: z.uuid(),
    requestId: z.uuid(),
    phase: z.enum(["opening", "opened", "closed", "refused", "unknown"]),
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime().nullable(),
    auditEventId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export const terminalHandoffPageSchema = z
  .object({ attempt: terminalHandoffAttemptSchema.nullable() })
  .strict();

export type TerminalHandoffAttempt = z.infer<
  typeof terminalHandoffAttemptSchema
>;
