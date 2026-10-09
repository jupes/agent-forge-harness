#!/usr/bin/env bun

/**
 * quality-gate.ts
 *
 * Triggered on TaskCompleted and TeammateIdle events.
 * Runs core checks plus optional strict evaluator verdict (see AGENT_FORGE_EVAL_VERDICT).
 * Exits with code 2 to block completion if any fail.
 * Outputs structured JSON for agent consumption.
 *
 * Which event this is comes from the host's JSON on stdin, else from a
 * `TaskCompleted` / `TeammateIdle` token on the command line, else it is a run
 * by hand and acts as TaskCompleted. Stdin that arrived and is not one of
 * those two payloads fails the gate before anything is checked.
 *
 * The Beads issue and the Forge run come only from a run correlation: the file
 * `--correlation <path>` or `AGENT_FORGE_RUN_CORRELATION` points at (see
 * `scripts/run-correlation.ts`). Without one the base checks still run and the
 * result is logged as unlinked: it names no issue and no run, nothing is asked
 * of Beads and the strict verdict check fails. A `--correlation` that does
 * not validate fails the gate outright. What the host says about itself on
 * stdin is recorded in the log entry and goes nowhere else.
 *
 * Each run is also appended to the event ledger as `gate.ran`, and a verdict
 * the strict check read as `verdict.bound`.
 *
 * Pure logic is exported (and tested in `scripts/quality-gate-hook.test.ts`);
 * the block at the bottom is the only part that runs as the hook.
 */

