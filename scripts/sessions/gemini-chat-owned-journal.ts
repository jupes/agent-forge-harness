import { z } from "zod";
import type { ConversationFrame } from "../../types/conversation";
import type { GeminiAcpUsage } from "../../types/gemini-acp";
import type { PreparedGeminiChat } from "../../types/gemini-chat-runtime";
import type {
  GeminiChatDecisionIntent,
  GeminiChatPrivateFrame,
} from "../../types/gemini-owned-chat";
import { reportedJsonSchema, reportedTextSchema } from "./activity-protocol";
import { geminiChatDecisionReceiptSchema } from "./gemini-chat-owned-protocol";
import { privatePacketHash } from "./private-packet";
import { sessionRequestHashSchema, sessionRequestIdSchema } from "./protocol";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const pid = z.number().int().positive().max(0x7fffffff);
const name = z.string().min(1).max(200);
const rpcId = z.union([name, count]);
const usage = z
  .object({
    inputTokens: count,
    outputTokens: count,
    totalTokens: count,
    cachedReadTokens: count.optional(),
    thoughtTokens: count.optional(),
  })
  .strict()
  .transform(
    (value): GeminiAcpUsage => ({
      inputTokens: value.inputTokens,
      outputTokens: value.outputTokens,
      totalTokens: value.totalTokens,
      ...(value.cachedReadTokens === undefined
        ? {}
        : { cachedReadTokens: value.cachedReadTokens }),
      ...(value.thoughtTokens === undefined
        ? {}
        : { thoughtTokens: value.thoughtTokens }),
    }),
  );
const stopReason = z.enum([
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
]);
const scoped = {
  scope: z.enum(["turn", "native-session"]),
  requestId: sessionRequestIdSchema.nullable(),
};
const validScope = (value: { scope: string; requestId: string | null }) =>
  value.scope === "turn" ? value.requestId !== null : value.requestId === null;
const permission = z
  .object({
    kind: z.literal("permission"),
    rpcId,
    requestId: sessionRequestIdSchema,
    toolCallId: name,
    detail: reportedJsonSchema,
    detailsComplete: z.boolean(),
    options: z
      .array(
        z
          .object({
            optionId: name,
            name,
            kind: z.enum(["allow_once", "reject_once"]),
          })
          .strict(),
      )
      .max(16),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.options.map((item) => item.optionId)).size ===
        value.options.length &&
      (value.detailsComplete ||
        value.options.every((item) => item.kind !== "allow_once")),
  );
const nativeEvent = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("process"),
      pid,
      bootstrapPid: pid,
      smith: name.max(80),
      requestId: sessionRequestIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("identity"),
      sessionId: z.uuid(),
      resumed: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("text"),
      text: z.string().max(524_288),
      role: z.enum(["assistant", "user"]),
      ...scoped,
    })
    .strict()
    .refine(validScope),
  z
    .object({
      kind: z.literal("context"),
      usedTokens: count,
      contextTokens: count,
    })
    .strict(),
  z
    .object({
      kind: z.literal("error"),
      requestId: sessionRequestIdSchema.nullable(),
      code: z.number().int().min(-0x80000000).max(0x7fffffff),
      message: reportedTextSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("tool"),
      toolCallId: name,
      status: z.enum(["pending", "in_progress", "completed", "failed"]),
      detail: reportedJsonSchema,
      ...scoped,
    })
    .strict()
    .refine(validScope),
  permission,
  z
    .object({
      kind: z.literal("approval-offer"),
      id: sessionRequestIdSchema,
      requestId: sessionRequestIdSchema,
      rpcId,
      toolCallId: name,
    })
    .strict(),
  z
    .object({
      kind: z.literal("permission-intent"),
      requestId: sessionRequestIdSchema,
      decisionRequestId: sessionRequestIdSchema,
      rpcId,
      toolCallId: name,
      optionId: name.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("result"),
      requestId: sessionRequestIdSchema,
      stopReason,
      usage: usage.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("outcome"),
      outcome: z
        .object({
          phase: z.enum(["completed", "failed", "unknown"]),
          reason: z.string().max(16_384).nullable(),
          sessionId: z.uuid().nullable(),
          stopReason: stopReason.nullable(),
          usage: usage.nullable(),
        })
        .strict(),
      exitCode: z.number().int().min(-0x80000000).max(0xffffffff).nullable(),
      stopped: z.boolean(),
      timedOut: z.boolean(),
      stderr: reportedTextSchema,
    })
    .strict()
    .refine(
      (value) =>
        value.outcome.phase !== "completed" ||
        (value.exitCode === 0 &&
          !value.stopped &&
          !value.timedOut &&
          value.outcome.sessionId !== null &&
          value.outcome.stopReason === "end_turn"),
    ),
]);
/** This separate wire does not widen Keeper or turn native-session replay into an answer. */
export const geminiChatPrivateFrameSchema = z
  .object({
    kind: z.literal("coding-gemini-chat"),
    provider: z.literal("gemini"),
    version: z.literal("0.65.0"),
    event: nativeEvent,
  })
  .strict() satisfies z.ZodType<GeminiChatPrivateFrame>;
