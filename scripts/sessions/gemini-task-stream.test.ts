import { expect, test } from "bun:test";
import {
  createGeminiTaskParser,
  GEMINI_TASK_STREAM_LIMITS,
} from "./gemini-task-stream";

const version = "0.65.0";
const sessionId = "0199a213-81c0-7800-8aa1-bbab2a035a53";
const timestamp = "2026-10-23T08:00:00.000Z";
const line = (event: Record<string, unknown>) =>
  JSON.stringify({ timestamp, ...event });
const init = {
  type: "init",
  session_id: sessionId,
  model: "auto-gemini-example",
};
const stats = {
  total_tokens: 26,
  input_tokens: 23,
  output_tokens: 3,
  cached: 7,
  input: 16,
  duration_ms: 1200,
  tool_calls: 0,
  models: {
    "gemini-actual-example": {
      total_tokens: 26,
      input_tokens: 23,
      output_tokens: 3,
      cached: 7,
      input: 16,
    },
  },
};
const cleanExit = { exitCode: 0, timedOut: false, stopped: false, stderr: "" };

test("Gemini native JSONL retains exact identity, assistant deltas and native per-model token units through supervised completion", () => {
  const parser = createGeminiTaskParser({ version });
  const identity = parser.read(line(init));
  expect(identity).toEqual([
    {
      kind: "identity",
      provider: "gemini",
      route: "gemini-cli",
      version,
      sessionId,
      configuredModel: "auto-gemini-example",
    },
  ]);
  expect(
    parser.read(
      line({ type: "message", role: "user", content: "Private prompt" }),
    ),
  ).toEqual([]);
  expect(
    parser.read(
      line({
        type: "message",
        role: "assistant",
        content: "Reply 🌱",
        delta: true,
      }),
    ),
  ).toEqual([{ kind: "text", text: "Reply 🌱", delta: true }]);
  const events = parser.read(
    line({ type: "result", status: "success", stats }),
  );
  expect(events).toHaveLength(1);
  const result = parser.finish(cleanExit);
  expect(result.phase).toBe("completed");
  expect(result.sessionId).toBe(sessionId);
  expect(result.configuredModel).toBe("auto-gemini-example");
  expect(result.usage).toEqual({
    totalTokens: 26,
    inputTokens: 23,
    outputTokens: 3,
    cachedInputTokens: 7,
    uncachedInputTokens: 16,
    durationMs: 1200,
    toolCalls: 0,
    models: {
      "gemini-actual-example": {
        totalTokens: 26,
        inputTokens: 23,
        outputTokens: 3,
        cachedInputTokens: 7,
        uncachedInputTokens: 16,
      },
    },
  });
  expect(result.usage?.inputTokens).toBe(23);
  expect(result.usage?.models["auto-gemini-example"]).toBeUndefined();
});

test("native policy denials retain the actual correlated tool report without becoming an approval request or fabricated execution", () => {
  const parser = createGeminiTaskParser({ version });
  parser.read(line(init));
  expect(
    parser.read(
      line({
        type: "tool_use",
        tool_id: "tool-1",
        tool_name: "run_shell_command",
        parameters: {
          command: "DO_NOT_EXECUTE",
          description: "Private fixture",
        },
      }),
    ),
  ).toEqual([
    {
      kind: "tool",
      id: "tool-1",
      name: "run_shell_command",
      state: "requested",
      input: {
        json: '{"command":"DO_NOT_EXECUTE","description":"Private fixture"}',
        truncated: false,
      },
    },
  ]);
  expect(
    parser.read(
      line({
        type: "tool_result",
        tool_id: "tool-1",
        status: "error",
        error: {
          type: "policy_violation",
          message: "Blocked by the synthetic policy",
        },
      }),
    ),
  ).toEqual([
    {
      kind: "tool",
      id: "tool-1",
      name: "run_shell_command",
      state: "failed",
      error: {
        type: "policy_violation",
        message: { text: "Blocked by the synthetic policy", truncated: false },
      },
    },
  ]);
  parser.read(
    line({
      type: "message",
      role: "assistant",
      content: "The tool was denied; no command ran.",
      delta: true,
    }),
  );
  parser.read(
    line({
      type: "result",
      status: "success",
      stats: { ...stats, tool_calls: 1 },
    }),
  );
  expect(parser.finish(cleanExit).phase).toBe("completed");
});