import { Glob } from "bun";
import { execSync } from "child_process";
import { appendFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { evaluateCloseTestingAttestation } from "../../scripts/close-testing-attestation";
import {
  type EvalVerdictParsed,
  parseEvalVerdictJson,
  verdictBlocksShip,
} from "../../scripts/eval-verdict";
import { readRunState } from "../../scripts/forge/runs-store";
import {
  type ExecFile,
  execFileNoShell,
  readBeadsIssue,
} from "../../scripts/quality-gate-beads";
import {
  type GateEvent,
  type GateEventSource,
  type GateIdentity,
  type GateStdinState,
  gateIdentity,
  gateInvocation,
} from "../../scripts/quality-gate-identity";
import type { RunCorrelation } from "../../scripts/run-correlation";
import { pointedRunCorrelation } from "../../scripts/run-correlation-store";
import { getQualityGateLogPath } from "./utils/constants";
import { type HookStdin, readHookStdin } from "./utils/hook-input";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * How long the gate waits for the host's payload. Longer than the other hooks
 * wait: a late payload here would log a TeammateIdle as a TaskCompleted.
 */
const GATE_STDIN_WAIT_MS = 2_000;

/** Far above either payload: an event name, a few ids, a task's subject and description. */
const GATE_STDIN_MAX_BYTES = 1024 * 1024;

/** The gate blocks completion with this exit code. */
const EXIT_BLOCKED = 2;

interface CheckResult {
  name: string;
  passed: boolean;
  output?: string;
  skipped?: boolean;
  skipReason?: string;
}

/**
 * One gate run as logged. The log is shared by every checkout on the machine,
 * so each entry carries the identity of the checkout and run it came from.
 */
export interface GateResult extends GateIdentity {
  event: GateEvent;
  eventSource: GateEventSource;
  /** What stdin was: with the default event, `silent` is a payload that never came. */
  stdin: GateStdinState;
  timestamp: string;
  passed: boolean;
  checks: CheckResult[];
  blockingFailures: string[];
}

/** Everything the gate touches outside its arguments, so tests can replace it. */
export interface GateDeps {
  cwd: string;
  env: Env;
  /** Runs one of the gate's own fixed command lines. Never given a value from outside. */
  run(cmd: string): { ok: boolean; output: string };
  /** Runs a program with an argument array and no shell: how `bd` is called. */
  execFile: ExecFile;
  hasScript(name: string): boolean;
  hasTestFiles(): boolean;
}

export type GateOutcome =
  /** Stdin, or the `--correlation` flag, was not something the gate accepts. Nothing was checked. */
  | { kind: "refused"; error: string }
  | {
      kind: "ran";
      result: GateResult;
      correlation: RunCorrelation | null;
      /** The verdict the strict check read and matched to the bead, if it got that far. */
      strictVerdict: EvalVerdictParsed | null;
      /** The hook event that ran the gate; absent for a run by hand. */
      trigger?: GateEvent;
      /** Something the caller should see on stderr that did not block the run. */
      notice?: string;
    };

const SKIP_UNLINKED = "no run correlation";
const SKIP_NOT_SHOWN = "bd could not show the correlated issue";

/**
 * The checks for one gate run. Given the event and the correlation only: what
 * the host sent on stdin is not in scope here.
 */
function runChecks(
  event: GateEvent,
  correlation: RunCorrelation | null,
  deps: GateDeps,
): {
  checks: CheckResult[];
  blockingFailures: string[];
  strictVerdict: EvalVerdictParsed | null;
} {
  const { run } = deps;
  const checks: CheckResult[] = [];
  const blockingFailures: string[] = [];
  let strictVerdict: EvalVerdictParsed | null = null;

  // Check 1: TypeScript typecheck
  {
    const r = run("bun run typecheck");
    checks.push({
      name: "typecheck",
      passed: r.ok,
      ...(r.ok ? {} : { output: r.output.slice(0, 800) }),
    });
    if (!r.ok) blockingFailures.push("typecheck");
  }

  // Check 2: Lint (skip if no lint script)
  if (deps.hasScript("lint")) {
    const r = run("bun run lint");
    checks.push({
      name: "lint",
      passed: r.ok,
      ...(r.ok ? {} : { output: r.output.slice(0, 800) }),
    });
    if (!r.ok) blockingFailures.push("lint");
  } else {
    checks.push({
      name: "lint",
      passed: true,
      skipped: true,
      skipReason: "no lint script in package.json",
    });
  }

  // Check 3: Tests (skip if no test files)
  if (deps.hasTestFiles()) {
    const r = run(deps.hasScript("test") ? "bun run test" : "bun test scripts");
    checks.push({
      name: "tests",
      passed: r.ok,
      ...(r.ok ? {} : { output: r.output.slice(0, 1200) }),
    });
    if (!r.ok) blockingFailures.push("tests");
  } else {
    checks.push({
      name: "tests",
      passed: true,
      skipped: true,
      skipReason: "no test files found",
    });
  }

  // Check 4: Clean working tree
  {
    const r = run("git status --porcelain");
    const clean = r.ok && r.output.trim() === "";
    checks.push({
      name: "clean-tree",
      passed: clean,
      ...(clean ? {} : { output: r.output.slice(0, 400) }),
    });
    if (!clean) blockingFailures.push("clean-tree");
  }

  // TaskCompleted-only checks
  if (event !== "TaskCompleted") {
    return { checks, blockingFailures, strictVerdict };
  }

  // Checks 5 and 6 read the Beads issue the run is correlated to.
  if (correlation === null) {
    for (const name of ["ac-verify", "close-testing-attestation"]) {
      checks.push({
        name,
        passed: true,
        skipped: true,
        skipReason: SKIP_UNLINKED,
      });
    }
  } else {
    const issue = readBeadsIssue(correlation.beadsIssueId, deps.execFile);

    // Check 5: AC verification
    if (!issue.shown) {
      checks.push({
        name: "ac-verify",
        passed: true,
        skipped: true,
        skipReason: SKIP_NOT_SHOWN,
      });
    } else if (issue.acceptanceListed) {
      // AC list was found — mark as needing human/agent verification
      checks.push({
        name: "ac-verify",
        passed: true,
        output: "AC found — verify before closing task",
      });
    } else {
      checks.push({
        name: "ac-verify",
        passed: true,
        skipped: true,
        skipReason: "no AC found or Beads not configured",
      });
    }

    // Check 6: Feature/Epic close testing attestation
    const attestation = evaluateCloseTestingAttestation(
      issue.issueType,
      issue.commentBodies,
    );
    if (!attestation.required) {
      checks.push({
        name: "close-testing-attestation",
        passed: true,
        skipped: true,
        skipReason: issue.shown
          ? `issue type ${issue.issueType} does not require attestation`
          : SKIP_NOT_SHOWN,
      });
    } else {
      checks.push({
        name: "close-testing-attestation",
        passed: attestation.passed,
        ...(attestation.passed
          ? {}
          : { output: attestation.guidance ?? "testing attestation required" }),
      });
      if (!attestation.passed)
        blockingFailures.push("close-testing-attestation");
    }
  }

  // Check 7: Test evidence (recent commits should include test files)
  {
    const r = run("git log --oneline --name-only -5");
    const hasRecentTests =
      r.ok && (r.output.includes(".test.") || r.output.includes(".spec."));
    checks.push({
      name: "test-evidence",
      passed: hasRecentTests,
      ...(hasRecentTests
        ? {}
        : {
            output:
              "No test files in recent commits — ensure tests were committed",
          }),
    });
    if (!hasRecentTests) blockingFailures.push("test-evidence");
  }

  // Check 8 (optional): strict evaluator verdict JSON
  {
    const mode = (deps.env["AGENT_FORGE_EVAL_VERDICT"] ?? "")
      .trim()
      .toLowerCase();
    if (mode === "strict") {
      if (correlation === null) {
        checks.push({
          name: "eval-verdict",
          passed: false,
          output:
            "AGENT_FORGE_EVAL_VERDICT=strict requires a run correlation: pass --correlation <path> or set AGENT_FORGE_RUN_CORRELATION (bun run forge:correlate --bead <id>)",
        });
        blockingFailures.push("eval-verdict");
      } else {
        const bead = correlation.beadsIssueId;
        const verdictPath = join(
          deps.cwd,
          ".tmp",
          "work",
          `${bead}-verdict.json`,
        );
        if (!existsSync(verdictPath)) {
          checks.push({
            name: "eval-verdict",
            passed: false,
            output: `Missing verdict file: ${verdictPath}`,
          });
          blockingFailures.push("eval-verdict");
        } else {
          let text: string;
          try {
            text = readFileSync(verdictPath, "utf8");
          } catch {
            checks.push({
              name: "eval-verdict",
              passed: false,
              output: `Could not read verdict file: ${verdictPath}`,
            });
            blockingFailures.push("eval-verdict");
            text = "";
          }
          if (text.trim() === "" && blockingFailures.includes("eval-verdict")) {
            // read already failed
          } else if (text.trim() === "") {
            checks.push({
              name: "eval-verdict",
              passed: false,
              output: `Empty verdict file: ${verdictPath}`,
            });
            blockingFailures.push("eval-verdict");
          } else {
            const pr = parseEvalVerdictJson(text);
            if (!pr.ok) {
              checks.push({
                name: "eval-verdict",
                passed: false,
                output: pr.error,
              });
              blockingFailures.push("eval-verdict");
            } else if (pr.value.taskId !== bead) {
              checks.push({
                name: "eval-verdict",
                passed: false,
                output: `verdict taskId "${pr.value.taskId}" !== correlation beadsIssueId "${bead}"`,
              });
              blockingFailures.push("eval-verdict");
            } else if (verdictBlocksShip(pr.value)) {
              strictVerdict = pr.value;
              checks.push({
                name: "eval-verdict",
                passed: false,
                output: `verdict FAIL with blocker/high — ${JSON.stringify(pr.value.findings)}`,
              });
              blockingFailures.push("eval-verdict");
            } else {
              strictVerdict = pr.value;
              checks.push({
                name: "eval-verdict",
                passed: true,
                output: `${pr.value.verdict} B=${pr.value.findings.blocker} H=${pr.value.findings.high}`,
              });
            }
          }
        }
      }
    } else {
      checks.push({
        name: "eval-verdict",
        passed: true,
        skipped: true,
        skipReason:
          mode === ""
            ? "set AGENT_FORGE_EVAL_VERDICT=strict to require .tmp/work/<TASK-ID>-verdict.json"
            : `AGENT_FORGE_EVAL_VERDICT="${mode}" is not strict`,
      });
    }
  }

  return { checks, blockingFailures, strictVerdict };
}

/**
 * One gate run: what stdin and the command line say it is for, the run
 * correlation it was pointed at, the checks, and the entry to log.
 */
export function runQualityGate(input: {
  stdin: HookStdin;
  argv: readonly string[];
  deps: GateDeps;
}): GateOutcome {
  const { deps } = input;
  const invocation = gateInvocation(input.stdin, input.argv);
  if (!invocation.ok) return { kind: "refused", error: invocation.error };

  // The log is shared by every checkout and worktree on the machine, so record
  // which checkout this result belongs to.
  const toplevel = deps.run("git rev-parse --show-toplevel");
  const checkoutRoot =
    toplevel.ok && toplevel.output ? toplevel.output : deps.cwd;
  const pointed = pointedRunCorrelation({
    argv: input.argv,
    env: deps.env,
    checkout: checkoutRoot,
  });
  // Whoever passed the flag is right here to see it fail. A pointer from the
  // environment was set by a launcher the run cannot repair: carry on unlinked.
  if (!pointed.linked && pointed.refused === "flag") {
    return { kind: "refused", error: pointed.reason };
  }
  const correlation = pointed.linked ? pointed.correlation : null;

  const { checks, blockingFailures, strictVerdict } = runChecks(
    invocation.event,
    correlation,
    deps,
  );

  const headBranch = deps.run("git rev-parse --abbrev-ref HEAD");
  const result: GateResult = {
    ...gateIdentity({
      cwd: deps.cwd,
      gitToplevel: toplevel.ok ? toplevel.output : null,
      gitBranch: headBranch.ok ? headBranch.output : null,
      correlation,
      ...(pointed.linked ? {} : { unlinkedReason: pointed.reason }),
      ...(invocation.host ? { host: invocation.host } : {}),
    }),
    event: invocation.event,
    eventSource: invocation.eventSource,
    stdin: invocation.stdin,
    timestamp: new Date().toISOString(),
    passed: blockingFailures.length === 0,
    checks,
    blockingFailures,
  };
  return {
    kind: "ran",
    result,
    correlation,
    strictVerdict,
    ...(invocation.eventSource === "stdin"
      ? { trigger: invocation.event }
      : {}),
    ...(!pointed.linked && pointed.refused === "env"
      ? { notice: pointed.reason }
      : {}),
  };
}

// ── The hook ─────────────────────────────────────────────────────────────────

function run(cmd: string, cwd?: string): { ok: boolean; output: string } {
  try {
    const output = execSync(cmd, {
      cwd: cwd ?? process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    return { ok: true, output: output.trim() };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

function hasScript(name: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    return Boolean(pkg?.scripts?.[name]);
  } catch {
    return false;
  }
}

function hasTestFiles(): boolean {
  const cwd = process.cwd();
  const patterns = [
    "**/*.test.ts",
    "**/*.test.tsx",
    "**/*.spec.ts",
    "**/*.spec.tsx",
  ];
  for (const pattern of patterns) {
    const glob = new Glob(pattern);
    for (const file of glob.scanSync({ cwd, onlyFiles: true })) {
      const norm = file.replaceAll("\\", "/");
      if (norm.includes("node_modules/")) continue;
      if (norm.startsWith("repos/") || norm.startsWith("trees/")) continue;
      return true;
    }
  }
  return false;
}

if (import.meta.main) {
  const startedAt = performance.now();
  let stdin: HookStdin;
  try {
    stdin = await readHookStdin({
      waitMs: GATE_STDIN_WAIT_MS,
      maxBytes: GATE_STDIN_MAX_BYTES,
    });
  } catch {
    // No stdin to read at all: the same as a run by hand.
    stdin = { kind: "none", reason: "silent" };
  }

  const outcome = runQualityGate({
    stdin,
    argv: process.argv.slice(2),
    deps: {
      cwd: process.cwd(),
      env: process.env,
      run,
      execFile: execFileNoShell,
      hasScript,
      hasTestFiles,
    },
  });

  if (outcome.kind === "refused") {
    console.error(`quality-gate: ${outcome.error}. Nothing was checked.`);
    process.exit(EXIT_BLOCKED);
  }
  const { result, correlation, strictVerdict } = outcome;
  if (outcome.notice !== undefined) {
    console.error(`quality-gate: ${outcome.notice}`);
  }

  // Log to file
  try {
    appendFileSync(getQualityGateLogPath(), JSON.stringify(result) + "\n");
  } catch {
    // Log failure is non-fatal
  }

  // Record the run in the event ledger. Loaded and run inside the guard: the
  // gate's verdict never depends on its audit trail.
  try {
    const ledger = await import("../../scripts/quality-gate-ledger");
    const { appendEvent } = await import("../../scripts/ledger/append");
    const runState =
      correlation !== null
        ? readRunState(correlation.executionRunId, result.checkout)
        : null;
    const attach = ledger.gateAttach({
      cwd: process.cwd(),
      env: process.env,
      correlation,
      state: runState,
    });
    if (strictVerdict !== null) {
      appendEvent(
        ledger.strictVerdictEvent({
          verdict: strictVerdict,
          ...(runState?.executor ? { builder: runState.executor } : {}),
          attach,
        }),
      );
    }
    appendEvent(
      ledger.gateRanEvent({
        result,
        durationMs: performance.now() - startedAt,
        ...(outcome.trigger !== undefined ? { trigger: outcome.trigger } : {}),
        attach,
      }),
    );
  } catch (error) {
    console.error(
      `quality-gate: ledger event not recorded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Output JSON for agent consumption
  console.log(JSON.stringify(result, null, 2));

  if (!result.passed) {
    console.error(
      `\nQuality gate FAILED. Blocking failures: ${result.blockingFailures.join(", ")}`,
    );
    process.exit(EXIT_BLOCKED);
  }

  process.exit(0);
}
