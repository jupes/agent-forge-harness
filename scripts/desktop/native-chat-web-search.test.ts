import { expect, test } from "bun:test";
import { nativeChatWebSearches } from "../../apps/desktop/src/native-chat-web-search";
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
