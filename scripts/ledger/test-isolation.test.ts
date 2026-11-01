/**
 * Guard against the test suite writing the ledger under the user's home.
 *
 * Two halves. In this process, the preload has already moved the ledger to a
 * temp directory, so an emitter that names no ledger lands there. For child
 * processes — which may be handed an environment that drops the preload's
 * setting — every test file that can start a process is run again with the OS
 * home pointed at a scratch directory (`HOME` and `USERPROFILE` both) and no
 * `AGENT_FORGE_HOME`: a child that keeps the OS home variable then has the
 * default home `<scratch>/.agent-forge`, and it must not appear. A child whose
 * environment has neither `AGENT_FORGE_HOME` nor the OS home variable
 * (`USERPROFILE` on Windows, `HOME` elsewhere) would take the home of the
 * user's account instead; in the re-run the spawn probe (`isolation-probe.ts`)
 * starts such a child with `AGENT_FORGE_HOME` set to `<scratch>/.agent-forge`
 * when it is started with `Bun.spawn`, `Bun.spawnSync` or a
 * `node:child_process` function (which the MCP stdio client reaches), so it is
 * caught the same way. That directory is the hearth's as well as the ledger's,
 * so a lock or token file written there fails this too.
 *
 * "Can start a process" is decided by a scan, so a new test is covered without
 * being listed here: a `*.test.ts` file under `scripts/` is re-run when it, or
 * any module it loads (followed by `scripts/import-graph.ts`), names one of
 * the primitives in `SPAWNS`. A test that starts a hearth through
 * `scripts/hearth/supervisor.ts` or an executor through `scripts/executors/`
 * is therefore in, though the test file itself spawns nothing.
 *
 * What this does not cover:
 * - a child whose environment names neither `AGENT_FORGE_HOME` nor the OS home
 *   variable and that the spawn probe does not reach: one started through the
 *   Bun shell (`Bun.$` given an environment of its own; no test does that
 *   today, bead `agent-forge-harness-usuz`), and one started by another child,
 *   which runs without the preload and so without the probe. Its OS home comes
 *   from the user's account, so it writes under the real home in this re-run
 *   as in an ordinary run, and the scratch directory never sees it.
 * - a test file the scan does not list: only `*.test.ts` files under
 *   `scripts/` are read, though `bun test` also runs other names (`.test.tsx`,
 *   `.spec.ts`, `_test.ts`; there are none today). The Playwright specs under
 *   `tests/e2e` are not run by `bun test` at all.
 * - a process started through a primitive that is not in `SPAWNS`, or from
 *   inside a package other than the MCP stdio client;
 * - a module the import scan does not follow (its header lists what it cannot
 *   see, such as a computed specifier);
 * - a child that writes somewhere other than the default home.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { availableParallelism, homedir, tmpdir } from "os";
import { basename, dirname, join, relative, resolve, sep } from "path";
import { INTERACTIVE_START_MAX_BYTES } from "../executors/interactive-bootstrap";
import { interactiveLifetimeMs } from "../executors/interactive-lifetime";
import { type InteractiveSupervised, supervise } from "../executors/supervisor";
import { createImportGraphSession } from "../import-graph";
import { ISOLATION_HOME } from "./isolation-probe";
import {
  type IsolationFailureRecord,
  type IsolationRerunControl,
  settleIsolationReruns,
} from "./isolation-reruns";
import { ledgerHome, ledgerPath } from "./paths";
import { rerunReport } from "./rerun-output";

const REPO = resolve(import.meta.dir, "..", "..");
const TEST_ROOT = join(REPO, "scripts");
const SELF = resolve(import.meta.path);

/**
 * The ways code in this repo starts a process: Bun's spawn and shell, Node's
 * `child_process` (whatever is imported from it), and the MCP stdio client,
 * which spawns inside its package.
 */
const SPAWNS =
  /Bun\.spawn|Bun\.\$|child_process|StdioClientTransport|\{[^}]*\$[^}]*\}\s*from\s*["']bun["']/;

/**
 * How many re-run files run at once in their own `bun test`: Windows uses
 * three workers from 2 to 15 logical CPUs and four at 16 or more; other
 * platforms keep the quarter-CPU formula bounded from two to four. All use
 * two workers below two CPUs. On a 16-thread
 * machine, with two other full runs going, the 62 files took 144 to 153 s one
 * after another in one `bun test`, and 46 to 51 s four at a time (wwj5). One
 * after another, the re-run went past the test's 180 s limit in full runs.
 */
const isolationRerunWorkerCount = (
  platform: NodeJS.Platform,
  cpuCount: number,
): number => {
  if (cpuCount < 2) return 2;
  if (platform === "win32" && cpuCount < 16) return 3;
  return Math.min(4, Math.max(2, Math.floor(cpuCount / 4)));
};

const RERUN_WORKERS = isolationRerunWorkerCount(
  process.platform,
  availableParallelism(),
);

test("Windows home-isolation worker policy uses three slots at two logical CPUs", () => {
  expect(isolationRerunWorkerCount("win32", 2)).toBe(3);
});

const workerPolicyCases: ReadonlyArray<
  readonly [NodeJS.Platform, number, number]
> = [
  ["win32", 0, 2],
  ["win32", 1, 2],
  ["win32", 2, 3],
  ["win32", 4, 3],
  ["win32", 8, 3],
  ["win32", 12, 3],
  ["win32", 16, 4],
  ["win32", 64, 4],
  ["linux", 0, 2],
  ["linux", 1, 2],
  ["linux", 2, 2],
  ["linux", 4, 2],
  ["linux", 8, 2],
  ["linux", 12, 3],
  ["linux", 16, 4],
  ["linux", 64, 4],
];

for (const [platform, cpuCount, expected] of workerPolicyCases) {
  test(`worker policy ${platform} at ${cpuCount} CPUs`, () => {
    expect(isolationRerunWorkerCount(platform, cpuCount)).toBe(expected);
  });
}

/**
 * Only the aggregate coordinator budget, not an individual test or native
 * process deadline. The suite grew to 360 files / 201 process-reaching files,
 * including 17 actual compile fixtures. A smaller Linux tree took 171.69 s;
 * the expanded Linux run exceeded 180 s without an individual failure, while
 * Windows completed in 210.54 s under its established 600 s policy. Apply
 * that bounded aggregate policy on every platform; keep the worker/exclusive
 * schedule, all selected files and the per-test 15 s limit unchanged.
 */
const RERUN_LIMIT_MS = 600_000;
// Stop admission at 590s; retire concurrently through 598s; reserve the final 2s.
const RERUN_WORK_CUTOFF_MS = RERUN_LIMIT_MS - 10_000;
const RERUN_RETIRE_HARD_MS = RERUN_LIMIT_MS - 2_000;

/**
 * The per-test limit of each re-run file, the one CI gives the whole suite
 * (`bun test scripts --timeout 15000`). With bun's default of 5 s, a test of
 * beads.test.ts that passes in the suite timed out in the re-run on the
 * windows-latest runner.
 */
const RERUN_TEST_TIMEOUT = "15000";

/**
 * A re-run file whose `bun test` did not exit 0: its failing tests' own lines
 * (error and diff) and the end of its output (`rerun-output.ts`).
 */
interface FailedRerun {
  file: string;
  exitCode: number;
  failures: string;
  tail: string;
  failureRecord?: IsolationFailureRecord;
}

/**
 * Run each file in its own `bun test` with `env`, `RERUN_WORKERS` at a time.
 * The timed append file gets an exclusive phase first: Windows CI stored all
 * 10,000 rows but exceeded its unchanged 60s bound under concurrent disk work.
 * Every file still runs with the scratch home, so a default home written by
 * any of them is still found; running them apart also names the file that
 * failed. The `./` makes bun take the path as a file, not a name filter.
 */
type RawInteractiveProcess = Bun.Subprocess<"pipe", "pipe", "pipe">;

interface OwnedProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  providerPid: number;
  ownedTreeReleased: boolean;
}

