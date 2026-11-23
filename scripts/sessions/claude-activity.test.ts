import { expect, test } from "bun:test";
import { eventSchema } from "../conversations/protocol";
import {
  codingActivitySchema,
  SESSION_ACTIVITY_LIMITS,
} from "./activity-protocol";
import {
  claudeBlockActivity,
  claudeResultReports,
  claudeToolResultActivity,
} from "./claude-activity";

const version = "2.1.296";

test("typed result permission denials retain distinct native ids as bounded historical data without approval authority", () => {
  const denial = {
    tool_name: "Bash",
    tool_use_id: "denial-one",
    tool_input: { command: "<script>inert</script>" },
  };
  const events = claudeResultReports({
    version,
    value: {
      type: "result",
      permission_denials: [denial, { ...denial, tool_use_id: "denial-two" }],
    },
  });
  expect(events).toMatchObject([
    {
      kind: "coding-activity",
      provider: "claude",
      version,
      source: "claude.result",
      partial: false,
      activity: {
        kind: "permission-denials",
        truncated: false,
        denials: [
          {
            toolId: "denial-one",
            name: "Bash",
            input: {
              json: '{"command":"<script>inert</script>"}',
              truncated: false,
            },
          },
          { toolId: "denial-two", name: "Bash" },
        ],
      },
    },
  ]);
  expect(eventSchema.safeParse(events[0]).success).toBe(false);
  expect(
    codingActivitySchema.safeParse({
      ...events[0],
      provider: "codex",
      source: "codex.item.completed",
    }).success,
  ).toBe(false);
  const many = claudeResultReports({
    version,
    value: {
      permission_denials: Array.from(
        { length: SESSION_ACTIVITY_LIMITS.items + 1 },
        (_, index) => ({ ...denial, tool_use_id: `denial-${index}` }),
      ),
    },
  });
  const report = many[0];
  if (
    report?.kind !== "coding-activity" ||
    report.activity.kind !== "permission-denials"
  )
    throw Error("Missing historical denial report");
  expect(report.activity.denials).toHaveLength(SESSION_ACTIVITY_LIMITS.items);
  expect(report.activity.truncated).toBe(true);
  expect(() =>
    claudeResultReports({
      version,
      value: { permission_denials: [{ ...denial, tool_input: null }] },
    }),
  ).toThrow();
  expect(
    claudeResultReports({ version, value: { permission_denials: [] } }),
  ).toEqual([]);
  expect(() =>
    claudeResultReports({
      version,
      value: {
        permission_denials: [
          denial,
          { ...denial, tool_input: { command: "conflicting" } },
        ],
      },
    }),
  ).toThrow();
  const large = claudeResultReports({
    version,
    value: {
      permission_denials: [
        denial,
        {
          ...denial,
          tool_use_id: "large-one",
          tool_input: { text: "x".repeat(35_000) },
        },
        {
          ...denial,
          tool_use_id: "large-two",
          tool_input: { text: "y".repeat(35_000) },
        },
      ],
    },
  });
  expect(
    new TextEncoder().encode(JSON.stringify(large[0])).byteLength,
  ).toBeLessThanOrEqual(SESSION_ACTIVITY_LIMITS.eventBytes);
  expect(large[0]).toMatchObject({ activity: { truncated: true } });
});
test("Claude thinking, redaction and tool input stay inert private activity", () => {
  const base = {
    version,
    id: "message:0",
    source: "claude.assistant",
    partial: false,
  } as const;
  expect(
    claudeBlockActivity({
      ...base,
      block: {
        type: "thinking",
        thinking: "Visible provider reasoning",
        signature: "opaque-never-retained",
      },
    })?.activity,
  ).toEqual({
    kind: "reasoning",
    content: { text: "Visible provider reasoning", truncated: false },
    redacted: false,
  });
  const redacted = claudeBlockActivity({
    ...base,
    block: { type: "redacted_thinking", data: "encrypted-never-retained" },
  });
  expect(redacted?.activity).toEqual({
    kind: "reasoning",
    content: { text: "", truncated: false },
    redacted: true,
  });
  expect(JSON.stringify(redacted)).not.toContain("encrypted");
  const tool = claudeBlockActivity({
    ...base,
    block: {
      type: "tool_use",
      id: "t1",
      name: "Bash",
      input: { command: "echo private" },
    },
  });
  expect(tool?.activity).toMatchObject({
    kind: "tool",
    toolId: "t1",
    name: "Bash",
    state: "running",
    input: { json: '{"command":"echo private"}' },
  });
  expect(eventSchema.safeParse(tool).success).toBe(false);
});
test("only matching reported tool results provide command output, diffs and plan status", () => {
  const block = {
    type: "tool_result",
    tool_use_id: "t1",
    content: "Text given to model",
    is_error: false,
  };
  const command = claudeToolResultActivity({
    version,
    block,
    tool: { id: "t1", name: "Bash", input: { command: "echo private" } },
    structured: {
      stdout: "reported merged output",
      stderr: "tool notice",
      interrupted: false,
    },
  });
  expect(command).toMatchObject([
    { activity: { kind: "tool", state: "completed" } },
    {
      activity: {
        kind: "command",
        command: { text: "echo private" },
        output: { text: "reported merged output" },
        state: "completed",
      },
    },
  ]);
  expect(JSON.stringify(command)).not.toContain("exitCode");
  const edit = claudeToolResultActivity({
    version,
    block,
    tool: { id: "t1", name: "Edit", input: {} },
    structured: {
      filePath: "src/private.ts",
      gitDiff: {
        filename: "src/private.ts",
        status: "modified",
        patch: "-old\n+new",
        additions: 1,
        deletions: 1,
        changes: 2,
      },
    },
  });
  expect(edit).toMatchObject([
    { activity: { kind: "tool" } },
    {
      activity: {
        kind: "files",
        changes: [
          {
            path: "src/private.ts",
            operation: "update",
            diff: { text: "-old\n+new" },
            additions: 1,
            deletions: 1,
          },
        ],
      },
    },
  ]);
  const plan = claudeToolResultActivity({
    version,
    block,
    tool: { id: "t1", name: "TodoWrite", input: {} },
    structured: {
      oldTodos: [],
      newTodos: [
        { content: "Read", status: "completed", activeForm: "Reading" },
        { content: "Check", status: "in_progress", activeForm: "Checking" },
      ],
    },
  });
  expect(plan).toMatchObject([
    { activity: { kind: "tool" } },
    {
      activity: {
        kind: "plan",
        steps: [{ state: "completed" }, { state: "in-progress" }],
      },
    },
  ]);
  expect(() =>
    claudeToolResultActivity({
      version,
      block,
      tool: { id: "other", name: "Bash", input: {} },
      structured: { stdout: "must not correlate" },
    }),
  ).toThrow("protocol");
});
test("structured output is retained only when reported; token usage and cumulative estimates never become plan allowance", () => {
  expect(
    claudeResultReports({
      version,
      value: {
        type: "result",
        uuid: "r",
        result: '{"not":"structured"}',
        is_error: false,
        subtype: "success",
      },
    }),
  ).toEqual([]);
  const events = claudeResultReports({
    version,
    value: {
      type: "result",
      uuid: "r",
      structured_output: { answer: [1, 2] },
      usage: { input_tokens: 12, output_tokens: 3 },
      total_cost_usd: 0.24,
      duration_ms: 35,
    },
  });
  expect(events).toMatchObject([
    {
      kind: "coding-activity",
      source: "claude.result",
      activity: {
        kind: "structured-output",
        output: { json: '{"answer":[1,2]}', truncated: false },
      },
    },
    {
      kind: "coding-usage",
      provider: "claude",
      source: "claude.result",
      usage: { inputTokens: 12, outputTokens: 3 },
      cumulativeEstimateUsd: 0.24,
      durationMs: 35,
    },
  ]);
  expect(JSON.stringify(events)).not.toContain("reset");
  expect(() =>
    claudeResultReports({
      version,
      value: { type: "result", usage: { input_tokens: -1 } },
    }),
  ).toThrow("protocol");
});
