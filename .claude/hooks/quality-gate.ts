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
 * Which checks run follows the checkout the correlation names
 * (`scripts/quality-gate-repos.ts`). A run in the checkout the gate runs in
 * gets the gate's own command lines. A run in a repository under the
 * harness's `repos/` (or a worktree of one) gets the `checks` list on its
 * entry in `repos/repos.json`, each run in the run's checkout as an argument
 * array without a shell, then clean-tree and test-evidence there too; the
 * entry is logged as that checkout's, with `repository` set. Such a
 * repository with no usable check set, or one that tracks files where run
 * correlations or verdicts are kept, is refused before anything runs.
 *
 * In strict mode the run's evaluator verdict is read from the one path the
 * correlation's run id declares (`scripts/eval-verdict-store.ts`), once: the
 * bytes that are validated are the bytes that are hashed, and the log entry
 * carries their path, digest and size with the ids and evaluator they name.
 *
 * Each run is also appended to the event ledger as `gate.ran`, and a verdict
 * the strict check bound as `verdict.bound`.
 *
 * Pure logic is exported (and tested in `scripts/quality-gate-hook.test.ts`);
 * the block at the bottom is the only part that runs as the hook.
 */

import { Glob } from "bun";
import { execSync } from "child_process";
import { appendFileSync, readFileSync } from "fs";
import { join } from "path";
import { evaluateCloseTestingAttestation } from "../../scripts/close-testing-attestation";
import { loadConfig } from "../../scripts/config/load";
import {
  type EvalVerdict,
  parseEvalVerdictJson,
  verdictBlocksShip,
  verdictForRun,
  verdictReviewProblem,
} from "../../scripts/eval-verdict";
import {
  type ReadVerdictResult,
  readVerdictOnce,
} from "../../scripts/eval-verdict-store";
import { strictEvaluatorProblem } from "../../scripts/evaluator-policy";
import type { ForgeState } from "../../scripts/forge/phases";
import { readRunState } from "../../scripts/forge/runs-store";
import { isMain } from "../../scripts/is-main";
import {
  type ExecFile,
  execFileNoShell,
  readBeadsIssue,
} from "../../scripts/quality-gate-beads";
import {
  type EvaluatorArtifactReference,
  type GateEvent,
  type GateEventSource,
  type GateIdentity,
  type GateStdinState,
  gateIdentity,
  gateInvocation,
} from "../../scripts/quality-gate-identity";
import {
  EVIDENCE_DIRS,
  HARNESS_FILES,
  type RunCheckSet,
  runCheckSet,
} from "../../scripts/quality-gate-repos";
import {
  correlationPointer,
  type RunCorrelation,
} from "../../scripts/run-correlation";
import { pointedRunCorrelationAnywhere } from "../../scripts/run-correlation-store";
import type { EvaluatorIdentity, Smith } from "../../types/hearth";
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
  /** The evaluator verdict the strict check bound. Absent when it bound none. */
  evaluatorArtifact?: EvaluatorArtifactReference;
  /**
   * For a run in a repository under `repos/`: the entry in `repos/repos.json`
   * whose checks ran, in `checkout`. Absent when the gate's own checks ran.
   */
  repository?: string;
}

/** A run whose checks are its repository's (`scripts/quality-gate-repos.ts`). */
type RepositoryRun = Extract<RunCheckSet, { kind: "repository" }>;

