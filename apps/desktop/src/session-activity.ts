import type {
  CodexChatCommand,
  CodexChatOutcome,
  CodexChatUsage,
} from "../../../types/codex-chat";
import type { CodexCodingUsageEvent } from "../../../types/codex-owned-task";
import type { ConversationPage } from "../../../types/conversation";
import type {
  ClaudeCodingUsageEvent,
  CodingActivityEvent,
  CodingOutcomeEvent,
  ReportedText,
} from "../../../types/session-activity";
import type { CodexChatDecisionView } from "./codex-chat-decisions";
import {
  type NativeChatFileChangeReport,
  nativeChatFileChanges,
} from "./native-chat-file-changes";
import {
  type NativeChatMcpToolCallReport,
  nativeChatMcpToolCalls,
} from "./native-chat-mcp-tool-calls";
import {
  type NativeChatReasoningReport,
  nativeChatReasoningSummaries,
} from "./native-chat-reasoning";
import { nativeChatTurnFinalReport } from "./native-chat-turn-closure";
import {
  type NativeChatTurnPlanReport,
  nativeChatTurnPlan,
} from "./native-chat-turn-plan";
import {
  type NativeChatWebSearchReport,
  nativeChatWebSearches,
} from "./native-chat-web-search";

export interface NativeChatCommandReport {
  version: string;
  report: CodexChatCommand;
  initialAggregate: ReportedText | null;
  finalAggregate: ReportedText | null;
  streamedOutput: ReportedText | null;
  streamPrefixMissing: boolean;
}

export interface ClaudeRateLimitResetFact {
  source: "claude.rate_limit_event";
  resetsAt?: number;
  resetUnit: "unreported";
}

export interface OwnedSessionTurn {
  activities: CodingActivityEvent[];
  nativeCommands: NativeChatCommandReport[];
  nativeFileChanges: NativeChatFileChangeReport[];
  nativeMcpToolCalls: NativeChatMcpToolCallReport[];
  nativeWebSearches: NativeChatWebSearchReport[];
  nativeSummaries: NativeChatReasoningReport[];
  nativePlan: NativeChatTurnPlanReport | null;
  usage: ClaudeCodingUsageEvent | CodexCodingUsageEvent | null;
  outcome: CodingOutcomeEvent | null;
  rateLimitReset: ClaudeRateLimitResetFact | null;
  observedModel: string | null;
  requestedModel: string | null;
}

