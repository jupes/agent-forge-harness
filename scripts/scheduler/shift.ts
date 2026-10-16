/**
 * A shift: a bounded, unattended loop that takes approved, queued beads and
 * runs each through a smith's provider CLI in a worktree of its own.
 *
 * It decides nothing the other scheduler modules decide, and repeats none of
 * their work:
 * - which beads may start is `readEligibility` (the exact queued set, `bd
 *   ready`, no overlap with a reservation or an earlier bead);
 * - a bead moves only through `createQueue(...).move(id, action, "scheduler")`:
 *   `start` (the claim), `submit`, `release`, `halt`;
 * - its files are claimed with `reserve` and freed with `release`, under the
 *   queue lock;
 * - its worktree is made by the registry (`createWorktree`);
 * - each run is `runExec`, forge:exec's own function: the adapter, the
 *   environment allowlist, the ledger sink, the run correlation.
 *
 * What is its own: the base (origin's branch, fetched once before anything
 * else, every worktree starting at the commit it named), the bounds
 * (concurrency, time, beads admitted, spend: each the caller's, else the
 * config's `[shift]`), the host throttle (`[shift] throttle`), repairs,
 * noticing a bead the operator paused or halted (or that another run started
 * since), the draft pull request of a bead that reached `review`
 * (`shift-pr.ts`), the `worklog:` comments on each bead it ran, and
 * stopping: every child is aborted (its tree killed by the
 * supervisor) and awaited, its bead put back in `queued` and its reservation
 * released before `shift.stopped` is recorded. It never merges and pushes
 * nothing but a bead's own shift branch.
 *
 * Not covered: a shift that dies (Ctrl-C, a crash, a kill) has its children
 * killed by the supervisor's exit hook, but leaves their beads `running`,
 * their reservations held and its record `running`. `forge:shift recover`
 * (`shift-recover.ts`) is the way back once its process has ended.
 */

import { join } from "node:path";
import {
  type LedgerEventInput,
  QUEUE_LABEL_PREFIX,
  type ShiftStopReason,
} from "../../types/hearth";
import { SHIFT_LIMITS } from "../config/defaults";
import {
  BUILTIN_SHIFT_CONFIG,
  type ForgeConfig,
  loadConfig,
  maxUsdError,
  wholeNumberError,
} from "../config/load";
import { resolveSmith } from "../config/resolve";
import { type ExecDeps, runExec } from "../executors/exec-cli";
import { isValidSlug } from "../forge/runs";
import type { BdResult, BdRunner } from "../hearth/routes/dev-api";
import { isBeadId, parsed, refusal, storeEvent } from "../hearth/tracker-write";
import { type AppendResult, appendEvent } from "../ledger/append";
import type { queryEvents } from "../ledger/query";
import { resolveCheckout } from "../ledger/workspace";
import { type Eligible, readEligibility } from "./eligibility";
import { createQueue, queueStateOf, smithFor } from "./queue";
import { type ReservationDeps, release, reserve } from "./reservations";
import {
  fetchBase,
  isBaseBranch,
  openDraftPr,
  PR_FAILURES,
  type PullRequestOutcome,
  RUN_PR_BODY,
  type ToolRun,
} from "./shift-pr";
import { runOwnership } from "./shift-recover";
import {
  mintShiftId,
  type ShiftBeadRecord,
  type ShiftRecord,
  stopRequested,
  writeShiftRecord,
} from "./shift-store";

// ── Options ─────────────────────────────────────────────────────────────────

export interface ShiftOptions {
  /** How many beads run at once. */
  concurrency: number;
  /** How long the shift lasts, in ms. Each run is given the time that is left. */
  forMs: number;
  /** How many beads it admits in all. */
  maxBeads: number;
  /** The spend, in US dollars, past which it admits no more. */
  maxUsd: number;
  /** Runs after a failed one before the bead is halted. */
  repairs: number;
  /** Only beads under this epic. */
  epic?: string | undefined;
  /** Every bead goes to this smith, whatever the bead says. */
  smith?: string | undefined;
  /** How often the loop looks for a stop and the deadline. */
  tickMs: number;
  /** How often it reads eligibility while nothing changed, and reads back the beads it runs. */
  pollMs: number;
  /** The longest one run may take, below the time left. */
  runTimeoutMs?: number | undefined;
  /** The branch on origin every worktree starts from and every pull request goes into. */
  base: string;
}

/**
 * The bounds are `[shift]`'s builtins (scripts/config/defaults.ts); the rest
 * are the shift's own. `runShift` takes a bound it was not given from the
 * loaded `[shift]`, so these apply only where no config was read.
 */
