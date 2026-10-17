#!/usr/bin/env bun
/**
 * shift-cli.ts — run a shift, stop one, recover one whose process died, list
 * them.
 *
 * Usage:
 *   bun run forge:shift run [--for <duration>] [--concurrency <n>]
 *       [--max-beads <n>] [--max-usd <dollars>] [--repairs <n>] [--epic <id>]
 *       [--smith <name>] [--run-timeout <duration>] [--base master]
 *       [--id <shift-id>]
 *   bun run forge:shift stop <shift-id>
 *   bun run forge:shift recover <shift-id>
 *   bun run forge:shift list
 *
 * A duration is a whole number of seconds, minutes or hours: `90s`, `30m`,
 * `2h`. The bounds (`SHIFT_LIMITS`, `SHIFT_MAX_USD`, `SHIFT_THROTTLE` in
 * scripts/config/defaults.ts): `--for` up to 24h, `--concurrency` 1 to 8,
 * `--max-beads` 1 to 100, `--max-usd` above 0 and up to 1000, `--repairs` 0
 * to 10, and `[shift] throttle` 0.1 to 1. A flag and `[shift]` out of bounds
 * are refused in the same words after the name (`--for` / `shift.for`:
 * `expected a duration of at most 24h`). Each of `--for`, `--concurrency`,
 * `--max-beads`, `--max-usd` and
 * `--repairs` left out is the config's `[shift]` value (`for`,
 * `concurrency`, `max_beads`, `max_usd`, `repairs`), else its builtin
 * (`BUILTIN_SHIFT`, scripts/config/defaults.ts); the host is too busy to
 * admit more at `[shift] throttle`. The config is read as each run's
 * `forge:exec` reads it:
 * `agent-forge.toml` in the checkout the shift runs in, over `config.toml` in
 * the Agent Forge home. `bun run forge:config get shift.<key>` says which
 * value applies and where it came from; a flag still wins. `--id` gives the shift the id it runs under instead of one minted at
 * the start: the hearth's `POST /shifts` mints the id first, so that its audit
 * row names the shift, and starts `run --id <id>` as its child. It must be a
 * shift id (`shift-YYYYMMDD-HHMMSS-xxxx`) that no shift record and no stop
 * request in the home has, or nothing starts. `run` first fetches `--base`
 * (default master) from origin, and every bead's worktree starts at the
 * commit it names, whatever the checkout it runs in has checked out; a base
 * that cannot be fetched starts nothing. It then writes one line to stderr,
 * the shift's id and the command that stops it, runs until the shift stops
 * and prints the shift's record. It takes only
 * beads in `queued` (an operator approved and queued them) and never merges.
 * A bead whose run succeeds ends in `review` with its work committed on the
 * branch `shift/<shift-id>/<bead>`, in a worktree under `trees/` that is
 * kept; that branch alone is pushed to origin and a draft pull request is
 * opened into the base with `gh pr create --draft`. Each bead it ran gets a
 * `worklog:` comment when it starts and one when it ends.
 *
 * `stop` asks a running shift to stop (the hearth's `POST /shifts/:id/stop`
 * does the same): it stops every run, puts their beads back in `queued`,
 * frees their reservations and records `shift.stopped`. The first Ctrl-C
 * (`SIGINT`) or `SIGTERM` of `run` does the same in-process, says so on
 * stderr and exits 0 once the shift has stopped; a second, or a stop not over
 * within `INTERRUPT_GRACE_MS` (30 s), ends the runs and exits 130 at once
 * (`shiftCliMain`). A crash, a kill or that second signal ends the runs but
 * leaves their beads `running`, their reservations held and the record
 * `running`. `recover` (the
 * hearth's `POST /shifts/:id/recover` does the same) is the way back once the
 * shift's process has ended: it puts back in `queued` each bead the shift
 * still owns (its newest recorded queue move is this shift's start of it;
 * any other is left as it is and reported), frees every reservation held in
 * the shift's worktrees, closes the record and records `shift.stopped` with
 * the reason `recovered`. It is refused while the record's process is alive,
 * and a pid the system gave to another program since reads as alive too. A
 * recovery that could not finish exits 1, says what is left and leaves the
 * record `running`: run it again.
 *
 * Every command prints `{ ok, data, error }` and exits 1 when `ok` is false.
 * bd runs in the main checkout; the ledger, the queue lock and the shift
 * records are the harness home's, the same ones the hearth uses.
 */

