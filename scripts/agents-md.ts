#!/usr/bin/env bun

import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "fs";
import { join, relative } from "path";

type Mode = "validate" | "scaffold";

interface ParseArgsResult {
  mode: Mode;
  write: boolean;
  hook: boolean;
}

interface AgentsCheckResult {
  root: string;
  scannedDirs: string[];
  missingAgents: string[];
}

const IGNORED_DIRS = new Set([
  ".beads",
  ".claude-cache",
  ".dolt",
  ".git",
  ".tmp",
  "node_modules",
  "repos",
  "trees",
]);

function parseArgs(argv: string[]): ParseArgsResult {
  let mode: Mode = "validate";
  let write = false;
  let hook = false;
  for (const arg of argv) {
    if (arg === "validate" || arg === "scaffold") mode = arg;
    if (arg === "--write") write = true;
    if (arg === "--hook") hook = true;
  }
  return { mode, write, hook };
}

function shouldIgnoreDir(name: string): boolean {
  if (name.startsWith(".")) return true;
  return IGNORED_DIRS.has(name);
}

function listDirsUpToDepth(root: string, maxDepth: number): string[] {
  const out: string[] = [root];
  const stack: Array<{ path: string; depth: number }> = [
    { path: root, depth: 0 },
  ];
  while (stack.length > 0) {
    const next = stack.pop();
    if (!next) break;
    if (next.depth >= maxDepth) continue;
    const entries = readdirSync(next.path, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (shouldIgnoreDir(entry.name)) continue;
      const child = join(next.path, entry.name);
      out.push(child);
      stack.push({ path: child, depth: next.depth + 1 });
    }
  }
  return out;
}

function checkAgentsMd(root: string): AgentsCheckResult {
  const scannedDirs = listDirsUpToDepth(root, 2);
  const missingAgents = scannedDirs.filter(
    (dir) => !existsSync(join(dir, "AGENTS.md")),
  );
  return { root, scannedDirs, missingAgents };
}

function scaffoldText(forDir: string): string {
  const dirname = relative(process.cwd(), forDir) || ".";
  return `# AGENTS.md — ${dirname}

Local agent guidance for this directory.

## Scope

- Applies to this directory and descendants unless a deeper \`AGENTS.md\` overrides it.
- Parent guidance still applies unless this file states a stricter override.

## Local Rules

- Keep edits focused on files within this subtree.
- Follow repository-level quality gates before shipping.

## Notes

- Add directory-specific conventions here (build/test commands, ownership, constraints).
`;
}

function scaffoldMissing(result: AgentsCheckResult, write: boolean): string[] {
  if (!write) return result.missingAgents;
  const created: string[] = [];
  for (const dir of result.missingAgents) {
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "AGENTS.md");
    writeFileSync(target, scaffoldText(dir));
    created.push(target);
  }
  return created;
}

function emitJson(ok: boolean, data: unknown, error: string | null): void {
  console.log(JSON.stringify({ ok, data, error }, null, 2));
}

function main(argv: string[]): number {
  const args = parseArgs(argv);
  const root = process.cwd();
  const result = checkAgentsMd(root);

  if (args.mode === "validate") {
    const payload = {
      root,
      scannedDirCount: result.scannedDirs.length,
      missingCount: result.missingAgents.length,
      missingDirs: result.missingAgents.map((d) => relative(root, d) || "."),
    };
    if (args.hook) {
      if (result.missingAgents.length > 0) {
        console.log(
          `[agents-md] Missing ${result.missingAgents.length} AGENTS.md file(s). Run: bun run agents-md scaffold --write`,
        );
      } else {
        console.log("[agents-md] AGENTS.md coverage valid (depth <= 2).");
      }
    }
    emitJson(true, payload, null);
    return 0;
  }

  const created = scaffoldMissing(result, args.write);
  emitJson(
    true,
    {
      root,
      write: args.write,
      createdCount: created.length,
      createdFiles: created.map((p) => relative(root, p)),
      pendingCount: args.write ? 0 : result.missingAgents.length,
      pendingDirs: args.write
        ? []
        : result.missingAgents.map((d) => relative(root, d) || "."),
    },
    null,
  );
  return 0;
}

export {
  checkAgentsMd,
  listDirsUpToDepth,
  main,
  parseArgs,
  scaffoldMissing,
  scaffoldText,
  shouldIgnoreDir,
};

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