export const SHIFT_DEFAULTS = {
  concurrency: BUILTIN_SHIFT_CONFIG.concurrency,
  forMs: BUILTIN_SHIFT_CONFIG.forMs,
  maxBeads: BUILTIN_SHIFT_CONFIG.maxBeads,
  maxUsd: BUILTIN_SHIFT_CONFIG.maxUsd,
  repairs: BUILTIN_SHIFT_CONFIG.repairs,
  tickMs: 1000,
  pollMs: 15_000,
  base: "master",
} as const;

/** `[shift]`'s bounds, the ones the loader checks, and the shift's own two. */
const LIMITS = {
  ...SHIFT_LIMITS,
  tickMs: [1, 60_000],
  pollMs: [1, 10 * 60_000],
} as const;

const SMITH_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/** The options with their defaults, or why they are not a shift's. */
export function shiftOptions(
  given: Partial<ShiftOptions> = {},
): Checked<ShiftOptions> {
  const options: ShiftOptions = { ...SHIFT_DEFAULTS, ...given };
  for (const [name, limits] of Object.entries(LIMITS)) {
    const error = wholeNumberError(
      options[name as keyof typeof LIMITS],
      limits,
    );
    if (error !== null) return { ok: false, error: `${name}: ${error}` };
  }
  const spend = maxUsdError(options.maxUsd);
  if (spend !== null) return { ok: false, error: `maxUsd: ${spend}` };
  if (
    options.runTimeoutMs !== undefined &&
    (!Number.isInteger(options.runTimeoutMs) || options.runTimeoutMs < 1)
  )
    return {
      ok: false,
      error: "runTimeoutMs: expected a positive whole number",
    };
  if (options.epic !== undefined && !isBeadId(options.epic))
    return { ok: false, error: "epic: expected a Beads issue id" };
  if (options.smith !== undefined && !SMITH_NAME.test(options.smith))
    return {
      ok: false,
      error: "smith: expected the name of a configured smith",
    };
  if (!isBaseBranch(options.base))
    return {
      ok: false,
      error: "base: expected the name of a branch on origin, not a shift's own",
    };
  return { ok: true, value: options };
}

// ── What a run is told ──────────────────────────────────────────────────────

/**
 * The prompt a bead's run gets on stdin: the forgemaster-auto command for the
 * bead, and the rules of a shift. A repair also names how the run before it
 * ended.
 */
export function shiftPrompt(input: {
  beadId: string;
  shiftId: string;
  runId: string;
  branch: string;
  attempt: number;
  repairs: number;
  lastFailure?: string | undefined;
}): string {
  const lines = [
    `/forgemaster-auto ${input.beadId}`,
    "",
    `You are running unattended in shift ${input.shiftId}. Work on bead ${input.beadId} only, in this worktree, on its branch ${input.branch}.`,
    `Use ${input.runId} as the Forge run id.`,
    "Commit your work on this branch. Do not push, do not open a pull request and do not merge.",
    `Leave the filled PR body at ${RUN_PR_BODY} in this worktree (the PR template; bun run pr:check must pass on it): the shift opens the draft pull request from it.`,
    "Stop once the ship phase's quality gates pass and your work is committed.",
  ];
  if (input.attempt > 1)
    lines.push(
      "",
      `This is repair ${input.attempt - 1} of ${input.repairs}. The run before it ended: ${(input.lastFailure ?? "it failed").slice(0, 500)}`,
      "Continue from the worktree as it is.",
    );
  return `${lines.join("\n")}\n`;
}

/** The Forge run id a bead's runs in this shift carry. */
export function shiftRunId(beadId: string, shiftId: string, n: number): string {
  const named = `${beadId}-${shiftId}`;
  return isValidSlug(named) ? named : `${shiftId}-${n}`;
}

// ── What it says on a bead ──────────────────────────────────────────────────

/**
 * Why the shift let a bead go, as the bead's end comment says it. Fixed
 * words: what a provider, git or gh printed stays on the shift record.
 */
export const SHIFT_ENDINGS = {
  submitted: "A run succeeded and the bead was submitted for review.",
  stopped:
    "The shift stopped its run (its time ran out, or it was asked to stop) and put the bead back in queued.",
  notStarted: "Its run could not be started; the bead is back in queued.",
  failed: "The shift failed while running it and put the bead back in queued.",
  halted:
    "Every run failed; the bead was halted, and the operator's queue action is the way out.",
  unmoved:
    "A queue move after its run did not go through, so it may still be in running; the shift record says which.",
  taken:
    "Another run started it while this one ran, so the shift stopped its own run and left the bead, still running, to that one.",
  noStep: "the pull request step failed before it finished",
} as const;

