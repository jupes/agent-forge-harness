import type { CodexCodingUsageEvent } from "../../../types/codex-owned-task";
import type { ConversationPage } from "../../../types/conversation";
import type {
  ClaudeCodingUsageEvent,
  CodingActivityEvent,
  CodingOutcomeEvent,
} from "../../../types/session-activity";

export interface OwnedSessionTurn {
  activities: CodingActivityEvent[];
  usage: ClaudeCodingUsageEvent | CodexCodingUsageEvent | null;
  outcome: CodingOutcomeEvent | null;
  observedModel: string | null;
  requestedModel: string | null;
}

/** Protected private frames are cumulative reports, not instructions or new transcript authority. */
export function ownedSessionTurn(
  page: ConversationPage | null,
  turnId: string,
): OwnedSessionTurn {
  const activities = new Map<string, CodingActivityEvent>();
  const result: OwnedSessionTurn = {
    activities: [],
    usage: null,
    outcome: null,
    observedModel: null,
    requestedModel: null,
  };
  for (const frame of page?.frames ?? []) {
    if (frame.turnId !== turnId) continue;
    const event = frame.event;
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
    } else if (event.kind === "coding-usage") result.usage = event;
    else if (event.kind === "coding-outcome") result.outcome = event;
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
  result.activities = [...activities.values()];
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

export interface OwnedSessionLifecycle {
  state:
    | "loading"
    | "empty"
    | "starting"
    | "running"
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
