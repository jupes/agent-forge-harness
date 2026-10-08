#!/usr/bin/env bun
/**
 * session.ts
 *
 * Runs on SessionStart and SessionEnd. Which one comes from stdin
 * `hook_event_name`; with no stdin (a run by hand) it acts as SessionStart.
 *
 * SessionStart: records `session.started` in the ledger, leaves the session
 * mirror in the worktree, logs to `session.jsonl`, pulls Beads and prints the
 * orientation lines the session reads.
 * SessionEnd: records `session.ended` first, then pushes Beads exactly once
 * and logs how the push went. It prints nothing.
 *
 * It always exits 0: a failure here must never cost the session.
 */

import { execFileSync, execSync } from "child_process";
import { appendFileSync, existsSync } from "fs";
import { join } from "path";
import {
  handleSessionEnd,
  handleSessionStart,
  hookDeps,
} from "../../scripts/ledger/hook-events";
import { getSessionLogPath } from "./utils/constants";
import {
  type HookInput,
  isAdapterChild,
  readHookInput,
} from "./utils/hook-input";

const SESSION_HANDOFF_PATH = join(
  process.cwd(),
  ".tmp",
  "work",
  "session-handoff.md",
);

/** Leaves room inside the SessionEnd hook's own timeout (see `.claude/settings.json`). */
const PUSH_TIMEOUT_MS = 30_000;

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

function log(entry: Record<string, unknown>): void {
  try {
    appendFileSync(getSessionLogPath(), `${JSON.stringify(entry)}\n`);
  } catch {
    // Non-fatal
  }
}

function pushBeads(): { ok: boolean; ms: number } {
  const started = performance.now();
  let ok = false;
  try {
    execFileSync("bd", ["dolt", "push"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: PUSH_TIMEOUT_MS,
    });
    ok = true;
  } catch {
    // No remote, no auth, no `bd`: reported through `ok`.
  }
  return { ok, ms: Math.round(performance.now() - started) };
}

/** The ledger half of the hook. A failure is one stderr line, never an exit code. */
function ledger(event: string, input: HookInput): void {
  try {
    const deps = hookDeps({ env: process.env, cwd: process.cwd() });
    if (event === "SessionEnd")
      handleSessionEnd(input, deps, {
        push: pushBeads,
        log: (entry) => log({ ...entry, timestamp: new Date().toISOString() }),
      });
    else handleSessionStart(input, deps);
  } catch (error) {
    console.error(
      `[session] ledger: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function main(): Promise<void> {
  const input = await readHookInput();
  const event =
    input?.hook_event_name === "SessionEnd" ? "SessionEnd" : "SessionStart";
  // An adapter records its headless child's session itself.
  const attached = input !== null && !isAdapterChild();

  // The ledger first: `session.ended` must land before the push, which may be
  // cut short, and before the git calls below, which are slow.
  if (attached) ledger(event, input);

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
  log(logEntry);
  if (event === "SessionEnd") return;

  // Beads / Dolt: pull at session start (non-fatal if no remote or auth)
  const pullOut = run("bd dolt pull 2>&1");
  if (pullOut) {
    console.log(`[session] bd dolt pull: ${pullOut.slice(0, 200)}`);
  }
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
  console.log(`[session] ${event} logged.`);
}

main()
  .catch((error: unknown) => {
    console.error(
      `[session] ${error instanceof Error ? error.message : String(error)}`,
    );
  })
  .finally(() => process.exit(0));