/** Protected private frames are cumulative reports, not instructions or new transcript authority. */
export function ownedSessionTurn(
  page: ConversationPage | null,
  turnId: string,
): OwnedSessionTurn {
  const activities = new Map<string, CodingActivityEvent>();
  const commands = new Map<string, NativeChatCommandReport>();
  const frames = (page?.frames ?? []).filter(
      (frame) => frame.turnId === turnId,
    ),
    nativeTurns = new Set(
      frames.flatMap(({ event }) =>
        event.kind === "coding-chat" &&
        event.version === page?.binding?.version &&
        "threadId" in event.event &&
        "turnId" in event.event &&
        event.event.threadId === page?.binding?.sessionId
          ? [event.event.turnId]
          : [],
      ),
    ),
    nativeTurn =
      nativeTurns.size === 1
        ? (nativeTurns.values().next().value ?? null)
        : null;
  let nativeTurnEnded = false;
  let latestClaudeRateLimitReset: ClaudeRateLimitResetFact | null = null;
  const result: OwnedSessionTurn = {
    activities: [],
    nativeCommands: [],
    nativeFileChanges: nativeChatFileChanges(page, turnId),
    nativeMcpToolCalls: nativeChatMcpToolCalls(page, turnId),
    nativeWebSearches: nativeChatWebSearches(page, turnId),
    nativeSummaries: nativeChatReasoningSummaries(page, turnId),
    nativePlan: nativeChatTurnPlan(page, turnId),
    usage: null,
    outcome: null,
    rateLimitReset: null,
    observedModel: null,
    requestedModel: null,
  };
  for (const frame of frames) {
    const event = frame.event;
    const finalNativeReport =
      page?.binding?.provider === "codex" &&
      nativeTurn !== null &&
      event.kind === "coding-chat" &&
      event.version === page.binding.version &&
      nativeChatTurnFinalReport(
        event.event,
        page.binding.sessionId,
        nativeTurn,
      );
    if (finalNativeReport) nativeTurnEnded = true;
    if (event.kind === "coding-activity") {
      const key = JSON.stringify([
        event.provider,
        event.version,
        event.activity.kind,
        event.id,
      ]);
      const previous = activities.get(key);
      if (
        event.activity.kind === "tool" &&
        previous?.activity.kind === "tool" &&
        event.activity.toolId === previous.activity.toolId &&
        event.activity.name === previous.activity.name
      )
        activities.set(key, {
          ...event,
          activity: { ...previous.activity, ...event.activity },
        });
      else activities.set(key, event);
    } else if (event.kind === "coding-chat" && event.event.kind === "command") {
      const report = event.event;
      if (
        page?.binding?.provider !== "codex" ||
        page.binding.sessionId !== report.threadId ||
        page.binding.version !== event.version ||
        (nativeTurnEnded && !finalNativeReport)
      )
        continue;
      const key = JSON.stringify([
        report.threadId,
        report.turnId,
        report.itemId,
      ]);
      const previous = commands.get(key);
      if (
        previous &&
        (previous.report.status !== "inProgress" ||
          previous.report.source === "turn/completed" ||
          previous.report.source === "item/completed")
      )
        continue;
      const streamedOutput =
        report.outputSource === "delta" && report.output
          ? {
              text: (previous?.streamedOutput?.text ?? "") + report.output.text,
              truncated:
                previous?.streamedOutput?.truncated === true ||
                report.output.truncated,
            }
          : (previous?.streamedOutput ?? null);
      commands.set(key, {
        version: event.version,
        report,
        initialAggregate:
          report.source === "item/started"
            ? report.output
            : (previous?.initialAggregate ?? null),
        finalAggregate:
          report.source === "item/completed" ||
          report.source === "turn/completed"
            ? report.output
            : null,
        streamedOutput,
        streamPrefixMissing:
          previous?.streamPrefixMissing ??
          report.source === "item/commandExecution/outputDelta",
      });
    } else if (event.kind === "coding-usage") result.usage = event;
    else if (event.kind === "coding-outcome") result.outcome = event;
    else if (
      page?.binding?.provider === "claude" &&
      event.kind === "coding-account" &&
      event.provider === "claude" &&
      event.version === page.binding.version &&
      event.source === "claude.rate_limit_event"
    )
      latestClaudeRateLimitReset = {
        source: event.source,
        ...(event.report.resetsAt === undefined
          ? {}
          : { resetsAt: event.report.resetsAt }),
        resetUnit: event.report.resetUnit,
      };
    else if (event.kind === "model") result.observedModel = event.model;
    else if (event.kind === "user")
      result.requestedModel =
        event.session?.launch.model ??
        event.codexTask?.launch.model ??
        event.geminiTask?.launch.model ??
        null;
    else if (event.kind === "process" && result.requestedModel === null)
      result.requestedModel = event.requestedModel;
  }
  result.rateLimitReset =
    page?.binding?.provider === "claude" &&
    result.outcome?.code === "rate-limited" &&
    result.outcome.provider === "claude" &&
    result.outcome.version === page.binding.version
      ? latestClaudeRateLimitReset
      : null;
  result.activities = [...activities.values()];
  result.nativeCommands = [...commands.values()];
  return result;
}

export const unsupportedSessionStates = [
  {
    label: "Needs permission",
    reason:
      "These non-interactive transports do not expose live permission requests. Tool reports do not grant approval authority.",
  },
  {
    label: "Waiting for input",
    reason:
      "These transports do not expose an interactive input request. A completed Chat can accept an explicit next turn.",
  },
  {
    label: "Observed",
    reason:
      "Observed sessions run outside app ownership. This view reads an app-owned private conversation.",
  },
] as const;

