/**
 * Codex adapter: `codex exec --json`, prompt on stdin (`-`).
 *
 * `bun run codex:sync` runs first so `.agents/skills/` exists for the worktree
 * (inject `prepare` in tests).
 *
 * Checked against `codex` on Windows, run directly (2026-10-08): 0.159.0 and
 * 0.160.0 both accept the flags below except the `-c` that carries the
 * effort, and every recorded stream opened with
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
 *
 * The smith's effort goes in `-c model_reasoning_effort=<level>`: `-c` is the
 * inline config override `codex exec` documents, and `model_reasoning_effort`
 * the documented config key (levels such as `low`, `medium`, `high`,
 * `xhigh`, depending on the model). The value is passed bare: a `-c` value
 * that does not parse as TOML is taken as the literal string, so `medium`
 * arrives as the string `medium`, and no quote has to survive a Windows
 * command shim. It was added after those runs and has not been run against a
 * real CLI.
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

/**
 * The message of a line that reports an error: an `error` item, a top-level
 * `error`, or `turn.failed`. `codex` 0.159.0 printed all three for a rejected
 * model (exit 1); a copy missing the helper it runs tools with printed an
 * `error` item and an agent message, then `turn.completed`, and exited 0. A
 * line with no message yields its type.
 */
export function parseCodexError(line: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const said = (message: unknown, type: string) =>
    typeof message === "string" && message.trim() ? message.trim() : type;
  if (value.type === "error") return said(value.message, "error");
  if (value.type === "turn.failed") {
    return said(
      isRecord(value.error) ? value.error.message : undefined,
      "turn.failed",
    );
  }
  if (
    value.type === "item.completed" &&
    isRecord(value.item) &&
    value.item.type === "error"
  ) {
    return said(value.item.message, "error item");
  }
  return undefined;
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
      "-c",
      `model_reasoning_effort=${request.smith.effort}`,
      "--cd",
      request.worktree,
      "-",
    ],
    parseLine: parseCodexLine,
    parseError: parseCodexError,
  });
}

export const codexAdapter = createCodexAdapter();