/** The `worklog:` comment a bead gets when the shift starts it. */
export function startedComment(input: {
  shiftId: string;
  runId: string;
  smith: string;
  worktree: string;
  branch: string;
}): string {
  return `worklog: shift ${input.shiftId} started this bead: run ${input.runId}, smith ${input.smith}, worktree ${input.worktree}, branch ${input.branch}. Its events: bun run forge:audit --run ${input.runId}.`;
}

/** The `worklog:` comment a bead gets when the shift lets it go. */
export function endedComment(input: {
  shiftId: string;
  attempts: number;
  outcome: string;
  why: string;
}): string {
  const runs = `${input.attempts} run${input.attempts === 1 ? "" : "s"}`;
  return `worklog: shift ${input.shiftId} ended this bead after ${runs}: ${input.outcome}. ${input.why}`;
}

// ── Dependencies ────────────────────────────────────────────────────────────

/** How one run ended, as the loop needs it. */
export interface Attempt {
  ok: boolean;
  /** The provider was never started (the run's own checks refused it). */
  notStarted: boolean;
  timedOut: boolean;
  stopped: boolean;
  /** What the run reported spending, when it reported it. */
  costUsd?: number | undefined;
  error: string | null;
}

export interface ShiftDeps {
  /** The checkout the shift runs for: its config and its tracker. */
  root: string;
  /** Runs `bd` in the checkout that holds the tracker. */
  runBd: BdRunner;
  ledgerPath: string;
  /** The queue lock: the hearth's, so the operator's moves and the shift's are serialized. */
  lockFile: string;
  /** Where the shift's record and stop request are (`<home>/shifts`). */
  shiftsDir: string;
  /** Where its worktrees go: `<main>/trees/<id>`. */
  mainCheckout: string;
  /** Says whether the host is too busy to admit more: CPU or memory in use at or above `threshold` (`[shift] throttle`). */
  sampleHost(
    threshold: number,
  ): Promise<{ busy: boolean; reason?: string | undefined }>;
  /** Makes `<mainCheckout>/trees/<id>` on a new branch that starts at `startPoint`. */
  makeWorktree(request: {
    id: string;
    branch: string;
    beadId: string;
    startPoint: string;
  }): { ok: true; path: string } | { ok: false; error: string };
  /** git, for the base (fetch, rev-parse) and the pull request (log, push). */
  git: ToolRun;
  /** gh, for `pr create` only. */
  gh: ToolRun;
  /** `bun run pr:check` on a body file: null when every section is there and filled, else why not. */
  checkPrBody(path: string): Promise<string | null>;
  /** What `runExec` is given besides the run itself: the environment, the home, adapter and command overrides. */
  exec?: Pick<ExecDeps, "env" | "home" | "adapters" | "command"> | undefined;
  appendEvent?: ((event: LedgerEventInput) => AppendResult) | undefined;
  /**
   * The ledger's `queryEvents`, through which the pause watch reads whose
   * start of a running bead is the newest; the ledger's own by default. A
   * test gives one that fails.
   */
  queryEvents?: typeof queryEvents | undefined;
  /** An in-process stop: as an operator's stop request. */
  signal?: AbortSignal | undefined;
  now?: (() => Date) | undefined;
  shiftId?: string | undefined;
  /** The record's pid; this process by default. */
  pid?: number | undefined;
}

export type ShiftOutcome =
  | {
      ok: true;
      value: {
        shiftId: string;
        reason: ShiftStopReason;
        record: ShiftRecord;
        /** False when `shift.stopped` could not be stored. */
        recorded: boolean;
        recordError?: string;
      };
    }
  | { ok: false; error: string };

// ── Reading a bead ──────────────────────────────────────────────────────────

interface Shown {
  title: string;
  labels: string[];
  metadata: unknown;
  parent: string | null;
}

async function showBead(runBd: BdRunner, id: string): Promise<Checked<Shown>> {
  let result: BdResult;
  try {
    result = await runBd(["show", "--readonly", "--json", "--", id]);
  } catch {
    return { ok: false, error: "bd show could not be run" };
  }
  if (result.status !== 0)
    return { ok: false, error: `bd show failed: ${refusal(result)}` };
  const rows = parsed(result.stdout);
  const row = Array.isArray(rows)
    ? (rows as Array<Record<string, unknown> | null>).find(
        (each) => each?.["id"] === id,
      )
    : undefined;
  if (row === undefined || row === null)
    return { ok: false, error: `bd show did not print ${id}` };
  const labels = Array.isArray(row["labels"])
    ? row["labels"].filter((l): l is string => typeof l === "string")
    : [];
  const deps = Array.isArray(row["dependencies"]) ? row["dependencies"] : [];
  const parent = deps.find(
    (dep: unknown) =>
      typeof dep === "object" &&
      dep !== null &&
      (dep as Record<string, unknown>)["dependency_type"] === "parent-child",
  ) as Record<string, unknown> | undefined;
  return {
    ok: true,
    value: {
      title: typeof row["title"] === "string" ? row["title"] : "",
      labels,
      metadata: row["metadata"],
      parent: typeof parent?.["id"] === "string" ? parent["id"] : null,
    },
  };
}