export function sessionStateSupport(
  nativeChat: boolean,
  requestsEnabled = true,
) {
  return unsupportedSessionStates.map((item) =>
    item.label === "Needs permission" && nativeChat
      ? {
          label: item.label,
          reason: requestsEnabled
            ? "Current verified native requests appear in the inline permission cards. Saved reports never authorize a decision."
            : "Permission requests were disabled when this Chat started. Saved reports never authorize a decision.",
        }
      : item,
  );
}

export interface OwnedSessionLifecycle {
  state:
    | "loading"
    | "empty"
    | "starting"
    | "running"
    | "needs-permission"
    | "idle"
    | "ended"
    | "error"
    | "stopped"
    | "timed-out"
    | "stale"
    | "unknown";
  label: string;
  detail: string;
}

/** A saved outcome describes this accepted turn only; it grants no process or reply authority. */
export function ownedCodexChatOutcome(
  page: ConversationPage | null,
  turnId: string,
): CodexChatOutcome | null {
  const saved = [...(page?.frames ?? [])]
    .reverse()
    .find(
      (frame) =>
        frame.turnId === turnId &&
        frame.event.kind === "coding-chat" &&
        frame.event.event.kind === "outcome",
    )?.event;
  if (saved?.kind !== "coding-chat" || saved.event.kind !== "outcome")
    return null;
  const outcome = saved.event.outcome;
  if (
    outcome.threadId !== null &&
    (page?.binding?.provider !== "codex" ||
      outcome.threadId !== page.binding.sessionId)
  )
    return null;
  return outcome;
}

export function ownedCodexChatUsage(
  page: ConversationPage | null,
  turnId: string,
): CodexChatUsage | null {
  if (
    page?.binding?.provider !== "codex" ||
    !page.turns.some((turn) => turn.requestId === turnId)
  )
    return null;
  const latest = [...page.frames].reverse();
  const saved = latest.find(
    (frame) =>
      frame.turnId === turnId &&
      frame.event.kind === "coding-chat" &&
      frame.event.version === page.binding?.version &&
      frame.event.event.kind === "usage",
  )?.event;
  if (saved?.kind === "coding-chat" && saved.event.kind === "usage")
    return saved.event.usage;
  const terminal = latest.find(
    (frame) =>
      frame.turnId === turnId &&
      frame.event.kind === "coding-chat" &&
      frame.event.version === page.binding?.version &&
      frame.event.event.kind === "outcome",
  )?.event;
  return terminal?.kind === "coding-chat" &&
    terminal.event.kind === "outcome" &&
    terminal.event.outcome.threadId === page.binding.sessionId
    ? terminal.event.outcome.usage
    : null;
}