interface OwnedProcessTestHook {
  afterStart?: (owner: {
    providerPid: Promise<number>;
    done: InteractiveSupervised["done"];
    stdout: Promise<string>;
    stderr: Promise<string>;
    stop(reason: string): Promise<void>;
  }) => Promise<void>;
  onLine?: (line: string) => void;
  /** Short lifetime only for bounded native fixtures; production reruns retain the reviewed default. */
  timeoutMs?: number;
  /** Local fault simulation only; native proof keeps the real supervisor factory. */
  superviseForTest?: (options: {
    beforeStart: () => Promise<void>;
    onOutputError: () => void;
  }) => InteractiveSupervised;
  /** Inert controlled reader faults only; native tests use the actual spawn/tee path. */
  rawCaptureForTest?: () => {
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
  };
}

interface OwnedProcessState {
  retainScratch: boolean;
  pendingObligations: number;
}

function observeRawText(
  stream: ReadableStream<Uint8Array>,
  control: IsolationRerunControl,
): Promise<string> {
  const captured = new Response(stream).text();
  const observed = captured.catch((error: unknown) => {
    control.failFatal(error);
    throw error;
  });
  void observed.catch(() => undefined);
  return control.registerObligation(observed);
}

/** Exact test-only raw-pipe tee; the supervisor reads its own tee branches. */
async function runOwnedProcess(
  command: string[],
  cwd: string,
  env: Record<string, string>,
  control: IsolationRerunControl,
  state: OwnedProcessState,
  hook: OwnedProcessTestHook = {},
): Promise<OwnedProcessResult> {
  const expired = () =>
    control.signal.aborted || control.now() >= control.deadlineAt;
  const refuseBeforeLaunch = () => {
    if (expired())
      throw (
        control.signal.reason ??
        new Error("Isolation work cutoff reached before launch.")
      );
  };
  refuseBeforeLaunch();
  const target = Bun.which(command[0] ?? "");
  if (!target || target !== command[0]) {
    const error = new Error(
      "The test runner executable did not resolve identically.",
    );
    control.failFatal(error);
    throw error;
  }
  // Repeat after executable resolution; repeat again after setup at acquisition.
  refuseBeforeLaunch();
  let capture: {
    process: RawInteractiveProcess | null;
    stdout: Promise<string> | null;
    stderr: Promise<string> | null;
    setupFailure: unknown;
  } = { process: null, stdout: null, stderr: null, setupFailure: null };
  let child: InteractiveSupervised | null = null;
  let stopPromise: Promise<void> | null = null;
  let outputGuardFailure: Error | null = null;
  const onOutputError = () => {
    const error =
      outputGuardFailure ?? new Error("The interactive output reader failed.");
    outputGuardFailure = error;
    control.failFatal(error);
  };
  let ownerRegistered = false;
  let positivelyReleased = false;
  let removeAbortListener = () => {};

  const stop = (reason: string): Promise<void> => {
    if (stopPromise) return stopPromise;
    try {
      if (child) stopPromise = Promise.resolve(child.stop(reason));
      else if (capture.process) {
        capture.process.kill("SIGKILL");
        stopPromise = capture.process.exited.then(() => undefined);
      } else
        stopPromise = Promise.reject(
          new Error("No exact interactive owner was acquired."),
        );
    } catch (error) {
      stopPromise = Promise.reject(error);
    }
    void stopPromise.catch((error: unknown) => {
      if (!expired()) control.failFatal(error);
    });
    return stopPromise;
  };

  const spawn: NonNullable<Parameters<typeof supervise>[0]["spawn"]> = (
    suppliedCommand,
    suppliedOptions,
  ) => {
    const raw = Bun.spawn(suppliedCommand, suppliedOptions);
    capture.process = raw;
    let supervisorStdout = raw.stdout;
    let supervisorStderr = raw.stderr;
    try {
      const [ownedStdout, capturedStdout] = raw.stdout.tee();
      supervisorStdout = ownedStdout;
      capture.stdout = observeRawText(capturedStdout, control);
      const [ownedStderr, capturedStderr] = raw.stderr.tee();
      supervisorStderr = ownedStderr;
      capture.stderr = observeRawText(capturedStderr, control);
    } catch (error) {
      capture.setupFailure = error;
      control.failFatal(error);
    }
    return new Proxy(raw, {
      get(targetProcess, property) {
        if (property === "stdout") return supervisorStdout;
        if (property === "stderr") return supervisorStderr;
        const value = Reflect.get(targetProcess, property, targetProcess);
        return typeof value === "function" ? value.bind(targetProcess) : value;
      },
    });
  };

  if (hook.rawCaptureForTest) {
    const streams = hook.rawCaptureForTest();
    capture.stdout = observeRawText(streams.stdout, control);
    capture.stderr = observeRawText(streams.stderr, control);
  }

  const beforeStart = () => {
    if (!child) {
      const error = new Error(
        "The exact owner handle was unavailable at the grant callback.",
      );
      control.failFatal(error);
      return Promise.reject(error);
    }
    if (!ownerRegistered && !expired()) {
      const error = new Error(
        "The exact owner was not registered before the grant callback.",
      );
      control.failFatal(error);
      return Promise.reject(error);
    }
    const refusal =
      capture.setupFailure ??
      (expired()
        ? (control.signal.reason ??
          new Error("Isolation work cutoff reached before grant."))
        : null);
    if (refusal !== null) {
      if (capture.setupFailure !== null)
        control.failFatal(capture.setupFailure);
      void stop("interactive grant refused");
      return Promise.reject(refusal);
    }
    return Promise.resolve();
  };
  try {
    // Setup hooks and raw capture can advance the clock; check at acquisition.
    refuseBeforeLaunch();
    if (hook.superviseForTest) {
      child = hook.superviseForTest({
        beforeStart,
        onOutputError,
      });
    } else {
      child = supervise({
        command,
        cwd,
        env,
        stdinMode: "interactive",
        spawn,
        onLine: hook.onLine ?? (() => undefined),
        onOutputError,
        beforeStart,
        ...(hook.timeoutMs === undefined
          ? {}
          : { timeoutMs: interactiveLifetimeMs(hook.timeoutMs) }),
      });
    }
  } catch (error) {
    control.failFatal(error);
    if (capture.process) state.retainScratch = true;
    removeAbortListener();
    if (capture.process) {
      void stop("supervisor acquisition failed");
      const receipts = Promise.allSettled([
        control.registerObligation(capture.process.exited),
        ...(capture.stdout ? [capture.stdout] : []),
        ...(capture.stderr ? [capture.stderr] : []),
      ]);
      try {
        await boundedFixtureWait(
          receipts,
          control.retirementDeadlineAt,
          "Acquisition cleanup remained unsettled.",
        );
      } catch {
        state.retainScratch = true;
      }
    }
    throw error;
  }

  // Register the exact returned handle before any await and before its queued grant callback.
  const owner = { done: child.done, stop };
  try {
    ownerRegistered = control.registerOwner(owner);
  } catch (error) {
    control.failFatal(error);
    ownerRegistered = false;
  }
  const abortOwner = () => {
    void stop("home-isolation work cutoff");
  };
  control.signal.addEventListener("abort", abortOwner, { once: true });
  removeAbortListener = () =>
    control.signal.removeEventListener("abort", abortOwner);

  const stdout = capture.stdout;
  const stderr = capture.stderr;
  const failSetup =
    capture.setupFailure !== null ||
    !stdout ||
    !stderr ||
    !ownerRegistered ||
    expired();
  if (failSetup) {
    if (capture.setupFailure !== null) control.failFatal(capture.setupFailure);
    if ((!stdout || !stderr) && capture.setupFailure === null)
      control.failFatal(
        new Error(
          "The raw interactive stdout and stderr captures are required.",
        ),
      );
    if (!ownerRegistered && !expired())
      control.failFatal(
        new Error("The acquired interactive owner was refused."),
      );
    void child.providerPid.catch(() => undefined);
    const pending = Promise.allSettled([
      stop("interactive owner admission refused"),
      child.done,
      ...(stdout ? [stdout] : []),
      ...(stderr ? [stderr] : []),
    ]);
    try {
      const receipts = await boundedFixtureWait(
        pending,
        control.retirementDeadlineAt,
        "Refused owner cleanup remained unsettled.",
      );
      const doneReceipt = receipts[1];
      positivelyReleased =
        receipts.every((receipt) => receipt.status === "fulfilled") &&
        doneReceipt?.status === "fulfilled" &&
        doneReceipt.value.ownedTreeReleased === true &&
        stdout !== null &&
        stderr !== null;
      if (!positivelyReleased) state.retainScratch = true;
    } catch {
      state.retainScratch = true;
      void pending;
    }
    removeAbortListener();
    throw (
      capture.setupFailure ??
      outputGuardFailure ??
      new Error("Interactive owner admission or raw capture setup failed.")
    );
  }

  const providerPid = child.providerPid;
  void providerPid.catch((error: unknown) => {
    if (!expired()) control.failFatal(error);
  });
  const endInput = control.registerObligation(
    providerPid.then(() => child!.end()),
  );
  void endInput.catch((error: unknown) => {
    if (!expired()) control.failFatal(error);
  });
  const done = child.done;
  void done.catch((error: unknown) => {
    if (!expired()) control.failFatal(error);
  });

  try {
    if (hook.afterStart)
      await hook.afterStart({ providerPid, done, stdout, stderr, stop });
    const [doneResult, stdoutText, stderrText] = await Promise.all([
      done,
      stdout,
      stderr,
      endInput,
    ]);
    positivelyReleased = doneResult.ownedTreeReleased === true;
    if (!positivelyReleased) {
      state.retainScratch = true;
      const error = new Error(
        "The interactive process tree was not positively released.",
      );
      control.failFatal(error);
      throw error;
    }
    return {
      exitCode: doneResult.exitCode,
      stdout: stdoutText,
      stderr: stderrText,
      providerPid: await providerPid,
      ownedTreeReleased: true,
    };
  } catch (error) {
    if (!expired()) control.failFatal(error);
    const pending = Promise.allSettled([
      stop("interactive adapter failure"),
      done,
      stdout,
      stderr,
      endInput,
    ]);
    try {
      const receipts = await boundedFixtureWait(
        pending,
        control.retirementDeadlineAt,
        "Adapter failure cleanup remained unsettled.",
      );
      const doneReceipt = receipts[1];
      positivelyReleased =
        receipts.every((receipt) => receipt.status === "fulfilled") &&
        doneReceipt?.status === "fulfilled" &&
        doneReceipt.value.ownedTreeReleased === true;
      if (!positivelyReleased) state.retainScratch = true;
    } catch {
      state.retainScratch = true;
      void pending;
    }
    throw error;
  } finally {
    removeAbortListener();
  }
}

