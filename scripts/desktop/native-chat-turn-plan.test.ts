import { expect, test } from "bun:test";
import { nativeChatTurnPlan } from "../../apps/desktop/src/native-chat-turn-plan";
import { SessionActivity } from "../../apps/desktop/src/SessionActivity";
import { ownedSessionTurn } from "../../apps/desktop/src/session-activity";
import type { CodexChatEvent, CodexChatTurnPlan } from "../../types/codex-chat";
import type {
  ConversationEvent,
  ConversationPage,
} from "../../types/conversation";
import { attrs, findAll, textOf } from "../dashboard/ds/vnode";

const threadId = "0199a213-81c0-7800-8aa1-bbab2a035a53",
  nativeTurn = "0199a213-81c0-7800-8aa1-bbab2a035a54",
  appTurn = "accepted-application-turn",
  version = "0.163.0-alpha.10.2";
const plan: CodexChatTurnPlan = {
  kind: "turn-plan",
  source: "turn/plan/updated",
  threadId,
  turnId: nativeTurn,
  explanation: null,
  plan: [
    { step: { text: "Original step", truncated: false }, status: "completed" },
  ],
  truncated: false,
};
const event = (report: CodexChatEvent): ConversationEvent => ({
  kind: "coding-chat",
  provider: "codex",
  version,
  event: report,
});
function page(events: ConversationEvent[]): ConversationPage {
  return {
    version: 1,
    projectId: "fixture",
    conversationId: "session-fixture",
    revision: events.length,
    binding: { provider: "codex", sessionId: threadId, version },
    turns: [],
    frames: events.map((event, index) => ({
      seq: index + 1,
      turnId: appTurn,
      at: "2026-10-23T00:00:00Z",
      event,
    })),
    more: false,
    nextCursor: events.length,
    lastSequence: events.length,
    request: null,
    controllable: false,
  };
}

test("native turn plans choose the latest mutable replacement in one collapsed inert disclosure without treating steps as turn completion", () => {
  const revised: CodexChatTurnPlan = {
      ...plan,
      explanation: { text: "Revised supplied plan", truncated: false },
      plan: [
        {
          step: {
            text: "<script>inert</script> revised step",
            truncated: false,
          },
          status: "pending",
        },
      ],
    },
    current = page([
      event({ kind: "turn", threadId, turnId: nativeTurn }),
      event(plan),
      event(plan),
      event(revised),
    ]),
    before = structuredClone(current),
    value = ownedSessionTurn(current, appTurn),
    view = SessionActivity({ value });
  expect(value.nativePlan).toEqual({ version, report: revised });
  expect(nativeChatTurnPlan(current, appTurn)).toEqual(value.nativePlan);
  expect(textOf(view)).toContain("Reported turn plan");
  expect(textOf(view)).toContain("Latest reported snapshot in this view");
  expect(textOf(view)).toContain("Revised supplied plan");
  expect(textOf(view)).toContain("<script>inert</script> revised step");
  expect(textOf(view)).toContain("Pending");
  expect(textOf(view)).not.toContain("Original step");
  expect(textOf(view)).toContain(
    "Step status does not confirm that the chat turn has finished",
  );
  expect(textOf(view)).toContain("turn/plan/updated");
  const disclosures = findAll(view, "details");
  expect(disclosures).toHaveLength(1);
  expect(attrs(disclosures[0]).open).toBeUndefined();
  for (const tag of ["button", "a", "script", "iframe", "img"])
    expect(findAll(view, tag)).toHaveLength(0);
  expect(current).toEqual(before);
});

test("an absent plan stays unreported while explicit empty steps, null explanation and empty reported text remain distinct", () => {
  expect(nativeChatTurnPlan(null, appTurn)).toBeNull();
  expect(
    SessionActivity({ value: ownedSessionTurn(page([]), appTurn) }),
  ).toBeNull();
  const empty = { ...plan, plan: [] },
    view = SessionActivity({
      value: ownedSessionTurn(page([event(empty)]), appTurn),
    });
  expect(textOf(view)).toContain("No steps reported");
  expect(textOf(view)).toContain("Explanation not reported");
  const suppliedEmpty = SessionActivity({
    value: ownedSessionTurn(
      page([event({ ...empty, explanation: { text: "", truncated: false } })]),
      appTurn,
    ),
  });
  expect(textOf(suppliedEmpty)).not.toContain("Explanation not reported");
  expect(textOf(suppliedEmpty)).toContain("No text reported");
  expect(textOf(suppliedEmpty)).toContain("No steps reported");
});