/** No clock heuristic or provider prose can establish process death, permissions or allowance. */
export function ownedSessionLifecycle(
  page: ConversationPage | null,
  view: {
    mode: "task" | "chat" | null;
    loaded: boolean;
    live: boolean;
    stopping: boolean;
    feedInterrupted: boolean;
    readError: string;
    approvals?: CodexChatDecisionView | null;
  },
): OwnedSessionLifecycle {
  const turn = page?.turns.at(-1);
  if (!turn && view.readError)
    return {
      state: "error",
      label: "Saved conversation unavailable",
      detail: view.readError,
    };
  if (!turn)
    return view.loaded
      ? {
          state: "empty",
          label: "No admitted turn reported",
          detail: "Check the original Start before sending another request.",
        }
      : {
          state: "loading",
          label: "Loading session…",
          detail: "Reading the saved private conversation.",
        };
  const outcome = ownedSessionTurn(page, turn.requestId).outcome;
  const chatOutcome = ownedCodexChatOutcome(page, turn.requestId);
  const geminiOutcome = page?.frames
    .filter(
      (frame) =>
        frame.turnId === turn.requestId &&
        frame.event.kind === "coding-gemini-task" &&
        frame.event.event.kind === "outcome",
    )
    .at(-1)?.event;
  if (
    outcome?.code === "timed-out" ||
    chatOutcome?.timedOut ||
    (geminiOutcome?.kind === "coding-gemini-task" &&
      geminiOutcome.event.kind === "outcome" &&
      geminiOutcome.event.timedOut)
  )
    return {
      state: "timed-out",
      label: "Timed out",
      detail:
        "The supervised process reached its time limit. Saved partial activity is retained; this turn was not resent.",
    };
  if (outcome?.code === "stopped" || turn.phase === "cancelled")
    return {
      state: "stopped",
      label: "Stopped",
      detail: "Stop is confirmed. Saved partial activity is retained.",
    };
  if (chatOutcome && ["accepted", "running", "cancelling"].includes(turn.phase))
    return chatOutcome.phase === "completed"
      ? {
          state: "ended",
          label: "Native turn ended",
          detail:
            "The native process ended. Waiting for the final saved conversation status before another follow-up.",
        }
      : {
          state: chatOutcome.phase === "failed" ? "error" : "unknown",
          label:
            chatOutcome.phase === "failed"
              ? "Ended with error"
              : "Outcome unknown",
          detail:
            chatOutcome.reason ??
            "The native provider did not confirm successful completion. This turn was not resent.",
        };
  if (turn.phase === "unknown")
    return {
      state: "unknown",
      label: "Outcome unknown",
      detail:
        turn.reason ??
        "Completion is not confirmed. Read the saved conversation before taking another action; this turn was not resent.",
    };
  if (turn.phase === "failed" || (outcome && outcome.code !== "completed"))
    return {
      state: "error",
      label: "Ended with error",
      detail:
        outcome?.code === "auth-error"
          ? "The provider reported an authentication error. Check its sign-in before starting another turn."
          : outcome?.code === "rate-limited"
            ? "The provider reported a usage limit. Check the reported allowance before starting another turn."
            : (turn.reason ??
              "The provider did not finish this turn. Saved partial activity and the reported outcome are retained below."),
    };
  if (turn.phase === "completed") {
    if (view.mode === "chat" && page?.binding)
      return {
        state: "idle",
        label: "Idle · ready for the next turn",
        detail:
          "The last turn ended. A follow-up resumes this same confirmed provider conversation.",
      };
    return {
      state: "ended",
      label: "Ended",
      detail:
        view.mode === "chat"
          ? "No confirmed provider conversation is available to resume. Check the original Start."
          : "This Task ended. Start another session explicitly for more work.",
    };
  }
  if (view.stopping || turn.phase === "cancelling")
    return {
      state: "running",
      label: "Stopping… waiting for confirmation",
      detail: "Stop was requested. The process is not confirmed stopped yet.",
    };
  if (view.feedInterrupted && !view.live)
    return {
      state: "stale",
      label: "Stale · live updates interrupted",
      detail:
        "The saved status may be out of date; process failure is not confirmed. Reload the conversation to check. This turn was not resent.",
    };
  if (!page?.controllable)
    return {
      state: turn.phase === "accepted" ? "starting" : "running",
      label: `Saved status: ${turn.phase === "accepted" ? "Starting" : "Running"}`,
      detail:
        "This hearth has no confirmed process ownership. The saved status does not prove the provider is still running; Stop is unavailable here.",
    };
  const approvals = view.approvals;
  if (
    view.mode === "chat" &&
    page.binding?.provider === "codex" &&
    view.loaded &&
    view.live &&
    !view.feedInterrupted &&
    !view.readError &&
    approvals?.actionable &&
    !approvals.error &&
    approvals.projectId === page.projectId &&
    approvals.sessionId === page.conversationId &&
    approvals.turnRequestId === turn.requestId &&
    approvals.pending.some(
      (item) => item.actionable && item.turnRequestId === turn.requestId,
    )
  )
    return {
      state: "needs-permission",
      label: "Needs permission",
      detail:
        "The provider is waiting for a permission decision. Review the current inline request; saved history cannot approve it.",
    };
  return turn.phase === "accepted"
    ? {
        state: "starting",
        label: "Starting",
        detail:
          "The original request was accepted. Waiting for the provider's first report.",
      }
    : {
        state: "running",
        label: "Running",
        detail:
          "Following this provider turn. Closing this view leaves its process running.",
      };
}