/** Preflight the exact target envelope; never filter keys to satisfy bootstrap bounds. */
function validateInteractiveEnvelope(
  command: string[],
  cwd: string,
  env: Record<string, string>,
): void {
  if (
    command.length > 32 ||
    command.some((word) => !word || word.length > 8192 || word.includes("\0"))
  )
    throw new Error(
      "The test runner command exceeds the trusted interactive bound.",
    );
  const target = Bun.which(command[0] ?? "");
  if (!target || target !== command[0])
    throw new Error("The test runner executable did not resolve identically.");
  const entries = Object.entries(env);
  if (entries.length > 128)
    throw new Error(
      "The exact test runner environment exceeds the trusted interactive bound.",
    );
  for (const [name, value] of entries) {
    if (
      !name ||
      name.length > 128 ||
      name.includes("=") ||
      name.includes("\0") ||
      value.length > 32768 ||
      value.includes("\0")
    )
      throw new Error(
        "The exact test runner environment exceeds the trusted interactive bound.",
      );
  }
  const envelope =
    JSON.stringify({
      version: 1,
      command: [target, ...command.slice(1)],
      cwd,
      env,
      timeoutMs: interactiveLifetimeMs(),
    }) + "\n";
  if (Buffer.byteLength(envelope) > INTERACTIVE_START_MAX_BYTES)
    throw new Error("The exact test runner start envelope exceeds its bound.");
}

function errorDiagnostic(reason: unknown): string {
  return reason instanceof Error
    ? reason.name + ": " + reason.message
    : String(reason);
}

