import { expect, test } from "bun:test";
import { nativeChatMcpToolCalls } from "../../apps/desktop/src/native-chat-mcp-tool-calls";
import { SessionActivity } from "../../apps/desktop/src/SessionActivity";
import { ownedSessionTurn } from "../../apps/desktop/src/session-activity";
import type {
  CodexChatEvent,
  CodexChatMcpToolCall,
} from "../../types/codex-chat";
import type {
  ConversationEvent,
  ConversationPage,
} from "../../types/conversation";
import { attrs, findAll, textOf } from "../dashboard/ds/vnode";

const threadId = "0199a213-81c0-7800-8aa1-bbab2a035a53",
  nativeTurn = "0199a213-81c0-7800-8aa1-bbab2a035a54",
  appTurn = "accepted-mcp-turn",
  version = "0.163.0-alpha.10.2";
const report: CodexChatMcpToolCall = {
  kind: "mcp-tool-call",
  source: "item/started",
  threadId,
  turnId: nativeTurn,
  itemId: "native-mcp-call",
  server: { text: "local-server", truncated: false },
  tool: { text: "search_files", truncated: false },
  status: "inProgress",
  arguments: {
    json: '{"query":"<script>literal text</script>"}',
    truncated: false,
  },
  result: null,
  error: null,
  durationMs: null,
  partial: true,
  closure: "open",
  turnStatus: null,
};
const event = (value: CodexChatEvent): ConversationEvent => ({
  kind: "coding-chat",
  provider: "codex",
  version,
  event: value,
});
function page(events: ConversationEvent[]): ConversationPage {
  return {
    version: 1,
    projectId: "fixture",
    conversationId: "session-fixture",
    revision: events.length,
    binding: { provider: "codex", sessionId: threadId, version },
    turns: [],
    frames: events.map((value, index) => ({
      seq: index + 1,
      turnId: appTurn,
      at: "2026-10-23T00:00:00Z",
      event: value,
    })),
    more: false,
    nextCursor: events.length,
    lastSequence: events.length,
    request: null,
    controllable: false,
  };
}

test("native MCP projection selects the latest full snapshot in one collapsed inert disclosure", () => {
  const completed: CodexChatMcpToolCall = {
      ...report,
      source: "item/completed",
      status: "completed",
      result: {
        content: {
          json: '[{"type":"text","text":"<img>literal output</img>"}]',
          truncated: false,
        },
        structuredContent: { json: '{"matches":2}', truncated: false },
      },
      error: null,
      durationMs: 27,
      partial: false,
      closure: "item-ended",
    },
    final: CodexChatMcpToolCall = {
      ...completed,
      source: "turn/completed",
      closure: "turn-ended",
      turnStatus: "completed",
    },
    current = page([
      event({ kind: "turn", threadId, turnId: nativeTurn }),
      event(report),
      event(completed),
      event(final),
    ]),
    before = structuredClone(current),
    value = ownedSessionTurn(current, appTurn),
    view = SessionActivity({ value });
  expect(value.nativeMcpToolCalls).toEqual([{ version, report: final }]);
  expect(nativeChatMcpToolCalls(current, appTurn)).toEqual(
    value.nativeMcpToolCalls,
  );
  expect(textOf(view)).toContain("MCP tool call · local-server · search_files");
  expect(textOf(view)).toContain("Latest full snapshot in this view");
  expect(textOf(view)).toContain('{"query":"<script>literal text</script>"}');
  expect(textOf(view)).toContain("<img>literal output</img>");
  expect(textOf(view)).toContain('{"matches":2}');
  expect(textOf(view)).toContain("Native turn reported completed");
  expect(textOf(view)).toContain("No error reported");
  expect(textOf(view)).not.toContain("inProgress");
  const disclosures = findAll(view, "details");
  expect(disclosures).toHaveLength(1);
  expect(attrs(disclosures[0]).open).toBeUndefined();
  expect(findAll(view, "pre")).toHaveLength(3);
  for (const region of findAll(view, "pre"))
    expect(attrs(region)).toMatchObject({ role: "region", tabIndex: 0 });
  for (const tag of ["button", "a", "script", "iframe", "img", "form"])
    expect(findAll(view, tag)).toHaveLength(0);
  expect(current).toEqual(before);
});

