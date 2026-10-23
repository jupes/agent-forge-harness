import { z } from "zod";
import type { CodexCodingUsageEvent } from "../../types/codex-owned-task";
import type {
  ConversationEvent,
  PreparedConversationSend,
} from "../../types/conversation";
import { ConversationError } from "../conversations/error";
import {
  conversationPageSchema,
  eventSchema,
  parsePreparedConversationSend,
  stateSchema,
} from "../conversations/protocol";
import { codexExecCapabilitiesSchema } from "./codex-task";
import { preparedCodexTaskSchema } from "./codex-task-runtime-protocol";

const object = z
  .object({
    kind: z.enum(["bead", "session", "run", "event"]),
    id: z.string().min(1).max(200),
  })
  .strict();
const text = z
  .string()
  .min(1)
  .max(16_384)
  .refine((value) => !!value.trim() && !value.includes("\0"));
const codexUser = z
  .object({
    kind: z.literal("user"),
    text,
    about: z.array(object).max(16),
    codexTask: preparedCodexTaskSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.text === value.codexTask.launch.prompt &&
      JSON.stringify(value.about) ===
        JSON.stringify(value.codexTask.launch.context?.about ?? []),
  );
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const codingUsage = z
  .object({
    kind: z.literal("coding-usage"),
    provider: z.literal("codex"),
    source: z.literal("exec.turn.completed"),
    version: codexExecCapabilitiesSchema.shape.version,
    usage: z
      .object({
        inputTokens: count.optional(),
        outputTokens: count.optional(),
        cachedInputTokens: count.optional(),
        cacheWriteInputTokens: count.optional(),
        reasoningOutputTokens: count.optional(),
      })
      .strict(),
  })
  .strict()
  .transform(
    (value): CodexCodingUsageEvent => ({
      kind: value.kind,
      provider: value.provider,
      source: value.source,
      version: value.version,
      usage: {
        ...(value.usage.inputTokens === undefined
          ? {}
          : { inputTokens: value.usage.inputTokens }),
        ...(value.usage.outputTokens === undefined
          ? {}
          : { outputTokens: value.usage.outputTokens }),
        ...(value.usage.cachedInputTokens === undefined
          ? {}
          : { cachedInputTokens: value.usage.cachedInputTokens }),
        ...(value.usage.cacheWriteInputTokens === undefined
          ? {}
          : { cacheWriteInputTokens: value.usage.cacheWriteInputTokens }),
        ...(value.usage.reasoningOutputTokens === undefined
          ? {}
          : { reasoningOutputTokens: value.usage.reasoningOutputTokens }),
      },
    }),
  );
/** Only an explicitly addressed coding partition accepts Codex private intent or usage. */
export const ownedCodingEventSchema = z.union([
  eventSchema,
  codexUser,
  codingUsage,
]);
const frame = z
  .object({
    seq: z.number().int().positive(),
    turnId: z.string().uuid(),
    at: z.iso.datetime(),
    event: ownedCodingEventSchema,
  })
  .strict();
const inProject = (value: {
  projectId: string;
  binding: { provider: string; sessionId: string } | null;
  frames: { event: ConversationEvent }[];
}) =>
  value.frames.every(
    ({ event }) =>
      event.kind !== "user" ||
      !event.codexTask ||
      (event.codexTask.launch.context?.projectId === value.projectId &&
        (!value.binding ||
          (value.binding.provider === "codex" &&
            z.string().uuid().safeParse(value.binding.sessionId).success))),
  );
export const ownedCodingStateSchema = stateSchema
  .extend({ frames: z.array(frame).max(20_000) })
  .strict()
  .refine(inProject);
export const ownedCodingPageSchema = conversationPageSchema
  .extend({ frames: z.array(frame).max(100) })
  .strict()
  .refine(inProject);
const prepared = z
  .object({
    requestId: z.string().uuid(),
    expectedRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1),
    text,
    about: z.array(object).max(16),
    codexTask: preparedCodexTaskSchema,
  })
  .strict();

export function parseOwnedPreparedConversationSend(
  input: unknown,
): PreparedConversationSend {
  if (
    typeof input === "object" &&
    input !== null &&
    Object.hasOwn(input, "codexTask")
  ) {
    const parsed = prepared.safeParse(input);
    if (!parsed.success)
      throw new ConversationError(
        400,
        "Expected a bounded private owned Codex Task.",
      );
    return parsed.data;
  }
  return parsePreparedConversationSend(input);
}
export function parseOwnedCodingEvent(input: unknown): ConversationEvent {
  const parsed = ownedCodingEventSchema.safeParse(input);
  if (!parsed.success)
    throw new ConversationError(400, "Expected a bounded owned coding frame.");
  return parsed.data;
}