function describeFailure(
  reason: unknown,
  record?: IsolationFailureRecord,
): string {
  const primary = record?.hasPrimary ? record.primary : reason;
  const secondary = record?.secondaryErrors ?? [];
  return [
    errorDiagnostic(primary),
    ...secondary.map((error) => "cleanup: " + errorDiagnostic(error)),
  ].join("\n");
}

function summarizeRerun(
  file: string,
  result: OwnedProcessResult,
): FailedRerun | null {
  if (result.exitCode === 0) return null;
  return {
    file,
    exitCode: result.exitCode ?? -1,
    ...rerunReport(result.stdout + result.stderr),
  };
}

async function rerunEach(
  files: string[],
  env: Record<string, string>,
  deadlineAt: number,
  hardDeadlineAt: number,
  signal: AbortSignal,
  state: OwnedProcessState,
): Promise<FailedRerun[]> {
  console.error(
    "[home-isolation] " +
      JSON.stringify({
        event: "plan",
        files: files.length,
        workers: RERUN_WORKERS,
        aggregateLimitMs: RERUN_LIMIT_MS,
        workCutoffMs: RERUN_WORK_CUTOFF_MS,
        retirementHardMs: RERUN_RETIRE_HARD_MS,
        perTestLimitMs: Number(RERUN_TEST_TIMEOUT),
      }),
  );
  for (const file of files) {
    validateInteractiveEnvelope(
      [process.execPath, "test", "--timeout", RERUN_TEST_TIMEOUT, "./" + file],
      REPO,
      env,
    );
  }
  const results = await settleIsolationReruns(
    files,
    RERUN_WORKERS,
    async (file, control): Promise<FailedRerun | null> => {
      const result = await runOwnedProcess(
        [
          process.execPath,
          "test",
          "--timeout",
          RERUN_TEST_TIMEOUT,
          "./" + file,
        ],
        REPO,
        env,
        control,
        state,
      );
      return summarizeRerun(file, result);
    },
    (progress) => {
      console.error("[home-isolation] " + JSON.stringify(progress));
    },
    {
      signal,
      deadlineAt,
      hardDeadlineAt,
      onHardDeadline(pending) {
        if (pending > 0) state.retainScratch = true;
      },
      onPendingChange(pending) {
        state.pendingObligations = pending;
      },
    },
  );
  const failed: FailedRerun[] = results.flatMap((result, index) =>
    result.status === "fulfilled"
      ? result.value === null
        ? []
        : [result.value]
      : [
          {
            file: files[index] ?? "unknown file",
            exitCode: -1,
            failures: describeFailure(result.reason, result.failureRecord),
            ...(result.failureRecord
              ? { failureRecord: result.failureRecord }
              : {}),
            tail: "",
          },
        ],
  );
  return failed.sort((a, b) => a.file.localeCompare(b.file));
}

function testFiles(
  dir: string,
  counts?: { directories: number; candidates: number },
): string[] {
  if (counts) counts.directories++;
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === "node_modules" ? [] : testFiles(path, counts);
    if (!entry.name.endsWith(".test.ts")) return [];
    if (counts) counts.candidates++;
    return [path];
  });
}

/** Whether a file names a spawn primitive; each file is read once. */
const spawns = new Map<string, boolean>();
function startsProcesses(file: string): boolean {
  let known = spawns.get(file);
  if (known === undefined) {
    known = SPAWNS.test(readFileSync(file, "utf8"));
    spawns.set(file, known);
  }
  return known;
}

function spawningTestFiles(): string[] {
  const diagnose = process.env["AGENT_FORGE_TEST_PROBE_DIAGNOSTICS"] === "1",
    scanStarted = performance.now(),
    counts = { directories: 0, candidates: 0 },
    enumerationStarted = performance.now(),
    candidates = testFiles(TEST_ROOT, diagnose ? counts : undefined),
    enumerationMs = Math.round(performance.now() - enumerationStarted),
    session = createImportGraphSession(),
    selected: string[] = [],
    slowRoots: Array<{ file: string; elapsedMs: number }> = [];
  let roots = 0,
    graphFiles = 0;
  for (const file of candidates) {
    if (resolve(file) === SELF) continue;
    const rootStarted = performance.now();
    const graph = session.importGraph(file);
    graphFiles += graph.files.length;
    if (graph.files.some(startsProcesses)) selected.push(file);
    if (diagnose) {
      const elapsedMs = Math.round(performance.now() - rootStarted);
      slowRoots.push({
        file: relative(REPO, file).split(sep).join("/"),
        elapsedMs,
      });
      slowRoots.sort((a, b) => b.elapsedMs - a.elapsedMs);
      slowRoots.length = Math.min(slowRoots.length, 5);
      roots++;
      if (roots % 32 === 0)
        console.error(
          `[isolation-scan] ${JSON.stringify({ roots, candidates: counts.candidates, elapsedMs: Math.round(performance.now() - scanStarted) })}`,
        );
    }
  }
  if (diagnose)
    console.error(
      `[isolation-scan] ${JSON.stringify({ event: "complete", directories: counts.directories, candidates: counts.candidates, roots, enumerationMs, elapsedMs: Math.round(performance.now() - scanStarted), graphFiles, ...session.stats(), slowRoots })}`,
    );
  return selected
    .map((file) => relative(REPO, file).split(sep).join("/"))
    .sort();
}

interface Rerun {
  exitCode: number;
  /** The failing tests' own lines, for a failure message. */
  failures: string;
  /** The end of the run's output, for a failure message. */
  tail: string;
  /** What `<scratch>/.agent-forge` holds after the run, or null when it was never created. */
  home: string[] | null;
  /** The session ids of the events in that directory's ledger, if it has one. */
  sessions: string[];
}

/** The distinct session ids in a ledger file; none when there is no file. */
function sessionsIn(path: string): string[] {
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true });
  try {
    return db
      .query<{ session: string | null }, []>(
        "SELECT DISTINCT session_id AS session FROM events ORDER BY session_id",
      )
      .all()
      .flatMap((row) => (row.session === null ? [] : [row.session]));
  } finally {
    db.close();
  }
}

/**
 * Runs `bun test` on the given files from the repo root, with the OS home
 * (`HOME` and `USERPROFILE`) pointed at a scratch directory and no
 * `AGENT_FORGE_HOME`, and reports what the run left in
 * `<scratch>/.agent-forge`. `ISOLATION_HOME` names that directory, so the
 * preload installs the spawn probe (`isolation-probe.ts`): a child started
 * with an environment that names no home is given it as `AGENT_FORGE_HOME`.
 */