import { join, resolve } from "node:path";
import { agentForgeHome } from "../agent-forge-home";
import { SHIFT_LIMITS, SHIFT_MAX_USD } from "../config/defaults";
import { parseDuration, shiftLength } from "../config/load";
import { killAllLive, ownInterrupts } from "../executors/supervisor";
import { bdRunner, localStateRoot } from "../hearth/routes/dev-api";
import { QUEUE_LOCK_FILE } from "../hearth/routes/queue";
import { isMain } from "../is-main";
import { ledgerPath } from "../ledger/paths";
import { resolveCheckout } from "../ledger/workspace";
import { createHostSampler, type HostSamplerOptions } from "./host-load";
import type { CliResult } from "./reservations-cli";
import { runShift, type ShiftDeps, type ShiftOptions } from "./shift";
import { prCheckRunner, toolRunner } from "./shift-pr";
import { recoverShift, unfinishedMessage } from "./shift-recover";
import {
  isShiftId,
  listShiftRecords,
  mintShiftId,
  readShiftRecord,
  requestStop,
  SHIFTS_DIR,
  shiftIdInUse,
} from "./shift-store";
import { createWorktree } from "./worktrees";

const range = ([low, high]: readonly [number, number]): string =>
  `${low}-${high}`;

const USAGE = `run [--for <duration, up to ${SHIFT_LIMITS.forMs[1] / 3_600_000}h>] [--concurrency <${range(SHIFT_LIMITS.concurrency)}>] [--max-beads <${range(SHIFT_LIMITS.maxBeads)}>] [--max-usd <dollars above 0, up to ${SHIFT_MAX_USD}>] [--repairs <${range(SHIFT_LIMITS.repairs)}>] [--epic <id>] [--smith <name>] [--run-timeout <duration>] [--base master] [--id <shift-id>] | stop <shift-id> | recover <shift-id> | list. Each of the first five left out is [shift] in agent-forge.toml, else the builtin (bun run forge:config get shift.<key>)`;

type Env = Readonly<Record<string, string | undefined>>;

/** The checkout this file belongs to: where `bun run pr:check` is defined. */
const HARNESS = resolve(import.meta.dir, "..", "..");

/**
 * The real dependencies for `cwd`: bd in the main checkout; the ledger, the
 * queue lock and the shift records in the harness home; worktrees made by the
 * registry under the main checkout, from the base commit the shift fetched;
 * git and gh from the PATH, and this harness's `pr:check`; the host sampled
 * from this machine (`host` replaces what the sampler reads, for a test),
 * each sample against the threshold the shift passes. Runs use the
 * providers' own CLIs.
 */
export function shiftCliDeps(
  cwd: string,
  env: Env = process.env,
  host: Pick<HostSamplerOptions, "probe" | "sleep"> = {},
): ShiftDeps {
  const main = localStateRoot(cwd);
  const home = agentForgeHome(env);
  const sampler = createHostSampler(host);
  return {
    root: cwd,
    runBd: bdRunner(main),
    ledgerPath: ledgerPath(env),
    lockFile: join(home, QUEUE_LOCK_FILE),
    shiftsDir: join(home, SHIFTS_DIR),
    mainCheckout: main,
    sampleHost: (threshold) => sampler(threshold),
    makeWorktree: ({ id, branch, beadId, startPoint }) => {
      const made = createWorktree(
        main,
        cwd,
        { branch, beadId, startPoint },
        { newId: () => id },
      );
      return made.ok
        ? { ok: true, path: made.value.path }
        : { ok: false, error: made.error };
    },
    git: toolRunner("git"),
    gh: toolRunner("gh"),
    checkPrBody: prCheckRunner(HARNESS),
  };
}

const done = (data: unknown): CliResult => ({
  exit: 0,
  out: { ok: true, data, error: null },
});
const failed = (error: string): CliResult => ({
  exit: 1,
  out: { ok: false, data: null, error },
});

const RUN_FLAGS = {
  "--for": "forMs",
  "--concurrency": "concurrency",
  "--max-beads": "maxBeads",
  "--max-usd": "maxUsd",
  "--repairs": "repairs",
  "--epic": "epic",
  "--smith": "smith",
  "--run-timeout": "runTimeoutMs",
  "--base": "base",
} as const;

/**
 * The options `run` was given, and the shift id `--id` gave it, or why they
 * are not options. The hearth's `POST /shifts` parses its flags with this
 * too, before it starts the child that will parse them again.
 */
