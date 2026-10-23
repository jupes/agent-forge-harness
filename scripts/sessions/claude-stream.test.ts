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

test("full-only messages deduplicate equivalent JSON whitespace and ignore tools and thinking", () => {
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
        { type: "tool_use", input: { secret: "private tool body" } },
      ],
    },
  };
  const first = parser.line(JSON.stringify(full));
  expect(parser.line(JSON.stringify(full, null, 1))).toEqual([]);
  expect(first.filter((event) => event.kind === "text")).toEqual([
    { kind: "text", messageId: "m", text: "Full reply" },
  ]);
  expect(JSON.stringify(first)).not.toContain("private");
});

test("identity forks, malformed packets, conflicting duplicate ids and excessive output are refused", () => {
  const parser = createClaudeSessionParser({
    version: "2.1.296",
    resumeId: id,
  });
  expect(() =>
    parser.line(packet({ type: "system", session_id: other })),
  ).toThrow("identity");
  expect(() => parser.line("{malformed")).toThrow("protocol");
  expect(() => parser.line("x".repeat(1_048_577))).toThrow("protocol");
  const full = (text: string) =>
    packet({
      type: "assistant",
      uuid: "same-packet",
      message: { id: "m", content: [{ type: "text", text }] },
    });
  parser.line(full("one"));
  expect(() => parser.line(full("two"))).toThrow("protocol");
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
    reason: "Fixture provider error",
  });
});