test("typed warnings remain notices but native errors cannot become success solely because the process exits0", () => {
  const warning = createGeminiTaskParser({ version });
  warning.read(line(init));
  expect(
    warning.read(
      line({
        type: "error",
        severity: "warning",
        message: "Synthetic warning",
      }),
    ),
  ).toEqual([
    {
      kind: "notice",
      severity: "warning",
      message: { text: "Synthetic warning", truncated: false },
    },
  ]);
  warning.read(line({ type: "result", status: "success" }));
  expect(warning.finish(cleanExit).phase).toBe("completed");
  const failure = createGeminiTaskParser({ version });
  failure.read(line(init));
  failure.read(
    line({
      type: "error",
      severity: "error",
      message: "Private native failure",
    }),
  );
  failure.read(line({ type: "result", status: "success" }));
  expect(failure.finish(cleanExit).phase).toBe("failed");
  const noIdentity = createGeminiTaskParser({ version });
  expect(
    noIdentity.read(
      line({
        type: "result",
        status: "error",
        error: {
          type: "AUTHENTICATION_ERROR",
          message: "Synthetic sign-in error",
        },
      }),
    ),
  ).toEqual([
    {
      kind: "notice",
      severity: "error",
      reportedType: "AUTHENTICATION_ERROR",
      message: { text: "Synthetic sign-in error", truncated: false },
    },
  ]);
  expect(noIdentity.finish(cleanExit)).toMatchObject({
    phase: "failed",
    sessionId: null,
    usage: null,
  });
});

test("malformed and conflicting native identities cannot confirm completion, including extra foreign IDs on otherwise valid messages", () => {
  for (const raw of [
    "{",
    "null",
    line({ type: "future" }),
    line({ ...init, session_id: "wrong" }),
    line({
      type: "message",
      role: "assistant",
      content: "private",
      session_id: "0199a213-81c0-7800-8aa1-bbab2a035a54",
    }),
    line({
      type: "tool_use",
      tool_id: "bad\0id",
      tool_name: "tool",
      parameters: {},
    }),
    line({
      type: "result",
      status: "success",
      stats: { ...stats, input_tokens: -1 },
    }),
  ]) {
    const parser = createGeminiTaskParser({ version });
    parser.read(line(init));
    expect(() => {
      parser.read(raw);
    }).toThrow();
    expect(parser.finish(cleanExit).phase).toBe("unknown");
  }
  const empty = createGeminiTaskParser({ version });
  expect(empty.finish(cleanExit).phase).toBe("unknown");
  const missing = createGeminiTaskParser({ version });
  missing.read(line(init));
  missing.read(
    line({
      type: "tool_use",
      tool_id: "pending",
      tool_name: "tool",
      parameters: {},
    }),
  );
  missing.read(line({ type: "result", status: "success" }));
  expect(missing.finish(cleanExit).phase).toBe("unknown");
});

test("line, aggregate and assistant-text byte bounds remain enforced before even ignored JSONL whitespace", () => {
  const lines = createGeminiTaskParser({ version });
  for (let i = 0; i < GEMINI_TASK_STREAM_LIMITS.lines; i++) lines.read("");
  expect(() => {
    lines.read("");
  }).toThrow();
  const huge = createGeminiTaskParser({ version });
  expect(() => {
    huge.read(" ".repeat(GEMINI_TASK_STREAM_LIMITS.lineBytes + 1));
  }).toThrow();
  const total = createGeminiTaskParser({ version });
  const chunk = " ".repeat(GEMINI_TASK_STREAM_LIMITS.lineBytes);
  for (let i = 0; i < GEMINI_TASK_STREAM_LIMITS.totalBytes / chunk.length; i++)
    total.read(chunk);
  expect(() => {
    total.read(" ");
  }).toThrow();
  const text = createGeminiTaskParser({ version });
  text.read(line(init));
  text.read(
    line({
      type: "message",
      role: "assistant",
      content: "🌱".repeat(GEMINI_TASK_STREAM_LIMITS.textBytes / 4),
      delta: true,
    }),
  );
  expect(() => {
    text.read(
      line({ type: "message", role: "assistant", content: "a", delta: true }),
    );
  }).toThrow();
  expect(text.finish(cleanExit).phase).toBe("unknown");
});

test("full bounded tool packets distinguish conflicting input beyond the displayed truncation and exact duplicate reports stay idempotent", () => {
  const parser = createGeminiTaskParser({ version });
  parser.read(line(init));
  const use = {
    type: "tool_use",
    tool_id: "tool-1",
    tool_name: "read_file",
    parameters: { path: "x".repeat(32768) + "a" },
  };
  const events = parser.read(line(use));
  expect(events[0]).toMatchObject({ kind: "tool", input: { truncated: true } });
  expect(parser.read(line(use))).toEqual([]);
  expect(() => {
    parser.read(
      line({ ...use, parameters: { path: "x".repeat(32768) + "b" } }),
    );
  }).toThrow();
  expect(parser.finish(cleanExit).phase).toBe("unknown");
});