export function runOptions(
  args: readonly string[],
):
  | { ok: true; value: Partial<ShiftOptions>; shiftId?: string | undefined }
  | { ok: false; error: string } {
  const options: Partial<ShiftOptions> = {};
  let shiftId: string | undefined;
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i] ?? "";
    const value = args[i + 1];
    if (flag !== "--id" && !Object.hasOwn(RUN_FLAGS, flag))
      return { ok: false, error: `unknown option ${flag}` };
    if (value === undefined || value.startsWith("--"))
      return { ok: false, error: `${flag} needs a value` };
    if (flag === "--id") {
      if (!isShiftId(value))
        return {
          ok: false,
          error: "--id: expected a shift id (shift-YYYYMMDD-HHMMSS-xxxx)",
        };
      shiftId = value;
      continue;
    }
    const name = RUN_FLAGS[flag as keyof typeof RUN_FLAGS];
    if (name === "epic" || name === "smith" || name === "base") {
      options[name] = value;
      continue;
    }
    if (name === "forMs") {
      // Refused in the words `[shift] for` is refused in.
      const length = shiftLength(value);
      if (!length.ok) return { ok: false, error: `${flag}: ${length.error}` };
      options.forMs = length.value;
      continue;
    }
    if (name === "runTimeoutMs") {
      const ms = parseDuration(value);
      if (ms === null)
        return {
          ok: false,
          error: `${flag}: expected a duration such as 90s, 30m or 2h`,
        };
      options[name] = ms;
      continue;
    }
    const number = Number(value);
    if (value.trim() === "" || !Number.isFinite(number))
      return { ok: false, error: `${flag}: expected a number` };
    options[name] = number;
  }
  return { ok: true, value: options, shiftId };
}

export interface ShiftCliIo {
  /** Where `run` says which shift it started, before it runs. */
  announce(line: string): void;
}

export async function runShiftCli(
  argv: readonly string[],
  deps: ShiftDeps,
  io: ShiftCliIo = { announce: (line) => process.stderr.write(`${line}\n`) },
): Promise<CliResult> {
  const [command, ...rest] = argv;

  if (command === "run") {
    const options = runOptions(rest);
    if (!options.ok) return failed(`${options.error}. Usage: ${USAGE}`);
    // Checked here and not again: a second start with the same id between
    // this check and the record is not prevented.
    if (
      options.shiftId !== undefined &&
      shiftIdInUse(deps.shiftsDir, options.shiftId)
    )
      return failed(
        `--id: ${options.shiftId} is in use: a shift record or a stop request has it; nothing was started`,
      );
    const shiftId = options.shiftId ?? deps.shiftId ?? mintShiftId(new Date());
    io.announce(
      JSON.stringify({ shiftId, stop: `bun run forge:shift stop ${shiftId}` }),
    );
    const outcome = await runShift(options.value, { ...deps, shiftId });
    if (!outcome.ok) return failed(outcome.error);
    const { reason, record, recorded, recordError } = outcome.value;
    return done({
      shiftId,
      reason,
      recorded,
      ...(recordError !== undefined ? { recordError } : {}),
      record,
    });
  }

  if (command === "stop") {
    const [id, extra] = rest;
    if (id === undefined || extra !== undefined)
      return failed(`Usage: ${USAGE}`);
    const asked = requestStop(deps.shiftsDir, id);
    return asked.ok ? done(asked.value) : failed(asked.error);
  }

  if (command === "recover") {
    const [id, extra] = rest;
    if (id === undefined || extra !== undefined)
      return failed(`Usage: ${USAGE}`);
    const recovered = await recoverShift(id, {
      workspace: resolveCheckout(deps.root).workspace,
      runBd: deps.runBd,
      ledgerPath: deps.ledgerPath,
      appendEvent: deps.appendEvent,
      lockFile: deps.lockFile,
      shiftsDir: deps.shiftsDir,
      mainCheckout: deps.mainCheckout,
      now: deps.now,
    });
    if (!recovered.ok) return failed(recovered.error);
    const recovery = recovered.value;
    return recovery.complete
      ? done(recovery)
      : {
          exit: 1,
          out: {
            ok: false,
            data: recovery,
            error: unfinishedMessage(recovery),
          },
        };
  }

  if (command === "list") {
    if (rest.length > 0) return failed(`Usage: ${USAGE}`);
    return done(listShiftRecords(deps.shiftsDir));
  }

  return failed(
    `${command === undefined ? "No command" : `Unknown command: ${command}`}. Usage: ${USAGE}`,
  );
}

/**
 * How long the first `SIGINT` or `SIGTERM` gives `run` to stop its shift
 * before its runs are killed and it exits 130: as long as the hearth gives a
 * shift it asked to stop (`SHIFT_STOP_GRACE_MS`).
 */
export const INTERRUPT_GRACE_MS = 30_000;

/** The exit code of a `run` cut short by a second signal or the deadline. */
export const INTERRUPTED_EXIT = 130;