export const geminiChatDecisionIntentSchema = z
  .object({
    kind: z.literal("coding-gemini-chat-decision"),
    provider: z.literal("gemini"),
    version: z.literal("0.65.0"),
    requestHash: sessionRequestHashSchema,
    receipt: geminiChatDecisionReceiptSchema,
  })
  .strict() satisfies z.ZodType<GeminiChatDecisionIntent>;

/** A private page can start mid-turn, but cannot contradict its address, binding or accepted original. */
export function validGeminiChatPage(value: {
  projectId: string;
  conversationId: string;
  binding: { provider: string; sessionId: string; version: string } | null;
  frames: ConversationFrame[];
}): boolean {
  return value.frames.every((frame) => {
    const event = frame.event;
    if (event.kind === "coding-gemini-chat-decision") {
      const {
        projectId,
        sessionId,
        requestId,
        turnRequestId,
        approvalId,
        optionId,
      } = event.receipt;
      return (
        projectId === value.projectId &&
        sessionId === value.conversationId &&
        turnRequestId === frame.turnId &&
        event.requestHash ===
          privatePacketHash({
            projectId,
            sessionId,
            requestId,
            turnRequestId,
            approvalId,
            optionId,
          })
      );
    }
    if (event.kind !== "coding-gemini-chat") return true;
    const native = event.event;
    if (
      "requestId" in native &&
      native.requestId !== null &&
      native.requestId !== frame.turnId
    )
      return false;
    if (native.kind === "process") return native.pid !== native.bootstrapPid;
    if (native.kind === "error" && value.binding === null) return true;
    if (native.kind === "outcome" && native.outcome.sessionId === null)
      return (
        native.outcome.phase !== "completed" && native.outcome.usage === null
      );
    return (
      value.binding?.provider === "gemini" &&
      value.binding.version === event.version &&
      (native.kind !== "identity" ||
        native.sessionId === value.binding.sessionId) &&
      (native.kind !== "outcome" ||
        native.outcome.sessionId === value.binding.sessionId)
    );
  });
}