/** Everything the gate touches outside its arguments, so tests can replace it. */
export interface GateDeps {
  cwd: string;
  env: Env;
  /** Runs one of the gate's own fixed command lines. Never given a value from outside. */
  run(cmd: string): { ok: boolean; output: string };
  /**
   * Runs a program with an argument array and no shell: how `bd`, git for the
   * test evidence, and every call for a run in a repository under `repos/`
   * (its checks and git) are made.
   */
  execFile: ExecFile;
  /** The checkout this gate belongs to: `repos/` is looked up in its main checkout. */
  harness: string;
  /** A file's text, or null when it cannot be read: how `repos/repos.json` is read. */
  registry(file: string): string | null;
  hasScript(name: string): boolean;
  hasTestFiles(): boolean;
  /** The smiths configured for the checkout: where a provider and model get a rank. */
  smiths(checkout: string): readonly Smith[];
  /** The stored state of a Forge run in the checkout, when it has one. */
  runState(runId: string, checkout: string): ForgeState | null;
  /** Reads a run's evaluator verdict at its declared path: called at most once per gate run. */
  readVerdict(checkout: string, executionRunId: string): ReadVerdictResult;
}

export type GateOutcome =
  /** Stdin, or the `--correlation` flag, was not something the gate accepts. Nothing was checked. */
  | { kind: "refused"; error: string }
  | {
      kind: "ran";
      result: GateResult;
      correlation: RunCorrelation | null;
      /** The state of the correlated run, when it has one on disk. */
      runState: ForgeState | null;
      /**
       * The verdict the strict check accepted as this run's: schema 2, naming
       * the correlated bead and run, by an evaluator that satisfies strict
       * completion. Its outcome may still block. The file it was read from
       * is `result.evaluatorArtifact`.
       */
      boundVerdict: EvalVerdict | null;
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
  strict: StrictPlaces,
  repository: RepositoryRun | null,
): {
  checks: CheckResult[];
  blockingFailures: string[];
  bound: BoundVerdict | null;
} {
  const { checks, blockingFailures } =
    repository === null
      ? gateBaseChecks(deps)
      : repositoryBaseChecks(repository, deps.execFile);
  let bound: BoundVerdict | null = null;

  // TaskCompleted-only checks
  if (event !== "TaskCompleted") {
    return { checks, blockingFailures, bound };
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

  // Check 7: Test evidence (the branch's own commits should include test files)
  {
    const evidence = testEvidenceCheck(deps.execFile, repository?.checkout);
    checks.push(evidence);
    if (!evidence.passed) blockingFailures.push("test-evidence");
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
        const outcome = strictVerdictCheck(correlation, deps, strict);
        checks.push(outcome.check);
        if (!outcome.check.passed) blockingFailures.push("eval-verdict");
        bound = outcome.bound;
      }
    } else {
      checks.push({
        name: "eval-verdict",
        passed: true,
        skipped: true,
        skipReason:
          mode === ""
            ? "set AGENT_FORGE_EVAL_VERDICT=strict to require the run's evaluator verdict (.claude/protocols/evaluation-verdict.md)"
            : `AGENT_FORGE_EVAL_VERDICT="${mode}" is not strict`,
      });
    }
  }

  return { checks, blockingFailures, bound };
}

/**
 * Where the strict check looks: the run's state and the smiths are the
 * checkout the gate runs in, where the Forge commands keep them; the verdict
 * is in the checkout the run builds in.
 */
interface StrictPlaces {
  checkout: string;
  verdictCheckout: string;
  runState: ForgeState | null;
}

/**
 * Checks 1–4 for a run in the checkout the gate runs in, or an unlinked run:
 * the gate's own fixed command lines, run there.
 */
function gateBaseChecks(deps: GateDeps): {
  checks: CheckResult[];
  blockingFailures: string[];
} {
  const { run } = deps;
  const checks: CheckResult[] = [];
  const blockingFailures: string[] = [];

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

  return { checks, blockingFailures };
}

/**
 * Checks 1–4 for a run in a repository under `repos/`: its own checks from
 * `repos/repos.json`, then clean-tree, each run in the run's checkout as an
 * argument array, without a shell. clean-tree leaves out what the harness
 * itself keeps there (`HARNESS_FILES`).
 */
