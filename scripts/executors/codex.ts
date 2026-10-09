/**
 * Codex adapter: `codex exec --json`, prompt on stdin (`-`).
 *
 * `bun run codex:sync` runs first so `.agents/skills/` exists for the worktree
 * (inject `prepare` in tests).
 *
 * Checked against `codex` 0.159.0 and 0.160.0 on Windows, run directly
 * (2026-10-08): the flags below are accepted, and a shell command arrives as
 * `item.started` then `item.completed` with `item.type: "command_execution"`
 * and a numeric `exit_code`. Only the completed item is mapped, so a command
 * is one tool call. Items other than a shell command have not been observed
 * and are not mapped.
 */

import { createCliAdapter, type ParsedTool } from "./cli-adapter";
import type { SpawnRequest } from "./types";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseCodexLine(line: string): ParsedTool[] {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isRecord(value) || value.type !== "item.completed") return [];
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
