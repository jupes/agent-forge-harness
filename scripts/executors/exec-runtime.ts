/**
 * exec-cli.ts — run one bounded task through a smith's provider CLI.
 *
 *   bun run forge:exec --bead <id> --worktree <dir> --prompt <text>
 *       [--smith <name>] [--bead-smith <name>] [--complexity low|medium|high]
 *       [--run <slug>] [--timeout-ms <n>] [--prompt-file <path>] [--json]
 *
 * Smith resolution: --smith, then --bead-smith, then the bench for
 * --complexity, then workflow.default_crew. The child gets only allowlisted
 * variables of this process's environment, plus the ones its adapter sets
 * itself (`env.ts`) and, with --run, the correlation pointer described below.
 *
 * The run's events (`session.started`, one `tool.called` per tool,
 * `session.ended`) go to the ledger; read them with
 * `bun run forge:audit --bead <id>`. An event the ledger does not take never
 * stops the provider: the envelope reports `recorded`, `notRecorded` and the
 * first `ledgerError`, and `ledger` names the file written.
 *
 * A --run value that is not a Forge run id (a run's slug) is refused before
 * anything is started or written. With --run, the run's correlation
 * (`scripts/run-correlation.ts`) is written in the worktree and its path put
 * in the child's environment, so a quality gate that runs inside the child is
 * linked to this bead and run. The worktree must be a checkout's top level for
 * that. A run already correlated to another bead is left alone. Whenever no
 * pointer is handed on, a gate inside the child runs unlinked and
 * `data.correlationNote` says why. The child still runs, and the run's ledger
 * events and the adapter's variables still carry --bead and --run: a run moves
 * from one bead to the next (`.claude/workflows/forge.md`), so they record the
 * bead this session was launched for, while the correlation records the bead a
 * gate in the run is checked against. The child never inherits a pointer from
 * this process.
 *
 * Exit code 0 when the provider exits 0 and reported no error in its stream,
 * 2 otherwise — whatever the ledger did. A provider that exits 0 after
 * reporting an error (one whose tool host was missing did) is not a success.
 * `error` gives the provider's own reason after its exit code: the first
 * error it reported, else the last line of its stderr. `data.providerErrors`
 * and `data.stderr` (its end) hold that text, which never reaches the ledger:
 * `session.ended` records `failed: exit <n>`, or
 * `failed: exit 0, provider reported an error`.
 *
 * When the provider's stream names the model its responses came from (the
 * Claude adapter reads an assistant message's `message.model`), that model is
 * cached in the same ledger for the run's session, as the hooks cache an
 * interactive session's: it is what `forge:verdict`, run inside the child,
 * records as observed. The run's events keep the smith that was asked for.
 */

import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import {
  BENCH_NAMES,
  type BenchName,
  type LedgerEventInput,
  type ProviderUsage,
} from "../../types/hearth";
import { loadConfig } from "../config/load";
import { resolveSmith } from "../config/resolve";
import { isValidSlug } from "../forge/runs";
import { readSessionMirror } from "../ledger/identity";
import { ledgerPath } from "../ledger/paths";
import { setSessionModel } from "../ledger/session-models";
import { resolveCheckout } from "../ledger/workspace";
import { RUN_CORRELATION_ENV } from "../run-correlation";
import {
  correlationReport,
  initRunCorrelation,
  type RunCorrelationReport,
} from "../run-correlation-store";
import { buildChildEnv } from "./env";
import { runFailure } from "./outcome";
import {
  PrivateCaptureError,
  type PrivateExecCaptureFactory,
} from "./private-capture";
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
  /** Replaces the ledger sink altogether; no model is cached then. */
  sink?: EventSink;
  /**
   * Stops the run: aborted before the child is spawned, nothing is spawned or
   * written; aborted while it runs, the child's tree is killed and the run
   * ends `stopped: <reason>` (the abort's reason, when it is a string).
   */
  signal?: AbortSignal;
  /** Trusted attended shift owner; never populated by CLI flags or a model tool. */
  privateCapture?: PrivateExecCaptureFactory;
  privateBootstrapCommand?: readonly string[];
}

/** An abort's reason as `session.ended` and the error name it: a short fixed text. */
function abortReason(signal: AbortSignal): string {
  return typeof signal.reason === "string" && signal.reason.trim() !== ""
    ? signal.reason.trim().slice(0, 200)
    : "aborted";
}

export interface ExecOutcome {
  /** Fatal private-capture failure; callers must not repair or admit another bead. */
  privateCaptureFailed?: true;
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
  const runId = args.get("run");
  if (runId && !isValidSlug(runId)) {
    return failure(
      "--run must be a Forge run id: a letter or digit, then letters, digits, dot, dash or underscore (80 at most)",
    );
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

  // Before anything is written: a run stopped before it started leaves nothing.
  if (deps.signal?.aborted) {
    return failure(
      `stopped before the provider was started: ${abortReason(deps.signal)}`,
    );
  }

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
      ...(deps.privateCapture ? { privateCapture: deps.privateCapture } : {}),
      ...(deps.privateBootstrapCommand
        ? { privateBootstrapCommand: deps.privateBootstrapCommand }
        : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
      // The observed model goes where the run's events go: the ledger.
      ...(deps.sink
        ? {}
        : {
            onModel: (observed: {
              sessionId: string;
              provider: string;
              model: string;
            }) => {
              setSessionModel(
                observed,
                deps.ledgerPath === undefined ? {} : { path: deps.ledgerPath },
              );
            },
          }),
    });
  } catch (error) {
    const result = failure(
      error instanceof Error ? error.message : String(error),
    );
    return error instanceof PrivateCaptureError
      ? { ...result, privateCaptureFailed: true }
      : result;
  }

  // An abort stops the child: the supervisor kills its tree. The handle's
  // `done` settles once it has, so the loop below ends as for any exit.
  const { signal } = deps;
  const onAbort = () => {
    if (signal) void handle.stop(abortReason(signal));
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  // Aborted between the check above and the spawn: stop it now.
  if (signal?.aborted) onAbort();

  // The provider's outcome decides the result. An event the ledger did not
  // take is counted and reported, and the child is left to finish.
  let events = 0;
  let recorded = 0;
  let ledgerError: string | null = null;
  let usage: ProviderUsage | null = null;
  try {
    for await (const event of handle.events) {
      events++;
      if (event.kind === "session.ended" && event.payload.usage)
        usage = event.payload.usage;
      const stored = await store(sink, event);
      if (stored.ok) recorded++;
      else ledgerError ??= stored.error;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  let result: Awaited<typeof handle.done>;
  try {
    result = await handle.done;
  } catch (error) {
    const result = failure(
      error instanceof Error
        ? error.message
        : "The provider outcome is unknown.",
    );
    return error instanceof PrivateCaptureError
      ? { ...result, privateCaptureFailed: true }
      : result;
  }
  const runError =
    result.stopped && signal?.aborted
      ? `stopped: ${abortReason(signal)}`
      : runFailure(result);
  const ok = runError === null;
  return {
    code: ok ? 0 : 2,
    ...(result.privateCaptureFailed ? { privateCaptureFailed: true } : {}),
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
        stopped: result.stopped,
        usage,
        providerErrors: result.providerErrors,
        stderr: result.stderr,
        correlation: correlated.correlation,
        ...(correlated.note ? { correlationNote: correlated.note } : {}),
      },
      error: runError,
    },
  };
}