/**
 * One `bd comments add`, built as the hearth's tracker writes are: both
 * values after the `--`, so a text that looks like an option stays a text.
 * Never repeated. Null once bd printed the comment on that issue, else why
 * not, in words that never repeat the text.
 */
async function postComment(
  runBd: BdRunner,
  id: string,
  text: string,
): Promise<string | null> {
  let result: BdResult;
  try {
    result = await runBd(["comments", "add", "--json", "--", id, text]);
  } catch {
    return "bd comments add could not be run";
  }
  if (result.status === null)
    return "bd comments add did not finish, or never started; the comment may have been added";
  if (result.status !== 0) return `bd comments add failed: ${refusal(result)}`;
  const printed = parsed(result.stdout);
  return typeof printed === "object" &&
    printed !== null &&
    (printed as Record<string, unknown>)["issue_id"] === id
    ? null
    : "bd comments add exited 0 but printed no comment on the bead";
}

// ── The loop ────────────────────────────────────────────────────────────────

interface Slot {
  entry: ShiftBeadRecord;
  controller: AbortController;
  /** The bead's title, for its pull request. */
  title: string;
  /** Its worktree's directory name under `<main>/trees/`, as the registry made it. */
  worktreeId: string;
  /** Set before the controller is aborted: why the shift let the run go. */
  stopKind?: "shift" | "left";
  leftWhy?: string;
  /** The queue state the operator left it in, as the shift read it. */
  leftWhere?: string;
  /** The run whose start, newer than this one's, the watch found: the bead is that run's now. */
  takenBy?: string;
  /** Why it went back to queued, for its end comment. */
  released?: "stopped" | "notStarted" | "failed";
  /** How its pull request step ended; "failed" when the step itself threw. */
  pr?: PullRequestOutcome | "failed";
  done?: Promise<void>;
}

/** The fixed reason a bead's end comment gives for how it ended. */
function endWhy(slot: Slot): string {
  const { entry, pr } = slot;
  if (entry.outcome === "review") {
    if (pr !== undefined && pr !== "failed" && pr.ok)
      return `${SHIFT_ENDINGS.submitted} Draft pull request: ${pr.url}.`;
    const why =
      pr === undefined || pr === "failed"
        ? SHIFT_ENDINGS.noStep
        : PR_FAILURES[pr.kind];
    return `${SHIFT_ENDINGS.submitted} No pull request was opened: ${why}.`;
  }
  if (entry.outcome === "released")
    return SHIFT_ENDINGS[slot.released ?? "stopped"];
  if (entry.outcome === "halted") return SHIFT_ENDINGS.halted;
  if (entry.outcome === "left") {
    if (slot.stopKind === "left" && slot.takenBy !== undefined)
      return SHIFT_ENDINGS.taken;
    return slot.stopKind === "left" && slot.leftWhere !== undefined
      ? `It was moved while it ran (it is ${slot.leftWhere}) and was left as it is.`
      : SHIFT_ENDINGS.unmoved;
  }
  return `It ended ${entry.outcome}.`;
}

/**
 * Run a shift to its end. Each bound not `given` is the config's `[shift]`
 * (its builtin where no file sets it), read as each run's `forge:exec` reads
 * the config; the host threshold is `[shift] throttle`. Refused before
 * anything is done: a config that cannot be read, options that are not a
 * shift's, a ledger that does not store `shift.started`. Otherwise it answers
 * once it has stopped, with why.
 */
