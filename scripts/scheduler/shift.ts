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
 * What is its own: the bounds (concurrency, time, beads admitted, spend), the
 * host throttle, repairs, noticing a bead the operator paused or halted, and
 * stopping: every child is aborted (its tree killed by the supervisor) and
 * awaited, its bead put back in `queued` and its reservation released before
 * `shift.stopped` is recorded. It never merges, never pushes and opens no
 * pull request: a bead whose run succeeds ends in `review`, its work committed
 * on the shift's branch in a worktree that is kept.
 *
 * Not covered: a shift that dies (Ctrl-C, a crash, a kill) has its children
 * killed by the supervisor's exit hook, but leaves their beads `running` and
 * their reservations held. `forge:reservations release` and the operator's
 * queue actions are the way out.
 */

import { join } from "node:path";
import {
  type LedgerEventInput,
  QUEUE_LABEL_PREFIX,
  type ShiftStopReason,
} from "../../types/hearth";
import { type ForgeConfig, loadConfig } from "../config/load";
import { resolveSmith } from "../config/resolve";
import { type ExecDeps, runExec } from "../executors/exec-cli";
import { isValidSlug } from "../forge/runs";
import type { BdResult, BdRunner } from "../hearth/routes/dev-api";
import { parsed, refusal, storeEvent } from "../hearth/tracker-write";
import { type AppendResult, appendEvent } from "../ledger/append";
import { resolveCheckout } from "../ledger/workspace";
import { type Eligible, readEligibility } from "./eligibility";
import { createQueue, queueStateOf, smithFor } from "./queue";
import { type ReservationDeps, release, reserve } from "./reservations";
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
}

/** Decision 8 for the first four; the count and the spend are this bead's defaults. */
export const SHIFT_DEFAULTS = {
  concurrency: 2,
  forMs: 2 * 60 * 60 * 1000,
  maxBeads: 4,
  maxUsd: 10,
  repairs: 3,
  tickMs: 1000,
  pollMs: 15_000,
} as const;

const LIMITS = {
  concurrency: [1, 8],
  forMs: [1, 24 * 60 * 60 * 1000],
  maxBeads: [1, 100],
  repairs: [0, 10],
  tickMs: [1, 60_000],
  pollMs: [1, 10 * 60_000],
} as const;

const SMITH_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BEAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/** The options with their defaults, or why they are not a shift's. */
export function shiftOptions(
  given: Partial<ShiftOptions> = {},
): Checked<ShiftOptions> {
  const options: ShiftOptions = { ...SHIFT_DEFAULTS, ...given };
  for (const [name, [low, high]] of Object.entries(LIMITS)) {
    const value = options[name as keyof typeof LIMITS];
    if (!Number.isInteger(value) || value < low || value > high)
      return {
        ok: false,
        error: `${name}: expected a whole number from ${low} to ${high}`,
      };
  }
  if (
    typeof options.maxUsd !== "number" ||
    !Number.isFinite(options.maxUsd) ||
    options.maxUsd <= 0 ||
    options.maxUsd > 1000
  )
    return {
      ok: false,
      error: "maxUsd: expected dollars above 0, at most 1000",
    };
  if (
    options.runTimeoutMs !== undefined &&
    (!Number.isInteger(options.runTimeoutMs) || options.runTimeoutMs < 1)
  )
    return {
      ok: false,
      error: "runTimeoutMs: expected a positive whole number",
    };
  if (options.epic !== undefined && !BEAD_ID.test(options.epic))
    return { ok: false, error: "epic: expected a Beads issue id" };
  if (options.smith !== undefined && !SMITH_NAME.test(options.smith))
    return {
      ok: false,
      error: "smith: expected the name of a configured smith",
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
  /** The checkout the shift runs for: its config, its tracker, and the HEAD worktrees start from. */
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
  /** Says whether the host is too busy to admit more. */
  sampleHost(): Promise<{ busy: boolean; reason?: string | undefined }>;
  /** Makes `<mainCheckout>/trees/<id>` on a new branch. */
  makeWorktree(request: {
    id: string;
    branch: string;
    beadId: string;
  }): { ok: true; path: string } | { ok: false; error: string };
  /** What `runExec` is given besides the run itself: the environment, the home, adapter and command overrides. */
  exec?: Pick<ExecDeps, "env" | "home" | "adapters" | "command"> | undefined;
  appendEvent?: ((event: LedgerEventInput) => AppendResult) | undefined;
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
      labels,
      metadata: row["metadata"],
      parent: typeof parent?.["id"] === "string" ? parent["id"] : null,
    },
  };
}

// ── The loop ────────────────────────────────────────────────────────────────

interface Slot {
  entry: ShiftBeadRecord;
  controller: AbortController;
  /** Set before the controller is aborted: why the shift let the run go. */
  stopKind?: "shift" | "left";
  leftWhy?: string;
  done?: Promise<void>;
}

/**
 * Run a shift to its end. Refused before anything is done: options that are
 * not a shift's, a config that cannot be read, a ledger that does not store
 * `shift.started`. Otherwise it answers once it has stopped, with why.
 */
export async function runShift(
  given: Partial<ShiftOptions>,
  deps: ShiftDeps,
): Promise<ShiftOutcome> {
  const checked = shiftOptions(given);
  if (!checked.ok) return checked;
  const options = checked.value;

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
  if (options.smith !== undefined) {
    const explicit = resolveSmith(config, { explicit: options.smith });
    if (!explicit.ok) return { ok: false, error: explicit.error };
  }

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
      ...(options.epic !== undefined ? { epic: options.epic } : {}),
      ...(options.smith !== undefined ? { smith: options.smith } : {}),
    },
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
  const storeFor = (runId: string): ReservationDeps => ({
    workspace,
    ledgerPath: deps.ledgerPath,
    appendEvent: appendFor(runId),
    lockFile: deps.lockFile,
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

  /** One bead from its first run to its last, then its reservation freed. */
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
          return;
        }
        if (slot.controller.signal.aborted || run.stopped) break;
        if (run.timedOut && timeoutMs === left) {
          deadlineHit = true;
          break;
        }
        if (run.notStarted) {
          note(entry, `the run was not started: ${run.error ?? "no reason"}`);
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
      made = deps.makeWorktree({ id, branch, beadId: bead.id });
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
    const slot: Slot = { entry, controller: new AbortController() };
    slots.set(bead.id, slot);
    save();
    slot.done = work(slot, resolution.smith.name).finally(() => {
      slots.delete(bead.id);
      changed = true;
      save();
      wakeUp();
    });
  }

  /** Read back each bead being run; one the operator moved is let go. */
  async function watch(): Promise<void> {
    for (const slot of [...slots.values()]) {
      if (slot.stopKind !== undefined) continue;
      const shown = await showBead(deps.runBd, slot.entry.beadId);
      // A read that fails says nothing about the bead: it runs on.
      if (!shown.ok) continue;
      const standing = queueStateOf(shown.value);
      if (standing.kind === "state" && standing.state === "running") continue;
      const where =
        standing.kind === "state"
          ? `${QUEUE_LABEL_PREFIX}${standing.state}`
          : "in none of the queue's states";
      slot.stopKind = "left";
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
        const host = await deps.sampleHost();
        if (host.busy) {
          hostBusy = true;
          break;
        }
        const read = await readEligibility({
          root: deps.root,
          runBd: deps.runBd,
          ledgerPath: deps.ledgerPath,
          host: { busy: false },
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
