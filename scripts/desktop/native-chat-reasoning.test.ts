import { expect, test } from "bun:test";
import { SessionActivity } from "../../apps/desktop/src/SessionActivity";
import { ownedSessionTurn } from "../../apps/desktop/src/session-activity";
import type { CodexChatReasoningSummary } from "../../types/codex-chat";
import type {
  ConversationEvent,
  ConversationPage,
} from "../../types/conversation";
import { attrs, findAll, textOf } from "../dashboard/ds/vnode";

const threadId = "0199a213-81c0-7800-8aa1-bbab2a035a53",
  nativeTurn = "0199a213-81c0-7800-8aa1-bbab2a035a54",
  turnId = "accepted-human-turn",
  version = "0.163.0-alpha.10.2";
const summary: CodexChatReasoningSummary = {
  kind: "reasoning-summary",
  source: "item/started",
  threadId,
  turnId: nativeTurn,
  itemId: "reported-summary",
  partial: true,
  update: {
    kind: "snapshot",
    summary: [{ text: "Initial snapshot", truncated: false }],
    truncated: false,
    closure: "open",
    turnStatus: null,
  },
};
const event = (report: CodexChatReasoningSummary): ConversationEvent => ({
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
      turnId,
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

test("native reasoning keeps supplied snapshots and indexed streams independent in a collapsed inert disclosure", () => {
  const current = page([
    event(summary),
    event({
      ...summary,
      source: "item/reasoning/summaryPartAdded",
      update: { kind: "part-added", summaryIndex: 0 },
    }),
    event({
      ...summary,
      source: "item/reasoning/summaryTextDelta",
      update: {
        kind: "delta",
        summaryIndex: 0,
        content: { text: "<script>visible </script>", truncated: false },
        prefixMissing: false,
      },
    }),
    event({
      ...summary,
      source: "item/reasoning/summaryTextDelta",
      update: {
        kind: "delta",
        summaryIndex: 0,
        content: { text: "summary suffix", truncated: true },
        prefixMissing: false,
      },
    }),
    event({
      ...summary,
      source: "item/completed",
      partial: false,
      update: {
        kind: "snapshot",
        summary: [{ text: "Distinct final snapshot", truncated: false }],
        truncated: false,
        closure: "item-ended",
        turnStatus: null,
      },
    }),
    event({
      ...summary,
      source: "turn/completed",
      partial: false,
      update: {
        kind: "snapshot",
        summary: [{ text: "Distinct final snapshot", truncated: false }],
        truncated: false,
        closure: "turn-ended",
        turnStatus: "completed",
      },
    }),
  ]);
  const value = ownedSessionTurn(current, turnId);
  expect(value).toMatchObject({
    nativeSummaries: [
      {
        initialSnapshot: { summary: [{ text: "Initial snapshot" }] },
        itemSnapshot: { summary: [{ text: "Distinct final snapshot" }] },
        turnSnapshot: { turnStatus: "completed" },
        earlierReportsMissing: false,
        parts: [
          {
            index: 0,
            announced: true,
            prefixMissing: false,
            content: {
              text: "<script>visible </script>summary suffix",
              truncated: true,
            },
          },
        ],
      },
    ],
  });
  const view = SessionActivity({ value });
  expect(textOf(view)).toContain("Reported reasoning summary");
  expect(textOf(view)).toContain("Initial snapshot");
  expect(textOf(view)).toContain("Distinct final snapshot");
  expect(textOf(view)).toContain("<script>visible </script>summary suffix");
  expect(textOf(view)).toContain("truncated");
  expect(textOf(view)).not.toContain("Reasoning completed");
  for (const tag of ["button", "a", "script", "iframe", "img"])
    expect(findAll(view, tag)).toHaveLength(0);
  const disclosure = findAll(view, "details");
  expect(disclosure).toHaveLength(1);
  expect(attrs(disclosure[0]!).open).toBeUndefined();
});

test("unannounced indices and partially loaded streams remain incomplete, while an empty final snapshot is only an absent report", () => {
  const current = page([
    event({
      ...summary,
      update: {
        ...summary.update,
        kind: "snapshot",
        summary: [],
        truncated: false,
        closure: "open",
        turnStatus: null,
      },
    }),
    event({
      ...summary,
      source: "item/reasoning/summaryTextDelta",
      update: {
        kind: "delta",
        summaryIndex: 7,
        content: { text: "Unannounced suffix", truncated: false },
        prefixMissing: true,
      },
    }),
    event({
      ...summary,
      source: "item/reasoning/summaryPartAdded",
      update: { kind: "part-added", summaryIndex: 7 },
    }),
    event({
      ...summary,
      source: "item/reasoning/summaryPartAdded",
      update: { kind: "part-added", summaryIndex: 2 },
    }),
    event({
      ...summary,
      source: "turn/completed",
      update: {
        kind: "snapshot",
        summary: [],
        truncated: false,
        closure: "turn-ended",
        turnStatus: "interrupted",
      },
    }),
  ]);
  const value = ownedSessionTurn(current, turnId);
  expect(value).toMatchObject({
    nativeSummaries: [
      {
        report: { partial: true },
        turnSnapshot: { summary: [], turnStatus: "interrupted" },
        parts: [
          {
            index: 7,
            announced: true,
            prefixMissing: true,
            content: { text: "Unannounced suffix" },
          },
          { index: 2, announced: true, prefixMissing: false, content: null },
        ],
      },
    ],
  });
  const view = SessionActivity({ value });
  expect(textOf(view)).toContain("Partial report");
  expect(textOf(view)).toContain("Earlier text for this part is missing");
  expect(textOf(view)).toContain(
    "No summary text was reported in this snapshot",
  );
  expect(textOf(view)).toContain("Text not reported for this part");
  expect(textOf(view)).not.toMatch(/redacted|unsupported|reasoning completed/i);
  const partial = { ...current, frames: current.frames.slice(1, 4) };
  expect(ownedSessionTurn(partial, turnId)).toMatchObject({
    nativeSummaries: [{ earlierReportsMissing: true }],
  });
  expect(
    textOf(SessionActivity({ value: ownedSessionTurn(partial, turnId) })),
  ).toContain("Earlier reasoning reports are not available in this view");
  const empty = SessionActivity({ value: ownedSessionTurn(page([]), turnId) });
  expect(empty).toBeNull();
});

test("reasoning presentation refuses foreign accepted/native identity and does not reopen ended items or a terminal turn", () => {
  const started = event(summary),
    ended = event({
      ...summary,
      source: "item/completed",
      partial: false,
      update: {
        kind: "snapshot",
        summary: [{ text: "Saved final", truncated: false }],
        truncated: false,
        closure: "item-ended",
        turnStatus: null,
      },
    }),
    delta = event({
      ...summary,
      source: "item/reasoning/summaryTextDelta",
      update: {
        kind: "delta",
        summaryIndex: 0,
        content: { text: "Late excluded text", truncated: false },
        prefixMissing: true,
      },
    });
  const current = page([started, ended, delta]);
  expect(
    textOf(SessionActivity({ value: ownedSessionTurn(current, turnId) })),
  ).not.toContain("Late excluded text");
  const bindings: Array<ConversationPage["binding"]> = [
    null,
    { provider: "claude", sessionId: threadId, version },
    { provider: "codex", sessionId: "foreign", version },
    { provider: "codex", sessionId: threadId, version: "different" },
  ];
  for (const binding of bindings)
    expect(ownedSessionTurn({ ...current, binding }, turnId)).toMatchObject({
      nativeSummaries: [],
    });
  expect(ownedSessionTurn(current, "another-accepted-turn")).toMatchObject({
    nativeSummaries: [],
  });
  const foreign = page([
    {
      kind: "coding-chat",
      provider: "codex",
      version,
      event: { kind: "turn", threadId, turnId: "another-native-turn" },
    },
    started,
  ]);
  expect(ownedSessionTurn(foreign, turnId)).toMatchObject({
    nativeSummaries: [],
  });
  const terminal = page([
    started,
    {
      kind: "coding-chat",
      provider: "codex",
      version,
      event: {
        kind: "outcome",
        outcome: {
          phase: "failed",
          reason: "Actual native failure",
          threadId,
          turnId: nativeTurn,
          observedModel: null,
          usage: null,
          exitCode: 1,
          stopped: false,
          timedOut: false,
        },
      },
    },
    delta,
    event({ ...summary, itemId: "late-created-item" }),
  ]);
  const result = ownedSessionTurn(terminal, turnId);
  expect(result).toMatchObject({ nativeSummaries: [{ parts: [] }] });
  expect(findAll(SessionActivity({ value: result }), "details")).toHaveLength(
    1,
  );
});

test("interleaved native items retain their own indexed text and completed-only snapshots do not invent streams after reload", () => {
  const delta = (itemId: string, value: string): ConversationEvent =>
    event({
      ...summary,
      itemId,
      source: "item/reasoning/summaryTextDelta",
      update: {
        kind: "delta",
        summaryIndex: 4,
        content: { text: value, truncated: false },
        prefixMissing: true,
      },
    });
  const current = page([
    delta("first", "First suffix "),
    delta("second", "Second suffix"),
    delta("first", "continued"),
    event({
      ...summary,
      itemId: "completed-only",
      source: "turn/completed",
      partial: false,
      update: {
        kind: "snapshot",
        summary: [{ text: "Only supplied final snapshot", truncated: false }],
        truncated: false,
        closure: "turn-ended",
        turnStatus: "completed",
      },
    }),
  ]);
  const projected = ownedSessionTurn(current, turnId);
  expect(projected).toMatchObject({
    nativeSummaries: [
      {
        report: { itemId: "first" },
        parts: [
          {
            index: 4,
            prefixMissing: true,
            content: { text: "First suffix continued" },
          },
        ],
      },
      {
        report: { itemId: "second" },
        parts: [
          { index: 4, prefixMissing: true, content: { text: "Second suffix" } },
        ],
      },
      {
        report: { itemId: "completed-only" },
        initialSnapshot: null,
        parts: [],
        earlierReportsMissing: false,
      },
    ],
  });
  expect(ownedSessionTurn(structuredClone(current), turnId)).toEqual(projected);
  expect(
    findAll(SessionActivity({ value: projected }), "details"),
  ).toHaveLength(3);
});