function repositoryBaseChecks(
  repository: RepositoryRun,
  exec: ExecFile,
): { checks: CheckResult[]; blockingFailures: string[] } {
  const cwd = repository.checkout;
  const checks: CheckResult[] = [];
  const blockingFailures: string[] = [];
  for (const { name, argv } of repository.checks) {
    const [program = "", ...args] = argv;
    const r = exec(program, args, { cwd });
    checks.push({
      name,
      passed: r.ok,
      ...(r.ok ? {} : { output: r.output.slice(0, 1200) }),
    });
    if (!r.ok) blockingFailures.push(name);
  }
  const status = exec("git", repositoryStatusArgs(), { cwd });
  const clean = status.ok && status.output.trim() === "";
  checks.push({
    name: "clean-tree",
    passed: clean,
    ...(clean ? {} : { output: status.output.slice(0, 400) }),
  });
  if (!clean) blockingFailures.push("clean-tree");
  return { checks, blockingFailures };
}

/** `git status` for a repository's clean-tree: everything but the harness's own files. */
function repositoryStatusArgs(): string[] {
  return [
    "status",
    "--porcelain",
    "--",
    ".",
    ...HARNESS_FILES.map((path) => `:(exclude)${path}`),
  ];
}

/**
 * Why a run in a repository is refused before anything is checked because of
 * what git tracks there, or null. A run correlation or a verdict is never
 * taken from a commit: in this harness `.tmp/` is gitignored, and a
 * repository is held to the same by refusing one that tracks files there.
 */
function trackedEvidenceProblem(
  repository: RepositoryRun,
  exec: ExecFile,
): string | null {
  const cwd = repository.checkout;
  const listed = exec("git", ["ls-files", "--", ...EVIDENCE_DIRS], { cwd });
  if (!listed.ok) {
    return `git could not list what ${cwd} tracks under ${EVIDENCE_DIRS.join(" or ")}: ${listed.output.slice(0, 400)}`;
  }
  if (listed.output.trim() === "") return null;
  return `${cwd} tracks files under ${EVIDENCE_DIRS.join(" or ")}, and a run correlation or a verdict is never taken from a commit: untrack them, and ignore .tmp/ there`;
}

/** A branch's own commits are the ones since the remote's default branch. */
const BRANCH_BASE = "origin/HEAD";

/** Each commit's line in the listing starts with this byte, which no listed path holds. */
const COMMIT_MARK = "\0";

/** What `git log` is asked for: one marked line per commit, then the paths it changes. */
const LISTING = ["log", "--format=%x00%H", "--name-only"] as const;

/** Paths whose change leaves the tests nothing to run. */
const DOCUMENTATION = /\.(md|mdx|markdown|txt|rst|adoc)$/i;
const DOCUMENTATION_KINDS = ".md, .mdx, .markdown, .txt, .rst, .adoc";

const isTestFile = (path: string): boolean =>
  path.includes(".test.") || path.includes(".spec.");

/**
 * The commits and paths a listing holds. git quotes a path with unusual bytes
 * in it; the quotes are dropped so its name can still be read.
 */
function commitListing(output: string): { commits: number; paths: string[] } {
  let commits = 0;
  const paths: string[] = [];
  for (const line of output.split("\n")) {
    const text = line.trimEnd();
    if (text.startsWith(COMMIT_MARK)) commits++;
    else if (text.length > 1 && text.startsWith('"') && text.endsWith('"'))
      paths.push(text.slice(1, -1));
    else if (text.length > 0) paths.push(text);
  }
  return { commits, paths };
}

/**
 * Check 7: the work's tests are committed. The evidence is every commit of the
 * branch's own, the ones since origin/HEAD, however many there are: a test
 * file in any of them passes. Commits that change only documentation, or no
 * commits at all, leave nothing to test, and the check says so as a skip.
 *
 * Without an origin/HEAD the branch's own commits cannot be told apart, so the
 * last five commits are read instead, and only a test file among them passes.
 *
 * git is run with an argument array, never through a shell: in `cwd` when
 * given (a run in a repository under `repos/`), else where the gate runs.
 */