/** Whole history correlates captured updates without claiming native per-turn identity for replay. */
export function validGeminiChatHistory(value: {
  projectId: string;
  conversationId: string;
  binding: { provider: string; sessionId: string; version: string } | null;
  frames: ConversationFrame[];
}): boolean {
  type Permission = z.infer<typeof permission>;
  type Turn = {
    snapshot: PreparedGeminiChat;
    pid?: number;
    identity?: string;
    resumed?: boolean;
    terminal: boolean;
    result?: Extract<GeminiChatPrivateFrame["event"], { kind: "result" }>;
    permissions: Map<string | number, Permission>;
    offers: Map<string, Permission>;
    intents: Map<string, GeminiChatDecisionIntent>;
    nativeDecisions: Set<string>;
    bytes: number;
  };
  const turns = new Map<string, Turn>(),
    offerIds = new Set<string>(),
    decisionIds = new Set<string>();
  let identities = 0;
  for (const frame of value.frames) {
    const event = frame.event;
    if (event.kind === "user" && event.geminiChat) {
      if (turns.has(frame.turnId)) return false;
      turns.set(frame.turnId, {
        snapshot: event.geminiChat,
        resumed: identities > 0,
        terminal: false,
        permissions: new Map(),
        offers: new Map(),
        intents: new Map(),
        nativeDecisions: new Set(),
        bytes: 0,
      });
      continue;
    }
    if (
      turns.has(frame.turnId) &&
      (event.kind === "text" ||
        event.kind === "model" ||
        event.kind === "process")
    )
      return false;
    if (
      event.kind !== "coding-gemini-chat" &&
      event.kind !== "coding-gemini-chat-decision"
    )
      continue;
    const turn = turns.get(frame.turnId);
    if (
      !turn ||
      turn.terminal ||
      turn.snapshot.launch.context?.projectId !== value.projectId ||
      turn.snapshot.capabilities.version !== event.version
    )
      return false;
    if (event.kind === "coding-gemini-chat-decision") {
      const receipt = event.receipt,
        offered = turn.offers.get(receipt.approvalId);
      if (
        !offered ||
        turn.result ||
        receipt.projectId !== value.projectId ||
        receipt.sessionId !== value.conversationId ||
        receipt.turnRequestId !== frame.turnId ||
        decisionIds.has(receipt.requestId) ||
        turn.intents.has(receipt.approvalId) ||
        (receipt.optionId !== null &&
          !offered.options.some((item) => item.optionId === receipt.optionId))
      )
        return false;
      decisionIds.add(receipt.requestId);
      turn.intents.set(receipt.approvalId, event);
      continue;
    }
    const native = event.event;
    turn.bytes += new TextEncoder().encode(JSON.stringify(native)).byteLength;
    if (turn.bytes > 4_194_304) return false;
    if (native.kind === "process") {
      if (
        turn.pid ||
        native.pid === native.bootstrapPid ||
        native.smith !== turn.snapshot.smith ||
        native.requestId !== frame.turnId
      )
        return false;
      turn.pid = native.pid;
      continue;
    }
    if (native.kind === "identity") {
      if (
        !turn.pid ||
        turn.identity ||
        value.binding?.provider !== "gemini" ||
        value.binding.version !== event.version ||
        native.sessionId !== value.binding.sessionId ||
        native.resumed !== turn.resumed
      )
        return false;
      turn.identity = native.sessionId;
      turn.resumed = native.resumed;
      identities++;
      continue;
    }
    if (native.kind === "outcome") {
      if (
        native.outcome.sessionId !==
          (turn.identity ?? (turn.resumed ? value.binding?.sessionId : null)) ||
        (native.outcome.phase === "completed" &&
          (!turn.result || turn.result.stopReason !== "end_turn")) ||
        (turn.result &&
          (native.outcome.stopReason !== turn.result.stopReason ||
            JSON.stringify(native.outcome.usage) !==
              JSON.stringify(turn.result.usage)))
      )
        return false;
      turn.terminal = true;
      continue;
    }
    if (native.kind === "error") {
      if (
        !turn.pid ||
        (native.requestId !== null && native.requestId !== frame.turnId)
      )
        return false;
      continue;
    }
    // Native load may replay session notifications before its reply confirms the new process.
    // They stay native-session scoped and cannot establish a new-turn identity/result.
    if (
      !turn.identity &&
      !(
        turn.pid &&
        turn.resumed &&
        (native.kind === "text" ||
          native.kind === "tool" ||
          native.kind === "context")
      )
    )
      return false;
    if (native.kind === "text" || native.kind === "tool") {
      if (
        (turn.resumed && native.scope !== "native-session") ||
        (native.scope === "turn" && native.requestId !== frame.turnId)
      )
        return false;
    } else if (native.kind === "permission") {
      if (
        turn.result ||
        native.requestId !== frame.turnId ||
        turn.permissions.has(native.rpcId)
      )
        return false;
      turn.permissions.set(native.rpcId, native);
    } else if (native.kind === "approval-offer") {
      const offered = turn.permissions.get(native.rpcId);
      if (
        turn.result ||
        native.requestId !== frame.turnId ||
        offerIds.has(native.id) ||
        !offered ||
        offered.toolCallId !== native.toolCallId ||
        [...turn.offers.values()].includes(offered)
      )
        return false;
      offerIds.add(native.id);
      turn.offers.set(native.id, offered);
    } else if (native.kind === "permission-intent") {
      const intent = [...turn.intents.values()].find(
        (item) => item.receipt.requestId === native.decisionRequestId,
      );
      const offered = intent && turn.offers.get(intent.receipt.approvalId);
      if (
        turn.result ||
        native.requestId !== frame.turnId ||
        turn.nativeDecisions.has(native.decisionRequestId) ||
        !intent ||
        !offered ||
        offered.rpcId !== native.rpcId ||
        offered.toolCallId !== native.toolCallId ||
        intent.receipt.optionId !== native.optionId
      )
        return false;
      turn.nativeDecisions.add(native.decisionRequestId);
    } else if (native.kind === "result") {
      if (turn.result || native.requestId !== frame.turnId) return false;
      turn.result = native;
    }
  }
  return validGeminiChatPage(value);
}
