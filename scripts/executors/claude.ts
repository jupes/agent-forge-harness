/**
 * Claude Code adapter: `claude -p --output-format stream-json`, prompt on stdin.
 *
 * Headless permissions follow decision #6: `acceptEdits` plus an allowlist of
 * project scripts. `--dangerously-skip-permissions` is never used.
 *
 * The stream shape (`assistant` messages carrying `tool_use` content blocks)
 * is the documented stream-json format; the flags were not run against a real
 * CLI here (none installed) — see the follow-up that verifies both providers.
 */

import { createCliAdapter, type ParsedTool } from "./cli-adapter";

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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseClaudeLine(line: string): ParsedTool[] {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isRecord(value) || value.type !== "assistant") return [];
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