export async function runShift(
  given: Partial<ShiftOptions>,
  deps: ShiftDeps,
): Promise<ShiftOutcome> {
  let config: ForgeConfig;
  try {
    config = loadConfig({
      harnessRoot: deps.root,
      home: deps.exec?.home,
      env: deps.exec?.env,
    }).config;
  } catch (error) {
    return {
      ok: false,
      error: `the config could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const { throttle, ...configured } = config.shift;
  const checked = shiftOptions({ ...configured, ...given });
  if (!checked.ok) return checked;
  const options = checked.value;

  if (options.smith !== undefined) {
    const explicit = resolveSmith(config, { explicit: options.smith });
    if (!explicit.ok) return { ok: false, error: explicit.error };
  }

  // Every worktree starts at origin's base as it is now, fetched once: a
  // shift run from a feature branch, or from a checkout whose base is behind,
  // builds nothing on that.
  const based = await fetchBase(deps.git, deps.mainCheckout, options.base);
  if (!based.ok)
    return {
      ok: false,
      error: `the base could not be fetched (${based.error}); nothing was started`,
    };
  const baseSha = based.value.sha;

  const now = deps.now ?? (() => new Date());
  const clock = () => now().getTime();
  const append =
    deps.appendEvent ??
    ((event: LedgerEventInput) =>
      appendEvent(event, { path: deps.ledgerPath }));
  const { workspace } = resolveCheckout(deps.root);
  const startedAt = now();
  const shiftId = deps.shiftId ?? mintShiftId(startedAt);
  const deadline = startedAt.getTime() + options.forMs;

  const record: ShiftRecord = {
    shiftId,
    pid: deps.pid ?? process.pid,
    workspace,
    startedAt: startedAt.toISOString(),
    deadline: new Date(deadline).toISOString(),
    state: "running",
    options: {
      concurrency: options.concurrency,
      forMs: options.forMs,
      maxBeads: options.maxBeads,
      maxUsd: options.maxUsd,
      repairs: options.repairs,
      throttle,
      base: options.base,
      ...(options.epic !== undefined ? { epic: options.epic } : {}),
      ...(options.smith !== undefined ? { smith: options.smith } : {}),
    },
    baseSha,
    spentUsd: 0,
    unpriced: 0,
    beads: [],
  };
  /** The record is a report: one that cannot be written stops nothing once the shift runs. */
  const save = (): string | null => {
    try {
      writeShiftRecord(deps.shiftsDir, record);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  const unsaved = save();
  if (unsaved !== null)
    return {
      ok: false,
      error: `the shift record could not be written (${unsaved}); nothing was started`,
    };

  // The event precedes everything the shift does.
  const notStarted = await storeEvent(append, {
    kind: "shift.started",
    workspace,
    payload: {
      shiftId,
      concurrency: options.concurrency,
      durationMs: options.forMs,
      maxBeads: options.maxBeads,
      maxUsd: options.maxUsd,
      ...(options.epic !== undefined ? { filter: `epic:${options.epic}` } : {}),
    },
  });
  if (notStarted !== null) {
    record.state = "stopped";
    record.reason = "halted";
    record.endedAt = now().toISOString();
    save();
    return {
      ok: false,
      error: `the ledger did not store shift.started (${notStarted}); nothing was started`,
    };
  }

  /** Every event of one bead's story carries its run id. */
  const appendFor =
    (runId: string) =>
    (event: LedgerEventInput): AppendResult =>
      append({ ...event, runId });
  const queueFor = (runId: string) =>
    createQueue({
      workspace,
      runBd: deps.runBd,
      appendEvent: appendFor(runId),
      lockFile: deps.lockFile,
    });
  // With the shift records: a bead another shift's worktree still holds is
  // not reserved again here, so no second run of it starts (`heldByShift`).
  const storeFor = (runId: string): ReservationDeps => ({
    workspace,
    ledgerPath: deps.ledgerPath,
    appendEvent: appendFor(runId),
    lockFile: deps.lockFile,
    shiftsDir: deps.shiftsDir,
  });

  const slots = new Map<string, Slot>();
  const setAside = new Set<string>();
  const epicMembers = new Map<string, boolean>();
  let admitted = 0;
  let changed = true;
  let wake: (() => void) | null = null;
  const wakeUp = () => {
    const resume = wake;
    wake = null;
    resume?.();
  };
  deps.signal?.addEventListener("abort", wakeUp, { once: true });

  /** Rest until the next tick, a run ending, or an in-process stop. */
  const rest = (ms: number) =>
    new Promise<void>((done) => {
      const timer = setTimeout(() => {
        wake = null;
        done();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        done();
      };
    });

  const note = (entry: ShiftBeadRecord, error: string) => {
    entry.error =
      entry.error === undefined ? error : `${entry.error}; ${error}`;
  };

  /** Move the bead on as the scheduler; a move that does not go through leaves it, and says so. */
  async function settle(
    entry: ShiftBeadRecord,
    action: "submit" | "release" | "halt",
    outcome: ShiftBeadRecord["outcome"],
  ): Promise<void> {
    const moved = await queueFor(entry.runId).move(
      entry.beadId,
      action,
      "scheduler",
    );
    if (moved.ok) entry.outcome = outcome;
    else {
      entry.outcome = "left";
      note(entry, `${action}: ${moved.error}`);
    }
  }

  /** Post one `worklog:` comment on the bead; one that fails is written on its entry and stops nothing. */
  async function comment(
    entry: ShiftBeadRecord,
    which: "started" | "ended",
    text: string,
  ): Promise<void> {
    const failure = await postComment(deps.runBd, entry.beadId, text);
    if (failure === null) return;
    const said = `${which} comment: ${failure}`;
    entry.commentError =
      entry.commentError === undefined
        ? said
        : `${entry.commentError}; ${said}`;
  }

  /** The draft pull request of a bead now in review; one that cannot be opened leaves it there, and says why. */
  async function pullRequest(slot: Slot): Promise<void> {
    const { entry } = slot;
    try {
      const pr = await openDraftPr(
        {
          shiftId,
          beadId: entry.beadId,
          title: slot.title,
          runId: entry.runId,
          smith: entry.smith,
          attempts: entry.attempts,
          branch: entry.branch ?? "",
          worktree: entry.worktree ?? "",
          mainCheckout: deps.mainCheckout,
          worktreeId: slot.worktreeId,
          // The shift's own directory in the home: outside every worktree.
          bodyDir: join(deps.shiftsDir, shiftId),
          base: options.base,
          baseSha,
        },
        { git: deps.git, gh: deps.gh, checkPrBody: deps.checkPrBody },
      );
      slot.pr = pr;
      if (pr.body !== undefined) entry.prBody = pr.body;
      if (pr.ok) entry.prUrl = pr.url;
      else note(entry, `pull request: ${pr.kind}: ${pr.error}`);
    } catch (error) {
      slot.pr = "failed";
      note(
        entry,
        `pull request: the step failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    save();
  }

  async function inEpic(id: string): Promise<boolean> {
    const epic = options.epic;
    if (epic === undefined || id.startsWith(`${epic}.`)) return true;
    const known = epicMembers.get(id);
    if (known !== undefined) return known;
    const shown = await showBead(deps.runBd, id);
    const member = shown.ok && shown.value.parent === epic;
    if (shown.ok) epicMembers.set(id, member);
    return member;
  }

  async function runAttempt(
    slot: Slot,
    prompt: string,
    smith: string,
    timeoutMs: number,
  ): Promise<Attempt> {
    const { entry } = slot;
    const out = await runExec(
      [
        "--bead",
        entry.beadId,
        "--worktree",
        entry.worktree ?? "",
        "--prompt",
        prompt,
        "--smith",
        smith,
        "--run",
        entry.runId,
        "--timeout-ms",
        String(timeoutMs),
      ],
      {
        harnessRoot: deps.root,
        cwd: deps.root,
        ledgerPath: deps.ledgerPath,
        signal: slot.controller.signal,
        ...(deps.exec ?? {}),
      },
    );
    const data =
      typeof out.body.data === "object" && out.body.data !== null
        ? (out.body.data as Record<string, unknown>)
        : null;
    const usage = data?.["usage"] as { costUsd?: unknown } | null | undefined;
    const cost = usage?.costUsd;
    return {
      ok: out.code === 0,
      notStarted: data === null,
      timedOut: data?.["timedOut"] === true,
      stopped:
        data?.["stopped"] === true ||
        (data === null && slot.controller.signal.aborted),
      ...(typeof cost === "number" && Number.isFinite(cost) && cost >= 0
        ? { costUsd: cost }
        : {}),
      error: out.body.error,
    };
  }

  /**
   * One bead from its first run to its last (and its pull request, once in
   * review), then its reservation freed and its end comment posted.
   */
  async function work(slot: Slot, smith: string): Promise<void> {
    const { entry } = slot;
    let lastFailure: string | undefined;
    let deadlineHit = false;
    try {
      for (let attempt = 1; attempt <= options.repairs + 1; attempt++) {
        if (slot.controller.signal.aborted) break;
        const left = deadline - clock();
        if (left <= 0) {
          deadlineHit = true;
          break;
        }
        const timeoutMs = Math.min(options.runTimeoutMs ?? left, left);
        entry.attempts = attempt;
        save();
        const run = await runAttempt(
          slot,
          shiftPrompt({
            beadId: entry.beadId,
            shiftId,
            runId: entry.runId,
            branch: entry.branch ?? "",
            attempt,
            repairs: options.repairs,
            lastFailure,
          }),
          smith,
          timeoutMs,
        );
        if (run.costUsd !== undefined) {
          record.spentUsd += run.costUsd;
          entry.costUsd = (entry.costUsd ?? 0) + run.costUsd;
        } else if (!run.notStarted) record.unpriced++;
        if (run.ok) {
          await settle(entry, "submit", "review");
          if (entry.outcome === "review") await pullRequest(slot);
          return;
        }
        if (slot.controller.signal.aborted || run.stopped) break;
        if (run.timedOut && timeoutMs === left) {
          deadlineHit = true;
          break;
        }
        if (run.notStarted) {
          note(entry, `the run was not started: ${run.error ?? "no reason"}`);
          slot.released = "notStarted";
          await settle(entry, "release", "released");
          return;
        }
        lastFailure = run.error ?? "the run failed";
      }
      if (slot.stopKind === "left") {
        entry.outcome = "left";
        note(entry, slot.leftWhy ?? "the bead left the running state");
        return;
      }
      if (slot.controller.signal.aborted || deadlineHit) {
        await settle(entry, "release", "released");
        return;
      }
      note(
        entry,
        `${entry.attempts} runs failed; the last: ${lastFailure ?? "no reason"}`,
      );
      await settle(entry, "halt", "halted");
    } catch (error) {
      note(
        entry,
        `the shift failed while running it: ${error instanceof Error ? error.message : String(error)}`,
      );
      slot.released = "failed";
      if (slot.stopKind !== "left")
        await settle(entry, "release", "released").catch(() => undefined);
    } finally {
      const freed = await release(
        { beadId: entry.beadId, worktree: entry.worktree ?? "" },
        storeFor(entry.runId),
      ).catch((error: unknown) => ({
        ok: false as const,
        kind: "failed" as const,
        error: error instanceof Error ? error.message : String(error),
      }));
      if (!freed.ok) note(entry, `reservation: ${freed.error}`);
      await comment(
        entry,
        "ended",
        endedComment({
          shiftId,
          attempts: entry.attempts,
          outcome: entry.outcome,
          why: endWhy(slot),
        }),
      );
    }
  }

  /** Claim, smith, reservation, worktree; then the runs, in the background. */
  async function admit(bead: Eligible): Promise<void> {
    const n = record.beads.length + 1;
    const entry: ShiftBeadRecord = {
      beadId: bead.id,
      runId: shiftRunId(bead.id, shiftId, n),
      outcome: "set-aside",
      attempts: 0,
    };
    record.beads.push(entry);
    setAside.add(bead.id);
    const aside = (error: string) => {
      entry.outcome = "set-aside";
      note(entry, error);
      save();
    };

    const started = await queueFor(entry.runId).move(
      bead.id,
      "start",
      "scheduler",
    );
    if (!started.ok) return aside(`start: ${started.error}`);
    // From here the bead is running: every way out moves it on.
    const giveBack = async (error: string) => {
      note(entry, error);
      await settle(entry, "release", "set-aside");
      save();
    };

    const shown = await showBead(deps.runBd, bead.id);
    if (!shown.ok) return giveBack(`smith: ${shown.error}`);
    const resolution =
      options.smith !== undefined
        ? resolveSmith(config, { explicit: options.smith })
        : smithFor(config, {
            id: bead.id,
            labels: shown.value.labels,
            metadata: shown.value.metadata,
          });
    if (!resolution.ok) return giveBack(`smith: ${resolution.error}`);
    entry.smith = resolution.smith.name;

    const id = `${shiftId}-${n}`;
    const branch = `shift/${shiftId}/${bead.id}`;
    const planned = join(deps.mainCheckout, "trees", id);
    const reserved = await reserve(
      { beadId: bead.id, worktree: planned, globs: bead.globs },
      storeFor(entry.runId),
    );
    if (!reserved.ok) return giveBack(`reservation: ${reserved.error}`);

    let made: ReturnType<ShiftDeps["makeWorktree"]>;
    try {
      made = deps.makeWorktree({
        id,
        branch,
        beadId: bead.id,
        startPoint: baseSha,
      });
    } catch (error) {
      made = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (!made.ok) {
      const freed = await release(
        { beadId: bead.id, worktree: planned },
        storeFor(entry.runId),
      );
      if (!freed.ok) note(entry, `reservation: ${freed.error}`);
      return giveBack(`worktree: ${made.error}`);
    }

    entry.worktree = made.path;
    entry.branch = branch;
    entry.outcome = "running";
    admitted++;
    await comment(
      entry,
      "started",
      startedComment({
        shiftId,
        runId: entry.runId,
        smith: resolution.smith.name,
        worktree: made.path,
        branch,
      }),
    );
    const slot: Slot = {
      entry,
      controller: new AbortController(),
      title: shown.value.title,
      worktreeId: id,
    };
    slots.set(bead.id, slot);
    save();
    slot.done = work(slot, resolution.smith.name).finally(() => {
      slots.delete(bead.id);
      changed = true;
      save();
      wakeUp();
    });
  }

  /**
   * Read back each bead being run; one the operator moved, or one another
   * run started since, is let go.
   */
  async function watch(): Promise<void> {
    for (const slot of [...slots.values()]) {
      if (slot.stopKind !== undefined) continue;
      const shown = await showBead(deps.runBd, slot.entry.beadId);
      // A read that fails says nothing about the bead: it runs on.
      if (!shown.ok) continue;
      const standing = queueStateOf(shown.value);
      if (standing.kind === "state" && standing.state === "running") {
        // Running, but perhaps by another run's start (paused, resumed and
        // started again before this read): the ledger's newest move of it
        // says whose. Only that evidence stops this run; a ledger that
        // cannot be read, or that is missing this run's own start, says
        // nothing, and it runs on.
        const owner = runOwnership(
          {
            workspace,
            ledgerPath: deps.ledgerPath,
            queryEvents: deps.queryEvents,
          },
          slot.entry.beadId,
          slot.entry.runId,
        );
        if (owner.owned || owner.startedBy === undefined) continue;
        slot.stopKind = "left";
        slot.leftWhere = `${QUEUE_LABEL_PREFIX}running`;
        slot.takenBy = owner.startedBy;
        slot.leftWhy = `another run (${owner.startedBy}) started the bead while this one ran: this run was stopped, and the bead left to that one`;
        slot.controller.abort("bead started by another run");
        continue;
      }
      const where =
        standing.kind === "state"
          ? `${QUEUE_LABEL_PREFIX}${standing.state}`
          : "in none of the queue's states";
      slot.stopKind = "left";
      slot.leftWhere = where;
      slot.leftWhy = `the bead is ${where}: it was moved while it ran, and is left as it is`;
      slot.controller.abort("bead moved by the operator");
    }
  }

  let reason: ShiftStopReason | null = null;
  let readFailures = 0;
  let lastRead = Number.NEGATIVE_INFINITY;
  let lastWatch = clock();
  try {
    while (reason === null) {
      if (deps.signal?.aborted || stopRequested(deps.shiftsDir, shiftId)) {
        reason = "operator";
        break;
      }
      if (clock() >= deadline) {
        reason = "elapsed";
        break;
      }
      if (clock() - lastWatch >= options.pollMs) {
        lastWatch = clock();
        await watch();
      }

      let nothingEligible = false;
      let hostBusy = false;
      const due = changed || clock() - lastRead >= options.pollMs;
      while (
        due &&
        slots.size < options.concurrency &&
        admitted < options.maxBeads &&
        record.spentUsd < options.maxUsd &&
        clock() < deadline &&
        !deps.signal?.aborted
      ) {
        changed = false;
        lastRead = clock();
        const host = await deps.sampleHost(throttle);
        if (host.busy) {
          hostBusy = true;
          break;
        }
        const read = await readEligibility({
          root: deps.root,
          runBd: deps.runBd,
          ledgerPath: deps.ledgerPath,
          host: { busy: false },
          shiftsDir: deps.shiftsDir,
        });
        if (!read.ok) {
          readFailures++;
          if (readFailures >= 3) reason = "halted";
          break;
        }
        readFailures = 0;
        let next: Eligible | undefined;
        for (const candidate of read.value.eligible) {
          if (setAside.has(candidate.id) || slots.has(candidate.id)) continue;
          if (await inEpic(candidate.id)) {
            next = candidate;
            break;
          }
        }
        if (next === undefined) {
          nothingEligible = true;
          break;
        }
        await admit(next);
      }
      if (reason !== null) break;

      if (slots.size === 0) {
        if (admitted >= options.maxBeads) reason = "count";
        else if (record.spentUsd >= options.maxUsd) reason = "budget";
        else if (nothingEligible && !hostBusy) reason = "drained";
        if (reason !== null) break;
      }
      await rest(options.tickMs);
    }
  } catch (error) {
    // A failure of the loop itself: the shift cannot go on, and cleans up.
    reason = "halted";
    record.error = `the shift failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    // Every way out: stop each run, wait for it to give its bead back.
    const running = [...slots.values()];
    for (const slot of running) {
      slot.stopKind ??= "shift";
      slot.controller.abort(`shift ${reason ?? "stopped"}`);
    }
    await Promise.all(running.map((slot) => slot.done));
    deps.signal?.removeEventListener("abort", wakeUp);
  }

  const stopReason: ShiftStopReason = reason ?? "halted";
  record.state = "stopped";
  record.reason = stopReason;
  record.endedAt = now().toISOString();
  save();
  const unrecorded = await storeEvent(append, {
    kind: "shift.stopped",
    workspace,
    payload: { shiftId, reason: stopReason },
  });
  return {
    ok: true,
    value: {
      shiftId,
      reason: stopReason,
      record,
      recorded: unrecorded === null,
      ...(unrecorded !== null ? { recordError: unrecorded } : {}),
    },
  };
}
