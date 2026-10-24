import { expect, test } from "bun:test";
import { GeminiChatActivity } from "../../apps/desktop/src/GeminiChatActivity";
import { geminiChatPresentation } from "../../apps/desktop/src/gemini-chat-presentation";
import type { ConversationPage } from "../../types/conversation";
import type { GeminiChatPrivateFrame } from "../../types/gemini-owned-chat";
import { attrs, findAll, textOf } from "../dashboard/ds/vnode";

const turnId = "a5832fa0-7a21-403b-8184-44892f0d8d86";
function page(events: GeminiChatPrivateFrame["event"][]): ConversationPage {
  return {
    version: 1,
    projectId: "fixture",
    conversationId: `session-${turnId}`,
    revision: events.length,
    binding: { provider: "gemini", version: "0.65.0", sessionId: turnId },
    turns: [],
    frames: events.map((event, index) => ({
      seq: index + 1,
      turnId,
      at: "2026-10-23T00:00:00Z",
      event: {
        kind: "coding-gemini-chat",
        provider: "gemini",
        version: "0.65.0",
        event,
      },
    })),
    more: false,
    nextCursor: events.length,
    lastSequence: events.length,
    request: null,
    controllable: false,
  };
}
test("only exact accepted-turn assistant chunks become a reply; native-session replay and user text retain their own scope", () => {
  const value = page([
    {
      kind: "text",
      role: "assistant",
      scope: "turn",
      requestId: turnId,
      text: "**First",
    },
    {
      kind: "text",
      role: "assistant",
      scope: "turn",
      requestId: turnId,
      text: " answer**",
    },
    {
      kind: "text",
      role: "assistant",
      scope: "native-session",
      requestId: null,
      text: "Old replay",
    },
    {
      kind: "text",
      role: "assistant",
      scope: "native-session",
      requestId: null,
      text: " and possibly new text",
    },
    {
      kind: "text",
      role: "user",
      scope: "native-session",
      requestId: null,
      text: "Native user echo",
    },
    {
      kind: "text",
      role: "assistant",
      scope: "turn",
      requestId: "foreign",
      text: "Must not become reply",
    },
  ]);
  const reports = geminiChatPresentation(value, turnId);
  expect(reports.filter((item) => item.kind === "reply")).toEqual([
    { kind: "reply", sequence: 1, text: "**First answer**", open: false },
  ]);
  expect(reports.filter((item) => item.kind === "native-text")).toMatchObject([
    {
      sequence: 3,
      role: "assistant",
      text: "Old replay",
    },
    {
      sequence: 4,
      role: "assistant",
      text: " and possibly new text",
    },
    { sequence: 5, role: "user", text: "Native user echo" },
  ]);
  expect(JSON.stringify(reports)).not.toContain("Must not become reply");
  expect(geminiChatPresentation(value, "other")).toEqual([]);
  const rendered = GeminiChatActivity({ page: value, turnId });
  expect(
    findAll(rendered, "SessionReply").map((item) => attrs(item).text),
  ).toEqual(["**First answer**"]);
  expect(textOf(rendered)).toContain("their native turn is not reported");
  expect(textOf(rendered)).toContain("Native user echo");
});
test("tool/report boundaries close reply aggregation and per-turn result usage stays separate from native context occupancy", () => {
  const value = page([
    {
      kind: "text",
      role: "assistant",
      scope: "turn",
      requestId: turnId,
      text: "Before",
    },
    {
      kind: "tool",
      toolCallId: "tool",
      status: "completed",
      scope: "native-session",
      requestId: null,
      detail: { json: '{"output":"PRIVATE"}', truncated: false },
    },
    {
      kind: "text",
      role: "assistant",
      scope: "turn",
      requestId: turnId,
      text: "After",
    },
    { kind: "context", usedTokens: 0, contextTokens: 100 },
    {
      kind: "result",
      requestId: turnId,
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 2, totalTokens: 2 },
    },
  ]);
  const reports = geminiChatPresentation(value, turnId);
  expect(
    reports.filter((item) => item.kind === "reply").map((item) => item.text),
  ).toEqual(["Before", "After"]);
  expect(
    reports
      .filter((item) => item.kind === "report")
      .map((item) => item.event.kind),
  ).toEqual(["tool", "context", "result"]);
  expect(geminiChatPresentation(null, turnId)).toEqual([]);
  const text = textOf(GeminiChatActivity({ page: value, turnId }));
  expect(text).toContain("0 used tokens");
  expect(text).toContain("Input tokens0");
  expect(text).toContain(
    "separate from native context occupancy and account allowance",
  );
});

test("a foreign explicit prompt result cannot borrow the current capture turn's usage presentation", () => {
  const reports = geminiChatPresentation(
    page([
      {
        kind: "result",
        requestId: "foreign",
        stopReason: "end_turn",
        usage: { inputTokens: 99, outputTokens: 99, totalTokens: 198 },
      },
    ]),
    turnId,
  );
  expect(reports).toEqual([]);
});
