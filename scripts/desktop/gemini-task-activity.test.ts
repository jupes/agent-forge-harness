import { expect, test } from "bun:test";
import { GeminiTaskActivity } from "../../apps/desktop/src/GeminiTaskActivity";
import { ownedSessionLifecycle } from "../../apps/desktop/src/session-activity";
import type { ConversationPage } from "../../types/conversation";
import type { GeminiTaskRuntimeEvent } from "../../types/gemini-task-runtime";
import { attrs, findAll, textOf } from "../dashboard/ds/vnode";

const turnId = "a5832fa0-7a21-403b-8184-44892f0d8d86";
function page(events: GeminiTaskRuntimeEvent[]): ConversationPage {
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
        kind: "coding-gemini-task",
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
test("Gemini private reports keep configured labels, native text delta, denial data and per-model units without granting actions", () => {
  const value = page([
    {
      kind: "identity",
      provider: "gemini",
      route: "gemini-cli",
      version: "0.65.0",
      sessionId: turnId,
      configuredModel: "auto-configured",
    },
    { kind: "text", text: "<img src=x onerror=alert(1)>", delta: true },
    { kind: "text", text: "Exact full native text", delta: false },
    {
      kind: "tool",
      id: "denied",
      name: "run_shell_command",
      state: "failed",
      input: { json: '{"command":"DO_NOT_EXECUTE"}', truncated: false },
      error: {
        type: "policy_violation",
        message: { text: "Provider refusal", truncated: true },
      },
    },
    {
      kind: "usage",
      usage: {
        totalTokens: 26,
        inputTokens: 23,
        outputTokens: 3,
        cachedInputTokens: 7,
        uncachedInputTokens: 16,
        durationMs: 1200,
        toolCalls: 1,
        models: {
          "actually-reported-model": {
            totalTokens: 26,
            inputTokens: 23,
            outputTokens: 3,
            cachedInputTokens: 7,
            uncachedInputTokens: 16,
          },
        },
      },
    },
  ]);
  const view = GeminiTaskActivity({ page: value, turnId }),
    text = textOf(view);
  expect(attrs(view)["aria-label"]).toBe("Gemini Task reports");
  for (const fact of [
    "Configured model: auto-configured",
    "Native text delta",
    "Native text",
    "Exact full native text",
    "run_shell_command · failed",
    "policy_violation: Provider refusal (truncated)",
    "23 input · 3 output · 7 cached input · 16 uncached input · 26 total tokens",
    "actually-reported-model",
    "Account allowance and context occupancy are unavailable",
  ])
    expect(text).toContain(fact);
  expect(findAll(view, "img")).toHaveLength(0);
  expect(findAll(view, "button")).toHaveLength(0);
  expect(findAll(view, "a")).toHaveLength(0);
  expect(text).toContain("<img src=x onerror=alert(1)>");
  expect(
    GeminiTaskActivity({ page: value, turnId: "foreign-turn" }),
  ).toBeNull();
});

test("absent native usage is kept unavailable and a native deadline is presented as timed out", () => {
  const value = page([
    {
      kind: "outcome",
      outcome: {
        phase: "failed",
        reason: "Task deadline",
        sessionId: turnId,
        configuredModel: "auto-configured",
        usage: null,
      },
      exitCode: null,
      stopped: true,
      timedOut: true,
      stderr: { text: "Bounded diagnostic", truncated: false },
    },
  ]);
  value.turns = [
    {
      requestId: turnId,
      hash: "a".repeat(64),
      phase: "failed",
      createdAt: "2026-10-23T00:00:00Z",
      updatedAt: "2026-10-23T00:01:00Z",
      reason: "Task deadline",
      owner: null,
    },
  ];
  const text = textOf(GeminiTaskActivity({ page: value, turnId }));
  expect(text).toContain("Exit: unavailable");
  expect(text).toContain("Timed out");
  expect(text).toContain("Bounded diagnostic");
  expect(text).not.toContain("0 input");
  expect(text).not.toContain("Reported Task usage");
  expect(
    ownedSessionLifecycle(value, {
      mode: "task",
      loaded: true,
      live: false,
      stopping: false,
      feedInterrupted: false,
      readError: "",
    }).state,
  ).toBe("timed-out");
});
