#!/usr/bin/env bun
/**
 * bench.ts — how long the ledger takes to append N events on this machine.
 *
 * CLI:
 *   bun run scripts/ledger/bench.ts [count]     # default 10000
 *
 * Writes a throwaway ledger in the OS temp directory (never the real one),
 * appends `count` events one at a time through `appendEvent`, and prints
 * { ok, data: { events, ms, perEventMs, platform, bun }, error }.
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

if (import.meta.main) {
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
