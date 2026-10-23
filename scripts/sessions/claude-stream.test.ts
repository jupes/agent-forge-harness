import { expect, test } from "bun:test";
import { createClaudeSessionParser } from "./claude-stream";

const id = "102b7361-efc4-4fe0-88dc-9ca7f96fe277";
const other = "302b7361-efc4-4fe0-88dc-9ca7f96fe277";
const packet = (data: Record<string, unknown>) =>
  JSON.stringify({ session_id: id, ...data });
const exit = { exitCode: 0, timedOut: false, stopped: false };

test("coding text reconciles partial/full packets once, observes model, and ignores subordinate bodies", () => {
  const parser = createClaudeSessionParser({
    version: "2.1.296",
    resumeId: id,
  });
  const events = parser.line(packet({ type: "system", subtype: "init" }));
  events.push(
    ...parser.line(
      packet({
        type: "stream_event",
        event: {
          type: "message_start",
          message: { id: "m", model: "served-model" },
        },
      }),
    ),
  );
  events.push(
    ...parser.line(
      packet({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "Hello " },
        },
      }),
    ),
  );
  events.push(
    ...parser.line(
      packet({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "🌱" },
        },
      }),
    ),
  );
  const full = packet({
    type: "assistant",
    uuid: "packet-1",
    message: {
      id: "m",
      model: "served-model",
      content: [{ type: "text", text: "Hello 🌱!" }],
    },
  });
  events.push(...parser.line(full), ...parser.line(full));
  events.push(
    ...parser.line(
      packet({
        type: "assistant",
        parent_tool_use_id: "tool-1",
        session_id: other,
        message: {
          content: [{ type: "text", text: "Subordinate private prose" }],
        },
      }),
    ),
  );
  parser.line(
    packet({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Hello 🌱!",
    }),
  );
  expect(
    events
      .filter((event) => event.kind === "text")
      .map((event) => event.text)
      .join(""),
  ).toBe("Hello 🌱!");
  expect(events).toContainEqual({
    kind: "identity",
    provider: "claude",
    sessionId: id,
    version: "2.1.296",
  });
  expect(events).toContainEqual({ kind: "model", model: "served-model" });
  expect(parser.finish(exit)).toEqual({ phase: "completed", reason: null });
});

test("full-only messages deduplicate equivalent JSON whitespace and retain tool and visible thinking separately from main text", () => {
  const parser = createClaudeSessionParser({ version: "2.1.296" });
  const full = {
    session_id: id,
    type: "assistant",
    uuid: "full-only",
    message: {
      id: "m",
      model: "served",
      content: [
        { type: "thinking", thinking: "private reasoning" },
        { type: "text", text: "Full reply" },
        {
          type: "tool_use",
          id: "tool1",
          name: "Read",
          input: { secret: "private tool body" },
        },
      ],
    },
  };
  const first = parser.line(JSON.stringify(full));
  expect(parser.line(JSON.stringify(full, null, 1))).toEqual([]);
  expect(first.filter((event) => event.kind === "text")).toEqual([
    { kind: "text", messageId: "m", text: "Full reply" },
  ]);
  expect(
    first.filter((event) => event.kind === "coding-activity"),
  ).toMatchObject([
    { activity: { kind: "reasoning", content: { text: "private reasoning" } } },
    {
      activity: {
        kind: "tool",
        toolId: "tool1",
        input: { json: '{"secret":"private tool body"}' },
      },
    },
  ]);
});

