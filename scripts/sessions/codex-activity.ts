import type {
  CodingActivity,
  CodingActivityEvent,
} from "../../types/session-activity";
import {
  codingActivitySchema,
  reportedJson,
  reportedText,
  SESSION_ACTIVITY_LIMITS,
} from "./activity-protocol";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const bad = () =>
  new Error("The Codex activity item did not match the private Task protocol.");
const string = (value: unknown): string => {
  if (typeof value !== "string") throw bad();
  return value;
};
function state(value: unknown) {
  if (value === "in_progress") return "running";
  if (value === "completed" || value === "failed") return value;
  throw bad();
}

/** Exact exec item fields from openai/codex rust-v0.163.0 SDK items.ts, not app-server messages. */
export function codexActivity(input: {
  version: string;
  source: "codex.item.started" | "codex.item.updated" | "codex.item.completed";
  item: Record<string, unknown>;
}): CodingActivityEvent | null {
  const item = input.item,
    partial = input.source !== "codex.item.completed";
  let activity: CodingActivity;
  switch (item.type) {
    case "reasoning":
      activity = {
        kind: "reasoning",
        content: reportedText(string(item.text)),
        redacted: false,
      };
      break;
    case "command_execution": {
      const status = state(item.status);
      if (!partial && status === "running") throw bad();
      if (
        item.exit_code !== undefined &&
        (typeof item.exit_code !== "number" ||
          !Number.isInteger(item.exit_code))
      )
        throw bad();
      activity = {
        kind: "command",
        command: reportedText(string(item.command)),
        output: reportedText(string(item.aggregated_output)),
        state: status,
        ...(item.exit_code === undefined ? {} : { exitCode: item.exit_code }),
      };
      break;
    }
    case "file_change": {
      if (
        !Array.isArray(item.changes) ||
        !["completed", "failed"].includes(string(item.status))
      )
        throw bad();
      const changes = item.changes.map((change) => {
        if (
          !record(change) ||
          typeof change.path !== "string" ||
          !["add", "delete", "update"].includes(string(change.kind))
        )
          throw bad();
        return { path: change.path, operation: change.kind };
      });
      return codingActivitySchema.parse({
        kind: "coding-activity",
        provider: "codex",
        version: input.version,
        id: string(item.id),
        source: input.source,
        partial,
        activity: {
          kind: "files",
          state: item.status,
          changes: changes.slice(0, SESSION_ACTIVITY_LIMITS.items),
          truncated: changes.length > SESSION_ACTIVITY_LIMITS.items,
        },
      });
    }
    case "mcp_tool_call": {
      const status = state(item.status);
      if (!partial && status === "running") throw bad();
      if (!Object.hasOwn(item, "arguments")) throw bad();
      if (
        item.result !== undefined &&
        (!record(item.result) || !Array.isArray(item.result.content))
      )
        throw bad();
      if (
        item.error !== undefined &&
        (!record(item.error) || typeof item.error.message !== "string")
      )
        throw bad();
      activity = {
        kind: "tool",
        toolId: string(item.id),
        name: `${string(item.server)}.${string(item.tool)}`,
        state: status,
        input: reportedJson(item.arguments),
        ...(item.result === undefined
          ? {}
          : { output: reportedJson(item.result) }),
        ...(item.error === undefined
          ? {}
          : { error: reportedText(string(item.error.message)) }),
      };
      break;
    }
    case "web_search":
      activity = {
        kind: "tool",
        toolId: string(item.id),
        name: "web_search",
        state: partial ? "running" : "completed",
        input: reportedJson({ query: string(item.query) }),
      };
      break;
    case "todo_list": {
      if (!Array.isArray(item.items)) throw bad();
      const steps = item.items.map((step) => {
        if (
          !record(step) ||
          typeof step.text !== "string" ||
          typeof step.completed !== "boolean"
        )
          throw bad();
        return {
          content: reportedText(step.text),
          state: step.completed ? "completed" : "incomplete",
        };
      });
      return codingActivitySchema.parse({
        kind: "coding-activity",
        provider: "codex",
        version: input.version,
        id: string(item.id),
        source: input.source,
        partial,
        activity: {
          kind: "plan",
          steps: steps.slice(0, SESSION_ACTIVITY_LIMITS.items),
          truncated: steps.length > SESSION_ACTIVITY_LIMITS.items,
        },
      });
    }
    default:
      return null;
  }
  return codingActivitySchema.parse({
    kind: "coding-activity",
    provider: "codex",
    version: input.version,
    id: string(item.id),
    source: input.source,
    partial,
    activity,
  });
}
