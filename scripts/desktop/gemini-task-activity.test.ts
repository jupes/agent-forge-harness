import { expect, test } from "bun:test";
import { GeminiTaskActivity } from "../../apps/desktop/src/GeminiTaskActivity";
import { geminiTaskPresentation } from "../../apps/desktop/src/gemini-task-presentation";
import { KeeperMarkdown } from "../../apps/desktop/src/KeeperMarkdown";
import { SessionReply } from "../../apps/desktop/src/SessionReply";
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
test("Gemini assistant Markdown deltas become one exact copyable session reply", () => {
  const value = page([
    { kind: "text", text: "**Read", delta: true },
    { kind: "text", text: "able**\n\n`code`", delta: true },
  ]);
  const replies = findAll(
    GeminiTaskActivity({ page: value, turnId }),
    "SessionReply",
  );
  expect(replies).toHaveLength(1);
  expect(attrs(replies[0]).text).toBe("**Readable**\n\n`code`");
});

test("Gemini private reports retain configured labels, exact assistant text, denial data and per-model units without provider actions", () => {
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
  expect(
    findAll(view, "SessionReply").map((reply) => attrs(reply).text),
  ).toEqual(["<img src=x onerror=alert(1)>", "Exact full native text"]);
  expect(
    GeminiTaskActivity({ page: value, turnId: "foreign-turn" }),
  ).toBeNull();
});

test("only consecutive explicit deltas join; complete reports, tools, notices and foreign turns preserve boundaries", () => {
  const value = page([
    { kind: "text", text: "", delta: true },
    { kind: "text", text: "one", delta: true },
    { kind: "text", text: "", delta: true },
    { kind: "text", text: " two", delta: true },
    { kind: "text", text: "one two", delta: false },
    { kind: "text", text: "new delta", delta: true },
    { kind: "tool", id: "tool-1", name: "read_file", state: "requested" },
    { kind: "text", text: "after tool", delta: true },
    {
      kind: "notice",
      severity: "warning",
      message: { text: "private notice", truncated: false },
    },
    { kind: "text", text: "after notice", delta: true },
    { kind: "text", text: "", delta: false },
    { kind: "text", text: "after empty complete", delta: true },
    { kind: "text", text: "foreign", delta: true },
    { kind: "text", text: "after foreign", delta: true },
  ]);
  value.frames[12]!.turnId = "foreign-turn";
  const original = JSON.stringify(value);
  const projected = geminiTaskPresentation(value, turnId);
  expect(
    projected.filter((row) => row.kind === "reply").map((row) => row.text),
  ).toEqual([
    "one two",
    "one two",
    "new delta",
    "after tool",
    "after notice",
    "after empty complete",
    "after foreign",
  ]);
  expect(
    projected
      .filter((row) => row.kind === "report")
      .map((row) => row.event.kind),
  ).toEqual(["tool", "notice"]);
  expect(geminiTaskPresentation(value, "foreign-turn")).toEqual([
    { kind: "reply", sequence: 13, text: "foreign", open: false },
  ]);
  expect(JSON.stringify(value)).toBe(original);
  expect(geminiTaskPresentation(null, turnId)).toEqual([]);
});

test("only the live trailing Gemini delta segment has a caret; a report or terminal presentation closes it", () => {
  const value = page([
    { kind: "text", text: "complete", delta: false },
    { kind: "text", text: "still streaming", delta: true },
  ]);
  const streaming = findAll(
    GeminiTaskActivity({ page: value, turnId, streaming: true }),
    "SessionReply",
  );
  expect(streaming.map((row) => attrs(row).streaming)).toEqual([false, true]);
  expect(
    findAll(
      GeminiTaskActivity({ page: value, turnId, streaming: false }),
      "SessionReply",
    ).map((row) => attrs(row).streaming),
  ).toEqual([false, false]);
  const withNotice = page([
    { kind: "text", text: "partial", delta: true },
    {
      kind: "notice",
      severity: "warning",
      message: { text: "waiting", truncated: false },
    },
  ]);
  expect(
    attrs(
      findAll(
        GeminiTaskActivity({ page: withNotice, turnId, streaming: true }),
        "SessionReply",
      )[0],
    ).streaming,
  ).toBe(false);
  const emptyComplete = page([
    { kind: "text", text: "partial", delta: true },
    { kind: "text", text: "", delta: false },
  ]);
  expect(
    attrs(
      findAll(
        GeminiTaskActivity({ page: emptyComplete, turnId, streaming: true }),
        "SessionReply",
      )[0],
    ).streaming,
  ).toBe(false);
});

test("the shared reply uses safe Markdown and copies the exact original text without provider actions", () => {
  const text =
    "**Readable**\n\n`code`\n\n<script>alert(1)</script>\n\n[blocked](javascript:alert) [safe](https://example.com)";
  const copied: string[] = [];
  const view = SessionReply({
    text,
    streaming: true,
    onCopy: (value) => copied.push(value),
  });
  const markdown = findAll(view, "KeeperMarkdown")[0];
  expect(attrs(markdown).text).toBe(text);
  const rendered = KeeperMarkdown({ text });
  expect(textOf(findAll(rendered, "strong")[0])).toBe("Readable");
  expect(findAll(rendered, "script")).toHaveLength(0);
  expect(findAll(rendered, "img")).toHaveLength(0);
  expect(findAll(rendered, "a").map((link) => attrs(link).href)).toEqual([
    "https://example.com",
  ]);
  const button = findAll(view, "Button")[0];
  expect(textOf(button)).toBe("Copy session reply");
  const copy = attrs(button).onClick;
  if (typeof copy !== "function") throw Error("Missing copy action");
  copy();
  expect(copied).toEqual([text]);
  expect(findAll(view, "span").map((span) => attrs(span).class)).toContain(
    "af-session-streaming-caret",
  );
  expect(
    findAll(SessionReply({ text, streaming: false }), "span"),
  ).toHaveLength(0);
  expect(SessionReply({ text: "" })).toBeNull();
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
