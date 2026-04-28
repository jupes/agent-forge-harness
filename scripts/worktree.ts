#!/usr/bin/env bun
/**
 * worktree.ts — Git worktree management for parallel epic workers
 *
 * Usage:
 *   bun run worktree create <branch-name>
 *   bun run worktree cleanup <worktree-id>
 *   bun run worktree list
 *   bun run worktree cleanup-all
 *
 * All commands emit JSON output.
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const TREES_DIR = join(process.cwd(), "trees");
const STATE_FILE = join(TREES_DIR, ".state.json");

interface WorktreeRecord {
  id: string;
  path: string;
  branch: string;
  createdAt: string;
}

interface WorktreeState {
  worktrees: WorktreeRecord[];
}

function run(cmd: string, cwd?: string): { ok: boolean; output: string } {
  try {
    const out = execSync(cmd, {
      cwd: cwd ?? process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    return { ok: true, output: out.trim() };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string };
    return {
      ok: false,
      output: ((err.stdout ?? "") + (err.stderr ?? "")).trim(),
    };
  }
}

function loadState(): WorktreeState {
  mkdirSync(TREES_DIR, { recursive: true });
  if (!existsSync(STATE_FILE)) return { worktrees: [] };
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as WorktreeState;
  } catch {
    return { worktrees: [] };
  }
}

function saveState(state: WorktreeState): void {
  mkdirSync(TREES_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function randomId(): string {
  return Math.random().toString(16).slice(2, 8);
}

const [, , command, ...rest] = process.argv;

if (command === "create") {
  const branch = rest[0];
  if (!branch) {
    console.log(
      JSON.stringify({
        ok: false,
        error: "Usage: worktree create <branch-name>",
      }),
    );
    process.exit(1);
  }

  const id = randomId();
  const worktreePath = join(TREES_DIR, id);

  // Create the branch and worktree
  const r = run(`git worktree add -b ${branch} ${worktreePath}`);
  if (!r.ok) {
    console.log(JSON.stringify({ ok: false, error: r.output }));
    process.exit(1);
  }

  const record: WorktreeRecord = {
    id,
    path: worktreePath,
    branch,
    createdAt: new Date().toISOString(),
  };

  const state = loadState();
  state.worktrees.push(record);
  saveState(state);

  console.log(JSON.stringify({ ok: true, worktree: record }));
} else if (command === "cleanup") {
  const id = rest[0];
  if (!id) {
    console.log(
      JSON.stringify({ ok: false, error: "Usage: worktree cleanup <id>" }),
    );
    process.exit(1);
  }

  const state = loadState();
  const record = state.worktrees.find((w) => w.id === id);
  if (!record) {
    console.log(
      JSON.stringify({ ok: false, error: `Worktree ${id} not found in state` }),
    );
    process.exit(1);
  }

  const r = run(`git worktree remove --force ${record.path}`);
  state.worktrees = state.worktrees.filter((w) => w.id !== id);
  saveState(state);

  console.log(
    JSON.stringify({
      ok: r.ok,
      removed: record,
      error: r.ok ? null : r.output,
    }),
  );
} else if (command === "list") {
  const state = loadState();
  console.log(JSON.stringify({ ok: true, worktrees: state.worktrees }));
} else if (command === "cleanup-all") {
  const state = loadState();
  const results = [];
  for (const record of state.worktrees) {
    const r = run(`git worktree remove --force ${record.path}`);
    results.push({ id: record.id, ok: r.ok });
  }
  saveState({ worktrees: [] });
  console.log(JSON.stringify({ ok: true, removed: results }));
} else {
  console.log(
    JSON.stringify({
      ok: false,
      error: `Unknown command: ${command ?? "(none)"}`,
      usage: "worktree <create|cleanup|list|cleanup-all> [args]",
    }),
  );
  process.exit(1);
}