function disposeScratchHome(scratch: string, retain: boolean): boolean {
  if (retain) return false;
  const expectedParent = resolve(tmpdir());
  if (
    resolve(dirname(scratch)) !== expectedParent ||
    !basename(scratch).startsWith("ledger isolation home ")
  )
    throw new Error("Refusing cleanup outside the exact scratch-home leaf.");
  const leaf = lstatSync(scratch);
  if (!leaf.isDirectory() || leaf.isSymbolicLink())
    throw new Error("Scratch-home cleanup leaf is not a normal directory.");
  rmSync(scratch, { recursive: true, force: true });
  if (existsSync(scratch))
    throw new Error("Scratch-home cleanup did not remove its exact leaf.");
  return true;
}

async function rerunWithScratchHome(files: string[]): Promise<Rerun> {
  const scratch = mkdtempSync(join(tmpdir(), "ledger isolation home "));
  try {
    const home = join(scratch, ".agent-forge");
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined || key === "AGENT_FORGE_HOME") continue;
      env[key] = value;
    }
    env.HOME = scratch;
    env.USERPROFILE = scratch;
    env[ISOLATION_HOME] = home;

    const child = Bun.spawn([process.execPath, "test", ...files], {
      cwd: REPO,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const exitCode = await child.exited;
    return {
      exitCode,
      ...rerunReport(`${stdout}${stderr}`),
      home: existsSync(home) ? readdirSync(home).sort() : null,
      sessions: sessionsIn(join(home, "ledger.db")),
    };
  } finally {
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      // A file a child still holds on Windows: the OS temp directory reclaims it.
    }
  }
}

/** A test file that starts a child with only PATH in its environment and runs a ledger emitter there. */
const HOME_LESS_CHILD = "./scripts/ledger/fixtures/home-less-child.ts";

function boundedFixtureWait<T>(
  promise: Promise<T>,
  deadlineAt: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(label)),
        Math.max(0, deadlineAt - performance.now()),
      );
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

type FixtureOwner = {
  providerPid: Promise<number>;
  done: InteractiveSupervised["done"];
  stdout: Promise<string>;
  stderr: Promise<string>;
  stop(reason: string): Promise<void>;
};

async function finishFixtureOwner(
  owner: FixtureOwner | null,
  state: OwnedProcessState,
  deadlineAt: number,
): Promise<void> {
  if (!owner) return;
  let stop: Promise<void>;
  try {
    stop = owner.stop("fixture finally settlement");
  } catch (error) {
    stop = Promise.reject(error);
  }
  const observedFailures: unknown[] = [];
  const observe = <T>(promise: Promise<T>): Promise<T> =>
    promise.catch((error: unknown) => {
      observedFailures.push(error);
      throw error;
    });
  const pending = Promise.allSettled([
    observe(stop),
    observe(owner.done),
    observe(owner.stdout),
    observe(owner.stderr),
  ]);
  let receipts: Awaited<typeof pending>;
  try {
    receipts = await boundedFixtureWait(
      pending,
      deadlineAt,
      "Fixture finally settlement remained pending.",
    );
  } catch (error) {
    state.retainScratch = true;
    void pending;
    const failures = [...observedFailures, error];
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(
      failures,
      "Fixture finally settlement remained pending.",
    );
  }
  const failures = receipts.flatMap((receipt) =>
    receipt.status === "rejected" ? [receipt.reason] : [],
  );
  const done = receipts[1];
  if (done?.status === "fulfilled" && done.value.ownedTreeReleased !== true)
    failures.push(
      new Error("Fixture owner did not positively release its tree."),
    );
  if (failures.length > 0) {
    state.retainScratch = true;
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(failures, "Fixture owner cleanup failed.");
  }
}

async function withFixtureOwner<T>(
  body: () => Promise<T>,
  owner: () => FixtureOwner | null,
  state: OwnedProcessState,
  deadlineAt: number,
): Promise<T> {
  let value!: T;
  let primary: unknown;
  let failed = false;
  try {
    value = await body();
  } catch (error) {
    primary = error;
    failed = true;
  }
  let cleanup: unknown;
  let cleanupFailed = false;
  try {
    await finishFixtureOwner(owner(), state, deadlineAt);
  } catch (error) {
    cleanup = error;
    cleanupFailed = true;
  }
  if (failed && cleanupFailed)
    throw new AggregateError(
      [primary, cleanup],
      "Fixture work and final settlement both failed.",
      { cause: primary },
    );
  if (failed) throw primary;
  if (cleanupFailed) throw cleanup;
  return value;
}