test("identity forks, malformed packets, conflicting duplicate ids and excessive output are refused", () => {
  const parser = createClaudeSessionParser({
    version: "2.1.296",
    resumeId: id,
  });
  expect(() =>
    parser.line(packet({ type: "system", session_id: other })),
  ).toThrow("identity");
  expect(() =>
    createClaudeSessionParser({ version: "2.1.296" }).line("{malformed"),
  ).toThrow("protocol");
  expect(() =>
    createClaudeSessionParser({ version: "2.1.296" }).line(
      "x".repeat(1_048_577),
    ),
  ).toThrow("protocol");
  const full = (text: string) =>
    packet({
      type: "assistant",
      uuid: "same-packet",
      message: { id: "m", content: [{ type: "text", text }] },
    });
  const duplicated = createClaudeSessionParser({ version: "2.1.296" });
  duplicated.line(full("one"));
  expect(() => duplicated.line(full("two"))).toThrow("protocol");
  expect(duplicated.finish(exit).phase).toBe("unknown");
  const bounded = createClaudeSessionParser({ version: "2.1.296" });
  expect(() =>
    bounded.line(
      packet({
        type: "assistant",
        message: {
          id: "large",
          content: [{ type: "text", text: "x".repeat(512_001) }],
        },
      }),
    ),
  ).toThrow("protocol");
});

test("completion requires this turn's identity, successful terminal result and exit zero", () => {
  const make = () => createClaudeSessionParser({ version: "2.1.296" });
  const noIdentity = make();
  noIdentity.line(
    JSON.stringify({ type: "result", subtype: "success", is_error: false }),
  );
  expect(noIdentity.finish(exit).phase).toBe("unknown");
  const noResult = make();
  noResult.line(packet({ type: "system" }));
  expect(noResult.finish(exit).phase).toBe("unknown");
  const completed = make();
  completed.line(
    packet({ type: "result", subtype: "success", is_error: false }),
  );
  expect(completed.finish({ ...exit, exitCode: 7 }).phase).toBe("unknown");
  expect(completed.finish({ ...exit, timedOut: true }).phase).toBe("unknown");
  expect(completed.finish({ ...exit, stopped: true }).phase).toBe("failed");
  expect(() =>
    completed.line(
      packet({ type: "result", subtype: "success", is_error: false }),
    ),
  ).toThrow("protocol");
  const failed = make();
  failed.line(
    packet({
      type: "result",
      is_error: true,
      result: "Fixture provider error",
    }),
  );
  expect(failed.finish(exit)).toMatchObject({
    phase: "failed",
    reason: "The provider reported an unsuccessful turn.",
  });
});

test("private Claude reports correlate tools, preserve final structured output and expose only factual account metadata", () => {
  const parser = createClaudeSessionParser({ version: "2.1.296" });
  const events = parser.line(
    packet({
      type: "system",
      subtype: "init",
      uuid: "init",
      apiKeySource: "none",
    }),
  );
  const tool = {
    type: "assistant",
    uuid: "tool",
    message: {
      id: "tool-message",
      content: [
        {
          type: "tool_use",
          id: "bash-1",
          name: "Bash",
          input: { command: "echo hello" },
        },
      ],
    },
  };
  events.push(...parser.line(packet(tool)));
  const result = {
    type: "user",
    uuid: "tool-result",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "bash-1",
          content: "model-facing output",
          is_error: false,
        },
      ],
    },
    tool_use_result: {
      stdout: "reported output",
      stderr: "tool notice",
      interrupted: false,
    },
  };
  events.push(...parser.line(packet(result)));
  expect(parser.line(packet(result))).toEqual([]);
  events.push(
    ...parser.line(
      packet({
        type: "rate_limit_event",
        uuid: "rate",
        rate_limit_info: {
          status: "allowed_warning",
          utilization: 0.8,
          resetsAt: 123,
        },
      }),
    ),
  );
  events.push(
    ...parser.line(
      packet({
        type: "result",
        uuid: "result",
        subtype: "success",
        is_error: false,
        structured_output: { status: "actual" },
        usage: {
          input_tokens: 20,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
          output_tokens: 2,
        },
        total_cost_usd: 0.5,
      }),
    ),
  );
  expect(
    events.filter((event) => event.kind === "coding-account"),
  ).toMatchObject([
    { source: "claude.system.init", report: { apiKeySource: "none" } },
    {
      source: "claude.rate_limit_event",
      report: {
        status: "allowed_warning",
        resetsAt: 123,
        resetUnit: "unreported",
      },
    },
  ]);
  expect(
    events.filter((event) => event.kind === "coding-activity"),
  ).toMatchObject([
    { activity: { kind: "tool", state: "running" } },
    { activity: { kind: "tool", state: "completed" } },
    { activity: { kind: "command", output: { text: "reported output" } } },
    {
      activity: {
        kind: "structured-output",
        output: { json: '{"status":"actual"}' },
      },
    },
  ]);
  expect(events.filter((event) => event.kind === "coding-usage")).toMatchObject(
    [
      {
        provider: "claude",
        usage: { cacheReadInputTokens: 10, cacheCreationInputTokens: 5 },
        cumulativeEstimateUsd: 0.5,
      },
    ],
  );
  expect(parser.finish(exit).phase).toBe("completed");
});

