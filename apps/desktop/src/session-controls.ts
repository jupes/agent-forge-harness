import { serializeClaudeLaunch } from "../../../scripts/sessions/claude-launch";
import { serializeCodexChat } from "../../../scripts/sessions/codex-app-server-protocol";
import { serializeCodexTask } from "../../../scripts/sessions/codex-task";
import {
  serializeGeminiChat,
  serializeGeminiTask,
} from "../../../scripts/sessions/gemini-task";
import type { OwnedCodingSessionRecord } from "../../../types/codex-owned-task";
import type { ConversationPage } from "../../../types/conversation";
import { geminiChatOutcome } from "./gemini-chat-presentation";
import { ownedCodexChatOutcome } from "./session-activity";

export function ownedSessionControls(input: {
  record: OwnedCodingSessionRecord;
  page: ConversationPage | null;
  loaded: boolean;
  live: boolean;
  pending: boolean;
  stopping: boolean;
  feedInterrupted?: boolean;
  readError?: string;
}) {
  const current = input.page?.turns.at(-1);
  const active =
    !!current && ["accepted", "running", "cancelling"].includes(current.phase);
  const scoped =
    !input.record.origin &&
    input.page?.projectId === input.record.projectId &&
    input.page.conversationId === input.record.id;
  const first = scoped
    ? input.page?.frames.find(
        ({ event, turnId }) =>
          turnId === input.record.requestId && event.kind === "user",
      )?.event
    : undefined;
  const snapshot = first?.kind === "user" ? first.session : undefined;
  const codex = first?.kind === "user" ? first.codexTask : undefined;
  const chat = first?.kind === "user" ? first.codexChat : undefined;
  const gemini = first?.kind === "user" ? first.geminiTask : undefined;
  const geminiChat = first?.kind === "user" ? first.geminiChat : undefined;
  let commandPreview: string | null = null;
  try {
    const serialized =
      input.record.provider === "claude" && snapshot
        ? serializeClaudeLaunch(snapshot.launch, snapshot.capabilities)
        : input.record.provider === "codex" &&
            input.record.mode === "task" &&
            codex
          ? serializeCodexTask(codex.launch, codex.capabilities)
          : input.record.provider === "codex" &&
              input.record.mode === "chat" &&
              chat
            ? serializeCodexChat(chat.launch, chat.capabilities)
            : input.record.provider === "gemini" &&
                input.record.mode === "task" &&
                gemini
              ? serializeGeminiTask(gemini.launch, gemini.capabilities)
              : input.record.provider === "gemini" &&
                  input.record.mode === "chat" &&
                  geminiChat
                ? serializeGeminiChat(
                    geminiChat.launch,
                    geminiChat.capabilities,
                  )
                : null;
    if (serialized)
      commandPreview = `${serialized.equivalentCommand}\n\n${serialized.stdinNote}`;
  } catch {
    /* Unsupported snapshots never become invented commands. */
  }
  const codexNativeChat =
    input.record.provider === "codex" &&
    input.record.mode === "chat" &&
    !!chat &&
    !!commandPreview;
  const geminiNativeChat =
    input.record.provider === "gemini" &&
    input.record.mode === "chat" &&
    !!geminiChat &&
    !!commandPreview;
  const nativeChat = codexNativeChat || geminiNativeChat;
  const nativePermissions =
    geminiNativeChat ||
    (codexNativeChat && chat?.launch.approvalPolicy === "on-request");
  const nativeEnded =
    nativeChat &&
    !!current &&
    !!(geminiNativeChat
      ? geminiChatOutcome(input.page, current.requestId)
      : ownedCodexChatOutcome(input.page, current.requestId));
  const provider =
    input.record.provider === "codex"
      ? "Codex"
      : input.record.provider === "gemini"
        ? "Gemini"
        : "Claude";
  const ready =
    input.loaded && input.live && !input.feedInterrupted && !input.readError;
  const resumeReason = !scoped
    ? "This saved conversation does not match an ordinary session in this project."
    : input.record.mode !== "chat"
      ? `This ${provider} route supports one-turn Tasks. Start another session explicitly.`
      : !(input.record.provider === "claude" && snapshot && commandPreview) &&
          !nativeChat
        ? "The saved launch does not verify a supported Chat route."
        : !ready
          ? "Reconnect the private conversation before continuing this Chat."
          : !input.page?.binding ||
              input.page.binding.provider !== input.record.provider ||
              input.page.binding.version !==
                (geminiNativeChat
                  ? geminiChat?.capabilities.version
                  : codexNativeChat
                    ? chat?.capabilities.version
                    : snapshot?.capabilities.version)
            ? `A confirmed ${provider} conversation id and matching CLI version are required.`
            : input.record.provider === "claude" &&
                !snapshot?.capabilities.flags.includes("--resume")
              ? "The saved CLI capability report does not support exact conversation resume."
              : active ||
                  input.pending ||
                  input.stopping ||
                  current?.phase === "unknown"
                ? "Check the current turn and pending changes before sending another follow-up."
                : !current
                  ? "No accepted conversation turn is recorded yet."
                  : current.phase !== "completed"
                    ? "The current turn has not completed. Check its outcome before continuing this Chat."
                    : null;
  const terminalReason =
    input.record.provider !== "claude"
      ? "Native terminal handoff is currently supported only for a verified Claude Chat on Windows x64."
      : input.record.mode !== "chat"
        ? "Only a completed Claude Chat can open in a terminal."
        : resumeReason !== null
          ? resumeReason
          : null;
  return {
    commandPreview,
    resume: {
      available: resumeReason === null,
      reason:
        resumeReason ??
        `Focus the reply composer for a new follow-up in this same confirmed ${provider} conversation.`,
    },
    stop: {
      available:
        scoped &&
        active &&
        !nativeEnded &&
        !!input.page?.controllable &&
        !input.stopping &&
        current?.phase !== "cancelling",
      reason: !scoped
        ? "This saved conversation does not match an ordinary session in this project."
        : input.stopping || current?.phase === "cancelling"
          ? "Stop is pending until the owned process confirms cancellation."
          : !active || nativeEnded
            ? "There is no active owned turn to stop."
            : !input.page?.controllable
              ? "This hearth does not own the saved running process."
              : "The existing Stop action requests cancellation of this owned process only.",
    },
    fork: {
      available: false,
      reason: "Forking this conversation is unavailable here.",
    },
    terminal: {
      available: terminalReason === null,
      reason:
        terminalReason ??
        "Review the saved source input and exact Claude Chat identity before opening the managed terminal.",
    },
    permissions: {
      inline: nativeChat,
      available:
        nativePermissions &&
        ready &&
        active &&
        !nativeEnded &&
        !!input.page?.controllable &&
        !input.stopping &&
        current?.phase !== "cancelling",
      reason: nativePermissions
        ? "Review the inline native permission cards. Only current verified requests offer decisions; saved history does not."
        : nativeChat
          ? "This Chat was started with permission requests disabled. Start a new Chat explicitly to choose a different policy."
          : "This provider route cannot receive live permission decisions here. Historical permission denials remain read-only.",
    },
  };
}