describe("the test suite and the ledger under the user's home", () => {
  test("in the test process the default ledger is a temp directory, not the OS home", () => {
    const home = resolve(ledgerHome());
    expect(home.startsWith(resolve(tmpdir()) + sep)).toBe(true);
    expect(home).not.toBe(resolve(join(homedir(), ".agent-forge")));
    expect(resolve(ledgerPath())).toBe(join(home, "ledger.db"));
  });

  test("the scan finds the test files that start processes, directly or through a module they load", () => {
    const files = spawningTestFiles();
    expect(files).toEqual(
      expect.arrayContaining([
        "scripts/council/safety.test.ts",
        "scripts/forge/ledger-events.test.ts",
        "scripts/forge/stop-hook.test.ts",
        "scripts/ledger/audit-bead.test.ts",
        "scripts/ledger/audit-cli.test.ts",
        "scripts/ledger/db.test.ts",
        "scripts/ledger/hooks.test.ts",
        // Nothing in these files spawns: the modules they load do.
        "scripts/executors/exec-cli.test.ts",
        "scripts/hearth/supervisor.test.ts",
      ]),
    );
    // And it is a selection, not the whole suite.
    expect(files).not.toContain("scripts/ledger/ulid.test.ts");
    expect(files).not.toContain("scripts/ledger/paths.test.ts");
    expect(files).not.toContain("scripts/secret-patterns.test.ts");
  });

  test(
    "every test file that can start a process, re-run with the OS home pointed at a scratch directory and a child that names no home given <scratch>/.agent-forge as AGENT_FORGE_HOME, leaves no .agent-forge there",
    async () => {
      const workStarted = performance.now();
      const deadlineAt = workStarted + RERUN_WORK_CUTOFF_MS;
      const hardDeadlineAt = workStarted + RERUN_RETIRE_HARD_MS;
      const abort = new AbortController();
      const deadlineTimer = setTimeout(
        () =>
          abort.abort(
            new Error("Home-isolation aggregate work cutoff reached."),
          ),
        Math.max(0, deadlineAt - performance.now()),
      );
      const state: OwnedProcessState = {
        retainScratch: false,
        pendingObligations: 0,
      };
      let scratch: string | null = null;
      let failure: unknown = null;
      try {
        scratch = mkdtempSync(join(tmpdir(), "ledger isolation home "));
        const home = join(scratch, ".agent-forge");
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
          if (value === undefined || key === "AGENT_FORGE_HOME") continue;
          env[key] = value;
        }
        env.HOME = scratch;
        env.USERPROFILE = scratch;
        env[ISOLATION_HOME] = home;

        const files = spawningTestFiles();
        expect(
          await rerunEach(
            files,
            env,
            deadlineAt,
            hardDeadlineAt,
            abort.signal,
            state,
          ),
        ).toEqual([]);
        clearTimeout(deadlineTimer);
        expect(existsSync(home)).toBe(false);
      } catch (error) {
        failure = error;
      } finally {
        clearTimeout(deadlineTimer);
        if (scratch !== null) {
          try {
            if (performance.now() >= deadlineAt && state.pendingObligations > 0)
              state.retainScratch = true;
            const removed = disposeScratchHome(
              scratch,
              state.retainScratch || state.pendingObligations > 0,
            );
            if (!removed) {
              console.error(
                "[home-isolation] scratch retained because owner settlement was not confirmed",
              );
              if (failure === null)
                failure = new Error(
                  "Scratch home retained because process ownership is unresolved.",
                );
            }
          } catch (cleanupError) {
            failure =
              failure === null
                ? cleanupError
                : new AggregateError(
                    [failure, cleanupError],
                    "Home-isolation work and scratch cleanup both failed.",
                  );
          }
        }
      }
      if (failure !== null) throw failure;
    },
    RERUN_LIMIT_MS,
  );

  test("a test file that starts children with no home variable and no AGENT_FORGE_HOME, through Bun.spawn and through node:child_process, and runs an emitter in each, is caught by the re-run: both emitters' events land in the scratch .agent-forge", async () => {
    const { exitCode, failures, tail, home, sessions } =
      await rerunWithScratchHome([HOME_LESS_CHILD]);
    expect({
      exitCode,
      failures,
      tail,
      home: home !== null,
      sessions,
    }).toEqual({
      exitCode: 0,
      failures: "",
      tail: expect.any(String),
      home: true,
      sessions: ["home-less-bun-spawn", "home-less-child-process"],
    });
  }, 60_000);

  test("the interactive owner drains raw split UTF-8 and uncapped early stderr before exact stop settlement", async () => {
    const state: OwnedProcessState = {
      retainScratch: false,
      pendingObligations: 0,
    };
    const startedAt = performance.now();
    const deadlineAt = startedAt + 1_500;
    let fatal: unknown = null;
    const control: IsolationRerunControl = {
      signal: new AbortController().signal,
      deadlineAt,
      retirementDeadlineAt: deadlineAt,
      now: () => performance.now(),
      registerOwner: () => true,
      registerObligation<T>(promise: Promise<T>) {
        return promise;
      },
      failFatal(reason) {
        fatal ??= reason;
      },
    };
    let fixtureOwner: FixtureOwner | null = null;
    let readyResolve = () => {};
    const ready = new Promise<void>((resolve) => {
      readyResolve = resolve;
    });
    const script = [
      "let inputBytes = 0; process.stdin.on('data', (chunk) => { inputBytes += chunk.length; });",
      "process.stdin.on('end', () => {",
      "process.stderr.write('E'.repeat(5001));",
      "process.stdout.write(Buffer.from([0xe2]));",
      "process.stdout.write(Buffer.from([0x82, 0xac]));",
      "process.stdout.write(' RAW-READY-' + inputBytes + '\\n');",
      "setInterval(() => undefined, 1000);",
      "});",
    ].join("\n");
    await withFixtureOwner(
      async () => {
        const outcome = await runOwnedProcess(
          [process.execPath, "-e", script],
          REPO,
          Object.fromEntries(
            Object.entries(process.env).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
          control,
          state,
          {
            timeoutMs: 2_500,
            onLine(line) {
              if (line === "€ RAW-READY-0") readyResolve();
            },
            async afterStart(owner) {
              fixtureOwner = owner;
              await boundedFixtureWait(
                ready,
                deadlineAt,
                "Raw stream producer did not reach its ready marker.",
              );
              await owner.stop("raw pipe fixture complete");
            },
          },
        );
        expect(fatal).toBeNull();
        expect(state.retainScratch).toBe(false);
        expect(outcome.ownedTreeReleased).toBe(true);
        expect(outcome.stdout).toBe("€ RAW-READY-0\n");
        expect(outcome.stderr).toBe("E".repeat(5001));
      },
      () => fixtureOwner,
      state,
      deadlineAt,
    );
  });

  test("the exact registered interactive owner stops and positively settles a fixture with a live descendant", async () => {
    const state: OwnedProcessState = {
      retainScratch: false,
      pendingObligations: 0,
    };
    const startedAt = performance.now();
    const deadlineAt = startedAt + 4_000;
    let fatal: unknown = null;
    let fixtureOwner: FixtureOwner | null = null;
    let descendantResolve = (_pid: number) => {};
    const descendant = new Promise<number>((resolve) => {
      descendantResolve = resolve;
    });
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    await withFixtureOwner(
      async () => {
        const outcome = await runOwnedProcess(
          [
            process.execPath,
            join(REPO, "scripts", "executors", "fixtures", "fake-cli.ts"),
            "--fake-provider",
            "codex",
            "--fake-mode",
            "hang-tree",
          ],
          REPO,
          env,
          {
            signal: new AbortController().signal,
            deadlineAt,
            retirementDeadlineAt: deadlineAt,
            now: () => performance.now(),
            registerOwner(owner) {
              return owner.done !== undefined;
            },
            registerObligation<T>(promise: Promise<T>) {
              return promise;
            },
            failFatal(reason) {
              fatal ??= reason;
            },
          },
          state,
          {
            timeoutMs: 2_500,
            onLine(line) {
              try {
                const parsed = JSON.parse(line) as { childPid?: unknown };
                if (typeof parsed.childPid === "number")
                  descendantResolve(parsed.childPid);
              } catch {
                /* Ignore other inert fake-provider lines. */
              }
            },
            async afterStart(owner) {
              fixtureOwner = owner;
              const childPid = await boundedFixtureWait(
                descendant,
                deadlineAt,
                "The inert descendant marker was not observed.",
              );
              expect(childPid).toBeGreaterThan(0);
              expect(() => process.kill(childPid, 0)).not.toThrow();
              await owner.stop("owned-tree fixture stop");
            },
          },
        );
        expect(fatal).toBeNull();
        expect(outcome.ownedTreeReleased).toBe(true);
        expect(outcome.stdout).toContain('"childPid":');
        expect(state.retainScratch).toBe(false);
      },
      () => fixtureOwner,
      state,
      deadlineAt,
    );
  });
});

