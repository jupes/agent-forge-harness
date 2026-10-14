/**
 * Which checks the quality gate runs for a correlated run, by where the run
 * builds: the checkout its run correlation names.
 *
 * - A run in the checkout the gate runs in gets the gate's own checks.
 * - A run in a repository under the harness's `repos/` directory, or in a
 *   worktree of one, gets that repository's own check set: the `checks` list
 *   on its entry in `repos/repos.json`. That file is local to the machine and
 *   gitignored, so what the gate runs for a repository is the operator's to
 *   say, not something a commit can change. Each check is a name and an
 *   argument array, run in the run's checkout without a shell (see
 *   `execFileNoShell`). A repository with no usable check set is refused,
 *   naming the entry to fill in.
 * - A run anywhere else is somewhere this gate cannot judge.
 *
 * `repos/` and `repos/repos.json` are those of the harness's main checkout:
 * both are gitignored, so a worktree of the harness has neither.
 */

import { EVALUATIONS_DIR } from "./eval-verdict-store";
import { resolveCheckout } from "./ledger/workspace";
import { RUN_CORRELATIONS_DIR } from "./run-correlation";

/**
 * Where a run's correlation and its evaluator verdicts are kept in the run's
 * checkout. The gate never takes either from a file git tracks there.
 */
export const EVIDENCE_DIRS: readonly string[] = [
  RUN_CORRELATIONS_DIR,
  EVALUATIONS_DIR,
];

/**
 * What the harness itself writes into a run's checkout: the evidence above
 * and the session mirror (the ledger's `SESSION_MIRROR_FILE`, spelled out so
 * the gate loads no ledger module). A repository's clean-tree leaves them out.
 */
export const HARNESS_FILES: readonly string[] = [
  ...EVIDENCE_DIRS,
  ".agent-forge-session",
];

/** A repository's check: what the gate runs, as `argv[0]` with the rest as its arguments. */
export interface RepositoryCheck {
  name: string;
  argv: string[];
}

export type RunCheckSet =
  /** The gate's own checks, in the checkout it runs in. */
  | { kind: "gate" }
  /** The repository's checks from `repos/repos.json`, to run in `checkout`. */
  | {
      kind: "repository";
      /** The repository's name: its directory under `repos/` and its entry's `name`. */
      repository: string;
      /** The run's checkout, in comparable form: where its checks run. */
      checkout: string;
      checks: RepositoryCheck[];
    }
  /** The run builds somewhere this gate has no checks for. */
  | { kind: "elsewhere"; reason: string }
  /** The run builds in a repository whose check set is missing or unusable. */
  | { kind: "unconfigured"; error: string };

/** The names of the checks the gate runs itself, which a repository's check may not take. */
export const GATE_CHECK_NAMES: readonly string[] = [
  "clean-tree",
  "ac-verify",
  "close-testing-attestation",
  "test-evidence",
  "eval-verdict",
  "gate-log",
];

const CHECK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

const CHECK_SHAPE = '{ "name": ..., "argv": [program, ...arguments] }';

/** The run's check set. `registry` reads a file's text, or null when it cannot. */
export function runCheckSet(input: {
  /** The correlation's checkout, in comparable form. */
  runCheckout: string;
  /** The checkout the gate runs in. */
  gateCheckout: string;
  /** The checkout the gate belongs to. */
  harness: string;
  registry: (file: string) => string | null;
}): RunCheckSet {
  const run = resolveCheckout(input.runCheckout);
  const repos = `${resolveCheckout(input.harness).workspace}/repos`;
  const at = run.workspace.lastIndexOf("/");
  if (run.workspace.slice(0, at) === repos) {
    const repository = run.workspace.slice(at + 1);
    const file = `${repos}/repos.json`;
    const checks = repositoryChecks(input.registry(file), repository, file);
    return checks.ok
      ? {
          kind: "repository",
          repository,
          checkout: run.worktree,
          checks: checks.value,
        }
      : { kind: "unconfigured", error: checks.error };
  }
  if (run.worktree === resolveCheckout(input.gateCheckout).worktree) {
    return { kind: "gate" };
  }
  return {
    kind: "elsewhere",
    reason: `the run builds in ${run.worktree}, which is neither this checkout nor a repository under ${repos}: run the gate in that checkout`,
  };
}

type Read<T> = { ok: true; value: T } | { ok: false; error: string };

/** The check set on `repository`'s entry in the registry text. */
function repositoryChecks(
  text: string | null,
  repository: string,
  file: string,
): Read<RepositoryCheck[]> {
  const refuse = (error: string): Read<RepositoryCheck[]> => ({
    ok: false,
    error,
  });
  if (text === null) {
    return refuse(
      `the run builds in repository "${repository}", and ${file} could not be read: the gate runs a repository's checks only from the "checks" list on its entry there`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse(`${file} is not valid JSON`);
  }
  const repos =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { repos?: unknown }).repos
      : undefined;
  if (!Array.isArray(repos)) {
    return refuse(`${file} must be { "repos": [ ... ] }`);
  }
  const entry: unknown = repos.find(
    (candidate: unknown) =>
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as { name?: unknown }).name === repository,
  );
  if (entry === undefined) {
    return refuse(
      `${file} has no entry named "${repository}": add one with a "checks" list, each check ${CHECK_SHAPE}`,
    );
  }
  const named = `the "${repository}" entry in ${file}`;
  const checks = (entry as { checks?: unknown }).checks;
  if (!Array.isArray(checks) || checks.length === 0) {
    return refuse(
      `${named} has no "checks" list: add the checks the gate runs for it, each ${CHECK_SHAPE}`,
    );
  }
  const value: RepositoryCheck[] = [];
  for (const [index, check] of checks.entries()) {
    const at = `checks[${index}]`;
    const problem = checkProblem(check, at, value);
    if (problem !== null) return refuse(`${named}: ${problem}`);
    // justification: checkProblem has just confirmed both fields' types.
    const { name, argv } = check as RepositoryCheck;
    value.push({ name, argv: [...argv] });
  }
  return { ok: true, value };
}

/** What is wrong with one check, or null when it is a name and a non-empty argument list. */
function checkProblem(
  check: unknown,
  at: string,
  before: readonly RepositoryCheck[],
): string | null {
  if (typeof check !== "object" || check === null || Array.isArray(check)) {
    return `${at} must be an object`;
  }
  const { name, argv } = check as { name?: unknown; argv?: unknown };
  if (typeof name !== "string" || !CHECK_NAME.test(name)) {
    return `${at}.name must be letters, digits, dot, dash or underscore (40 at most)`;
  }
  if (GATE_CHECK_NAMES.includes(name)) {
    return `${at}.name "${name}" is a check the gate runs itself`;
  }
  if (before.some((earlier) => earlier.name === name)) {
    return `${at}.name "${name}" is given twice`;
  }
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    !argv.every((part) => typeof part === "string")
  ) {
    return `${at}.argv must be a list of strings, the program first`;
  }
  if ((argv[0] as string).trim().length === 0) {
    return `${at}.argv[0] must name a program`;
  }
  return null;
}
