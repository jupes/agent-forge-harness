import { z } from "zod";
import type {
  CodexChatApproval,
  CodexChatCommand,
  CodexChatDecision,
  CodexChatFileChange,
  CodexChatMcpToolCall,
  CodexChatWebSearch,
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
  SESSION_ACTIVITY_LIMITS,
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
  geminiChatDecisionIntentSchema,
  geminiChatPrivateFrameSchema,
  validGeminiChatHistory,
  validGeminiChatPage,
} from "./gemini-chat-owned-journal";
import { preparedGeminiChatSchema } from "./gemini-chat-runtime-protocol";
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
const geminiChatUser = z
  .object({
    kind: z.literal("user"),
    text,
    about: z.array(object).max(16),
    geminiChat: preparedGeminiChatSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.text === value.geminiChat.launch.prompt &&
      JSON.stringify(value.about) ===
        JSON.stringify(value.geminiChat.launch.context?.about ?? []),
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
  geminiChatUser,
  geminiChatPrivateFrameSchema,
  geminiChatDecisionIntentSchema,
]);
const frame = z
  .object({
    seq: z.number().int().positive(),
    turnId: z.string().uuid(),
    at: z.iso.datetime(),
    event: ownedCodingEventSchema,
  })
  .strict();
const ownerLifecycleFact = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("generation-started"),
      requestId: z.string().uuid(),
      generationId: z.string().uuid(),
      afterSequence: z.number().int().nonnegative(),
      revision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("generation-released"),
      requestId: z.string().uuid(),
      generationId: z.string().uuid(),
      afterSequence: z.number().int().nonnegative(),
      revision: z.number().int().positive(),
      binding: z
        .object({
          provider: z.literal("codex"),
          sessionId: z.string().uuid(),
          version: z.string().min(1).max(100),
          turnId: z.string().uuid(),
        })
        .strict(),
    })
    .strict(),
]);
const ownerLifecycle = z.array(ownerLifecycleFact).max(2000);
const inProject = (value: {
  projectId: string;
  conversationId: string;
  binding: { provider: string; sessionId: string; version: string } | null;
  frames: { turnId: string; event: ConversationEvent }[];
}) =>
  value.frames.every(
    ({ event }) =>
      event.kind !== "user" ||
      !(
        event.codexTask ??
        event.codexChat ??
        event.geminiTask ??
        event.geminiChat
      ) ||
      ((
        event.codexTask ??
        event.codexChat ??
        event.geminiTask ??
        event.geminiChat
      )?.launch.context?.projectId === value.projectId &&
        (!value.binding ||
          (value.binding.provider ===
            (event.geminiTask || event.geminiChat ? "gemini" : "codex") &&
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
    binding: { provider: string; sessionId: string; version: string } | null;
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
      event.kind !== "coding-gemini-task" &&
      event.kind !== "coding-gemini-chat" &&
      event.kind !== "coding-gemini-chat-decision"
    )
      return true;
    if (
      event.kind === "coding-chat" &&
      event.event.kind === "outcome" &&
      event.event.outcome.threadId !== null &&
      (value.binding?.provider !== "codex" ||
        value.binding.sessionId !== event.event.outcome.threadId)
    )
      return false;
    if (
      event.kind === "coding-chat" &&
      (event.event.kind === "command" ||
        event.event.kind === "file-change" ||
        event.event.kind === "reasoning-summary" ||
        event.event.kind === "turn-plan" ||
        event.event.kind === "mcp-tool-call" ||
        event.event.kind === "web-search")
    ) {
      if (
        value.binding?.provider !== "codex" ||
        value.binding.sessionId !== event.event.threadId ||
        value.binding.version !== event.version
      )
        return false;
      const native = value.frames.find(
        (candidate) =>
          candidate.turnId === frame.turnId &&
          candidate.event.kind === "coding-chat" &&
          candidate.event.event.kind === "turn",
      )?.event;
      if (
        native?.kind === "coding-chat" &&
        native.event.kind === "turn" &&
        native.event.turnId !== event.event.turnId
      )
        return false;
    }
    const user = value.frames.find(
      (candidate) =>
        candidate.turnId === frame.turnId && candidate.event.kind === "user",
    )?.event;
    if (user?.kind !== "user") {
      // Process ownership is saved before initialization can report a native
      // identity. Its preceding user frame may be on the prior private page.
      // A failed initialization may also end before any native identity exists.
      // Only process facts and terminal reports with no native identity or usage
      // are valid without a binding; no other provider frame gains identity.
      if (
        !complete &&
        (event.kind === "coding-chat" ||
          event.kind === "coding-gemini-task" ||
          event.kind === "coding-gemini-chat") &&
        event.event.kind === "process" &&
        value.binding === null
      )
        return true;
      if (
        !complete &&
        value.binding === null &&
        event.kind === "coding-gemini-chat" &&
        event.event.kind === "outcome" &&
        event.event.outcome.phase !== "completed" &&
        event.event.outcome.sessionId === null &&
        event.event.outcome.usage === null
      )
        return true;
      if (
        !complete &&
        value.binding === null &&
        event.kind === "coding-chat" &&
        event.event.kind === "outcome" &&
        event.event.outcome.phase !== "completed" &&
        event.event.outcome.threadId === null &&
        event.event.outcome.turnId === null &&
        event.event.outcome.usage === null
      )
        return true;
      return !complete && value.binding?.provider === event.provider;
    }
    if (event.kind === "coding-gemini-task" && !user.geminiTask) return false;
    if (
      (event.kind === "coding-gemini-chat" ||
        event.kind === "coding-gemini-chat-decision") &&
      !user.geminiChat
    )
      return false;
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
      user.session ??
      user.codexTask ??
      user.codexChat ??
      user.geminiTask ??
      user.geminiChat;
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
    terminal: boolean;
    richReportBytes: number;
    richTurnEnded: boolean;
    finalNativeStatus: "completed" | "failed" | "interrupted" | null;
    itemKinds: Map<
      string,
      | "text"
      | "command"
      | "reasoning-summary"
      | "file-change"
      | "mcp-tool-call"
      | "web-search"
    >;
    fileChanges: Map<string, CodexChatFileChange>;
    mcpToolCalls: Map<string, CodexChatMcpToolCall>;
    webSearches: Map<string, CodexChatWebSearch>;
    closedCommands: Set<string>;
    commands: Map<string, CodexChatCommand>;
    summaries: Map<
      string,
      {
        closed: boolean;
        turnEnded: boolean;
        snapshot: string;
        streamBytes: number;
        parts: Map<
          number,
          { announced: boolean; prefixMissing: boolean; truncated: boolean }
        >;
      }
    >;
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
        terminal: false,
        richReportBytes: 0,
        richTurnEnded: false,
        finalNativeStatus: null,
        itemKinds: new Map(),
        fileChanges: new Map(),
        mcpToolCalls: new Map(),
        webSearches: new Map(),
        closedCommands: new Set(),
        commands: new Map(),
        summaries: new Map(),
        approvals: new Map(),
        intents: new Map(),
      };
      turns.set(frame.turnId, turn);
    }
    // ConversationService.finish changes turn metadata without appending a
    // provider frame. Nothing from this ended native turn may arrive afterward.
    if (turn.terminal) return false;
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
    if (native.kind === "outcome") {
      const outcome = native.outcome;
      if (
        (outcome.exitCode !== null && turn.pid === undefined) ||
        (outcome.threadId !== null &&
          (value.binding?.provider !== "codex" ||
            outcome.threadId !== value.binding.sessionId)) ||
        (outcome.turnId !== null && outcome.turnId !== turn.nativeTurn) ||
        (outcome.phase === "completed" &&
          turn.finalNativeStatus !== null &&
          turn.finalNativeStatus !== "completed")
      )
        return false;
      turn.terminal = true;
      continue;
    }
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
    if (
      native.kind === "text" ||
      native.kind === "command" ||
      native.kind === "file-change" ||
      native.kind === "mcp-tool-call" ||
      native.kind === "web-search" ||
      native.kind === "reasoning-summary"
    ) {
      const previous = turn.itemKinds.get(native.itemId);
      // The live decoder keeps one native item map across these kinds. Repeated
      // text fragments keep the same identity; a different kind cannot borrow it.
      if (
        (previous !== undefined && previous !== native.kind) ||
        (previous === undefined && turn.itemKinds.size >= 256)
      )
        return false;
      turn.itemKinds.set(native.itemId, native.kind);
    }
    if (
      native.kind === "command" ||
      native.kind === "file-change" ||
      native.kind === "mcp-tool-call" ||
      native.kind === "web-search" ||
      native.kind === "reasoning-summary" ||
      native.kind === "turn-plan"
    ) {
      if (
        turn.pid === undefined ||
        native.threadId !== value.binding.sessionId ||
        native.turnId !== turn.nativeTurn ||
        (turn.richTurnEnded && native.source !== "turn/completed")
      )
        return false;
      turn.richReportBytes += new TextEncoder().encode(
        JSON.stringify(native),
      ).byteLength;
      if (turn.richReportBytes > SESSION_ACTIVITY_LIMITS.aggregateBytes)
        return false;
      if (native.source === "turn/completed") turn.richTurnEnded = true;
    }
    if (native.kind === "file-change") {
      const previous = turn.fileChanges.get(native.itemId);
      const signature = (report: CodexChatFileChange) =>
        JSON.stringify([report.status, report.changes, report.truncated]);
      if (
        previous &&
        previous.closure !== "open" &&
        (native.closure !== "turn-ended" ||
          previous.closure === "turn-ended" ||
          signature(previous) !== signature(native))
      )
        return false;
      if (
        (native.source === "item/started" && previous !== undefined) ||
        (native.source === "item/fileChange/patchUpdated" &&
          previous === undefined)
      )
        return false;
      if (native.source === "turn/completed") {
        if (
          turn.finalNativeStatus !== null &&
          turn.finalNativeStatus !== native.turnStatus
        )
          return false;
        turn.finalNativeStatus = native.turnStatus;
      }
      turn.fileChanges.set(native.itemId, native);
      continue;
    }
    if (native.kind === "mcp-tool-call") {
      const previous = turn.mcpToolCalls.get(native.itemId),
        identity = JSON.stringify([
          native.server,
          native.tool,
          native.arguments,
        ]),
        signature = JSON.stringify([
          native.status,
          native.result,
          native.error,
          native.durationMs,
        ]);
      if (
        (previous !== undefined &&
          JSON.stringify([
            previous.server,
            previous.tool,
            previous.arguments,
          ]) !== identity) ||
        (previous !== undefined &&
          previous.closure !== "open" &&
          (native.closure !== "turn-ended" ||
            previous.closure === "turn-ended" ||
            JSON.stringify([
              previous.status,
              previous.result,
              previous.error,
              previous.durationMs,
            ]) !== signature)) ||
        (native.source === "item/started" && previous !== undefined) ||
        (native.source === "item/completed" &&
          previous?.closure !== "open" &&
          previous !== undefined)
      )
        return false;
      if (native.source === "turn/completed") {
        if (
          turn.finalNativeStatus !== null &&
          turn.finalNativeStatus !== native.turnStatus
        )
          return false;
        turn.finalNativeStatus = native.turnStatus;
      }
      turn.mcpToolCalls.set(native.itemId, native);
      continue;
    }
    if (native.kind === "web-search") {
      const previous = turn.webSearches.get(native.itemId),
        identity = JSON.stringify(native.query),
        signature = JSON.stringify([native.action, native.results]);
      if (
        (previous !== undefined &&
          JSON.stringify(previous.query) !== identity) ||
        (previous !== undefined &&
          previous.closure !== "open" &&
          (native.closure !== "turn-ended" ||
            previous.closure === "turn-ended" ||
            JSON.stringify([previous.action, previous.results]) !==
              signature)) ||
        (native.source === "item/started" && previous !== undefined) ||
        (native.source === "item/completed" &&
          previous?.closure !== "open" &&
          previous !== undefined)
      )
        return false;
      if (native.source === "turn/completed") {
        if (
          turn.finalNativeStatus !== null &&
          turn.finalNativeStatus !== native.turnStatus
        )
          return false;
        turn.finalNativeStatus = native.turnStatus;
      }
      turn.webSearches.set(native.itemId, native);
      continue;
    }
    if (native.kind === "reasoning-summary") {
      if (turn.commands.has(native.itemId)) return false;
      const previous = turn.summaries.get(native.itemId),
        update = native.update;
      const signature =
        update.kind === "snapshot"
          ? JSON.stringify([update.summary, update.truncated])
          : "";
      if (
        previous?.closed &&
        (update.kind !== "snapshot" ||
          update.closure !== "turn-ended" ||
          previous.turnEnded ||
          previous.snapshot !== signature)
      )
        return false;
      if (update.kind === "snapshot") {
        if (
          (update.closure === "open" && previous) ||
          (!previous && turn.summaries.size + turn.commands.size >= 256)
        )
          return false;
        if (update.closure === "turn-ended") {
          if (
            turn.finalNativeStatus !== null &&
            turn.finalNativeStatus !== update.turnStatus
          )
            return false;
          turn.finalNativeStatus = update.turnStatus;
        }
        turn.summaries.set(native.itemId, {
          closed: update.closure !== "open",
          turnEnded: update.closure === "turn-ended",
          snapshot: signature,
          streamBytes: previous?.streamBytes ?? 0,
          parts: previous?.parts ?? new Map(),
        });
      } else {
        if (!previous) return false;
        const part = previous.parts.get(update.summaryIndex) ?? {
          announced: false,
          prefixMissing: true,
          truncated: false,
        };
        if (update.kind === "part-added") {
          if (part.announced) return false;
          if (!previous.parts.has(update.summaryIndex))
            part.prefixMissing = false;
          part.announced = true;
        } else {
          if (part.truncated || update.prefixMissing !== part.prefixMissing)
            return false;
          previous.streamBytes += new TextEncoder().encode(
            update.content.text,
          ).byteLength;
          if (previous.streamBytes > SESSION_ACTIVITY_LIMITS.textBytes)
            return false;
          part.truncated = update.content.truncated;
        }
        previous.parts.set(update.summaryIndex, part);
      }
      continue;
    }
    if (native.kind === "command") {
      if (
        turn.summaries.has(native.itemId) ||
        turn.closedCommands.has(native.itemId)
      )
        return false;
      const previous = turn.commands.get(native.itemId);
      if (
        previous &&
        (previous.status !== "inProgress" ||
          previous.cwd !== native.cwd ||
          JSON.stringify(previous.command) !== JSON.stringify(native.command))
      )
        return false;
      if (native.source === "item/commandExecution/outputDelta") {
        if (!previous || previous.output?.truncated) return false;
        const previousBytes = previous.output
          ? new TextEncoder().encode(previous.output.text).byteLength
          : 0;
        const output = {
          text: (previous.output?.text ?? "") + (native.output?.text ?? ""),
          truncated:
            previous.output?.truncated === true ||
            native.output?.truncated === true,
        };
        if (
          previousBytes +
            new TextEncoder().encode(native.output?.text ?? "").byteLength >
            SESSION_ACTIVITY_LIMITS.textBytes ||
          (previous.output?.truncated && !native.output?.truncated)
        )
          return false;
        turn.commands.set(native.itemId, { ...native, output });
      } else {
        if (native.source === "item/started" && previous) return false;
        if (!previous && turn.commands.size + turn.summaries.size >= 256)
          return false;
        turn.commands.set(native.itemId, native);
      }
      if (
        native.source === "item/completed" ||
        native.source === "turn/completed"
      )
        turn.closedCommands.add(native.itemId);
      continue;
    }
    if (native.kind === "turn" || native.kind === "identity") {
      if (native.threadId !== value.binding.sessionId) return false;
      if (native.kind === "turn") {
        if (turn.nativeTurn && turn.nativeTurn !== native.turnId) return false;
        turn.nativeTurn = native.turnId;
      }
    } else if (native.kind === "configuration") {
      if (
        (native.cwd !== snapshot.cwd && native.cwd !== snapshot.canonicalCwd) ||
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
function validOwnerLifecycle(value: {
  revision: number;
  binding: { provider: string; sessionId: string; version: string } | null;
  turns: { requestId: string }[];
  frames: { seq: number; turnId: string; event: ConversationEvent }[];
  codexChatOwnerLifecycle?: z.infer<typeof ownerLifecycle> | undefined;
}) {
  const facts = value.codexChatOwnerLifecycle ?? [],
    generations = new Map<string, string>(),
    started = new Map<string, z.infer<typeof ownerLifecycleFact>>(),
    released = new Set<string>();
  let previousRevision = 0;
  for (const fact of facts) {
    const generationOwner = generations.get(fact.generationId);
    if (
      fact.afterSequence > value.frames.length ||
      fact.revision > value.revision ||
      fact.revision <= previousRevision ||
      !value.turns.some((turn) => turn.requestId === fact.requestId)
    )
      return false;
    previousRevision = fact.revision;
    if (fact.kind === "generation-started") {
      if (started.has(fact.requestId) || generationOwner) return false;
      const process = value.frames.find(
        (item) =>
          item.turnId === fact.requestId &&
          item.event.kind === "coding-chat" &&
          item.event.event.kind === "process",
      );
      if (process && process.seq <= fact.afterSequence) return false;
      generations.set(fact.generationId, fact.requestId);
      started.set(fact.requestId, fact);
      continue;
    }
    const begin = started.get(fact.requestId),
      identityFrame = value.frames.find(
        (item) =>
          item.turnId === fact.requestId && item.event.kind === "identity",
      ),
      nativeTurnFrame = value.frames.find(
        (item) =>
          item.turnId === fact.requestId &&
          item.event.kind === "coding-chat" &&
          item.event.event.kind === "turn",
      ),
      identity = identityFrame?.event,
      nativeTurn = nativeTurnFrame?.event;
    if (
      !begin ||
      generationOwner !== fact.requestId ||
      begin.generationId !== fact.generationId ||
      begin.revision >= fact.revision ||
      fact.afterSequence < begin.afterSequence ||
      fact.afterSequence < (identityFrame?.seq ?? 0) ||
      fact.afterSequence < (nativeTurnFrame?.seq ?? 0) ||
      released.has(fact.requestId) ||
      value.binding?.provider !== "codex" ||
      value.binding.sessionId !== fact.binding.sessionId ||
      value.binding.version !== fact.binding.version ||
      identity?.kind !== "identity" ||
      identity.provider !== "codex" ||
      identity.sessionId !== fact.binding.sessionId ||
      identity.version !== fact.binding.version ||
      nativeTurn?.kind !== "coding-chat" ||
      nativeTurn.event.kind !== "turn" ||
      nativeTurn.event.threadId !== fact.binding.sessionId ||
      nativeTurn.event.turnId !== fact.binding.turnId
    )
      return false;
    const outcome = value.frames.find(
      (item) =>
        item.turnId === fact.requestId &&
        item.event.kind === "coding-chat" &&
        item.event.event.kind === "outcome",
    )?.seq;
    if (outcome !== undefined && outcome <= fact.afterSequence) return false;
    released.add(fact.requestId);
  }
  return facts.every(
    (fact) => fact.kind === "generation-started" || started.has(fact.requestId),
  );
}

export const ownedCodingStateSchema = stateSchema
  .extend({
    frames: z.array(frame).max(20_000),
    codexChatOwnerLifecycle: ownerLifecycle.optional(),
    keeperBriefIntents: z.never().optional(),
  })
  .strict()
  .refine(inProject)
  .refine(validOwnerLifecycle)
  .refine((value) => reportedTurn(value, true))
  .refine(nativeChatHistory)
  .refine(validGeminiChatHistory)
  .refine(validGeminiTaskHistory);
export const ownedCodingPageSchema = conversationPageSchema
  .extend({ frames: z.array(frame).max(100) })
  .strict()
  .refine(inProject)
  .refine(validGeminiChatPage)
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
const preparedGeminiChat = prepared
  .omit({ codexTask: true })
  .extend({ geminiChat: preparedGeminiChatSchema })
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
    Object.hasOwn(input, "geminiChat")
  ) {
    const parsed = preparedGeminiChat.safeParse(input);
    if (!parsed.success)
      throw new ConversationError(
        400,
        "Expected a bounded private owned Gemini Chat.",
      );
    return parsed.data;
  }
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