test("the adapter refuses expiry immediately before bootstrap acquisition", async () => {
  let factoryCalls = 0;
  let clockCalls = 0;
  const state: OwnedProcessState = {
    retainScratch: false,
    pendingObligations: 0,
  };
  const control: IsolationRerunControl = {
    signal: new AbortController().signal,
    deadlineAt: 10,
    retirementDeadlineAt: 100,
    now: () => (++clockCalls >= 3 ? 10 : 0),
    registerOwner: () => true,
    registerObligation<T>(promise: Promise<T>) {
      return promise;
    },
    failFatal: () => {},
  };
  const empty = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
  await expect(
    runOwnedProcess([process.execPath, "-e", ""], REPO, {}, control, state, {
      rawCaptureForTest: () => ({ stdout: empty(), stderr: empty() }),
      superviseForTest() {
        factoryCalls++;
        throw new Error("must not launch");
      },
    }),
  ).rejects.toThrow("before launch");
  expect(factoryCalls).toBe(0);
  expect(clockCalls).toBe(3);
  expect(state.retainScratch).toBe(false);
});

test("the adapter stops an acquired exact owner when expiry lands before grant", async () => {
  let ownerRegistered = false;
  const registeredDone: { value?: Promise<unknown> } = {};
  let factoryCalls = 0;
  const savedGrant: { current: (() => Promise<void>) | null } = {
    current: null,
  };
  let stopCalls = 0;
  const state: OwnedProcessState = {
    retainScratch: false,
    pendingObligations: 0,
  };
  const done = Promise.resolve({
    exitCode: 0,
    timedOut: false,
    stopped: true,
    stderr: "",
    ownedTreeReleased: true as const,
  });
  const empty = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
  const control: IsolationRerunControl = {
    signal: new AbortController().signal,
    deadlineAt: 5,
    retirementDeadlineAt: performance.now() + 2_000,
    now: () => (ownerRegistered ? 5 : 0),
    registerOwner(owner) {
      registeredDone.value = owner.done;
      ownerRegistered = true;
      return true;
    },
    registerObligation<T>(promise: Promise<T>) {
      return promise;
    },
    failFatal: () => {},
  };
  const factory: NonNullable<OwnedProcessTestHook["superviseForTest"]> = ({
    beforeStart,
  }) => {
    factoryCalls++;
    savedGrant.current = beforeStart;
    return {
      pid: 99,
      done,
      providerPid: Promise.resolve(100),
      stop: async () => {
        stopCalls++;
      },
      write: async () => {},
      end: async () => {},
    } as InteractiveSupervised;
  };
  await expect(
    runOwnedProcess([process.execPath, "-e", ""], REPO, {}, control, state, {
      rawCaptureForTest: () => ({ stdout: empty(), stderr: empty() }),
      superviseForTest: factory,
    }),
  ).rejects.toThrow("admission");
  expect(factoryCalls).toBe(1);
  expect(ownerRegistered).toBe(true);
  expect(registeredDone.value).toBe(done);
  expect(savedGrant.current).toEqual(expect.any(Function));
  const grant = savedGrant.current;
  if (grant === null)
    throw new Error("Expected the captured owner grant callback.");
  await expect(grant()).rejects.toThrow("before grant");
  expect(stopCalls).toBe(1);
  expect(state.retainScratch).toBe(false);
});

test("a raw tee reader failure is fatal and retains scratch despite a returned owner", async () => {
  const readerFailure = new Error("controlled raw capture failure");
  let fatal: unknown = null;
  let stopCalls = 0;
  const state: OwnedProcessState = {
    retainScratch: false,
    pendingObligations: 0,
  };
  const control: IsolationRerunControl = {
    signal: new AbortController().signal,
    deadlineAt: performance.now() + 2_000,
    retirementDeadlineAt: performance.now() + 2_000,
    now: () => performance.now(),
    registerOwner(owner) {
      return owner.done !== undefined;
    },
    registerObligation<T>(promise: Promise<T>) {
      return promise;
    },
    failFatal(reason) {
      fatal ??= reason;
    },
  };
  const failureStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(readerFailure);
    },
  });
  const emptyStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
  const factory: NonNullable<OwnedProcessTestHook["superviseForTest"]> = () =>
    ({
      pid: 101,
      done: Promise.resolve({
        exitCode: 0,
        timedOut: false,
        stopped: false,
        stderr: "",
        ownedTreeReleased: true as const,
      }),
      providerPid: Promise.resolve(102),
      stop: async () => {
        stopCalls++;
      },
      write: async () => {},
      end: async () => {},
    }) as InteractiveSupervised;

  await expect(
    runOwnedProcess([process.execPath, "-e", ""], REPO, {}, control, state, {
      superviseForTest: factory,
      rawCaptureForTest: () => ({ stdout: failureStream, stderr: emptyStream }),
    }),
  ).rejects.toBe(readerFailure);
  expect(fatal).toBe(readerFailure);
  expect(stopCalls).toBe(1);
  expect(state.retainScratch).toBe(true);
});

test("a trusted supervisor output-guard failure remains fatal through owner refusal and settlement", async () => {
  const state: OwnedProcessState = {
    retainScratch: false,
    pendingObligations: 0,
  };
  let stopCalls = 0;
  let beforeGrantCalls = 0;
  const savedGrant: { current: (() => Promise<void>) | null } = {
    current: null,
  };
  const empty = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
  const results = await settleIsolationReruns(
    ["guard-failure.test.ts"],
    1,
    async (_file, control) =>
      runOwnedProcess([process.execPath, "-e", ""], REPO, {}, control, state, {
        rawCaptureForTest: () => ({ stdout: empty(), stderr: empty() }),
        superviseForTest({ beforeStart, onOutputError }) {
          savedGrant.current = beforeStart;
          onOutputError();
          return {
            pid: 201,
            done: Promise.resolve({
              exitCode: 0,
              timedOut: false,
              stopped: true,
              stderr: "",
              ownedTreeReleased: true as const,
            }),
            providerPid: Promise.resolve(202),
            stop: async () => {
              stopCalls++;
            },
            write: async () => {},
            end: async () => {},
          } as InteractiveSupervised;
        },
        async afterStart() {
          beforeGrantCalls++;
        },
      }),
    undefined,
    { hardDeadlineAt: performance.now() + 2_000 },
  );
  expect(results[0]?.status).toBe("rejected");
  if (results[0]?.status !== "rejected")
    throw new Error("Expected fatal guard rejection");
  expect(results[0].reason).toBeInstanceOf(Error);
  expect(results[0].reason).toMatchObject({
    message: "The interactive output reader failed.",
  });
  expect(results[0].failureRecord?.primary).toBe(results[0].reason);
  expect(stopCalls).toBe(1);
  expect(savedGrant.current).toEqual(expect.any(Function));
  const grant = savedGrant.current;
  if (grant === null)
    throw new Error("Expected the captured owner grant callback.");
  await expect(grant()).rejects.toBe(results[0].reason);
  expect(beforeGrantCalls).toBe(0);
  expect(state.retainScratch).toBe(false);
});