test("visible thinking streams in bounded updates, reconciles the full block and never retains opaque signatures", () => {
  const parser = createClaudeSessionParser({ version: "2.1.296" });
  parser.line(packet({ type: "system", subtype: "init" }));
  parser.line(
    packet({
      type: "stream_event",
      event: { type: "message_start", message: { id: "thinking" } },
    }),
  );
  const events = parser.line(
    packet({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      },
    }),
  );
  events.push(
    ...parser.line(
      packet({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Visible summary" },
        },
      }),
    ),
  );
  events.push(
    ...parser.line(
      packet({
        type: "assistant",
        uuid: "thinking-full",
        message: {
          id: "thinking",
          content: [
            {
              type: "thinking",
              thinking: "Visible summary completed",
              signature: "opaque-never-retain",
            },
          ],
        },
      }),
    ),
  );
  parser.line(
    packet({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
    }),
  );
  expect(
    events.filter((event) => event.kind === "coding-activity"),
  ).toMatchObject([
    { partial: true },
    { partial: true, activity: { content: { text: "Visible summary" } } },
    {
      partial: false,
      activity: { content: { text: "Visible summary completed" } },
    },
  ]);
  expect(JSON.stringify(events)).not.toContain("opaque");
  expect(events.filter((event) => event.kind === "text")).toEqual([]);
});

test("only typed provider errors establish auth or rate outcomes; private words and supervisor causes remain distinct", () => {
  for (const reported of [
    "authentication_failed",
    "rate_limit",
    "cloud_credential_error",
  ]) {
    const parser = createClaudeSessionParser({ version: "2.1.296" });
    parser.line(
      packet({
        type: "assistant",
        uuid: "error",
        error: reported,
        message: {
          id: "err",
          model: "<synthetic>",
          content: [{ type: "text", text: "private provider words" }],
        },
      }),
    );
    parser.line(
      packet({
        type: "result",
        is_error: true,
        subtype: "error_during_execution",
        errors: ["private provider words"],
      }),
    );
    const outcome = parser.outcome({
      ...exit,
      exitCode: 1,
      stderr: "private stderr",
    });
    expect(outcome.code).toBe(
      reported === "authentication_failed"
        ? "auth-error"
        : reported === "rate_limit"
          ? "rate-limited"
          : "provider-error",
    );
    expect(outcome.message?.text).toBe("private provider words");
    expect(parser.finish({ ...exit, exitCode: 1 }).reason).not.toContain(
      "private",
    );
  }
  const broken = createClaudeSessionParser({ version: "2.1.296" });
  expect(() => broken.line("{malformed")).toThrow();
  expect(
    broken.outcome({ ...exit, exitCode: 1, stopped: true, stderr: "" }),
  ).toMatchObject({ code: "protocol-error", stopped: true });
  expect(
    broken.outcome({
      ...exit,
      exitCode: 1,
      stopped: true,
      timedOut: true,
      stderr: "",
    }).code,
  ).toBe("timed-out");
});
