#!/usr/bin/env bun
/**
 * session.ts
 *
 * Triggered on SessionStart / SessionEnd (when wired in settings).
 * Logs session metadata; syncs Beads via `bd dolt pull` / `bd dolt push` per CLAUDE.md (not removed `bd sync`).
 */

import { execSync } from "child_process";
import { appendFileSync, existsSync } from "fs";
import { join } from "path";
import { getSessionLogPath } from "./utils/constants";

const SESSION_HANDOFF_PATH = join(
  process.cwd(),
  ".tmp",
  "work",
  "session-handoff.md",
);

function run(cmd: string): string {
  try {
    return execSync(cmd, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    }).trim();
  } catch {
    return "";
  }
}

const event = process.env["CLAUDE_HOOK_EVENT"] ?? "SessionStart";

const logEntry = {
  event,
  timestamp: new Date().toISOString(),
  git: {
    branch: run("git branch --show-current"),
    commit: run("git rev-parse --short HEAD"),
    status: run("git status --short"),
    remote: run("git remote get-url origin"),
  },
  cwd: process.cwd(),
};

// Append to session log
try {
  appendFileSync(getSessionLogPath(), JSON.stringify(logEntry) + "\n");
} catch {
  // Non-fatal
}

// Beads / Dolt: pull at session start, push at session end (non-fatal if no remote or auth)
if (event === "SessionStart") {
  const pullOut = run("bd dolt pull 2>&1");
  if (pullOut) {
    console.log(`[session] bd dolt pull: ${pullOut.slice(0, 200)}`);
  }
} else if (event === "SessionEnd") {
  const pushOut = run("bd dolt push 2>&1");
  if (pushOut) {
    console.log(`[session] bd dolt push: ${pushOut.slice(0, 200)}`);
  }
}

if (event === "SessionStart") {
  if (existsSync(SESSION_HANDOFF_PATH)) {
    console.log(
      `\n[session] Continuity: read ${SESSION_HANDOFF_PATH} (see .claude/protocols/session-handoff.md) before editing code.\n`,
    );
  }
  // Print orientation info
  const ready = run("bd ready 2>/dev/null | head -5");
  if (ready) {
    console.log("\n[session] Ready work:\n" + ready);
  }
  console.log(
    `\n[session] Branch: ${logEntry.git.branch} @ ${logEntry.git.commit}`,
  );
  if (logEntry.git.status) {
    console.log(`[session] Uncommitted: ${logEntry.git.status}`);
  }
}

console.log(`[session] ${event} logged.`);
process.exit(0);
