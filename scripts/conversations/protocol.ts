import { z } from "zod";
import type {
  ConversationEvent,
  ConversationReceipt,
  ConversationSend,
  PreparedConversationSend,
} from "../../types/conversation";
import { briefSnapshotSchema } from "../keeper/brief-protocol";
import { ConversationError } from "./error";

// Select runtime validation before constructing schemas in the strict-CSP WebView.
if (typeof window !== "undefined") z.config({ jitless: true });

const uuid = z.string().uuid();
const object = z
  .object({
    kind: z.enum(["bead", "session", "run", "event"]),
    id: z.string().min(1).max(200),
  })
  .strict();
const sendSchema = z
  .object({
    requestId: uuid,
    expectedRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1),
    text: z.string().trim().min(1).max(16_384),
    about: z.array(object).max(16),
  })
  .strict();
export function parseConversationSend(input: unknown): ConversationSend {
  const parsed = sendSchema.safeParse(input);
  if (!parsed.success)
    throw new ConversationError(
      400,
      "Expected a request id, revision, message and bounded object references.",
    );
  return parsed.data;
}
const preparedSendSchema = sendSchema
  .extend({ brief: briefSnapshotSchema.optional() })
  .strict();
/** Private storage codec; the public message parser above never accepts intent. */
export function parsePreparedConversationSend(
  input: unknown,
): PreparedConversationSend {
  const parsed = preparedSendSchema.safeParse(input);
  if (!parsed.success)
    throw new ConversationError(
      400,
      "Expected a bounded prepared conversation request.",
    );
  return parsed.data;
}
export const isConversationRequestId = (value: unknown): value is string =>
  uuid.safeParse(value).success;

const binding = z
  .object({
    provider: z.enum(["claude", "codex", "gemini", "grok"]),
    sessionId: z.string().min(1).max(200),
    version: z.string().min(1).max(100),
  })
  .strict();
export const eventSchema: z.ZodType<ConversationEvent> = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        kind: z.literal("user"),
        text: z.string().max(16_384),
        about: z.array(object).max(16),
        brief: briefSnapshotSchema.optional(),
      })
      .strict(),
    binding.extend({ kind: z.literal("identity") }).strict(),
    z
      .object({
        kind: z.literal("text"),
        text: z.string().min(1).max(16_384),
        messageId: z.string().min(1).max(200).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("process"),
        pid: z.number().int().positive(),
        smith: z.string().min(1).max(200),
        requestedModel: z.string().min(1).max(200),
        requestedEffort: z.string().min(1).max(100),
      })
      .strict(),
    z
      .object({ kind: z.literal("model"), model: z.string().min(1).max(200) })
      .strict(),
    z
      .object({
        kind: z.literal("read"),
        query: z.enum(["beads", "queue", "sessions", "runs", "activity"]),
        source: z.string().max(200),
        asOf: z.iso.datetime(),
        complete: z.boolean(),
        reason: z.string().max(8000).nullable(),
        ids: z.array(z.string().max(200)).max(100),
        nextCursor: z
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER - 1)
          .nullable(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("context"),
        used: z
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER - 1)
          .nullable(),
        capacity: z
          .number()
          .int()
          .positive()
          .max(Number.MAX_SAFE_INTEGER - 1)
          .nullable(),
        basis: z.enum(["reported", "estimated", "unknown"]),
        source: z.string().max(200),
        asOf: z.iso.datetime(),
      })
      .strict(),
  ],
);
const turn = z
  .object({
    requestId: uuid,
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    phase: z.enum([
      "accepted",
      "running",
      "cancelling",
      "completed",
      "cancelled",
      "failed",
      "unknown",
    ]),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    reason: z.string().max(500).nullable(),
    owner: uuid.nullable(),
  })
  .strict();
export const stateSchema = z
  .object({
    version: z.literal(1),
    projectId: z.string(),
    conversationId: z.string(),
    revision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1),
    binding: binding.nullable(),
    turns: z.array(turn).max(1000),
    frames: z
      .array(
        z
          .object({
            seq: z.number().int().positive(),
            turnId: uuid,
            at: z.iso.datetime(),
            event: eventSchema,
          })
          .strict(),
      )
      .max(20_000),
  })
  .strict();

export const conversationPageSchema = stateSchema
  .extend({
    turns: z.array(turn).max(50),
    frames: stateSchema.shape.frames.max(100),
    more: z.boolean(),
    lastSequence: z.number().int().nonnegative(),
    nextCursor: z.number().int().nonnegative(),
    request: turn.nullable(),
    controllable: z.boolean(),
  })
  .strict();
export const conversationReceiptSchema: z.ZodType<ConversationReceipt> = z
  .object({
    conversationId: z.string(),
    revision: z.number().int().nonnegative(),
    turn,
  })
  .strict();
