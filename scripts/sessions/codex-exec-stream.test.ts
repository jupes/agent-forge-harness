import { expect, test } from "bun:test";
import {
  CODEX_EXEC_STREAM_LIMITS,
  createCodexExecParser,
} from "./codex-exec-stream";

const version = "0.163.0-alpha.10.2";
const threadId = "0199a213-81c0-7800-8aa1-bbab2a035a53";
const exit = { exitCode: 0, timedOut: false, stopped: false };
const line = (value: unknown) => JSON.stringify(value);
function started() {
  const parser = createCodexExecParser({ version });
  parser.line(line({ type: "thread.started", thread_id: threadId }));
  parser.line(line({ type: "turn.started" }));
  return parser;
}

test("actual exec JSONL reports its thread, completed assistant text and usage without inventing an observed model", () => {
  const parser = createCodexExecParser({ version });
  expect(
    parser.line(
      JSON.stringify({
        type: "thread.started",
        thread_id: threadId,
        model: "configured-is-not-telemetry",
      }),
    ),
  ).toEqual([{ kind: "identity", provider: "codex", threadId, version }]);
  expect(parser.line('{"type":"turn.started"}')).toEqual([]);
  expect(
    parser.line(
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Private reply 🌱","model":"requested-only"}}',
    ),
  ).toEqual([{ kind: "text", itemId: "item_0", text: "Private reply 🌱" }]);
  expect(
    parser.line(
      '{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122,"reasoning_output_tokens":64}}',
    ),
  ).toEqual([
    {
      kind: "usage",
      usage: {
        inputTokens: 24763,
        cachedInputTokens: 24448,
        outputTokens: 122,
        reasoningOutputTokens: 64,
      },
    },
  ]);
  expect(parser.finish(exit)).toEqual({
    phase: "completed",
    reason: null,
    threadId,
    observedModel: null,
    usage: {
      inputTokens: 24763,
      cachedInputTokens: 24448,
      outputTokens: 122,
      reasoningOutputTokens: 64,
    },
  });
});

test("cumulative updates and duplicate completed items cannot duplicate private main text or confuse private tools with prose", () => {
  const parser = started();
  expect(
    parser.line(
      line({
        type: "item.started",
        item: { id: "reply", type: "agent_message", text: "Partial" },
      }),
    ),
  ).toEqual([]);
  expect(
    parser.line(
      line({
        type: "item.updated",
        item: { id: "reply", type: "agent_message", text: "Partial full" },
      }),
    ),
  ).toEqual([]);
  for (const type of ["collab_tool_call", "future_passive_item"])
    expect(
      parser.line(
        line({
          type: "item.completed",
          item: {
            id: type,
            type,
            text: "private tool prose",
            aggregated_output: "secret output",
            receiver_thread_ids: ["foreign-child"],
          },
        }),
      ),
    ).toEqual([]);
  const reply = {
    type: "item.completed",
    item: { id: "reply", type: "agent_message", text: "Partial full" },
  };
  expect(parser.line(line(reply))).toEqual([
    { kind: "text", itemId: "reply", text: "Partial full" },
  ]);
  expect(
    parser.line(
      '{"item":{"text":"Partial full","type":"agent_message","id":"reply"},"type":"item.completed"}',
    ),
  ).toEqual([]);
  expect(() =>
    parser.line(
      line({
        ...reply,
        item: { ...reply.item, text: "changed after completion" },
      }),
    ),
  ).toThrow("protocol");
  expect(parser.finish(exit).phase).toBe("unknown");
});

test("the documented terminal result does not require completion packets for incidental tools", () => {
  const parser = started();
  parser.line(
    line({
      type: "item.started",
      item: {
        id: "pending",
        type: "command_execution",
        command: "echo waiting",
        aggregated_output: "",
        status: "in_progress",
      },
    }),
  );
  expect(parser.line(line({ type: "turn.completed" }))).toEqual([]);
  expect(parser.finish(exit).phase).toBe("completed");
});

