import { serializeClaudeLaunch } from "../../../scripts/sessions/claude-launch";
import { serializeCodexTask } from "../../../scripts/sessions/codex-task";
import type { OwnedCodingSessionRecord } from "../../../types/codex-owned-task";
import type { ConversationPage } from "../../../types/conversation";

export function ownedSessionControls(input: {
  record: OwnedCodingSessionRecord;
  page: ConversationPage | null;
  loaded: boolean;
  live: boolean;
  pending: boolean;
  stopping: boolean;
}) {
  const current = input.page?.turns.at(-1);
  const active =
    !!current && ["accepted", "running", "cancelling"].includes(current.phase);
  const first = input.page?.frames.find(
    ({ event }) => event.kind === "user" && (event.session || event.codexTask),
  )?.event;
  const snapshot = first?.kind === "user" ? first.session : undefined;
  const codex = first?.kind === "user" ? first.codexTask : undefined;
  let commandPreview: string | null = null;
  try {
    const serialized = snapshot
      ? serializeClaudeLaunch(snapshot.launch, snapshot.capabilities)
      : codex
        ? serializeCodexTask(codex.launch, codex.capabilities)
        : null;
    if (serialized)
      commandPreview = `${serialized.equivalentCommand}\n\n${serialized.stdinNote}`;
  } catch {
    /* Unsupported snapshots never become invented commands. */
  }
  const resumeReason =
    input.record.provider !== "claude"
      ? "This Codex exec route supports one-turn Tasks. Native Chat is not connected to this view."
      : input.record.mode !== "chat"
        ? "A Task accepts one turn. Start another session explicitly."
        : !input.loaded || !input.live
          ? "Reconnect the private conversation before continuing this Chat."
          : !input.page?.binding || input.page.binding.provider !== "claude"
            ? "A confirmed Claude conversation id is required."
            : !snapshot?.capabilities.flags.includes("--resume")
              ? "The saved CLI capability report does not support exact conversation resume."
              : active ||
                  input.pending ||
                  input.stopping ||
                  current?.phase === "unknown"
                ? "Check the current turn and pending changes before sending another follow-up."
                : !current
                  ? "No accepted conversation turn is recorded yet."
                  : null;
  return {
    commandPreview,
    resume: {
      available: resumeReason === null,
      reason:
        resumeReason ??
        "Focus the reply composer for a new follow-up in this same confirmed Claude conversation.",
    },
    stop: {
      available:
        active &&
        !!input.page?.controllable &&
        !input.stopping &&
        current?.phase !== "cancelling",
      reason:
        input.stopping || current?.phase === "cancelling"
          ? "Stop is pending until the owned process confirms cancellation."
          : !active
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
      available: false,
      reason: "Opening this conversation in a terminal is unavailable here.",
    },
    permissions: {
      available: false,
      reason:
        "This provider cannot receive live permission decisions here. Historical permission denials remain read-only.",
    },
  };
}
