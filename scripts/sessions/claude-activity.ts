import type {
  ClaudeCodingUsageEvent,
  CodingActivity,
  CodingActivityEvent,
} from "../../types/session-activity";
import {
  claudeCodingUsageSchema,
  codingActivitySchema,
  reportedJson,
  reportedText,
  SESSION_ACTIVITY_LIMITS,
} from "./activity-protocol";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const bad = () =>
  new Error("The Claude activity did not match the private coding protocol.");
const string = (value: unknown): string => {
  if (typeof value !== "string") throw bad();
  return value;
};
const count = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw bad();
  return value;
};
function event(
  input: {
    version: string;
    id: string;
    source:
      | "claude.assistant"
      | "claude.stream_event"
      | "claude.user"
      | "claude.result";
    partial: boolean;
  },
  activity: CodingActivity,
): CodingActivityEvent {
  return codingActivitySchema.parse({
    kind: "coding-activity",
    provider: "claude",
    ...input,
    activity,
  });
}
/** Content blocks only: signatures and opaque/redacted data are deliberately not copied. */
export function claudeBlockActivity(input: {
  version: string;
  id: string;
  source: "claude.assistant" | "claude.stream_event";
  partial: boolean;
  block: Record<string, unknown>;
}): CodingActivityEvent | null {
  const { block, ...base } = input;
  if (block.type === "thinking")
    return event(base, {
      kind: "reasoning",
      content: reportedText(string(block.thinking)),
      redacted: false,
    });
  if (block.type === "redacted_thinking")
    return event(base, {
      kind: "reasoning",
      content: reportedText(""),
      redacted: true,
    });
  if (block.type === "tool_use") {
    if (!Object.hasOwn(block, "input")) throw bad();
    return event(
      { ...base, id: string(block.id) },
      {
        kind: "tool",
        toolId: string(block.id),
        name: string(block.name),
        state: "running",
        input: reportedJson(block.input),
      },
    );
  }
  return null;
}
export interface ClaudeReportedTool {
  id: string;
  name: string;
  input: unknown;
}
/** SDKUserMessage.tool_use_result is interpreted only through its matching reported tool name. */
export function claudeToolResultActivity(input: {
  version: string;
  block: Record<string, unknown>;
  tool: ClaudeReportedTool;
  structured?: unknown;
}): CodingActivityEvent[] {
  const { block, tool, structured } = input;
  if (
    block.type !== "tool_result" ||
    block.tool_use_id !== tool.id ||
    (block.is_error !== undefined && typeof block.is_error !== "boolean")
  )
    throw bad();
  const state = block.is_error === true ? "failed" : "completed";
  const background =
    record(structured) &&
    (structured.detachedToolCall === true ||
      typeof structured.backgroundTaskId === "string");
  const base = {
    version: input.version,
    id: tool.id,
    source: "claude.user",
    partial: background,
  } as const;
  const output = {
    content: block.content ?? null,
    ...(structured === undefined ? {} : { structured }),
  };
  const reports = [
    event(base, {
      kind: "tool",
      toolId: tool.id,
      name: tool.name,
      state: background ? "running" : state,
      output: reportedJson(output),
    }),
  ];
  if (
    tool.name === "Bash" &&
    record(tool.input) &&
    typeof tool.input.command === "string" &&
    record(structured) &&
    typeof structured.stdout === "string"
  ) {
    reports.push(
      event(
        { ...base, id: `${tool.id}:command` },
        {
          kind: "command",
          command: reportedText(tool.input.command),
          output: reportedText(structured.stdout),
          state: background ? "running" : state,
        },
      ),
    );
  }
  if (
    (tool.name === "Edit" || tool.name === "Write") &&
    record(structured) &&
    block.is_error !== true
  ) {
    const diff = structured.gitDiff;
    if (record(diff)) {
      if (!["modified", "added"].includes(string(diff.status))) throw bad();
      reports.push(
        event(
          { ...base, id: `${tool.id}:files` },
          {
            kind: "files",
            state,
            changes: [
              {
                path: string(diff.filename),
                operation: diff.status === "added" ? "add" : "update",
                diff: reportedText(string(diff.patch)),
                additions: count(diff.additions),
                deletions: count(diff.deletions),
              },
            ],
            truncated: false,
          },
        ),
      );
    } else if (typeof structured.filePath === "string") {
      reports.push(
        event(
          { ...base, id: `${tool.id}:files` },
          {
            kind: "files",
            state,
            changes: [
              {
                path: structured.filePath,
                operation:
                  tool.name === "Write" && structured.type === "create"
                    ? "add"
                    : "update",
              },
            ],
            truncated: false,
          },
        ),
      );
    }
  }
  if (
    tool.name === "TodoWrite" &&
    record(structured) &&
    Array.isArray(structured.newTodos) &&
    block.is_error !== true
  ) {
    const steps = structured.newTodos.map((step) => {
      if (
        !record(step) ||
        !["pending", "in_progress", "completed"].includes(string(step.status))
      )
        throw bad();
      return {
        content: reportedText(string(step.content)),
        state:
          step.status === "pending"
            ? "incomplete"
            : step.status === "in_progress"
              ? "in-progress"
              : "completed",
      };
    });
    reports.push(
      codingActivitySchema.parse({
        kind: "coding-activity",
        provider: "claude",
        ...base,
        id: `${tool.id}:plan`,
        activity: {
          kind: "plan",
          steps: steps.slice(0, SESSION_ACTIVITY_LIMITS.items),
          truncated: steps.length > SESSION_ACTIVITY_LIMITS.items,
        },
      }),
    );
  }
  return reports;
}
export function claudeResultReports(input: {
  version: string;
  value: Record<string, unknown>;
}): (CodingActivityEvent | ClaudeCodingUsageEvent)[] {
  const value = input.value,
    reports: (CodingActivityEvent | ClaudeCodingUsageEvent)[] = [];
  if (Object.hasOwn(value, "permission_denials")) {
    if (!Array.isArray(value.permission_denials)) throw bad();
    const ids = new Set<string>();
    const denials = value.permission_denials.map((denial) => {
      if (!record(denial) || !record(denial.tool_input)) throw bad();
      const toolId = string(denial.tool_use_id),
        name = string(denial.tool_name);
      if (
        [toolId, name].some(
          (value) => !value || value.length > 200 || value.includes("\0"),
        )
      )
        throw bad();
      if (ids.has(toolId)) throw bad();
      ids.add(toolId);
      return { toolId, name, input: reportedJson(denial.tool_input) };
    });
    if (denials.length) {
      const base = {
        version: input.version,
        id: typeof value.uuid === "string" ? value.uuid : "result",
        source: "claude.result",
        partial: false,
      } as const;
      const activity: Extract<CodingActivity, { kind: "permission-denials" }> =
        {
          kind: "permission-denials",
          denials: denials.slice(0, SESSION_ACTIVITY_LIMITS.items),
          truncated: denials.length > SESSION_ACTIVITY_LIMITS.items,
        };
      while (
        activity.denials.length &&
        new TextEncoder().encode(
          JSON.stringify({
            kind: "coding-activity",
            provider: "claude",
            ...base,
            activity,
          }),
        ).byteLength > SESSION_ACTIVITY_LIMITS.eventBytes
      ) {
        activity.denials.pop();
        activity.truncated = true;
      }
      reports.push(event(base, activity));
    }
  }
  if (Object.hasOwn(value, "structured_output"))
    reports.push(
      event(
        {
          version: input.version,
          id: typeof value.uuid === "string" ? value.uuid : "result",
          source: "claude.result",
          partial: value.is_error === true,
        },
        {
          kind: "structured-output",
          output: reportedJson(value.structured_output),
        },
      ),
    );
  const usage: ClaudeCodingUsageEvent["usage"] = {};
  if (value.usage !== undefined) {
    if (!record(value.usage)) throw bad();
    for (const [wire, field] of [
      ["input_tokens", "inputTokens"],
      ["output_tokens", "outputTokens"],
      ["cache_read_input_tokens", "cacheReadInputTokens"],
      ["cache_creation_input_tokens", "cacheCreationInputTokens"],
    ] as const) {
      if (value.usage[wire] !== undefined)
        usage[field] = count(value.usage[wire]);
    }
  }
  if (
    Object.keys(usage).length ||
    value.total_cost_usd !== undefined ||
    value.duration_ms !== undefined
  ) {
    const parsed = claudeCodingUsageSchema.safeParse({
      kind: "coding-usage",
      provider: "claude",
      source: "claude.result",
      version: input.version,
      usage,
      ...(value.total_cost_usd === undefined
        ? {}
        : { cumulativeEstimateUsd: value.total_cost_usd }),
      ...(value.duration_ms === undefined
        ? {}
        : { durationMs: value.duration_ms }),
    });
    if (!parsed.success) throw bad();
    reports.push(parsed.data);
  }
  return reports;
}