function testEvidenceCheck(exec: ExecFile, cwd?: string): CheckResult {
  const name = "test-evidence";
  const where = cwd !== undefined ? { cwd } : {};
  const own = exec("git", [...LISTING, `${BRANCH_BASE}..HEAD`], where);
  if (own.ok) {
    const { commits, paths } = commitListing(own.output);
    const theirs = `this branch's ${commits} commit${commits === 1 ? "" : "s"} since ${BRANCH_BASE}`;
    const test = paths.find(isTestFile);
    if (test !== undefined) {
      return {
        name,
        passed: true,
        output: `test file among ${theirs}: ${test}`,
      };
    }
    const nothingToTest = (why: string): CheckResult => ({
      name,
      passed: true,
      skipped: true,
      skipReason: `${why}: nothing to test`,
    });
    if (commits === 0 && paths.length === 0) {
      return nothingToTest(`this branch has no commits since ${BRANCH_BASE}`);
    }
    if (paths.length === 0)
      return nothingToTest(`no files changed in ${theirs}`);
    if (paths.every((path) => DOCUMENTATION.test(path))) {
      return nothingToTest(
        `only documentation changed in ${theirs} (${DOCUMENTATION_KINDS})`,
      );
    }
    return {
      name,
      passed: false,
      output: `No test file among ${theirs}, and more than documentation changed: commit the tests with the work`,
    };
  }

  const recent = exec("git", [...LISTING, "-5"], where);
  if (!recent.ok) {
    return {
      name,
      passed: false,
      output: `git could not list the commits: ${recent.output.slice(0, 400)}`,
    };
  }
  const test = commitListing(recent.output).paths.find(isTestFile);
  return test !== undefined
    ? {
        name,
        passed: true,
        output: `no ${BRANCH_BASE} to find this branch's own commits from, so the last five commits were read: test file ${test}`,
      }
    : {
        name,
        passed: false,
        output: `No test file in the last five commits. There is no ${BRANCH_BASE} to find this branch's own commits from (\`git remote set-head origin --auto\` sets it)`,
      };
}

/** A verdict the strict check bound, with the file it was read from. */
interface BoundVerdict {
  verdict: EvalVerdict;
  artifact: EvaluatorArtifactReference;
}

/** An evaluator in a few words, for a check's output. */
function describeEvaluator(evaluator: EvaluatorIdentity): string {
  if (evaluator.kind === "human") return `human ${evaluator.actorKind}`;
  return `model ${evaluator.observedProvider}/${evaluator.observedModel} (requested ${evaluator.requestedProvider}/${evaluator.requestedModel}, rank ${evaluator.requestedRank})`;
}

/**
 * The strict check for a correlated run. The run's evaluator verdict is read
 * once, from the path the correlation's run id declares and nowhere else.
 * Everything after works on that one buffer: it must parse as a schema 2
 * verdict naming the correlation's bead and run, by an evaluator that
 * satisfies strict completion, and must not block. A verdict that gets that
 * far is bound: its reference carries the buffer's digest and size.
 */
