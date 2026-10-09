/**
 * Run correlations on disk — the launcher boundary and the gate's loader.
 *
 * Split from `run-correlation.ts` because the dashboard bundles that module
 * into the browser. Only Node-side callers (launchers, the quality gate)
 * import this one.
 *
 * A correlation is honoured in exactly one place: the file named after its run
 * id in the correlations directory of the checkout it names. The directory is
 * gitignored, so a correlation never arrives through a commit.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "fs";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { comparableCheckout } from "./forge/runs";
import { ulid } from "./ledger/ulid";
import { resolveCheckout } from "./ledger/workspace";
import {
  correlationPointer,
  createRunCorrelation,
  parseRunCorrelation,
  RUN_CORRELATION_ENV,
  RUN_CORRELATION_FLAG,
  RUN_CORRELATIONS_DIR,
  type RunCorrelation,
  runCorrelationPath,
} from "./run-correlation";

/** A checkout root that `comparableCheckout` lower-cased: a Windows drive path. */
const FOLDED_ROOT = /^[a-z]:\//;

/** A correlation is five short fields; anything larger is not one. */
const MAX_BYTES = 16 * 1024;

export type InitRunCorrelation =
  | {
      ok: true;
      correlation: RunCorrelation;
      /** Absolute path of the file. */
      path: string;
      /** The pointer to it, as the environment a launched child should get. */
      env: Record<typeof RUN_CORRELATION_ENV, string>;
    }
  | {
      ok: false;
      error: string;
      /** Set when the run is already correlated to another bead: what holds it. */
      held?: RunCorrelation;
    };

