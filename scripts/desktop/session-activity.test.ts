import { expect, test } from "bun:test";
import type { CodexChatDecisionView } from "../../apps/desktop/src/codex-chat-decisions";
import {
  SessionActivity,
  SessionOutcome,
  SessionTurnUsage,
} from "../../apps/desktop/src/SessionActivity";
import {
  ownedSessionLifecycle,
  ownedSessionTurn,
  sessionStateSupport,
  unsupportedSessionStates,
} from "../../apps/desktop/src/session-activity";
import type {
  ConversationEvent,
  ConversationPage,
} from "../../types/conversation";
import { attrs, findAll, textOf } from "../dashboard/ds/vnode";

const turnId = "original-turn";
function page(events: ConversationEvent[]): ConversationPage {
  return {
    version: 1,
    projectId: "fixture",
    conversationId: "session-fixture",
    revision: events.length,
    binding: { provider: "claude", sessionId: "native", version: "fixture" },
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
    controllable: true,
  };
}

test("owned activity replaces cumulative reasoning and joins a tool result with its original input without mixing another turn", () => {
  const common = {
    kind: "coding-activity",
    provider: "claude",
    version: "fixture",
  } as const;
  const original = page([
    {
      ...common,
      id: "thinking:0",
      source: "claude.stream_event",
      partial: true,
      activity: {
        kind: "reasoning",
        content: { text: "First", truncated: false },
        redacted: false,
      },
    },
    {
      ...common,
      id: "tool-one",
      source: "claude.assistant",
      partial: false,
      activity: {
        kind: "tool",
        toolId: "tool-one",
        name: "Read",
        state: "running",
        input: { json: '{"path":"private.ts"}', truncated: false },
      },
    },
    {
      ...common,
      id: "thinking:0",
      source: "claude.assistant",
      partial: false,
      activity: {
        kind: "reasoning",
        content: { text: "First, then inspect", truncated: false },
        redacted: false,
      },
    },
    {
      ...common,
      id: "tool-one",
      source: "claude.user",
      partial: false,
      activity: {
        kind: "tool",
        toolId: "tool-one",
        name: "Read",
        state: "completed",
        output: { json: '"<script>inert</script>"', truncated: false },
      },
    },
  ]);
  original.frames.push({
    ...original.frames[3]!,
    seq: 5,
    turnId: "another-turn",
    event: { kind: "text", text: "Other private answer" },
  });
  const result = ownedSessionTurn(original, turnId);
  expect(result.activities).toHaveLength(2);
  expect(result.activities[0]?.activity).toMatchObject({
    kind: "reasoning",
    content: { text: "First, then inspect" },
  });
  expect(result.activities[1]?.activity).toEqual({
    kind: "tool",
    toolId: "tool-one",
    name: "Read",
    state: "completed",
    input: { json: '{"path":"private.ts"}', truncated: false },
    output: { json: '"<script>inert</script>"', truncated: false },
  });
  expect(JSON.stringify(result)).not.toContain("Other private answer");
});

test("lifecycle uses actual outcomes and native resume support while partial failures never become confirmed Stop", () => {
  const current = page([]);
  current.turns = [
    {
      requestId: turnId,
      hash: "fixture",
      phase: "completed",
      createdAt: "2026-10-23T00:00:00Z",
      updatedAt: "2026-10-23T00:00:00Z",
      reason: null,
      owner: "fixture",
    },
  ];
  const options = {
    mode: "chat",
    loaded: true,
    live: true,
    stopping: false,
    feedInterrupted: false,
    readError: "",
  } as const;
  expect(ownedSessionLifecycle(null, { ...options, loaded: false }).state).toBe(
    "loading",
  );
  expect(
    ownedSessionLifecycle(null, { ...options, readError: "Saved read failed" }),
  ).toMatchObject({ state: "error", label: "Saved conversation unavailable" });
  expect(ownedSessionLifecycle(current, options).state).toBe("idle");
  expect(
    ownedSessionLifecycle(current, { ...options, mode: "task" }).state,
  ).toBe("ended");
  current.binding = null;
  expect(ownedSessionLifecycle(current, options)).toMatchObject({
    state: "ended",
    detail: expect.stringContaining("No confirmed provider conversation"),
  });
  current.turns[0]!.phase = "unknown";
  current.frames.push({
    seq: 1,
    turnId,
    at: "2026-10-23T00:00:00Z",
    event: {
      kind: "coding-outcome",
      provider: "claude",
      version: "fixture",
      code: "protocol-error",
      exitCode: 0,
      timedOut: false,
      stopped: true,
      message: {
        text: "free words: rate limit or authentication",
        truncated: false,
      },
      stderrTail: { text: "", truncated: false },
    },
  });
  expect(ownedSessionLifecycle(current, options)).toMatchObject({
    state: "unknown",
  });
  const outcome = current.frames[0]?.event;
  if (outcome?.kind !== "coding-outcome")
    throw Error("Missing fixture outcome");
  outcome.code = "timed-out";
  outcome.timedOut = true;
  expect(ownedSessionLifecycle(current, options).state).toBe("timed-out");
  outcome.code = "stopped";
  outcome.timedOut = false;
  current.turns[0]!.phase = "cancelled";
  expect(ownedSessionLifecycle(current, options).state).toBe("stopped");
});

