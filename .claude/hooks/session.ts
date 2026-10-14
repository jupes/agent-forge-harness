#!/usr/bin/env bun
/**
 * session.ts
 *
 * Runs on SessionStart and SessionEnd. Which one comes from stdin
 * `hook_event_name`; when stdin does not say (missing, late or unreadable),
 * from a `SessionStart` / `SessionEnd` token on the command line; with
 * neither (a run by hand) it acts as SessionStart.
 *
 * SessionStart: records `session.started` in the ledger (and says why on
 * stdout when the ledger refuses it), leaves the session mirror in the
 * worktree, logs to `session.jsonl`, pulls Beads and prints the orientation
 * lines the session reads.
 * SessionEnd: records `session.ended` first, then logs to `session.jsonl`. It
 * prints nothing and runs no `bd` command. Without a payload there is no
 * session id, so nothing is recorded in the ledger; the log line is still
 * written.
 *
 * Neither path pushes the tracker: it is local-only, and the only `bd`
 * commands here are the pull and the ready list of a session start.
 *
 * It always exits 0: a failure here must never cost the session.
 */

import { spawnSync } from "child_process";
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
  type SessionHookEvent,
  sessionEventOf,
} from "./utils/hook-input";

const SESSION_HANDOFF_PATH = join(
  process.cwd(),
  ".tmp",
  "work",
  "session-handoff.md",
);

/**
 * Run a program with an argument array and no shell: its trimmed stdout, then
 * its stderr when `withStderr` is set; "" when it cannot start or exits
 * nonzero. No shell, because on Windows a command line goes through cmd.exe,
 * where a POSIX redirect or `head` fails before the program runs
 * (agent-forge-harness-o89v).
 */
function run(
  file: string,
  args: readonly string[],
  withStderr = false,
): string {
  const result = spawnSync(file, [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  if (result.error !== undefined || result.status !== 0) return "";
  const stdout = result.stdout ?? "";
  return (withStderr ? stdout + (result.stderr ?? "") : stdout).trim();
}

/** The first `count` lines of a program's output. */
function firstLines(text: string, count: number): string {
  return text.split(/\r?\n/).slice(0, count).join("\n");
}

function log(entry: Record<string, unknown>): void {
  try {
    appendFileSync(getSessionLogPath(), `${JSON.stringify(entry)}\n`);
  } catch {
    // Non-fatal
  }
}

/**
 * The ledger half of the hook. A failure is one stderr line, never an exit
 * code. A start the ledger refused is also one stdout line, which the session
 * reads: the hooks after it record in the background, and the session does
 * not see their refusals.
 */
function ledger(event: SessionHookEvent, input: HookInput): void {
  try {
    const deps = hookDeps({ env: process.env, cwd: process.cwd() });
    if (event === "SessionEnd") {
      handleSessionEnd(input, deps);
      return;
    }
    const started = handleSessionStart(input, deps);
    if (started !== null && !started.ok)
      console.log(
        `[session] ledger: session.started was not recorded: ${started.error}`,
      );
  } catch (error) {
    console.error(
      `[session] ledger: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function main(): Promise<void> {
  const input = await readHookInput();
  const { event, source } = sessionEventOf(input, process.argv.slice(2));

  // The ledger first: `session.ended` must land before the git calls below,
  // which are slow and may be cut short. An adapter records its headless
  // child's session itself, and without a payload there is no session to record.
  if (input !== null && !isAdapterChild()) ledger(event, input);

  const logEntry = {
    event,
    eventSource: source,
    timestamp: new Date().toISOString(),
    git: {
      branch: run("git", ["branch", "--show-current"]),
      commit: run("git", ["rev-parse", "--short", "HEAD"]),
      status: run("git", ["status", "--short"]),
      remote: run("git", ["remote", "get-url", "origin"]),
    },
    cwd: process.cwd(),
  };
  log(logEntry);
  if (event === "SessionEnd") return;

  // Beads / Dolt: pull at session start (non-fatal if no remote or auth)
  const pullOut = run("bd", ["dolt", "pull"], true);
  if (pullOut) {
    console.log(`[session] bd dolt pull: ${pullOut.slice(0, 200)}`);
  }
  if (existsSync(SESSION_HANDOFF_PATH)) {
    console.log(
      `\n[session] Continuity: read ${SESSION_HANDOFF_PATH} (see .claude/protocols/session-handoff.md) before editing code.\n`,
    );
  }
  // Print orientation info
  const ready = firstLines(run("bd", ["ready"]), 5);
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