export type LoadedRunCorrelation =
  | { ok: true; value: RunCorrelation; path: string }
  | { ok: false; error: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The top level of the checkout a correlation for `dir` belongs in.
 *
 * `dir` must exist and be inside a git checkout; a correlation is never
 * written into a directory this had to create or guess. With `topLevel`, `dir`
 * must be that checkout's top level itself: for a directory a caller named as
 * "the checkout", where resolving to some enclosing checkout would put the
 * file somewhere nobody asked for.
 */
function checkoutRoot(
  dir: string,
  topLevel: boolean,
): { ok: true; root: string } | { ok: false; error: string } {
  let given: string;
  try {
    if (!statSync(dir).isDirectory()) {
      return { ok: false, error: "the checkout directory does not exist" };
    }
    given = comparableCheckout(realpathSync.native(dir));
  } catch {
    return { ok: false, error: "the checkout directory does not exist" };
  }
  const root = resolveCheckout(dir).worktree;
  if (!existsSync(join(root, ".git"))) {
    return { ok: false, error: "the directory is not in a git checkout" };
  }
  if (topLevel && given !== root) {
    return {
      ok: false,
      error: "the directory is not the top level of a checkout",
    };
  }
  return { ok: true, root };
}

/**
 * True when the correlations directory of `root`, as far as it exists, is the
 * checkout's own: no part of it is a link, wherever the link leads. Checked
 * before anything is created, so nothing is ever made or written behind a
 * link. The loader refuses a file behind one on its side.
 */
function correlationsDirIsOwn(root: string): boolean {
  let dir = root;
  for (const part of RUN_CORRELATIONS_DIR.split("/")) {
    dir = `${dir}/${part}`;
    let real: string;
    try {
      real = comparableCheckout(realpathSync.native(dir));
    } catch {
      // Not there yet, so neither is anything below it.
      return true;
    }
    if (real !== dir) return false;
  }
  return true;
}

/**
 * Start (or rejoin) a run's correlation: the one call a launcher makes.
 *
 * `executionRunId` is the id the caller already reserved for the run — a Forge
 * run's slug. One is minted only when there is none. Calling again for the
 * same run and bead returns the file already there. A run already correlated
 * to another bead is left alone unless the caller says `rebind`: only a
 * caller that was told the bead outright should.
 */
export function initRunCorrelation(input: {
  /** A directory in the checkout the run builds in. */
  checkout: string;
  /** Require `checkout` to be the top level of its checkout. */
  topLevel?: boolean;
  beadsIssueId: string;
  executionRunId?: string;
  /** Replace a correlation that names another bead for this run. */
  rebind?: boolean;
  now?: () => string;
  mint?: () => string;
}): InitRunCorrelation {
  const where = checkoutRoot(input.checkout, input.topLevel === true);
  if (!where.ok) return where;
  const { root } = where;
  const made = createRunCorrelation({
    executionRunId: input.executionRunId ?? (input.mint ?? ulid)(),
    beadsIssueId: input.beadsIssueId,
    checkout: root,
    ...(input.now ? { now: input.now } : {}),
  });
  if (!made.ok) return made;
  const relative = runCorrelationPath(made.value.executionRunId);
  if (relative === null) {
    return { ok: false, error: "executionRunId must be a Forge run id" };
  }
  const path = join(root, relative);
  const found = (correlation: RunCorrelation): InitRunCorrelation => ({
    ok: true,
    correlation,
    path,
    env: { [RUN_CORRELATION_ENV]: path },
  });

  if (!correlationsDirIsOwn(root)) {
    return {
      ok: false,
      error: `${RUN_CORRELATIONS_DIR} is, or sits under, a link: a correlation is only written in the checkout's own directory`,
    };
  }
  const existing = loadRunCorrelation(path, root);
  if (existing.ok) {
    const held = existing.value;
    if (
      held.executionRunId === made.value.executionRunId &&
      held.beadsIssueId === made.value.beadsIssueId
    ) {
      return found(held);
    }
    if (!input.rebind) {
      return {
        ok: false,
        error: `run ${held.executionRunId} is already correlated to ${held.beadsIssueId}`,
        held,
      };
    }
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Written beside the target and renamed, so a reader never sees half a file.
    const draft = `${path}.${process.pid}.tmp`;
    writeFileSync(draft, `${JSON.stringify(made.value, null, 2)}\n`);
    renameSync(draft, path);
  } catch (error) {
    return {
      ok: false,
      error: `could not write ${relative}: ${message(error)}`,
    };
  }
  return found(made.value);
}

/**
 * The correlation a pointer leads to, when it is one this checkout's gate may
 * trust. `pointer` is a path, absolute or relative to the checkout.
 *
 * Refused before the file is read: a real path outside the checkout or outside
 * its correlations directory, anything that is not a small regular file.
 * Refused after: an invalid correlation, a file not named after the run it
 * holds, a correlation written for another checkout.
 */
export function loadRunCorrelation(
  pointer: string,
  checkout: string,
): LoadedRunCorrelation {
  const refuse = (error: string): LoadedRunCorrelation => ({
    ok: false,
    error,
  });
  if (pointer.trim().length === 0) return refuse("the pointer is empty");

  const root = resolveCheckout(checkout).worktree;
  const path = isAbsolute(pointer) ? pointer : resolve(root, pointer);
  let real: string;
  let bytes: number;
  try {
    real = comparableCheckout(realpathSync.native(path));
    const stat = statSync(path);
    if (!stat.isFile()) return refuse("the pointer does not name a file");
    bytes = stat.size;
  } catch {
    return refuse("the pointer names no readable file");
  }
  if (!real.startsWith(`${root}/`)) {
    return refuse("the file is outside this checkout");
  }
  if (dirname(real) !== `${root}/${RUN_CORRELATIONS_DIR}`) {
    return refuse(`the file is not in ${RUN_CORRELATIONS_DIR}`);
  }
  if (bytes > MAX_BYTES) {
    return refuse(`the file is larger than ${MAX_BYTES} bytes`);
  }

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return refuse(`the file could not be read: ${message(error)}`);
  }
  const parsed = parseRunCorrelation(text);
  if (!parsed.ok) return refuse(parsed.error);
  const { value } = parsed;
  // `real` is case-folded exactly when `root` is: fold the expected name too.
  const named = `${value.executionRunId}.json`;
  if (
    basename(real) !== (FOLDED_ROOT.test(root) ? named.toLowerCase() : named)
  ) {
    return refuse(
      `the file holds run ${value.executionRunId} but is not named after it`,
    );
  }
  if (value.checkout !== root) {
    return refuse("the correlation was written for another checkout");
  }
  return { ok: true, value, path };
}