test("interrupted live observation is stale, saved ownership is explicit, and unsupported states never come from tool words", () => {
  const current = page([
    { kind: "text", text: "Waiting for input; needs permission" },
  ]);
  current.turns = [
    {
      requestId: turnId,
      hash: "fixture",
      phase: "running",
      createdAt: "2026-10-23T00:00:00Z",
      updatedAt: "2026-10-23T00:00:00Z",
      reason: null,
      owner: "fixture",
    },
  ];
  const options = {
    mode: "task",
    loaded: true,
    live: true,
    stopping: false,
    feedInterrupted: false,
    readError: "",
  } as const;
  expect(ownedSessionLifecycle(current, options).state).toBe("running");
  expect(
    ownedSessionLifecycle(current, {
      ...options,
      live: false,
      feedInterrupted: true,
    }),
  ).toMatchObject({
    state: "stale",
    detail: expect.stringContaining("process failure is not confirmed"),
  });
  current.controllable = false;
  expect(ownedSessionLifecycle(current, options)).toMatchObject({
    state: "running",
    label: "Saved status: Running",
    detail: expect.stringContaining("process ownership"),
  });
  expect(unsupportedSessionStates.map((item) => item.label)).toEqual([
    "Needs permission",
    "Waiting for input",
    "Observed",
  ]);
  expect(
    ownedSessionLifecycle(current, { ...options, stopping: true }).label,
  ).toBe("Stopping… waiting for confirmation");
});

test("Needs permission requires a current protected offer for this exact live owned Chat turn; held decision metadata alone cannot establish it", () => {
  const current = page([]);
  current.binding = {
    provider: "codex",
    sessionId: "native",
    version: "fixture",
  };
  current.turns = [
    {
      requestId: turnId,
      hash: "fixture",
      phase: "running",
      createdAt: "2026-10-23T00:00:00Z",
      updatedAt: "2026-10-23T00:00:00Z",
      reason: null,
      owner: "fixture",
    },
  ];
  const approvals: CodexChatDecisionView = {
    projectId: current.projectId,
    sessionId: current.conversationId,
    turnRequestId: turnId,
    actionable: true,
    pending: [
      {
        turnRequestId: turnId,
        actionable: true,
        detailsUnavailableReason: null,
        approval: {
          id: "offer",
          kind: "command",
          command: "inert",
          cwd: "/repo",
          reason: null,
          availableDecisions: ["accept", "decline"],
        },
      },
    ],
    identity: null,
    identityError: "",
    error: "",
    notice: "",
    loading: false,
    checking: false,
    posting: false,
    receipt: null,
  };
  const options = {
    mode: "chat",
    loaded: true,
    live: true,
    stopping: false,
    feedInterrupted: false,
    readError: "",
    approvals,
  } as const;
  expect(ownedSessionLifecycle(current, options)).toMatchObject({
    state: "needs-permission",
    label: "Needs permission",
    detail: expect.stringContaining("inline"),
  });
  for (const change of [
    { projectId: "foreign" },
    { sessionId: "foreign" },
    { turnRequestId: "old-turn" },
    { actionable: false },
    { error: "unverified" },
    { pending: [] },
    {
      pending: approvals.pending.map((item) => ({
        ...item,
        turnRequestId: "old-turn",
      })),
    },
  ])
    expect(
      ownedSessionLifecycle(current, {
        ...options,
        approvals: { ...approvals, ...change },
      }).state,
    ).toBe("running");
  expect(
    ownedSessionLifecycle(current, { ...options, stopping: true }).label,
  ).toContain("Stopping");
  expect(
    ownedSessionLifecycle(current, {
      ...options,
      live: false,
      feedInterrupted: true,
    }).state,
  ).toBe("stale");
  expect(
    ownedSessionLifecycle(current, { ...options, readError: "unavailable" })
      .state,
  ).not.toBe("needs-permission");
  expect(
    ownedSessionLifecycle({ ...current, controllable: false }, options).state,
  ).toBe("running");
  expect(
    ownedSessionLifecycle(current, { ...options, mode: "task" }).state,
  ).toBe("running");
  for (const phase of [
    "completed",
    "failed",
    "cancelled",
    "unknown",
  ] as const) {
    const ended = {
      ...current,
      turns: current.turns.map((turn) => ({ ...turn, phase })),
    };
    expect(ownedSessionLifecycle(ended, options).state).not.toBe(
      "needs-permission",
    );
  }
  const held = {
    ...approvals,
    pending: [],
    identity: {
      projectId: current.projectId,
      sessionId: current.conversationId,
      turnRequestId: turnId,
      approvalId: "old-offer",
      requestId: "original",
      decision: "accept" as const,
    },
  };
  expect(
    ownedSessionLifecycle(current, { ...options, approvals: held }).state,
  ).toBe("running");
  expect(
    ownedSessionLifecycle(current, {
      ...options,
      approvals: { ...held, pending: approvals.pending },
    }).state,
  ).toBe("needs-permission");
  expect(
    sessionStateSupport(true).find((item) => item.label === "Needs permission")
      ?.reason,
  ).toContain("Current verified native requests");
  expect(
    sessionStateSupport(false).find((item) => item.label === "Needs permission")
      ?.reason,
  ).toContain("do not expose live permission");
  expect(
    sessionStateSupport(true, false).find(
      (item) => item.label === "Needs permission",
    )?.reason,
  ).toContain("disabled when this Chat started");
});