test("rich exec activity remains private, updates one native item and conflicting completion poisons confirmation", () => {
  const parser = started();
  const command = {
    id: "cmd",
    type: "command_execution",
    command: "echo private",
    aggregated_output: "",
    status: "in_progress",
  };
  const first = parser.line(line({ type: "item.started", item: command }));
  expect(first).toMatchObject([
    {
      kind: "coding-activity",
      provider: "codex",
      version,
      id: "cmd",
      source: "codex.item.started",
      partial: true,
      activity: { kind: "command", state: "running" },
    },
  ]);
  expect(parser.line(line({ type: "item.started", item: command }))).toEqual(
    [],
  );
  const complete = {
    ...command,
    status: "completed",
    aggregated_output: "private output",
    exit_code: 0,
  };
  expect(
    parser.line(line({ type: "item.completed", item: complete })),
  ).toMatchObject([
    {
      kind: "coding-activity",
      partial: false,
      activity: {
        kind: "command",
        state: "completed",
        output: { text: "private output" },
        exitCode: 0,
      },
    },
  ]);
  expect(parser.line(line({ type: "item.completed", item: complete }))).toEqual(
    [],
  );
  expect(() =>
    parser.line(
      line({
        type: "item.completed",
        item: { ...complete, aggregated_output: "conflicting output" },
      }),
    ),
  ).toThrow("protocol");
  expect(parser.finish(exit).phase).toBe("unknown");
});

test("aggregate rich activity overflow retains bounded partial frames and refuses a confirmed full transcript", () => {
  const parser = started();
  let frames = 0;
  expect(() => {
    for (let index = 0; index < 200; index++)
      frames += parser.line(
        line({
          type: "item.updated",
          item: {
            id: `r${index}`,
            type: "reasoning",
            text: "x".repeat(16_384),
          },
        }),
      ).length;
  }).toThrow("protocol");
  expect(frames).toBeGreaterThan(100);
  expect(frames).toBeLessThan(150);
  expect(parser.finish(exit).phase).toBe("unknown");
});

test("foreign identities, malformed packets and invalid lifecycle remain poisoned after process success", () => {
  const cases = [
    [line({ type: "thread.started", thread_id: "not-a-uuid" })],
    [line({ type: "turn.started" })],
    [
      line({ type: "thread.started", thread_id: threadId }),
      line({
        type: "thread.started",
        thread_id: "13a72c84-6c9d-438c-9160-6fdd19f92177",
      }),
    ],
    [
      line({ type: "thread.started", thread_id: threadId }),
      line({
        type: "item.completed",
        item: { id: "too-early", type: "agent_message", text: "no" },
      }),
    ],
    [
      line({ type: "thread.started", thread_id: threadId }),
      line({ type: "turn.started" }),
      line({ type: "turn.started" }),
    ],
    [
      line({ type: "thread.started", thread_id: threadId }),
      line({ type: "turn.started" }),
      line({
        type: "turn.completed",
        thread_id: "13a72c84-6c9d-438c-9160-6fdd19f92177",
      }),
    ],
    [
      line({ type: "thread.started", thread_id: threadId }),
      line({ type: "turn.started" }),
      line({ type: "turn.completed" }),
      line({ type: "turn.started" }),
    ],
    ["{malformed"],
    ["[]"],
    [line({ type: "thread/started", params: { threadId } })],
  ];
  for (const packets of cases) {
    const parser = createCodexExecParser({ version });
    for (const packet of packets.slice(0, -1)) parser.line(packet);
    expect(() => parser.line(packets.at(-1) ?? "")).toThrow("protocol");
    expect(() =>
      parser.line(line({ type: "thread.started", thread_id: threadId })),
    ).toThrow("protocol");
    expect(parser.finish(exit).phase).toBe("unknown");
  }
  const parser = started();
  parser.line(
    line({
      type: "item.started",
      item: { id: "same", type: "reasoning", text: "Reported summary" },
    }),
  );
  expect(() =>
    parser.line(
      line({
        type: "item.completed",
        item: { id: "same", type: "agent_message", text: "switched type" },
      }),
    ),
  ).toThrow("protocol");
  expect(parser.finish(exit).phase).toBe("unknown");
});

