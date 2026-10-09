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
 * environment variables.
 *
 * The run's events (`session.started`, one `tool.called` per tool,
 * `session.ended`) go to the ledger; read them with
 * `bun run forge:audit --bead <id>`. An event the ledger does not take never
 * stops the provider: the envelope reports `recorded`, `notRecorded` and the
 * first `ledgerError`, and `ledger` names the file written.
 *
 * With --run, the run's correlation (`scripts/run-correlation.ts`) is written
 * in the worktree and its path put in the child's environment, so a quality
 * gate that runs inside the child is linked to this bead and run. The worktree
 * must be a checkout's top level for that. A run already correlated to
 * another bead is left alone. Whenever no pointer is handed on, the child
 * runs unlinked and `data.correlationNote` says why. The child never inherits
 * a pointer from this process.
 *
 * Exit code 0 when the provider exits 0, 2 otherwise — whatever the ledger did.
 */

import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import {
  BENCH_NAMES,
  type BenchName,
  type LedgerEventInput,
} from "../../types/hearth";
import { loadConfig } from "../config/load";
import { resolveSmith } from "../config/resolve";
import { readSessionMirror } from "../ledger/identity";
import { ledgerPath } from "../ledger/paths";
import { resolveCheckout } from "../ledger/workspace";
import { RUN_CORRELATION_ENV } from "../run-correlation";
import {
  correlationReport,
  initRunCorrelation,
  type RunCorrelationReport,
} from "../run-correlation-store";
import { buildChildEnv } from "./env";
import { ADAPTERS } from "./registry";
import { ledgerSink } from "./sinks";
import type { EventSink, ExecutorAdapter, SinkResult } from "./types";

/** A "bounded" task: 30 minutes unless --timeout-ms says otherwise. */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export interface ExecDeps {
  harnessRoot: string;
  home?: string;
  env?: Record<string, string | undefined>;
  adapters?: Readonly<Record<string, ExecutorAdapter>>;
  /** The directory forge:exec was launched from. Default: the current directory. */
  cwd?: string;
  /** Replaces the provider binary (tests). */
  command?: string[];
  /** The ledger file to write (tests). Default: the ledger of the process environment. */
  ledgerPath?: string;
  /** Replaces the ledger sink altogether. */
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

/**
 * The child's run correlation: written in its worktree when the caller named
 * a run, and the environment that carries the pointer to it.
 */
function correlateChild(input: {
  worktree: string;
  beadId: string;
  runId: string | undefined;
}): {
  env: Record<string, string>;
  correlation: RunCorrelationReport | null;
  note?: string;
} {
  const { worktree, beadId, runId } = input;
  if (!runId) {
    return {
      env: {},
      correlation: null,
      note: "no --run was given, so there is no run to correlate",
    };
  }
  const made = initRunCorrelation({
    // The worktree is where the child runs its gate, so the file goes there
    // and nowhere a directory that is not a checkout might resolve to.
    checkout: worktree,
    topLevel: true,
    beadsIssueId: beadId,
    executionRunId: runId,
  });
  if (made.ok) {
    return { env: made.env, correlation: correlationReport(made.correlation) };
  }
  return {
    env: {},
    correlation: null,
    note: made.held
      ? `${made.error}; rebind it with: bun run forge:correlate --bead ${beadId} --run ${runId}`
      : `run correlation not written: ${made.error}`,
  };
}

const failure = (error: string): ExecOutcome => ({
  code: 2,
  body: { ok: false, data: null, error },
});

/**
 * The session forge:exec was launched from: the one mirrored into that
 * directory's checkout, as for every other script emitter. Undefined when no
 * fresh mirror is there.
 */
function launchingSession(cwd: string): string | undefined {
  return readSessionMirror(resolveCheckout(cwd).worktree) ?? undefined;
}

/**
 * Hand one event to the sink. A sink that returns nothing has taken it; one
 * that throws is a refusal like any other.
 */
async function store(
  sink: EventSink,
  event: LedgerEventInput,
): Promise<SinkResult> {
  try {
    return (await sink(event)) ?? { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

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

  const sink =
    deps.sink ??
    ledgerSink(deps.ledgerPath === undefined ? {} : { path: deps.ledgerPath });
  const timeoutArg = args.get("timeout-ms");
  const timeoutMs = timeoutArg ? Number(timeoutArg) : DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return failure("--timeout-ms must be a positive number");
  }

  const runId = args.get("run");
  const correlated = correlateChild({
    worktree: resolve(worktree),
    beadId,
    runId,
  });
  const childEnv = buildChildEnv(
    deps.env ?? process.env,
    loaded.config.execution.envPass,
  );
  // The pointer is this launcher's to give: one inherited from the parent
  // names some other run's file.
  for (const name of Object.keys(childEnv)) {
    if (name.toLowerCase() === RUN_CORRELATION_ENV.toLowerCase()) {
      delete childEnv[name];
    }
  }
  Object.assign(childEnv, correlated.env);

  let handle: Awaited<ReturnType<ExecutorAdapter["spawn"]>>;
  try {
    handle = await adapter.spawn({
      beadId,
      worktree: resolve(worktree),
      workspace: deps.harnessRoot,
      smith,
      prompt,
      env: childEnv,
      runId,
      parentSessionId: launchingSession(deps.cwd ?? process.cwd()),
      timeoutMs,
      command: deps.command,
    });
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }

  // The provider's outcome decides the result. An event the ledger did not
  // take is counted and reported, and the child is left to finish.
  let events = 0;
  let recorded = 0;
  let ledgerError: string | null = null;
  for await (const event of handle.events) {
    events++;
    const stored = await store(sink, event);
    if (stored.ok) recorded++;
    else ledgerError ??= stored.error;
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
        events,
        recorded,
        notRecorded: events - recorded,
        ledgerError,
        ledger: deps.sink ? null : (deps.ledgerPath ?? ledgerPath()),
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        correlation: correlated.correlation,
        ...(correlated.note ? { correlationNote: correlated.note } : {}),
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