test("native MCP projection keeps null, explicit empty, truncation and omitted JSON facts distinct", () => {
  const explicitEmpty: CodexChatMcpToolCall = {
      ...report,
      source: "item/completed",
      status: "failed",
      arguments: { json: "null", truncated: false },
      result: {
        content: { json: "[]", truncated: false },
        structuredContent: null,
      },
      error: { text: "", truncated: false },
      durationMs: 0,
      partial: false,
      closure: "item-ended",
    },
    view = SessionActivity({
      value: ownedSessionTurn(page([event(explicitEmpty)]), appTurn),
    });
  expect(textOf(view)).toContain("[]");
  expect(textOf(view)).toContain("null");
  expect(textOf(view)).toContain("Structured content not reported");
  expect(textOf(view)).toContain("Reported error text was empty");
  expect(textOf(view)).toContain("0 ms");
  expect(textOf(view)).toContain("Reported failed");

  const clipped: CodexChatMcpToolCall = {
      ...explicitEmpty,
      arguments: { json: "{", truncated: true, omitted: "size" },
      result: {
        content: { json: "", truncated: true },
        structuredContent: { json: "", truncated: true, omitted: "nodes" },
      },
      error: { text: "partial", truncated: true },
    },
    clippedView = SessionActivity({
      value: ownedSessionTurn(page([event(clipped)]), appTurn),
    });
  expect(textOf(clippedView)).toContain("Arguments truncated (size limit)");
  expect(textOf(clippedView)).toContain("Result content truncated");
  expect(textOf(clippedView)).toContain(
    "Structured content truncated (nodes limit)",
  );
  expect(textOf(clippedView)).toContain("Reported error text truncated");
  expect(textOf(clippedView)).not.toContain("[]");

  const zeroRetainedError = SessionActivity({
    value: ownedSessionTurn(
      page([
        event({
          ...explicitEmpty,
          error: { text: "", truncated: true },
        }),
      ]),
      appTurn,
    ),
  });
  expect(textOf(zeroRetainedError)).toContain(
    "Error text truncated before any content was retained",
  );
  expect(textOf(zeroRetainedError)).not.toContain(
    "Reported error text was empty",
  );
});

test("native MCP projection cannot borrow another application turn, binding, version or native turn", () => {
  const current = page([
    event({ kind: "turn", threadId, turnId: nativeTurn }),
    event(report),
  ]);
  expect(nativeChatMcpToolCalls(null, appTurn)).toEqual([]);
  expect(nativeChatMcpToolCalls(current, "other-app-turn")).toEqual([]);
  for (const binding of [
    null,
    { provider: "claude" as const, sessionId: threadId, version },
    { provider: "codex" as const, sessionId: nativeTurn, version },
    { provider: "codex" as const, sessionId: threadId, version: "other" },
  ])
    expect(nativeChatMcpToolCalls({ ...current, binding }, appTurn)).toEqual(
      [],
    );
  expect(
    nativeChatMcpToolCalls(
      page([
        event({ kind: "turn", threadId, turnId: nativeTurn }),
        event({ ...report, turnId: threadId }),
      ]),
      appTurn,
    ),
  ).toEqual([]);
  expect(
    nativeChatMcpToolCalls(
      page([
        event(report),
        event({ ...report, itemId: "other-item", turnId: threadId }),
      ]),
      appTurn,
    ),
  ).toEqual([]);
  expect(
    ownedSessionTurn(current, "other-app-turn").nativeMcpToolCalls,
  ).toEqual([]);
});

test("native MCP projection keeps final supplied snapshots but excludes reports after terminal outcomes", () => {
  const completed: CodexChatMcpToolCall = {
      ...report,
      source: "item/completed",
      status: "failed",
      error: { text: "provider error", truncated: false },
      partial: false,
      closure: "item-ended",
    },
    final: CodexChatMcpToolCall = {
      ...completed,
      source: "turn/completed",
      closure: "turn-ended",
      turnStatus: "interrupted",
      partial: true,
    },
    late = { ...report, itemId: "late-call" } as CodexChatMcpToolCall,
    outcome: CodexChatEvent = {
      kind: "outcome",
      outcome: {
        phase: "failed",
        reason: "fixture failure",
        threadId,
        turnId: nativeTurn,
        observedModel: null,
        usage: null,
        exitCode: 1,
        stopped: false,
        timedOut: false,
      },
    };
  expect(
    nativeChatMcpToolCalls(
      page([event(report), event(completed), event(final), event(late)]),
      appTurn,
    ),
  ).toEqual([{ version, report: final }]);
  expect(
    ownedSessionTurn(
      page([event(report), event(completed), event(outcome), event(late)]),
      appTurn,
    ).nativeMcpToolCalls,
  ).toEqual([{ version, report: completed }]);
});
