#!/usr/bin/env bun
/**
 * session.ts
 *
 * Triggered on SessionStart and session stop events.
 * Logs session metadata, syncs Beads data on start and stop.
 */

import { execSync } from "child_process";
import { appendFileSync, existsSync } from "fs";
import { join } from "path";
import { getSessionLogPath } from "./utils/constants.ts";

const SESSION_HANDOFF_PATH = join(process.cwd(), ".tmp", "work", "session-handoff.md");

function run(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 }).trim();
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

// Sync Beads on start and stop
const bdSync = run("bd sync 2>&1");
if (bdSync) {
  console.log(`[session] bd sync: ${bdSync.slice(0, 200)}`);
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
  console.log(`\n[session] Branch: ${logEntry.git.branch} @ ${logEntry.git.commit}`);
  if (logEntry.git.status) {
    console.log(`[session] Uncommitted: ${logEntry.git.status}`);
  }
}

console.log(`[session] ${event} logged.`);
process.exit(0);
