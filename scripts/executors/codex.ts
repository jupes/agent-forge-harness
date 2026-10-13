/**
 * Codex adapter: `codex exec --json`, prompt on stdin (`-`).
 *
 * `bun run codex:sync` runs first so `.agents/skills/` exists for the worktree
 * (inject `prepare` in tests).
 *
 * Checked against `codex` on Windows, run directly (2026-10-08): 0.159.0 and
 * 0.160.0 both accept the flags below, and every recorded stream opened with
 * `thread.started` carrying a `thread_id`, the session id `parseCodexLine`
 * takes. On 0.160.0 — the only version that got as far as a command — one
 * shell command arrived as `item.started` then `item.completed` with
 * `item.type: "command_execution"` and a numeric `exit_code`. Only the
 * completed item is mapped, so a command is one tool call. The other items
 * recorded were `agent_message` and `error`, neither a tool; items for file
 * edits, MCP calls or web searches have not been observed and are not mapped.
 * A turn that finished ended with `turn.completed` and a `usage` object of five
 * token counts (0.159.0 and 0.160.0), which is the usage taken. One run
 * through `forge:exec` on 0.160.0 (2026-10-09) left `session.started`, a
 * `tool.called` for the shell command and `session.ended` in the ledger; that
 * was before the adapter read the thread id or the usage.
 */

import type { ProviderUsage, ProviderUsageCount } from "../../types/hearth";
import {
  createCliAdapter,
  type ParsedLine,
  type ParsedTool,
  usageCounts,
} from "./cli-adapter";
import type { SpawnRequest } from "./types";

/** The token counts of `turn.completed`'s `usage`, by the names the ledger stores them under. */
const USAGE_COUNTS: Readonly<Record<string, ProviderUsageCount>> = {
  input_tokens: "inputTokens",
  output_tokens: "outputTokens",
  cached_input_tokens: "cachedInputTokens",
  cache_write_input_tokens: "cacheWriteInputTokens",
  reasoning_output_tokens: "reasoningOutputTokens",
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A completed shell command is one tool call; no other item is mapped. */
function toolsOf(value: Record<string, unknown>): ParsedTool[] {
  if (value.type !== "item.completed") return [];
  const item = value.item;
  if (!isRecord(item) || item.type !== "command_execution") return [];
  return [
    {
      tool: "shell",
      input: item.command,
      ...(typeof item.exit_code === "number"
        ? { exitCode: item.exit_code }
        : {}),
    },
  ];
}

export function parseCodexLine(line: string): ParsedLine {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { tools: [] };
  }
  if (!isRecord(value)) return { tools: [] };
  // The stream's first line, `thread.started`, names the thread.
  const sessionId =
    value.type === "thread.started" &&
    typeof value.thread_id === "string" &&
    value.thread_id.length > 0
      ? value.thread_id
      : undefined;
  const usage: ProviderUsage | undefined =
    value.type === "turn.completed"
      ? usageCounts(value.usage, USAGE_COUNTS)
      : undefined;
  return {
    tools: toolsOf(value),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(usage !== undefined ? { usage } : {}),
  };
}

function syncSkills(request: SpawnRequest): void {
  const result = Bun.spawnSync(["bun", "run", "codex:sync"], {
    cwd: request.workspace,
    stdout: "ignore",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `codex:sync failed (exit ${result.exitCode}) in ${request.workspace}`,
    );
  }
}

export interface CodexOptions {
  /** Runs before each spawn; the default mirrors skills with `codex:sync` in the workspace. */
  prepare?: (request: SpawnRequest) => Promise<void> | void;
}

export function createCodexAdapter(options: CodexOptions = {}) {
  return createCliAdapter({
    provider: "codex",
    binary: "codex",
    versionArgs: ["--version"],
    prepare: options.prepare ?? syncSkills,
    buildArgs: (request) => [
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--model",
      request.smith.model,
      "--cd",
      request.worktree,
      "-",
    ],
    parseLine: parseCodexLine,
  });
}

export const codexAdapter = createCodexAdapter();