/** What the gate was pointed at, once the pointer has been followed. */
export type PointedRunCorrelation =
  | { linked: true; correlation: RunCorrelation; path: string }
  | {
      linked: false;
      reason: string;
      /** Set when a pointer was given and did not validate: who gave it. */
      refused?: "flag" | "env";
    };

/** Follow the caller's pointer, if there is one, to a correlation this checkout may trust. */
export function pointedRunCorrelation(input: {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  checkout: string;
}): PointedRunCorrelation {
  const pointer = correlationPointer(input.argv, input.env);
  if (pointer === null) {
    return {
      linked: false,
      reason: `no run correlation was given (${RUN_CORRELATION_FLAG} <path> or ${RUN_CORRELATION_ENV})`,
    };
  }
  const loaded = loadRunCorrelation(pointer.path, input.checkout);
  return loaded.ok
    ? { linked: true, correlation: loaded.value, path: loaded.path }
    : {
        linked: false,
        reason: `run correlation refused: ${loaded.error}`,
        refused: pointer.source,
      };
}

/** A correlation as a launcher's JSON output reports it. */
export interface RunCorrelationReport {
  /** The file, relative to `checkout`: what to pass as `--correlation` there. */
  pointer: string;
  beadsIssueId: string;
  executionRunId: string;
  /** The checkout the file is in, and the only one whose gate accepts it. */
  checkout: string;
}

export function correlationReport(
  correlation: RunCorrelation,
): RunCorrelationReport {
  return {
    pointer: runCorrelationPath(correlation.executionRunId) ?? "",
    beadsIssueId: correlation.beadsIssueId,
    executionRunId: correlation.executionRunId,
    checkout: correlation.checkout,
  };
}

/**
 * What a launcher that keeps run state does after writing it: correlate the
 * run to the bead it names, and report what the run's file now holds.
 *
 * `named` is a bead given outright on this call: it rebinds the run. `stored`
 * is the bead the run already had: it creates a correlation and never replaces
 * one, so a run someone correlated to a narrower issue stays there. A run that
 * names no bead gets no correlation. `note` is set when a correlation was
 * wanted and could not be written.
 */
export function correlateRun(input: {
  checkout: string;
  /** Require `checkout` to be the top level of its checkout. */
  topLevel?: boolean;
  executionRunId: string;
  named?: string;
  stored?: string;
  now?: () => string;
}): { correlation: RunCorrelationReport | null; note?: string } {
  const bead = input.named ?? input.stored;
  if (bead === undefined) return { correlation: null };
  const made = initRunCorrelation({
    checkout: input.checkout,
    ...(input.topLevel !== undefined ? { topLevel: input.topLevel } : {}),
    beadsIssueId: bead,
    executionRunId: input.executionRunId,
    rebind: input.named !== undefined,
    ...(input.now ? { now: input.now } : {}),
  });
  if (made.ok) return { correlation: correlationReport(made.correlation) };
  if (made.held) return { correlation: correlationReport(made.held) };

  // Not written for another reason. Say so, beside what the run's file still
  // holds: looked up only in a checkout that could have held it.
  const note = `run correlation not written: ${made.error}`;
  const where = checkoutRoot(input.checkout, input.topLevel === true);
  if (!where.ok) return { correlation: null, note };
  const held = loadRunCorrelation(
    runCorrelationPath(input.executionRunId) ?? "",
    where.root,
  );
  return {
    correlation: held.ok ? correlationReport(held.value) : null,
    note,
  };
}