test("reported activity is collapsed, inert and explicit about redaction, truncation and missing file counts", () => {
  const common = {
    kind: "coding-activity",
    provider: "codex",
    version: "0.163.0",
    source: "codex.item.completed",
    partial: false,
  } as const;
  const activity = ownedSessionTurn(
    page([
      {
        ...common,
        id: "reasoning",
        activity: {
          kind: "reasoning",
          content: { text: "", truncated: false },
          redacted: true,
        },
      },
      {
        ...common,
        id: "command",
        activity: {
          kind: "command",
          command: {
            text: "echo '<script>alert(1)</script>'",
            truncated: false,
          },
          state: "completed",
          output: { text: "<img src=x onerror=alert(1)>", truncated: true },
          exitCode: 0,
        },
      },
      {
        ...common,
        id: "files",
        activity: {
          kind: "files",
          state: "completed",
          changes: [{ path: "../../private.ts", operation: "update" }],
          truncated: false,
        },
      },
      {
        ...common,
        id: "result",
        activity: {
          kind: "structured-output",
          output: {
            json: '{"html":"<script>inert</script>"}',
            truncated: false,
          },
        },
      },
    ]),
    turnId,
  );
  const view = SessionActivity({ value: activity });
  expect(findAll(view, "details").every((node) => !attrs(node).open)).toBe(
    true,
  );
  expect(findAll(view, "script")).toHaveLength(0);
  expect(findAll(view, "img")).toHaveLength(0);
  expect(findAll(view, "a")).toHaveLength(0);
  expect(textOf(view)).toContain("Reasoning was redacted by the provider");
  expect(textOf(view)).toContain("Output truncated");
  expect(textOf(view)).toContain("Line counts not reported");
  expect(textOf(view)).toContain("<img src=x onerror=alert(1)>");
  expect(textOf(view)).toContain("Structured output");
  expect(textOf(view)).toContain("codex.item.completed");
});

test("per-turn usage keeps Claude cache and cumulative cost vocabulary separate and preserves unknown versus zero", () => {
  const current = ownedSessionTurn(
    page([
      { kind: "model", model: "actually-served" },
      {
        kind: "coding-usage",
        provider: "claude",
        version: "fixture",
        source: "claude.result",
        usage: {
          inputTokens: 0,
          outputTokens: 2,
          cacheReadInputTokens: 3,
          cacheCreationInputTokens: 4,
        },
        cumulativeEstimateUsd: 0,
      },
    ]),
    turnId,
  );
  const usage = SessionTurnUsage({
    value: current,
    requestedModel: "requested",
  });
  expect(textOf(usage)).toContain("Requested modelrequested");
  expect(textOf(usage)).toContain("Observed modelactually-served");
  expect(textOf(usage)).toContain("Turn input tokens0");
  expect(textOf(usage)).toContain("Cache read tokens3");
  expect(textOf(usage)).toContain("Cache creation tokens4");
  expect(textOf(usage)).toContain("Cumulative provider cost estimate (USD)0");
  const absent = SessionTurnUsage({
    value: ownedSessionTurn(null, turnId),
    requestedModel: null,
  });
  expect(textOf(absent)).toContain("Not reported");
  expect(textOf(absent)).not.toContain("tokens0");
});

test("typed usage-limit outcomes show only the reported reset, while internal kills never claim operator Stop", () => {
  const event = {
    kind: "coding-outcome",
    provider: "claude",
    version: "fixture",
    code: "rate-limited",
    exitCode: 0,
    timedOut: false,
    stopped: false,
    message: { text: "<script>private</script>", truncated: true },
    stderrTail: { text: "A bounded private tail", truncated: false },
    reportedCode: "rate_limit",
    resetAt: "2026-10-23T12:00:00Z",
  } as const;
  const view = SessionOutcome({ value: event });
  expect(textOf(view)).toContain("Provider reported a usage limit");
  expect(findAll(view, "time").map((node) => attrs(node).dateTime)).toEqual([
    event.resetAt,
  ]);
  expect(findAll(view, "script")).toHaveLength(0);
  expect(textOf(view)).toContain("Reported message truncated");
  const interrupted = SessionOutcome({
    value: {
      ...event,
      code: "protocol-error",
      stopped: true,
      resetAt: undefined,
    },
  });
  expect(textOf(interrupted)).toContain("Supervisor stopped the process");
  expect(textOf(interrupted)).not.toContain("Stop confirmed");
  expect(textOf(interrupted)).not.toContain("12:00");
});
