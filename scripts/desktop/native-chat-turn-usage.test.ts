import { expect, test } from "bun:test";
import { CodexChatUsage } from "../../apps/desktop/src/CodexChatUsage";
import { ownedCodexChatUsage } from "../../apps/desktop/src/session-activity";
import type { CodexChatUsage as NativeUsage } from "../../types/codex-chat";
import type {
  ConversationEvent,
  ConversationPage,
} from "../../types/conversation";
import { findAll, textOf } from "../dashboard/ds/vnode";

const first = "735267e5-6c43-4ba0-aa22-882c2aff1f58",
  second = "3a8f90ab-8fd9-414a-a2fa-7965fc229d56",
  version = "0.163.0-alpha.10.2";
function page(
  frames: { turnId: string; event: ConversationEvent }[],
): ConversationPage {
  return {
    version: 1,
    projectId: "fixture",
    conversationId: "session-fixture",
    revision: frames.length,
    binding: {
      provider: "codex",
      sessionId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
      version,
    },
    turns: [first, second].map((requestId) => ({
      requestId,
      hash: "a".repeat(64),
      phase: "completed",
      createdAt: "2026-10-23T00:00:00Z",
      updatedAt: "2026-10-23T00:00:00Z",
      owner: null,
      reason: null,
    })),
    frames: frames.map((frame, index) => ({
      ...frame,
      seq: index + 1,
      at: "2026-10-23T00:00:00Z",
    })),
    more: false,
    nextCursor: frames.length,
    lastSequence: frames.length,
    request: null,
    controllable: false,
  };
}
function usage(turnId: string, value: NativeUsage) {
  return {
    turnId,
    event: {
      kind: "coding-chat",
      provider: "codex",
      version,
      event: { kind: "usage", usage: value },
    },
  } as const;
}

test("historical native Chat keeps the latest saved response and thread scopes for its own accepted turn", () => {
  const earlier = {
      lastResponse: { inputTokens: 7 },
      threadTotal: { inputTokens: 80 },
    },
    exact = {
      lastResponse: { inputTokens: 0 },
      threadTotal: { inputTokens: 100 },
    },
    later = {
      lastResponse: { inputTokens: 13, outputTokens: 2 },
      threadTotal: { inputTokens: 200 },
    },
    saved = page([
      usage(first, earlier),
      usage(first, exact),
      usage(second, later),
    ]);
  expect(ownedCodexChatUsage(saved, first)).toEqual(exact);
  expect(ownedCodexChatUsage(saved, second)).toEqual(later);
  const rendered = CodexChatUsage({ usage: ownedCodexChatUsage(saved, first) });
  expect(findAll(rendered, "td").slice(0, 4).map(textOf)).toEqual([
    "0",
    "100",
    "Not reported",
    "Not reported",
  ]);
  expect(textOf(rendered)).toContain("Latest native response");
  expect(textOf(rendered)).toContain("Native thread total");
});

test("a same-turn terminal report supplies saved usage only when no native usage report is available", () => {
  const terminalUsage = {
      lastResponse: { outputTokens: 0 },
      threadTotal: { outputTokens: 9 },
    },
    saved = page([
      {
        turnId: first,
        event: {
          kind: "coding-chat",
          provider: "codex",
          version,
          event: {
            kind: "outcome",
            outcome: {
              phase: "completed",
              reason: null,
              threadId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
              turnId: "0199a214-81c0-7800-8aa1-bbab2a035a53",
              observedModel: null,
              usage: terminalUsage,
              exitCode: 0,
              stopped: false,
              timedOut: false,
            },
          },
        },
      },
    ]);
  expect(ownedCodexChatUsage(saved, first)).toEqual(terminalUsage);
  expect(ownedCodexChatUsage(saved, second)).toBeNull();
  const response = { lastResponse: { inputTokens: 3 }, threadTotal: {} };
  const withReport = page([usage(first, response), ...saved.frames]);
  expect(ownedCodexChatUsage(withReport, first)).toEqual(response);
});

test("native usage presentation retains the requested model without promoting it to execution telemetry", () => {
  const rendered = CodexChatUsage({
    usage: null,
    requestedModel: "requested-exact",
  });
  expect(textOf(rendered)).toContain("Requested modelrequested-exact");
  expect(textOf(rendered)).toContain("Observed modelNot reported");
  expect(textOf(rendered)).toContain(
    "Native response and thread usage have not been reported",
  );
});

test("missing, foreign, obsolete-version and unaccepted-turn reports cannot supply native Chat counters", () => {
  const exact = { lastResponse: { inputTokens: 5 }, threadTotal: {} },
    saved = page([usage(first, exact)]);
  expect(ownedCodexChatUsage(null, first)).toBeNull();
  expect(ownedCodexChatUsage(saved, "not-an-accepted-turn")).toBeNull();
  expect(ownedCodexChatUsage({ ...saved, binding: null }, first)).toBeNull();
  expect(
    ownedCodexChatUsage(
      {
        ...saved,
        binding: { provider: "claude", sessionId: "other", version },
      },
      first,
    ),
  ).toBeNull();
  const stale = usage(first, exact);
  expect(
    ownedCodexChatUsage(
      page([
        {
          ...stale,
          event: { ...stale.event, version: "obsolete" },
        },
      ]),
      first,
    ),
  ).toBeNull();
  expect(
    ownedCodexChatUsage(
      page([
        {
          turnId: first,
          event: {
            kind: "coding-usage",
            provider: "codex",
            version,
            source: "exec.turn.completed",
            usage: { inputTokens: 90 },
          },
        },
      ]),
      first,
    ),
  ).toBeNull();
});
