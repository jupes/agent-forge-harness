import { z } from "zod";
import type {
  CodexChatApproval,
  CodexChatDecision,
  PreparedCodexChat,
} from "../../types/codex-chat";
import type { CodexCodingUsageEvent } from "../../types/codex-owned-task";
import type {
  ConversationEvent,
  ConversationFrame,
  PreparedConversationSend,
} from "../../types/conversation";
import { ConversationError } from "../conversations/error";
import {
  conversationPageSchema,
  eventSchema,
  parsePreparedConversationSend,
  stateSchema,
} from "../conversations/protocol";
import { shiftTurnSnapshotSchema } from "../shifts/turn-protocol";
import {
  claudeCodingUsageSchema,
  codingActivitySchema,
  codingOutcomeSchema,
} from "./activity-protocol";
import { claudeAccountReportSchema } from "./claude-account";
import { preparedCodexChatSchema } from "./codex-app-server-protocol";
import {
  codexChatDecisionIntentSchema,
  codexChatPrivateEventSchema,
} from "./codex-chat-owned-journal";
import { codexExecCapabilitiesSchema } from "./codex-task";
import { preparedCodexTaskSchema } from "./codex-task-runtime-protocol";
import {
  geminiTaskPrivateFrameSchema,
  validGeminiTaskHistory,
} from "./gemini-owned-journal";
import { preparedGeminiTaskSchema } from "./gemini-task-runtime-protocol";

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
const shiftUser = z
  .object({
    kind: z.literal("user"),
    text,
    about: z.array(object).max(16),
    shift: shiftTurnSnapshotSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.text === value.shift.stdin &&
      JSON.stringify(value.about) ===
        JSON.stringify([
          { kind: "bead", id: value.shift.beadId },
          { kind: "run", id: value.shift.runId },
        ]),
  );
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const geminiUser = z
  .object({
    kind: z.literal("user"),
    text,
    about: z.array(object).max(16),
    geminiTask: preparedGeminiTaskSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.text === value.geminiTask.launch.prompt &&
      JSON.stringify(value.about) ===
        JSON.stringify(value.geminiTask.launch.context?.about ?? []),
  );
const codexChatUser = z
  .object({
    kind: z.literal("user"),
    text,
    about: z.array(object).max(16),
    codexChat: preparedCodexChatSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.text === value.codexChat.launch.prompt &&
      JSON.stringify(value.about) ===
        JSON.stringify(value.codexChat.launch.context?.about ?? []),
  );
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
  shiftUser,
  codingUsage,
  claudeCodingUsageSchema,
  codingActivitySchema,
  codingOutcomeSchema,
  claudeAccountReportSchema,
  codexChatUser,
  codexChatPrivateEventSchema,
  codexChatDecisionIntentSchema,
  geminiUser,
  geminiTaskPrivateFrameSchema,
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
  conversationId: string;
  binding: { provider: string; sessionId: string; version: string } | null;
  frames: { turnId: string; event: ConversationEvent }[];
}) =>
  value.frames.every(
    ({ event }) =>
      event.kind !== "user" ||
      !(event.codexTask ?? event.codexChat ?? event.geminiTask) ||
      ((event.codexTask ?? event.codexChat ?? event.geminiTask)?.launch.context
        ?.projectId === value.projectId &&
        (!value.binding ||
          (value.binding.provider === (event.geminiTask ? "gemini" : "codex") &&
            z.string().uuid().safeParse(value.binding.sessionId).success))),
  ) &&
  value.frames.every(
    ({ turnId, event }) =>
      event.kind !== "user" ||
      !event.shift ||
      (event.shift.projectId === value.projectId &&
        event.shift.conversationId === value.conversationId &&
        event.shift.turnId === turnId &&
        (!value.binding ||
          (value.binding.provider === event.shift.provider &&
            value.binding.version === event.shift.cliVersion))),
  );
/** Whole states prove reported activity against its immutable private launch, not a public row. */
function reportedTurn(
  value: {
    binding: { provider: string } | null;
    frames: { turnId: string; event: ConversationEvent }[];
  },
  complete: boolean,
) {
  return value.frames.every((frame) => {
    const event = frame.event;
    if (
      event.kind !== "coding-activity" &&
      event.kind !== "coding-outcome" &&
      event.kind !== "coding-account" &&
      event.kind !== "coding-usage" &&
      event.kind !== "coding-chat" &&
      event.kind !== "coding-chat-decision" &&
      event.kind !== "coding-gemini-task"
    )
      return true;
    const user = value.frames.find(
      (candidate) =>
        candidate.turnId === frame.turnId && candidate.event.kind === "user",
    )?.event;
    if (user?.kind !== "user")
      return (
        !complete &&
        (value.binding?.provider === event.provider ||
          (value.binding === null &&
            event.kind === "coding-gemini-task" &&
            event.event.kind === "process"))
      );
    if (event.kind === "coding-gemini-task" && !user.geminiTask) return false;
    if (
      (event.kind === "coding-chat" || event.kind === "coding-chat-decision") &&
      !user.codexChat
    )
      return false;
    if (
      user.codexChat &&
      event.provider === "codex" &&
      (event.kind === "coding-usage" || event.kind === "coding-activity")
    )
      return false;
    if (user.shift)
      return (
        user.shift.provider === event.provider &&
        user.shift.cliVersion === event.version
      );
    const snapshot =
      user.session ?? user.codexTask ?? user.codexChat ?? user.geminiTask;
    return (
      snapshot?.provider === event.provider &&
      snapshot.capabilities.version === event.version
    );
  });
}
function nativeChatHistory(value: {
  projectId: string;
  conversationId: string;
  binding: { provider: string; sessionId: string } | null;
  frames: ConversationFrame[];
}) {
  type Turn = {
    snapshot: PreparedCodexChat | undefined;
    pid: number | undefined;
    nativeTurn: string | undefined;
    approvals: Map<string, CodexChatApproval>;
    intents: Map<string, CodexChatDecision>;
  };
  const turns = new Map<string, Turn>(),
    approvalIds = new Set<string>(),
    requestIds = new Set<string>(),
    decided = new Set<string>();
  for (const frame of value.frames) {
    const event = frame.event;
    let turn = turns.get(frame.turnId);
    if (!turn) {
      turn = {
        snapshot: undefined,
        pid: undefined,
        nativeTurn: undefined,
        approvals: new Map(),
        intents: new Map(),
      };
      turns.set(frame.turnId, turn);
    }
    if (event.kind === "user") {
      turn.snapshot = event.codexChat;
      continue;
    }
    if (event.kind === "process") {
      turn.pid = event.pid;
      continue;
    }
    if (event.kind === "coding-chat-decision") {
      const receipt = event.receipt,
        offered = turn.approvals.get(receipt.approvalId);
      if (
        !turn.snapshot ||
        receipt.projectId !== value.projectId ||
        receipt.sessionId !== value.conversationId ||
        receipt.turnRequestId !== frame.turnId ||
        requestIds.has(receipt.requestId) ||
        decided.has(receipt.approvalId) ||
        !offered?.availableDecisions.includes(receipt.decision)
      )
        return false;
      requestIds.add(receipt.requestId);
      decided.add(receipt.approvalId);
      turn.intents.set(receipt.approvalId, receipt.decision);
      continue;
    }
    if (event.kind !== "coding-chat") continue;
    const native = event.event,
      snapshot = turn.snapshot;
    if (!snapshot) return false;
    if (native.kind === "process") {
      if (
        turn.pid !== native.pid ||
        native.pid === native.wrapperPid ||
        native.smith !== snapshot.smith ||
        native.requestedModel !== snapshot.launch.model ||
        native.requestedEffort !== (snapshot.launch.effort ?? null)
      )
        return false;
      continue;
    }
    if (value.binding?.provider !== "codex") return false;
    if (native.kind === "turn" || native.kind === "identity") {
      if (native.threadId !== value.binding.sessionId) return false;
      if (native.kind === "turn") turn.nativeTurn = native.turnId;
    } else if (native.kind === "configuration") {
      if (
        native.cwd !== snapshot.cwd ||
        native.model !== snapshot.launch.model ||
        (snapshot.launch.effort !== undefined &&
          native.effort !== snapshot.launch.effort)
      )
        return false;
    } else if (native.kind === "approval-request") {
      const approval = native.approval;
      if (
        approvalIds.has(approval.id) ||
        turn.pid !== approval.processId ||
        approval.threadId !== value.binding.sessionId ||
        approval.turnId !== turn.nativeTurn
      )
        return false;
      approvalIds.add(approval.id);
      turn.approvals.set(approval.id, approval);
    } else if (
      native.kind === "approval-decision" ||
      native.kind === "approval-resolved"
    ) {
      if (
        !turn.approvals.has(native.approvalId) ||
        (native.kind === "approval-decision" &&
          turn.intents.get(native.approvalId) !== native.decision)
      )
        return false;
    }
  }
  return true;
}
export const ownedCodingStateSchema = stateSchema
  .extend({ frames: z.array(frame).max(20_000) })
  .strict()
  .refine(inProject)
  .refine((value) => reportedTurn(value, true))
  .refine(nativeChatHistory)
  .refine(validGeminiTaskHistory);
export const ownedCodingPageSchema = conversationPageSchema
  .extend({ frames: z.array(frame).max(100) })
  .strict()
  .refine(inProject)
  .refine((value) => reportedTurn(value, false));
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
const preparedChat = prepared
  .omit({ codexTask: true })
  .extend({ codexChat: preparedCodexChatSchema })
  .strict();
const preparedGemini = prepared
  .omit({ codexTask: true })
  .extend({ geminiTask: preparedGeminiTaskSchema })
  .strict();
const preparedShift = z
  .object({
    requestId: z.uuid(),
    expectedRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1),
    text,
    about: z.array(object).max(16),
    shift: shiftTurnSnapshotSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.requestId === value.shift.turnId &&
      shiftUser.safeParse({
        kind: "user",
        text: value.text,
        about: value.about,
        shift: value.shift,
      }).success,
  );

export function parseOwnedPreparedConversationSend(
  input: unknown,
): PreparedConversationSend {
  if (
    typeof input === "object" &&
    input !== null &&
    Object.hasOwn(input, "shift")
  ) {
    const parsed = preparedShift.safeParse(input);
    if (!parsed.success)
      throw new ConversationError(
        400,
        "Expected a bounded private shift attempt.",
      );
    return parsed.data;
  }
  if (
    typeof input === "object" &&
    input !== null &&
    Object.hasOwn(input, "geminiTask")
  ) {
    const parsed = preparedGemini.safeParse(input);
    if (!parsed.success)
      throw new ConversationError(
        400,
        "Expected a bounded private owned Gemini Task.",
      );
    return parsed.data;
  }
  if (
    typeof input === "object" &&
    input !== null &&
    Object.hasOwn(input, "codexChat")
  ) {
    const parsed = preparedChat.safeParse(input);
    if (!parsed.success)
      throw new ConversationError(
        400,
        "Expected a bounded private owned Codex Chat turn.",
      );
    return parsed.data;
  }
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
