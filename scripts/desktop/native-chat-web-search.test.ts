import { expect, test } from "bun:test";
import { nativeChatFileChanges } from "../../apps/desktop/src/native-chat-file-changes";
import { nativeChatMcpToolCalls } from "../../apps/desktop/src/native-chat-mcp-tool-calls";
import { nativeChatReasoningSummaries } from "../../apps/desktop/src/native-chat-reasoning";
import { nativeChatTurnPlan } from "../../apps/desktop/src/native-chat-turn-plan";
import { nativeChatWebSearches } from "../../apps/desktop/src/native-chat-web-search";
import { ownedSessionTurn } from "../../apps/desktop/src/session-activity";
import type {
  CodexChatEvent,
  CodexChatWebSearch,
} from "../../types/codex-chat";
import type {
  ConversationEvent,
  ConversationPage,
} from "../../types/conversation";

const threadId = "0199a213-81c0-7800-8aa1-bbab2a035a53",
  nativeTurn = "0199a213-81c0-7800-8aa1-bbab2a035a54",
  appTurn = "accepted-search-turn",
  version = "0.163.0-alpha.10.2";
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

const started: CodexChatWebSearch = {
  kind: "web-search",
  source: "item/started",
  threadId,
  turnId: nativeTurn,
  itemId: "native-search-item",
  query: { text: "weather <literal>", truncated: false },
  action: null,
  results: null,
  partial: true,
  closure: "open",
  turnStatus: null,
};

test("native web-search projection retains exact supplied snapshots and closure", () => {
  const completed: CodexChatWebSearch = {
      ...started,
      source: "item/completed",
      query: { text: "weather <literal>", truncated: false },
      action: {
        json: '{"type":"search","query":"weather"}',
        truncated: false,
      },
      results: {
        json: '[{"title":"<literal>","url":"https://example.invalid"}]',
        truncated: false,
      },
      partial: false,
      closure: "item-ended",
    },
    final: CodexChatWebSearch = {
      ...completed,
      source: "turn/completed",
      closure: "turn-ended",
      turnStatus: "completed",
    },
    current = page([
      event({ kind: "turn", threadId, turnId: nativeTurn }),
      event(started),
      event(completed),
      event(final),
    ]),
    before = structuredClone(current);

  expect(nativeChatWebSearches(current, appTurn)).toEqual([
    { version, report: final },
  ]);
  expect(nativeChatWebSearches(current, "another-turn")).toEqual([]);
  expect(current).toEqual(before);
});

test("native web-search projection supports partial pages but fences foreign and terminal data", () => {
  const partial = page([event(started)]),
    foreign = page([
      event({ kind: "turn", threadId, turnId: nativeTurn }),
      event({ ...started, threadId: "foreign-thread" }),
    ]),
    terminal = page([
      event({ kind: "turn", threadId, turnId: nativeTurn }),
      event({
        kind: "outcome",
        outcome: {
          phase: "completed",
          reason: null,
          threadId,
          turnId: nativeTurn,
          observedModel: null,
          usage: null,
          exitCode: null,
          stopped: false,
          timedOut: false,
        },
      }),
      event(started),
    ]);

  expect(nativeChatWebSearches(partial, appTurn)).toEqual([
    { version, report: started },
  ]);
  expect(nativeChatWebSearches(foreign, appTurn)).toEqual([]);
  expect(nativeChatWebSearches(terminal, appTurn)).toEqual([]);
  expect(
    nativeChatWebSearches(
      {
        ...partial,
        binding: {
          provider: "claude",
          sessionId: "claude",
          version,
        },
      },
      appTurn,
    ),
  ).toEqual([]);
});