test("completion requires terminal and process success, and failure reasons never expose provider bodies", () => {
  const parser = started();
  expect(parser.finish(exit).phase).toBe("unknown");
  for (const status of [
    exit,
    { ...exit, exitCode: 7 },
    { ...exit, exitCode: null },
    { ...exit, timedOut: true },
    { ...exit, stopped: true },
  ]) {
    const complete = started();
    complete.line(line({ type: "turn.completed" }));
    expect(complete.finish(status).phase).toBe(
      status.stopped
        ? "failed"
        : status.timedOut || status.exitCode !== 0
          ? "unknown"
          : "completed",
    );
  }
  for (const packet of [
    { type: "turn.failed", error: { message: "SECRET provider failure" } },
    { type: "error", message: "SECRET top-level error" },
    {
      type: "item.completed",
      item: { id: "err", type: "error", message: "SECRET private item" },
    },
  ]) {
    const failed = started();
    expect(failed.line(line(packet))).toEqual([]);
    const result = failed.finish({ ...exit, exitCode: 1 });
    expect(result.phase).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("SECRET");
  }
  const counts = started();
  expect(
    counts.line(line({ type: "turn.completed", usage: { future_count: 123 } })),
  ).toEqual([]);
  expect(counts.finish(exit).usage).toBe(null);
  for (const count of [-1, 1.5, null, Number.MAX_SAFE_INTEGER + 1]) {
    const invalid = started();
    expect(() =>
      invalid.line(
        line({ type: "turn.completed", usage: { input_tokens: count } }),
      ),
    ).toThrow();
    expect(invalid.finish(exit).phase).toBe("unknown");
  }
});

test("packet, total, item and UTF-8 text bounds fail closed while valid text chunks preserve characters", () => {
  for (const fill of [
    (parser: ReturnType<typeof started>) =>
      parser.line(" ".repeat(CODEX_EXEC_STREAM_LIMITS.lineBytes + 1)),
    (parser: ReturnType<typeof started>) => {
      for (let index = 0; index <= CODEX_EXEC_STREAM_LIMITS.lines; index++)
        parser.line("");
    },
    (parser: ReturnType<typeof started>) => {
      for (let index = 0; index < 9; index++)
        parser.line(" ".repeat(CODEX_EXEC_STREAM_LIMITS.lineBytes));
    },
    (parser: ReturnType<typeof started>) => {
      for (let index = 0; index <= CODEX_EXEC_STREAM_LIMITS.items; index++)
        parser.line(
          line({
            type: "item.completed",
            item: { id: `item_${index}`, type: "future_passive_item" },
          }),
        );
    },
    (parser: ReturnType<typeof started>) =>
      parser.line(
        line({
          type: "item.completed",
          item: {
            id: "large",
            type: "agent_message",
            text: "🌱".repeat(131_073),
          },
        }),
      ),
  ]) {
    const parser = started();
    expect(() => fill(parser)).toThrow();
    expect(parser.finish(exit).phase).toBe("unknown");
  }
  const parser = started();
  const text = `${"a".repeat(15_999)}🌱${"b".repeat(16_000)}`;
  const events = parser.line(
    line({
      type: "item.completed",
      item: { id: "unicode", type: "agent_message", text },
    }),
  );
  expect(
    events.map((event) => (event.kind === "text" ? event.text : "")).join(""),
  ).toBe(text);
  expect(
    events.every(
      (event) =>
        event.kind === "text" &&
        event.text.length <= 16_000 &&
        !/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/.test(event.text),
    ),
  ).toBe(true);
});