test("native turn plans cannot borrow another application turn, native binding, version or conflicting native turn", () => {
  const current = page([
    event({ kind: "turn", threadId, turnId: nativeTurn }),
    event(plan),
  ]);
  expect(nativeChatTurnPlan(current, "other-application-turn")).toBeNull();
  for (const binding of [
    null,
    { provider: "claude" as const, sessionId: threadId, version },
    { provider: "codex" as const, sessionId: nativeTurn, version },
    { provider: "codex" as const, sessionId: threadId, version: "other" },
  ])
    expect(nativeChatTurnPlan({ ...current, binding }, appTurn)).toBeNull();
  expect(
    nativeChatTurnPlan(
      page([
        event({ kind: "turn", threadId, turnId: nativeTurn }),
        event({ ...plan, turnId: threadId }),
      ]),
      appTurn,
    ),
  ).toBeNull();
  expect(
    nativeChatTurnPlan(
      page([
        event({ kind: "turn", threadId, turnId: nativeTurn }),
        event({ kind: "turn", threadId, turnId: threadId }),
        event(plan),
      ]),
      appTurn,
    ),
  ).toBeNull();
  expect(
    nativeChatTurnPlan(
      page([event(plan), event({ ...plan, turnId: threadId })]),
      appTurn,
    ),
  ).toBeNull();
});

test("terminal native facts fence later plan snapshots but preserve the last supplied plan without adding lifecycle authority", () => {
  const later = {
    ...plan,
    explanation: { text: "LATE_NOT_VISIBLE", truncated: false },
  };
  for (const terminal of [
    event({
      kind: "outcome",
      outcome: {
        phase: "failed",
        reason: "actual failure",
        threadId,
        turnId: nativeTurn,
        observedModel: null,
        usage: null,
        exitCode: 1,
        stopped: false,
        timedOut: false,
      },
    }),
    event({
      kind: "reasoning-summary",
      source: "turn/completed",
      threadId,
      turnId: nativeTurn,
      itemId: "final",
      partial: false,
      update: {
        kind: "snapshot",
        summary: [],
        truncated: false,
        closure: "turn-ended",
        turnStatus: "completed",
      },
    }),
    event({
      kind: "command",
      source: "turn/completed",
      threadId,
      turnId: nativeTurn,
      itemId: "final",
      command: { text: "inert", truncated: false },
      cwd: "/fixture",
      status: "inProgress",
      output: null,
      outputSource: null,
      exitCode: null,
      durationMs: null,
      partial: true,
    }),
  ]) {
    const current = page([event(plan), terminal, event(later)]);
    expect(nativeChatTurnPlan(current, appTurn)).toEqual({
      version,
      report: plan,
    });
    expect(
      textOf(SessionActivity({ value: ownedSessionTurn(current, appTurn) })),
    ).not.toContain("LATE_NOT_VISIBLE");
  }
  const foreign = event({
    kind: "outcome",
    outcome: {
      phase: "failed",
      reason: "foreign",
      threadId: nativeTurn,
      turnId: nativeTurn,
      observedModel: null,
      usage: null,
      exitCode: 1,
      stopped: false,
      timedOut: false,
    },
  });
  expect(
    nativeChatTurnPlan(page([event(plan), foreign, event(later)]), appTurn),
  ).toEqual({ version, report: later });
});

test("protected partial plan snapshots remain self-contained and retain clipping facts across exact reload projection", () => {
  const report: CodexChatTurnPlan = {
      ...plan,
      explanation: { text: "Retained explanation", truncated: true },
      plan: [
        {
          step: { text: "Retained step", truncated: true },
          status: "inProgress",
        },
      ],
      truncated: true,
    },
    current = page([event(report)]);
  const saved = current.frames[0];
  if (!saved) throw Error("Missing planted partial plan");
  saved.seq = 101;
  current.nextCursor = 101;
  current.lastSequence = 101;
  const value = ownedSessionTurn(current, appTurn),
    view = SessionActivity({ value });
  expect(value.nativePlan).toEqual({ version, report });
  expect(nativeChatTurnPlan(structuredClone(current), appTurn)).toEqual(
    value.nativePlan,
  );
  expect(textOf(view)).toContain("Plan truncated");
  expect(textOf(view)).toContain("Step truncated");
  expect(textOf(view)).not.toContain("prefix");
  expect(textOf(view)).not.toContain("Earlier");
});
