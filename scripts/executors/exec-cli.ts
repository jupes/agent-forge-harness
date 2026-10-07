#!/usr/bin/env bun
/**
 * exec-cli.ts — run one bounded task through a smith's provider CLI.
 *
 *   bun run forge:exec --bead <id> --worktree <dir> --prompt <text>
 *       [--smith <name>] [--bead-smith <name>] [--complexity low|medium|high]
 *       [--run <slug>] [--timeout-ms <n>] [--prompt-file <path>] [--json]
 *
 * Smith resolution: --smith, then --bead-smith, then the bench for
 * --complexity, then workflow.default_crew. The child gets only allowlisted
 * environment variables. Events are written as NDJSON under
 * `.tmp/work/exec-events/<bead>.ndjson` until the ledger exists (x1gs.2.1).
 *
 * Exit code 0 when the provider exits 0, 2 otherwise.
 */

import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { BENCH_NAMES, type BenchName } from "../../types/hearth";
import { loadConfig } from "../config/load";
import { resolveSmith } from "../config/resolve";
import { buildChildEnv } from "./env";
import { ADAPTERS } from "./registry";
import { ndjsonSink } from "./sinks";
import type { EventSink, ExecutorAdapter } from "./types";

/** A "bounded" task: 30 minutes unless --timeout-ms says otherwise. */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export interface ExecDeps {
  harnessRoot: string;
  home?: string;
  env?: Record<string, string | undefined>;
  adapters?: Readonly<Record<string, ExecutorAdapter>>;
  /** Replaces the provider binary (tests). */
  command?: string[];
  /** Replaces the default NDJSON sink. */
  sink?: EventSink;
}

export interface ExecOutcome {
  code: 0 | 2;
  body: { ok: boolean; data: unknown; error: string | null };
}

function flags(argv: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg.startsWith("--") && arg !== "--json") {
      map.set(arg.slice(2), argv[i + 1] ?? "");
      i++;
    }
  }
  return map;
}

const failure = (error: string): ExecOutcome => ({
  code: 2,
  body: { ok: false, data: null, error },
});

export async function runExec(
  argv: string[],
  deps: ExecDeps,
): Promise<ExecOutcome> {
  const args = flags(argv);
  const beadId = args.get("bead");
  const worktree = args.get("worktree");
  const promptFile = args.get("prompt-file");
  const prompt =
    args.get("prompt") ??
    (promptFile && existsSync(promptFile)
      ? readFileSync(promptFile, "utf8")
      : undefined);
  if (!beadId || !worktree || !prompt) {
    return failure(
      "usage: forge:exec --bead <id> --worktree <dir> --prompt <text> [--smith <name>]",
    );
  }
  if (!existsSync(worktree)) return failure(`worktree not found: ${worktree}`);

  const complexity = args.get("complexity");
  if (complexity && !(BENCH_NAMES as readonly string[]).includes(complexity)) {
    return failure(`--complexity must be one of ${BENCH_NAMES.join(", ")}`);
  }

  let loaded: ReturnType<typeof loadConfig>;
  try {
    loaded = loadConfig({
      harnessRoot: deps.harnessRoot,
      home: deps.home,
      env: deps.env,
    });
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }

  const resolution = resolveSmith(loaded.config, {
    explicit: args.get("smith"),
    beadSmith: args.get("bead-smith"),
    complexity: complexity as BenchName | undefined,
    seed: beadId,
  });
  if (!resolution.ok) return failure(resolution.error);
  const { smith, via } = resolution;

  const adapter = (deps.adapters ?? ADAPTERS)[smith.provider];
  if (!adapter) {
    return failure(
      `no adapter for provider "${smith.provider}" (smith ${smith.name})`,
    );
  }

  const eventsFile = join(
    deps.harnessRoot,
    ".tmp",
    "work",
    "exec-events",
    `${beadId.replace(/[^\w.-]/g, "_")}.ndjson`,
  );
  const sink = deps.sink ?? ndjsonSink(eventsFile);
  const timeoutArg = args.get("timeout-ms");
  const timeoutMs = timeoutArg ? Number(timeoutArg) : DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return failure("--timeout-ms must be a positive number");
  }

  let handle: Awaited<ReturnType<ExecutorAdapter["spawn"]>>;
  try {
    handle = await adapter.spawn({
      beadId,
      worktree: resolve(worktree),
      workspace: deps.harnessRoot,
      smith,
      prompt,
      env: buildChildEnv(
        deps.env ?? process.env,
        loaded.config.execution.envPass,
      ),
      runId: args.get("run"),
      timeoutMs,
      command: deps.command,
    });
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }

  let count = 0;
  try {
    for await (const event of handle.events) {
      await sink(event);
      count++;
    }
  } catch (error) {
    await handle.stop("sink failed");
    return failure(error instanceof Error ? error.message : String(error));
  }
  const result = await handle.done;
  const ok = result.exitCode === 0 && !result.timedOut;
  return {
    code: ok ? 0 : 2,
    body: {
      ok,
      data: {
        sessionId: handle.sessionId,
        smith: smith.name,
        provider: smith.provider,
        via,
        events: count,
        eventsFile: deps.sink ? null : eventsFile,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
      },
      error: ok
        ? null
        : result.timedOut
          ? "timed out"
          : `provider exited ${result.exitCode}`,
    },
  };
}

if (import.meta.main) {
  const harnessRoot = join(import.meta.dir, "..", "..");
  const outcome = await runExec(process.argv.slice(2), { harnessRoot });
  console.log(JSON.stringify(outcome.body, null, 2));
  process.exit(outcome.code);
}
