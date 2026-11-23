import { expect, test } from "bun:test";
import type { ConversationEvent } from "../../types/conversation";
import { FIXTURE_PROJECT_ID, projectFixture } from "../projects/testing";
import { createClaudeConversationParser } from "./claude-stream";
import { readKeeperProject } from "./project-read";

const sessionId = "1c032c4b-62bd-4f03-a09e-a92d05b59bba";
const packet = (value: Record<string, unknown>) =>
  JSON.stringify({ session_id: sessionId, ...value });
const raw = (event: Record<string, unknown>) =>
  packet({ type: "stream_event", event });
const init = packet({
  type: "system",
  subtype: "init",
  tools: ["mcp__keeper__read_project", "EndConversation"],
});
const parserForTest = () =>
  createClaudeConversationParser({
    projectId: FIXTURE_PROJECT_ID,
    version: "fixture-1",
    now: () => new Date("2026-10-22T12:00:00.000Z"),
  });
const textOf = (events: ConversationEvent[]) =>
  events
    .flatMap((event) => (event.kind === "text" ? [event.text] : []))
    .join("");

test("partial text and per-block assistant packets are preserved once, including multiple blocks with one message id", () => {
  const parser = parserForTest();
  const events = parser.line(init);
  events.push(
    ...parser.line(
      raw({
        type: "message_start",
        message: { id: "msg-1", model: "observed-model" },
      }),
    ),
  );
  events.push(
    ...parser.line(
      raw({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
    ),
  );
  events.push(
    ...parser.line(
      raw({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello 🌱" },
      }),
    ),
  );
  const complete = packet({
    type: "assistant",
    uuid: "packet-1",
    message: {
      id: "msg-1",
      model: "observed-model",
      content: [{ type: "text", text: "Hello 🌱!" }],
    },
  });
  events.push(...parser.line(complete), ...parser.line(complete));
  events.push(...parser.line(raw({ type: "content_block_stop", index: 0 })));
  expect(parser.line(complete)).toEqual([]);
  events.push(
    ...parser.line(
      raw({
        type: "content_block_start",
        index: 2,
        content_block: { type: "text", text: "" },
      }),
    ),
  );
  events.push(
    ...parser.line(
      raw({
        type: "content_block_delta",
        index: 2,
        delta: { type: "text_delta", text: " Another block." },
      }),
    ),
  );
  events.push(
    ...parser.line(
      packet({
        type: "assistant",
        uuid: "packet-2",
        message: {
          id: "msg-1",
          model: "observed-model",
          content: [{ type: "text", text: " Another block." }],
        },
      }),
    ),
  );
  events.push(
    ...parser.line(
      raw({
        type: "content_block_delta",
        index: 3,
        delta: { type: "thinking_delta", thinking: "PRIVATE_THINKING" },
      }),
    ),
  );
  parser.line(
    packet({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Hello 🌱! Another block.",
    }),
  );
  expect(textOf(events)).toBe("Hello 🌱! Another block.");
  expect(JSON.stringify(events)).not.toContain("PRIVATE_THINKING");
  expect(events.filter((event) => event.kind === "identity")).toHaveLength(1);
  expect(
    parser.finish({ exitCode: 0, timedOut: false, stopped: false }).phase,
  ).toBe("completed");
});

test("actual scoped tool results yield a read trace while incomplete results and unexpected tools stay explicit", () => {
  const parser = parserForTest();
  parser.line(init);
  parser.line(
    raw({
      type: "message_start",
      message: { id: "read-msg", model: "observed-model" },
    }),
  );
  parser.line(
    raw({
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "tool-1",
        name: "mcp__keeper__read_project",
        input: {},
      },
    }),
  );
  parser.line(
    packet({
      type: "assistant",
      message: {
        id: "read-msg",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "mcp__keeper__read_project",
            input: { kind: "beads", id: "alpha-epic" },
          },
        ],
      },
    }),
  );
  const project = projectFixture("/served");
  const detail = readKeeperProject(
    project,
    1,
    {
      workspace: "/served",
      asOf: project.updatedAt,
      issues: [
        {
          id: "alpha-epic",
          title: "Alpha",
          type: "epic",
          status: "open",
          labels: ["project:alpha"],
          description: "PRIVATE_TOOL_BODY",
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        },
      ],
      queue: [],
      sessions: [],
      sessionsComplete: true,
      problems: [],
    },
    { events: [], more: false },
    { kind: "beads", id: "alpha-epic" },
  );
  const result = packet({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: true, data: detail, error: null }),
            },
          ],
        },
      ],
    },
  });
  const traced = parser.line(result);
  expect(traced).toContainEqual({
    kind: "read",
    query: "beads",
    source: detail.source,
    asOf: detail.asOf,
    complete: true,
    reason: null,
    ids: ["alpha-epic"],
    nextCursor: null,
  });
  expect(JSON.stringify(traced)).not.toContain("PRIVATE_TOOL_BODY");
  expect(parser.line(result)).toEqual([]);
  parser.line(raw({ type: "message_start", message: { id: "second-read" } }));
  parser.line(
    raw({
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "tool-2",
        name: "mcp__keeper__read_project",
        input: {},
      },
    }),
  );
  parser.line(
    packet({
      type: "assistant",
      message: {
        id: "second-read",
        content: [
          {
            type: "tool_use",
            id: "tool-2",
            name: "mcp__keeper__read_project",
            input: { kind: "queue" },
          },
        ],
      },
    }),
  );
  const failed = parser.line(
    packet({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-2",
            is_error: true,
            content: "PRIVATE_ERROR_BODY",
          },
        ],
      },
    }),
  );
  expect(failed).toContainEqual({
    kind: "read",
    query: "queue",
    source: "Project reader",
    asOf: "2026-10-22T12:00:00.000Z",
    complete: false,
    reason:
      "The project read was unavailable or malformed. The answer may be incomplete.",
    ids: [],
    nextCursor: null,
  });
  expect(JSON.stringify(failed)).not.toContain("PRIVATE_ERROR_BODY");
  expect(() =>
    parser.line(
      raw({
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "bad-tool",
          name: "Bash",
          input: {},
        },
      }),
    ),
  ).toThrow("read profile");
});

