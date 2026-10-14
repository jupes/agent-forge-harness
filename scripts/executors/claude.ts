/**
 * Claude Code adapter: `claude -p --output-format stream-json`, prompt on stdin.
 *
 * Headless permissions follow decision #6: `acceptEdits` plus an allowlist of
 * project scripts. `--dangerously-skip-permissions` is never used.
 *
 * Checked against `claude` 2.1.293 on Windows, run directly (2026-10-08):
 * every flag below is accepted, and the stream is framed as `system` /
 * `assistant` / `result` lines, each carrying the same `session_id` (the
 * `system` / `init` line first), and the `result` line a `usage` object and
 * `total_cost_usd`. `parseClaudeLine` takes the session id and that usage
 * from those fields. That run stopped at authentication, so the shape it maps
 * to tools — an `assistant` message carrying `tool_use` content blocks, the
 * documented stream-json format — has not been observed from a real CLI, and
 * neither has a successful `result`.
 *
 * The CLI's help lists a `--session-id` flag that would fix the id up front.
 * The adapter does not pass it and takes the id the stream reports instead:
 * the flag has not been run against a real CLI.
 */

import type { ProviderUsage, ProviderUsageCount } from "../../types/hearth";
import {
  createCliAdapter,
  type ParsedLine,
  type ParsedTool,
  usageCounts,
} from "./cli-adapter";

export const CLAUDE_ALLOWED_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "Grep",
  "Glob",
  "Bash(bun run:*)",
  "Bash(bun test:*)",
  "Bash(git status:*)",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git add:*)",
  "Bash(git commit:*)",
  "Bash(bd:*)",
];

/** The token counts of a `result` line's `usage`, by the names the ledger stores them under. */
const USAGE_COUNTS: Readonly<Record<string, ProviderUsageCount>> = {
  input_tokens: "inputTokens",
  output_tokens: "outputTokens",
  cache_read_input_tokens: "cacheReadInputTokens",
  cache_creation_input_tokens: "cacheCreationInputTokens",
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The `tool_use` blocks of an assistant message. */
function toolsOf(value: Record<string, unknown>): ParsedTool[] {
  if (value.type !== "assistant") return [];
  const message = value.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  const tools: ParsedTool[] = [];
  for (const block of message.content) {
    if (
      isRecord(block) &&
      block.type === "tool_use" &&
      typeof block.name === "string"
    ) {
      tools.push({ tool: block.name, input: block.input });
    }
  }
  return tools;
}

/**
 * The run's usage, from the `result` line only: an assistant message carries
 * a `usage` of its own, which is that message's, not the run's.
 */
function usageOf(value: Record<string, unknown>): ProviderUsage | undefined {
  if (value.type !== "result") return undefined;
  const cost = value.total_cost_usd;
  const usage: ProviderUsage = {
    ...usageCounts(value.usage, USAGE_COUNTS),
    ...(typeof cost === "number" && Number.isFinite(cost) && cost >= 0
      ? { costUsd: cost }
      : {}),
  };
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/**
 * The model an assistant message's response named (`message.model`). Not the
 * `system` / `init` line's `model`, which is what was configured, and not a
 * bracketed placeholder such as the `<synthetic>` the CLI put on the message
 * it wrote itself for a failed sign-in.
 */
function modelOf(value: Record<string, unknown>): string | undefined {
  if (value.type !== "assistant" || !isRecord(value.message)) return undefined;
  const model = value.message.model;
  if (typeof model !== "string") return undefined;
  const trimmed = model.trim();
  return trimmed.length > 0 && !trimmed.startsWith("<") ? trimmed : undefined;
}

export function parseClaudeLine(line: string): ParsedLine {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { tools: [] };
  }
  if (!isRecord(value)) return { tools: [] };
  const sessionId =
    typeof value.session_id === "string" && value.session_id.length > 0
      ? value.session_id
      : undefined;
  const usage = usageOf(value);
  const model = modelOf(value);
  return {
    tools: toolsOf(value),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}

/**
 * The reason a `result` line with `is_error: true` gives: its `result` text,
 * else its `subtype`. `claude` 2.1.293 with an expired sign-in gave its reason
 * in such a line's `result`, with nothing on stderr, and exited 1.
 */
export function parseClaudeError(line: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.type !== "result" || value.is_error !== true) {
    return undefined;
  }
  for (const said of [value.result, value.subtype]) {
    if (typeof said === "string" && said.trim()) return said.trim();
  }
  return "an error result with no message";
}

export const claudeAdapter = createCliAdapter({
  provider: "claude",
  binary: "claude",
  versionArgs: ["--version"],
  buildArgs: (request) => [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    request.smith.model,
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    CLAUDE_ALLOWED_TOOLS.join(","),
  ],
  parseLine: parseClaudeLine,
  parseError: parseClaudeError,
});
