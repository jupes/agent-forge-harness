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
 * The CLI also accepts `--session-id` to fix the id up front; the adapter
 * does not pass it, and takes the id the stream reports instead: that flag
 * has not been run against a real CLI.
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
  return {
    tools: toolsOf(value),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(usage !== undefined ? { usage } : {}),
  };
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
});