function strictVerdictCheck(
  correlation: RunCorrelation,
  deps: GateDeps,
  strict: StrictPlaces,
): { check: CheckResult; bound: BoundVerdict | null } {
  const refused = (output: string) => ({
    check: { name: "eval-verdict", passed: false, output },
    bound: null,
  });
  const read = deps.readVerdict(
    strict.verdictCheckout,
    correlation.executionRunId,
  );
  if (!read.ok) return refused(read.error);
  const parsed = parseEvalVerdictJson(read.buffer.toString("utf8"));
  if (!parsed.ok) return refused(parsed.error);
  const mine = verdictForRun(parsed.value, correlation);
  if (!mine.ok) return refused(mine.error);
  const verdict = mine.value;
  // A review round's verdict copied to the run's place is not the run's.
  const round = verdictReviewProblem(verdict, null);
  if (round !== null) return refused(round);
  const builder = strict.runState?.executor;
  const problem = strictEvaluatorProblem(verdict.evaluator, {
    // Only a model evaluator has a rank to look up.
    smiths:
      verdict.evaluator.kind === "model" ? deps.smiths(strict.checkout) : [],
    ...(builder ? { builder } : {}),
  });
  if (problem !== null) return refused(problem);

  const bound: BoundVerdict = {
    verdict,
    artifact: {
      kind: "evaluator-verdict",
      path: read.path,
      sha256: read.sha256,
      bytes: read.bytes,
      verdictSchemaVersion: verdict.schemaVersion,
      executionRunId: verdict.executionRunId,
      beadsIssueId: verdict.beadsIssueId,
      evaluator: verdict.evaluator,
    },
  };
  if (verdictBlocksShip(verdict)) {
    return {
      check: {
        name: "eval-verdict",
        passed: false,
        output: `verdict FAIL with blocker/high — ${JSON.stringify(verdict.findings)}`,
      },
      bound,
    };
  }
  return {
    check: {
      name: "eval-verdict",
      passed: true,
      output: `${verdict.verdict} B=${verdict.findings.blocker} H=${verdict.findings.high}; evaluator: ${describeEvaluator(verdict.evaluator)}`,
    },
    bound,
  };
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
  // The checkout the run builds in is the one its correlation names, which
  // need not be this one: a pointer is followed to the checkout it leads into.
  const pointed = pointedRunCorrelationAnywhere({
    argv: input.argv,
    env: deps.env,
    checkout: checkoutRoot,
  });
  const placed: RunCheckSet | null = pointed.linked
    ? runCheckSet({
        runCheckout: pointed.correlation.checkout,
        gateCheckout: checkoutRoot,
        harness: deps.harness,
        registry: deps.registry,
      })
    : null;
  // A repository with no usable check set cannot be judged by anything here.
  if (placed?.kind === "unconfigured") {
    return { kind: "refused", error: placed.error };
  }
  // A pointer this gate cannot use. Whoever passed the flag is right here to
  // see it fail; a pointer from the environment was set by a launcher the run
  // cannot repair: carry on unlinked.
  const unusable = !pointed.linked
    ? { reason: pointed.reason, from: pointed.refused }
    : placed?.kind === "elsewhere"
      ? {
          reason: `run correlation refused: ${placed.reason}`,
          from: correlationPointer(input.argv, deps.env)?.source,
        }
      : null;
  if (unusable?.from === "flag") {
    return { kind: "refused", error: unusable.reason };
  }
  const correlation =
    pointed.linked && unusable === null ? pointed.correlation : null;
  const repository = placed?.kind === "repository" ? placed : null;
  if (repository !== null) {
    const problem = trackedEvidenceProblem(repository, deps.execFile);
    if (problem !== null) return { kind: "refused", error: problem };
  }
  const runState =
    correlation !== null
      ? deps.runState(correlation.executionRunId, checkoutRoot)
      : null;

  const { checks, blockingFailures, bound } = runChecks(
    invocation.event,
    correlation,
    deps,
    {
      checkout: checkoutRoot,
      verdictCheckout: repository?.checkout ?? checkoutRoot,
      runState,
    },
    repository,
  );

  // A repository's run is logged as its checkout's, on the branch it has there.
  const headBranch =
    repository === null
      ? deps.run("git rev-parse --abbrev-ref HEAD")
      : deps.execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd: repository.checkout,
        });
  const result: GateResult = {
    ...gateIdentity({
      cwd: deps.cwd,
      gitToplevel:
        repository?.checkout ?? (toplevel.ok ? toplevel.output : null),
      gitBranch: headBranch.ok ? headBranch.output : null,
      correlation,
      ...(unusable !== null ? { unlinkedReason: unusable.reason } : {}),
      ...(invocation.host ? { host: invocation.host } : {}),
    }),
    event: invocation.event,
    eventSource: invocation.eventSource,
    stdin: invocation.stdin,
    timestamp: new Date().toISOString(),
    passed: blockingFailures.length === 0,
    checks,
    blockingFailures,
    ...(bound !== null ? { evaluatorArtifact: bound.artifact } : {}),
    ...(repository !== null ? { repository: repository.repository } : {}),
  };
  return {
    kind: "ran",
    result,
    correlation,
    runState,
    boundVerdict: bound?.verdict ?? null,
    ...(invocation.eventSource === "stdin"
      ? { trigger: invocation.event }
      : {}),
    ...(unusable?.from === "env" ? { notice: unusable.reason } : {}),
  };
}