test("missing terminals, identity forks and unapproved tool profiles cannot claim completion", () => {
  const parser = parserForTest();
  parser.line(init);
  expect(
    parser.finish({ exitCode: 0, timedOut: false, stopped: false }).phase,
  ).toBe("unknown");
  expect(() =>
    parser.line(
      packet({
        type: "system",
        subtype: "init",
        session_id: "da2d2c0d-59af-47cf-8e1f-6576f63c3152",
        tools: [],
      }),
    ),
  ).toThrow("resume");
  expect(() =>
    parserForTest().line(
      packet({ type: "system", subtype: "init", tools: ["Bash"] }),
    ),
  ).toThrow("read profile");
  expect(() =>
    parserForTest().line(
      packet({
        type: "system",
        subtype: "init",
        session_id: "../credential-file",
        tools: [],
      }),
    ),
  ).toThrow("resume");
});

test("a synthetic sign-in error remains a confirmed failure without exposing synthetic assistant content", () => {
  const parser = parserForTest();
  parser.line(packet({ type: "system", subtype: "init", tools: [] }));
  const synthetic = parser.line(
    packet({
      type: "assistant",
      message: {
        id: null,
        model: "<synthetic>",
        content: [{ type: "text", text: "SYNTHETIC_PRIVATE_CONTENT" }],
      },
    }),
  );
  expect(textOf(synthetic)).toBe("");
  parser.line(
    packet({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "Sign-in required",
    }),
  );
  expect(
    parser.finish({ exitCode: 1, timedOut: false, stopped: false }),
  ).toEqual({ phase: "failed", reason: "Sign-in required" });
});
