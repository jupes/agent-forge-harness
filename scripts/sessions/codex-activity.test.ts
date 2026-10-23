import { expect, test } from "bun:test";
import { eventSchema } from "../conversations/protocol";
import {
  createActivityBudget,
  SESSION_ACTIVITY_LIMITS,
} from "./activity-protocol";
import { codexActivity } from "./codex-activity";

const base = { version: "0.163.0", source: "codex.item.completed" } as const;
test("documented exec items retain only explicitly reported command, files, plan and inert MCP results", () => {
  const command = codexActivity({
    ...base,
    item: {
      id: "cmd",
      type: "command_execution",
      command: "git diff",
      aggregated_output: "private output",
      status: "completed",
      exit_code: 0,
    },
  });
  expect(command?.activity).toEqual({
    kind: "command",
    command: { text: "git diff", truncated: false },
    output: { text: "private output", truncated: false },
    state: "completed",
    exitCode: 0,
  });
  const files = codexActivity({
    ...base,
    item: {
      id: "files",
      type: "file_change",
      status: "completed",
      changes: [
        {
          path: "src/private.ts",
          kind: "update",
          diff: "not an exec field",
          additions: 42,
        },
      ],
    },
  });
  expect(files?.activity).toEqual({
    kind: "files",
    state: "completed",
    changes: [{ path: "src/private.ts", operation: "update" }],
    truncated: false,
  });
  const tool = codexActivity({
    ...base,
    item: {
      id: "tool",
      type: "mcp_tool_call",
      server: "repo",
      tool: "read",
      arguments: { path: "private" },
      status: "completed",
      result: {
        content: [{ type: "text", text: "private body" }],
        structured_content: { approved: true },
      },
    },
  });
  expect(JSON.stringify(tool)).toContain("private body");
  expect(eventSchema.safeParse(tool).success).toBe(false);
  const plan = codexActivity({
    ...base,
    item: {
      id: "plan",
      type: "todo_list",
      items: [
        { text: "Review the change", completed: false },
        { text: "Read files", completed: true },
      ],
    },
  });
  expect(plan?.activity).toMatchObject({
    kind: "plan",
    steps: [{ state: "incomplete" }, { state: "completed" }],
    truncated: false,
  });
  expect(
    codexActivity({
      ...base,
      item: {
        id: "reply",
        type: "agent_message",
        text: '{"looks":"structured"}',
      },
    }),
  ).toBe(null);
});
test("only a provider-supplied reasoning summary is retained and malformed native item shapes fail closed", () => {
  expect(
    codexActivity({
      ...base,
      item: {
        id: "r",
        type: "reasoning",
        text: "Reported summary",
        encrypted_content: "never retain",
      },
    })?.activity,
  ).toEqual({
    kind: "reasoning",
    content: { text: "Reported summary", truncated: false },
    redacted: false,
  });
  for (const item of [
    {
      id: "cmd",
      type: "command_execution",
      command: "echo",
      aggregated_output: "",
      status: "completed",
      exit_code: "0",
    },
    {
      id: "mcp",
      type: "mcp_tool_call",
      server: "s",
      tool: "t",
      status: "completed",
    },
    {
      id: "plan",
      type: "todo_list",
      items: [{ text: "x", completed: "true" }],
    },
  ])
    expect(() => codexActivity({ ...base, item })).toThrow("protocol");
});
test("per-item truncation is explicit and aggregate overflow cannot silently confirm a full activity transcript", () => {
  const event = codexActivity({
    ...base,
    item: {
      id: "r",
      type: "reasoning",
      text: "a".repeat(SESSION_ACTIVITY_LIMITS.textBytes + 1),
    },
  });
  expect(event?.activity).toMatchObject({
    kind: "reasoning",
    content: { truncated: true },
  });
  if (!event) throw Error("Expected an activity event");
  const budget = createActivityBudget();
  let accepted = 0;
  expect(() => {
    for (; accepted < 200; accepted++) budget(event);
  }).toThrow("bounded turn limit");
  expect(accepted).toBeGreaterThan(100);
  expect(accepted).toBeLessThan(200);
});