const UNRECORDED =
  "the gate log could not be written, so the bound verdict's evidence is not on record: strict completion is blocked";

/**
 * The result of a run once it is known whether its log entry was written.
 *
 * The entry is where a bound verdict's path, digest and evaluator are
 * recorded, and strict completion with no record of what satisfied it is not
 * completion: a run that bound a verdict and could not append its entry is a
 * failed run, with a failing `gate-log` check that says so. What is printed,
 * what goes to the ledger and the exit code all follow from this one result.
 * A run that bound no verdict is not held to its log.
 */
export function unrecordedVerdict(
  result: GateResult,
  recorded: { logged: boolean },
): GateResult {
  if (recorded.logged || result.evaluatorArtifact === undefined) return result;
  return {
    ...result,
    passed: false,
    checks: [
      ...result.checks,
      { name: "gate-log", passed: false, output: UNRECORDED },
    ],
    blockingFailures: [...result.blockingFailures, "gate-log"],
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

function readTextOrNull(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
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

/** The configured smiths. Config that cannot be read ranks nobody, so strict mode fails closed. */
function configuredSmiths(checkout: string): Smith[] {
  try {
    return Object.values(loadConfig({ harnessRoot: checkout }).config.smiths);
  } catch (error) {
    console.error(
      `quality-gate: smith config not readable, so no evaluator has a rank: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
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

if (isMain(import.meta)) {
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
      // This file is <harness>/.claude/hooks/quality-gate.ts.
      harness: join(import.meta.dir, "..", ".."),
      registry: readTextOrNull,
      hasScript,
      hasTestFiles,
      smiths: configuredSmiths,
      runState: readRunState,
      readVerdict: (checkout, executionRunId) =>
        readVerdictOnce({ checkout, executionRunId }),
    },
  });

  if (outcome.kind === "refused") {
    console.error(`quality-gate: ${outcome.error}. Nothing was checked.`);
    process.exit(EXIT_BLOCKED);
  }
  const { correlation, runState, boundVerdict } = outcome;
  if (outcome.notice !== undefined) {
    console.error(`quality-gate: ${outcome.notice}`);
  }

  // Log to file. A failure is not fatal to a run that bound no verdict; one
  // that did has its evidence in this entry (see `unrecordedVerdict`).
  let logged = true;
  try {
    appendFileSync(
      getQualityGateLogPath(),
      JSON.stringify(outcome.result) + "\n",
    );
  } catch {
    logged = false;
  }
  const result = unrecordedVerdict(outcome.result, { logged });
  if (result !== outcome.result) console.error(`quality-gate: ${UNRECORDED}.`);

  // Record the run in the event ledger. Loaded and run inside the guard: the
  // gate's verdict never depends on its audit trail.
  try {
    const ledger = await import("../../scripts/quality-gate-ledger");
    const { appendEvent } = await import("../../scripts/ledger/append");
    const attach = ledger.gateAttach({
      cwd: process.cwd(),
      env: process.env,
      correlation,
      state: runState,
    });
    // The verdict's file reference is the one already in the log entry: the
    // file is not opened again for the ledger.
    const artifact = result.evaluatorArtifact;
    if (boundVerdict !== null && artifact !== undefined) {
      appendEvent(
        ledger.strictVerdictEvent({
          verdict: boundVerdict,
          artifact: {
            path: artifact.path,
            sha256: artifact.sha256,
            bytes: artifact.bytes,
            schemaVersion: artifact.verdictSchemaVersion,
          },
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