export interface ShiftMainIo extends ShiftCliIo {
  /** Where the interrupt's notices go (stderr). */
  say(line: string): void;
  /** Where the result goes (stdout). */
  print(text: string): void;
  exit(code: number): void;
}

const processIo: ShiftMainIo = {
  announce: (line) => process.stderr.write(`${line}\n`),
  say: (line) => process.stderr.write(`${line}\n`),
  print: (text) => console.log(text),
  exit: (code) => process.exit(code),
};

export interface ShiftInterrupt {
  /** Aborted by the first signal: `ShiftDeps.signal`. */
  signal: AbortSignal;
  /** Give the signals back (to the supervisor's default) and drop the deadline. */
  release(): void;
}

/**
 * Own this process's `SIGINT` and `SIGTERM` for one `run`
 * (`ownInterrupts`, scripts/executors/supervisor.ts). The first aborts
 * `signal`, which stops the shift as `forge:shift stop` does, says so, and
 * starts the deadline: a stop not over by `graceMs` is cut short (every
 * supervised run killed, exit 130). A second is left to the supervisor,
 * which kills every supervised run and exits 130 at once. Each notice names
 * the shift once `shift()` knows its id, and offers `forge:shift recover`
 * only once its record is written: before that the shift has started
 * nothing, and a signal then means it never will (`runShift` refuses a
 * stopped shift before writing its record), so there is nothing to recover.
 */
export function interruptShift(
  io: Pick<ShiftMainIo, "say" | "exit">,
  shift: () => { id: string | undefined; recorded: boolean },
  graceMs: number = INTERRUPT_GRACE_MS,
): ShiftInterrupt {
  const controller = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const seconds = `${graceMs / 1000}s`;
  const named = (id: string | undefined): string =>
    id === undefined ? "the shift" : `shift ${id}`;
  const left = (): string => {
    const { id, recorded } = shift();
    return recorded && id !== undefined
      ? ` What the shift still holds stays held: bun run forge:shift recover ${id} gives it back.`
      : " Nothing was started: it had not written its record.";
  };
  const release = ownInterrupts((signal) => {
    if (controller.signal.aborted) {
      io.say(`forge:shift: ${signal} again: exiting now.${left()}`);
      return false;
    }
    controller.abort(signal);
    const { id, recorded } = shift();
    io.say(
      recorded
        ? `forge:shift: ${signal}: stopping ${named(id)}: its runs are stopped and their beads put back in queued (up to ${seconds}). Press Ctrl-C again to exit now.`
        : `forge:shift: ${signal}: stopping ${named(id)} before it has started: nothing will be started (up to ${seconds}). Press Ctrl-C again to exit now.`,
    );
    deadline = setTimeout(() => {
      io.say(
        `forge:shift: ${named(shift().id)} did not stop within ${seconds}: exiting now.${left()}`,
      );
      killAllLive();
      io.exit(INTERRUPTED_EXIT);
    }, graceMs);
    return true;
  });
  return {
    signal: controller.signal,
    release() {
      release();
      clearTimeout(deadline);
    },
  };
}

/**
 * The CLI as `bun run forge:shift` runs it: the result printed, the process
 * ended with its exit code. For `run`, the first `SIGINT` or `SIGTERM` stops
 * the shift (`interruptShift`) from before its base is fetched until it has
 * stopped; outside that window, and for every other command, a signal ends
 * the process at once as before.
 */
export async function shiftCliMain(
  argv: readonly string[],
  deps: ShiftDeps,
  options: { io?: ShiftMainIo; graceMs?: number } = {},
): Promise<void> {
  const io = options.io ?? processIo;
  let shiftId: string | undefined;
  const announce = (line: string): void => {
    try {
      const announced = (JSON.parse(line) as { shiftId?: unknown }).shiftId;
      if (typeof announced === "string") shiftId = announced;
    } catch {
      // Not the announce line: nothing to learn from it.
    }
    io.announce(line);
  };
  const interrupt =
    argv[0] === "run"
      ? interruptShift(
          io,
          () => ({
            id: shiftId,
            recorded:
              shiftId !== undefined &&
              readShiftRecord(deps.shiftsDir, shiftId) !== null,
          }),
          options.graceMs,
        )
      : null;
  let result: CliResult;
  try {
    result = await runShiftCli(
      argv,
      interrupt === null ? deps : { ...deps, signal: interrupt.signal },
      { announce },
    );
  } finally {
    interrupt?.release();
  }
  io.print(JSON.stringify(result.out, null, 2));
  io.exit(result.exit);
}

if (isMain(import.meta)) {
  await shiftCliMain(process.argv.slice(2), shiftCliDeps(process.cwd()));
}