test("unsettled ownership refuses scratch deletion and preserves its contents", () => {
  const scratch = mkdtempSync(join(tmpdir(), "ledger isolation home "));
  const marker = join(scratch, "owned-evidence.txt");
  writeFileSync(marker, "preserve while owner is unsettled");
  try {
    expect(disposeScratchHome(scratch, true)).toBe(false);
    expect(readFileSync(marker, "utf8")).toBe(
      "preserve while owner is unsettled",
    );
    expect(existsSync(scratch)).toBe(true);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("fixture cleanup failure is visible and preserves both body and cleanup errors", async () => {
  const bodyFailure = new Error("fixture body failed");
  const cleanupFailure = new Error("fixture Stop failed");
  const state: OwnedProcessState = {
    retainScratch: false,
    pendingObligations: 0,
  };
  const owner: FixtureOwner = {
    providerPid: Promise.resolve(1),
    done: Promise.resolve({
      exitCode: 0,
      timedOut: false,
      stopped: true,
      stderr: "",
      ownedTreeReleased: true,
    }),
    stdout: Promise.resolve(""),
    stderr: Promise.resolve(""),
    async stop() {
      throw cleanupFailure;
    },
  };
  let combined: unknown;
  try {
    await withFixtureOwner(
      async () => {
        throw bodyFailure;
      },
      () => owner,
      state,
      performance.now() + 500,
    );
  } catch (error) {
    combined = error;
  }
  expect(combined).toBeInstanceOf(AggregateError);
  expect(combined).toMatchObject({
    errors: [bodyFailure, cleanupFailure],
    cause: bodyFailure,
  });
  expect(state.retainScratch).toBe(true);
  const record: IsolationFailureRecord = {
    file: "fixture",
    primary: bodyFailure,
    hasPrimary: true,
    secondaryErrors: [cleanupFailure],
  };
  expect(describeFailure(bodyFailure, record)).toBe(
    "Error: fixture body failed\ncleanup: Error: fixture Stop failed",
  );
  await expect(
    withFixtureOwner(
      async () => "result",
      () => owner,
      state,
      performance.now() + 500,
    ),
  ).rejects.toBe(cleanupFailure);
  const doneFailure = new Error("fixture done failed");
  const doneOwner: FixtureOwner = {
    ...owner,
    done: Promise.reject(doneFailure),
    stop: async () => {},
  };
  await expect(
    withFixtureOwner(
      async () => "done",
      () => doneOwner,
      state,
      performance.now() + 500,
    ),
  ).rejects.toBe(doneFailure);
});

test("fixture cleanup retains every synchronous Stop and simultaneous settlement failure", async () => {
  const stopFailure = new Error("synchronous Stop failure");
  const doneFailure = new Error("done failure");
  const stdoutFailure = new Error("stdout capture failure");
  const stderrFailure = new Error("stderr capture failure");
  const state: OwnedProcessState = {
    retainScratch: false,
    pendingObligations: 0,
  };
  const owner: FixtureOwner = {
    providerPid: Promise.resolve(1),
    done: Promise.reject(doneFailure),
    stdout: Promise.reject(stdoutFailure),
    stderr: Promise.reject(stderrFailure),
    stop() {
      throw stopFailure;
    },
  };
  await expect(
    withFixtureOwner(
      async () => "body complete",
      () => owner,
      state,
      performance.now() + 500,
    ),
  ).rejects.toMatchObject({
    errors: [stopFailure, doneFailure, stdoutFailure, stderrFailure],
  });
  expect(state.retainScratch).toBe(true);
});

test("a synchronous Stop failure with unsettled receipts preserves the actual scratch leaf", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "ledger isolation home "));
  const marker = join(scratch, "owned-evidence.txt");
  writeFileSync(marker, "retain until all owner receipts settle");
  let releaseDone: (value: Awaited<InteractiveSupervised["done"]>) => void =
    () => {};
  let releaseStdout: (value: string) => void = () => {};
  let releaseStderr: (value: string) => void = () => {};
  const done = new Promise<Awaited<InteractiveSupervised["done"]>>(
    (resolve) => {
      releaseDone = resolve;
    },
  );
  const stdout = new Promise<string>((resolve) => {
    releaseStdout = resolve;
  });
  const stderr = new Promise<string>((resolve) => {
    releaseStderr = resolve;
  });
  const state: OwnedProcessState = {
    retainScratch: false,
    pendingObligations: 0,
  };
  const owner: FixtureOwner = {
    providerPid: Promise.resolve(1),
    done,
    stdout,
    stderr,
    stop() {
      throw new Error("synchronous Stop failure");
    },
  };
  try {
    await expect(
      withFixtureOwner(
        async () => "body complete",
        () => owner,
        state,
        performance.now() + 20,
      ),
    ).rejects.toMatchObject({
      message: "Fixture finally settlement remained pending.",
      errors: [
        expect.objectContaining({ message: "synchronous Stop failure" }),
        expect.any(Error),
      ],
    });
    expect(state.retainScratch).toBe(true);
    expect(disposeScratchHome(scratch, state.retainScratch)).toBe(false);
    expect(readFileSync(marker, "utf8")).toBe(
      "retain until all owner receipts settle",
    );
  } finally {
    releaseDone({
      exitCode: 0,
      timedOut: false,
      stopped: true,
      stderr: "",
      ownedTreeReleased: true,
    });
    releaseStdout("");
    releaseStderr("");
    await Promise.all([done, stdout, stderr]);
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the capture reader reassembles a controlled UTF-8 code point split across chunks without a newline", async () => {
  const fatal: unknown[] = [];
  const control: IsolationRerunControl = {
    signal: new AbortController().signal,
    deadlineAt: performance.now() + 1_000,
    retirementDeadlineAt: performance.now() + 1_000,
    now: () => performance.now(),
    registerOwner: () => false,
    registerObligation<T>(promise: Promise<T>) {
      return promise;
    },
    failFatal(reason) {
      fatal.push(reason);
    },
  };
  const chunks = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.of(0xe2));
      queueMicrotask(() => {
        controller.enqueue(Uint8Array.of(0x82, 0xac));
        controller.enqueue(new TextEncoder().encode("raw-tail"));
        controller.close();
      });
    },
  });
  expect(await observeRawText(chunks, control)).toBe("€raw-tail");
  expect(fatal).toEqual([]);
});

test("settled native exit zero stays success and nonzero preserves the existing report", () => {
  const base: OwnedProcessResult = {
    exitCode: 0,
    stdout: "",
    stderr: "",
    providerPid: 5,
    ownedTreeReleased: true,
  };
  expect(summarizeRerun("ok.test.ts", base)).toBeNull();
  const failed = summarizeRerun("failed.test.ts", {
    ...base,
    exitCode: 2,
    stdout: "\n(fail) controlled assertion\n",
    stderr: "controlled stderr",
  });
  expect(failed).toMatchObject({
    file: "failed.test.ts",
    exitCode: 2,
    failures: expect.stringContaining("(fail) controlled assertion"),
    tail: expect.stringContaining("controlled stderr"),
  });
});
