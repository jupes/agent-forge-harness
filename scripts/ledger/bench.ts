#!/usr/bin/env bun
/**
 * bench.ts — how long the ledger takes to append N events on this machine.
 *
 * CLI:
 *   bun run scripts/ledger/bench.ts [count]         # default 10000
 *   bun run scripts/ledger/bench.ts --hook [runs]   # default 20
 *
 * Writes a throwaway ledger in the OS temp directory (never the real one),
 * appends `count` events one at a time through `appendEvent`, and prints
 * { ok, data: { events, ms, perEventMs, platform, bun }, error }.
 *
 * `--hook` times the PostToolUse hook script instead: `runs` spawns of a Bun
 * process that does nothing, and `runs` spawns of the hook with a tool-call
 * payload on stdin, against a throwaway ledger. It prints the medians.
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { appendEvent } from "./append";
import { closeLedger } from "./db";
import { queryEvents } from "./query";

export interface BenchResult {
  events: number;
  ms: number;
  perEventMs: number;
  platform: string;
  bun: string;
}

/** Append `count` events to a fresh throwaway ledger and time it. */
export function benchAppend(count: number): BenchResult {
  const dir = mkdtempSync(join(tmpdir(), "ledger bench "));
  const path = join(dir, "ledger.db");
  try {
    const started = performance.now();
    for (let i = 0; i < count; i++) {
      const result = appendEvent(
        {
          kind: "tool.called",
          workspace: "c:/bench/workspace",
          sessionId: "bench-session",
          runId: "bench-run",
          executor: { provider: "claude", model: "bench-model" },
          payload: { tool: "Bash", argsHash: `sha256:${i}`, durationMs: i },
        },
        { path },
      );
      if (!result.ok) throw new Error(result.error);
    }
    const ms = performance.now() - started;
    const stored = queryEvents({ limit: 1 }, { path })[0]?.id ?? 0;
    if (stored !== count)
      throw new Error(`expected ${count} events, the ledger holds ${stored}`);
    return {
      events: count,
      ms: Math.round(ms),
      perEventMs: Number((ms / count).toFixed(4)),
      platform: `${process.platform} ${process.arch}`,
      bun: Bun.version,
    };
  } finally {
    closeLedger(path);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // The OS temp directory reclaims it.
    }
  }
}

export interface HookBenchResult {
  runs: number;
  /** Median wall time of a Bun process that does nothing. */
  noopMs: number;
  /** Median wall time of the PostToolUse hook, start to exit. */
  hookMs: number;
  /** `hookMs - noopMs`: what the hook's own work (imports, stdin, the insert) adds. */
  marginalMs: number;
  /**
   * Median time for the spawn call itself to return, without waiting for the
   * process: what a caller that does not wait pays. Measured from this
   * script, not from inside the host that runs the hooks.
   */
  launchMs: number;
  platform: string;
  bun: string;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 1
      ? (sorted[middle] ?? 0)
      : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  return Number(value.toFixed(1));
}

/** Time `runs` spawns of a no-op process and of the PostToolUse hook; report medians. */
export async function benchHook(runs: number): Promise<HookBenchResult> {
  const dir = mkdtempSync(join(tmpdir(), "ledger bench "));
  const noop = join(import.meta.dir, "fixtures", "noop.ts");
  const hook = join(
    import.meta.dir,
    "..",
    "..",
    ".claude",
    "hooks",
    "ledger-hook.ts",
  );
  // Nothing that names a live session, run or ledger reaches the children.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^(CLAUDE_|AGENT_FORGE_|FORGE_)/.test(key)) continue;
    env[key] = value;
  }
  env.AGENT_FORGE_HOME = dir;
  const payload = JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: "bench-session",
    cwd: dir,
    tool_name: "Bash",
    tool_input: { command: "git status" },
    effort: { level: "high" },
    duration_ms: 12,
  });

  const time = async (
    script: string,
  ): Promise<{ launch: number; wall: number }> => {
    const started = performance.now();
    const child = Bun.spawn([process.execPath, "run", script], {
      cwd: dir,
      env,
      stdin: new Blob([payload]),
      stdout: "ignore",
      stderr: "ignore",
    });
    const launch = performance.now() - started;
    const exitCode = await child.exited;
    if (exitCode !== 0) throw new Error(`${script} exited ${exitCode}`);
    return { launch, wall: performance.now() - started };
  };

  try {
    // One unmeasured run of each: creates the ledger and warms the file cache.
    await time(noop);
    await time(hook);
    const noops: number[] = [];
    const hooks: number[] = [];
    const launches: number[] = [];
    for (let i = 0; i < runs; i++) {
      noops.push((await time(noop)).wall);
      const timed = await time(hook);
      hooks.push(timed.wall);
      launches.push(timed.launch);
    }
    const stored = queryEvents({ limit: 1 }, { path: join(dir, "ledger.db") });
    if ((stored[0]?.id ?? 0) !== runs + 1)
      throw new Error(
        `expected ${runs + 1} events, the newest id is ${stored[0]?.id ?? 0}`,
      );
    const noopMs = median(noops);
    const hookMs = median(hooks);
    return {
      runs,
      noopMs,
      hookMs,
      marginalMs: Number((hookMs - noopMs).toFixed(1)),
      launchMs: median(launches),
      platform: `${process.platform} ${process.arch}`,
      bun: Bun.version,
    };
  } finally {
    closeLedger(join(dir, "ledger.db"));
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // The OS temp directory reclaims it.
    }
  }
}

function fail(error: string): never {
  console.log(JSON.stringify({ ok: false, data: null, error }));
  process.exit(2);
}

if (import.meta.main && process.argv[2] === "--hook") {
  const arg = process.argv[3] ?? "20";
  if (!/^\d+$/.test(arg) || Number(arg) < 1)
    fail(`--hook: expected a positive integer, got "${arg}"`);
  try {
    console.log(
      JSON.stringify({
        ok: true,
        data: await benchHook(Number(arg)),
        error: null,
      }),
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
} else if (import.meta.main) {
  const arg = process.argv[2] ?? "10000";
  if (!/^\d+$/.test(arg) || Number(arg) < 1) {
    console.log(
      JSON.stringify({
        ok: false,
        data: null,
        error: `count: expected a positive integer, got "${arg}"`,
      }),
    );
    process.exit(2);
  }
  try {
    console.log(
      JSON.stringify({ ok: true, data: benchAppend(Number(arg)), error: null }),
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        ok: false,
        data: null,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exit(2);
  }
}