test("native turn report closures fence stale sibling projections and retain matching final snapshots", () => {
  const turn = event({ kind: "turn", threadId, turnId: nativeTurn }),
    searchFinal: CodexChatWebSearch = {
      ...started,
      source: "turn/completed",
      action: { json: '{"type":"other"}', truncated: false },
      results: { json: "[]", truncated: false },
      partial: false,
      closure: "turn-ended",
      turnStatus: "completed",
    },
    searchStarted = event(started),
    mcpFinal: CodexChatEvent = {
      kind: "mcp-tool-call",
      source: "turn/completed",
      threadId,
      turnId: nativeTurn,
      itemId: "native-mcp",
      server: { text: "server", truncated: false },
      tool: { text: "tool", truncated: false },
      status: "completed",
      arguments: { json: "null", truncated: false },
      result: null,
      error: null,
      durationMs: null,
      partial: false,
      closure: "turn-ended",
      turnStatus: "completed",
    },
    fileStarted: CodexChatEvent = {
      kind: "file-change",
      source: "item/started",
      threadId,
      turnId: nativeTurn,
      itemId: "native-file",
      status: "inProgress",
      changes: [],
      truncated: false,
      partial: true,
      closure: "open",
      turnStatus: null,
    },
    fileFinal: CodexChatEvent = {
      kind: "file-change",
      source: "turn/completed",
      threadId,
      turnId: nativeTurn,
      itemId: "native-file",
      status: "completed",
      changes: [],
      truncated: false,
      partial: false,
      closure: "turn-ended",
      turnStatus: "completed",
    },
    reasoningFinal: CodexChatEvent = {
      kind: "reasoning-summary",
      source: "turn/completed",
      threadId,
      turnId: nativeTurn,
      itemId: "native-reasoning",
      partial: false,
      update: {
        kind: "snapshot",
        summary: [],
        truncated: false,
        closure: "turn-ended",
        turnStatus: "completed",
      },
    },
    commandStarted: CodexChatEvent = {
      kind: "command",
      source: "item/started",
      threadId,
      turnId: nativeTurn,
      itemId: "native-command",
      command: { text: "command", truncated: false },
      cwd: "/fixture",
      status: "inProgress",
      output: null,
      outputSource: null,
      exitCode: null,
      durationMs: null,
      partial: true,
    },
    commandFinal: CodexChatEvent = {
      kind: "command",
      source: "turn/completed",
      threadId,
      turnId: nativeTurn,
      itemId: "native-command",
      command: { text: "command", truncated: false },
      cwd: "/fixture",
      status: "completed",
      output: null,
      outputSource: null,
      exitCode: 0,
      durationMs: 1,
      partial: false,
    },
    plan: CodexChatEvent = {
      kind: "turn-plan",
      source: "turn/plan/updated",
      threadId,
      turnId: nativeTurn,
      explanation: null,
      plan: [],
      truncated: false,
    };

  expect(
    nativeChatMcpToolCalls(
      page([turn, event(searchFinal), event(mcpFinal)]),
      appTurn,
    ),
  ).toEqual([{ version, report: mcpFinal }]);
  expect(
    nativeChatMcpToolCalls(
      page([
        turn,
        event(searchFinal),
        event({
          ...mcpFinal,
          source: "item/started",
          closure: "open",
          partial: true,
          turnStatus: null,
        }),
      ]),
      appTurn,
    ),
  ).toEqual([]);
  expect(
    nativeChatFileChanges(
      page([turn, event(searchFinal), event(fileStarted)]),
      appTurn,
    ),
  ).toEqual([]);
  expect(
    nativeChatFileChanges(
      page([turn, event(searchFinal), event(fileFinal)]),
      appTurn,
    ),
  ).toEqual([{ version, report: fileFinal }]);
  expect(
    nativeChatReasoningSummaries(
      page([
        turn,
        event(searchFinal),
        event(reasoningFinal),
        event({
          kind: "reasoning-summary",
          source: "item/started",
          threadId,
          turnId: nativeTurn,
          itemId: "late-reasoning",
          partial: true,
          update: { kind: "part-added", summaryIndex: 0 },
        }),
      ]),
      appTurn,
    ),
  ).toMatchObject([
    {
      report: reasoningFinal,
      parts: [],
      turnSnapshot: {
        kind: "snapshot",
        summary: [],
        truncated: false,
        closure: "turn-ended",
        turnStatus: "completed",
      },
    },
  ]);
  expect(
    nativeChatTurnPlan(page([turn, event(searchFinal), event(plan)]), appTurn),
  ).toBeNull();
  expect(
    ownedSessionTurn(
      page([turn, event(searchFinal), event(commandStarted)]),
      appTurn,
    ).nativeCommands,
  ).toEqual([]);
  expect(
    ownedSessionTurn(
      page([turn, event(searchFinal), event(commandFinal)]),
      appTurn,
    ).nativeCommands,
  ).toEqual([
    {
      version,
      report: commandFinal,
      initialAggregate: null,
      finalAggregate: null,
      streamedOutput: null,
      streamPrefixMissing: false,
    },
  ]);

  for (const siblingFinal of [mcpFinal, reasoningFinal])
    expect(
      nativeChatWebSearches(
        page([turn, event(siblingFinal), searchStarted]),
        appTurn,
      ),
    ).toEqual([]);
  expect(
    nativeChatWebSearches(
      page([turn, event(mcpFinal), event(searchFinal)]),
      appTurn,
    ),
  ).toEqual([{ version, report: searchFinal }]);
});
