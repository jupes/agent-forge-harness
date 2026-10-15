#!/usr/bin/env bun
/**
 * shift-cli.ts — run a shift, stop one, recover one whose process died, list
 * them.
 *
 * Usage:
 *   bun run forge:shift run [--for 2h] [--concurrency 2] [--max-beads 4]
 *       [--max-usd 10] [--repairs 3] [--epic <id>] [--smith <name>]
 *       [--run-timeout <duration>] [--base master]
 *   bun run forge:shift stop <shift-id>
 *   bun run forge:shift recover <shift-id>
 *   bun run forge:shift list
 *
 * A duration is a whole number of seconds, minutes or hours: `90s`, `30m`,
 * `2h`. `run` first fetches `--base` (default master) from origin, and every
 * bead's worktree starts at the commit it names, whatever the checkout it
 * runs in has checked out; a base that cannot be fetched starts nothing. It
 * then writes one line to stderr, the shift's id and the command that stops
 * it, runs until the shift stops and prints the shift's record. It takes only
 * beads in `queued` (an operator approved and queued them) and never merges.
 * A bead whose run succeeds ends in `review` with its work committed on the
 * branch `shift/<shift-id>/<bead>`, in a worktree under `trees/` that is
 * kept; that branch alone is pushed to origin and a draft pull request is
 * opened into the base with `gh pr create --draft`. Each bead it ran gets a
 * `worklog:` comment when it starts and one when it ends.
 *
 * `stop` asks a running shift to stop (the hearth's `POST /shifts/:id/stop`
 * does the same): it stops every run, puts their beads back in `queued`,
 * frees their reservations and records `shift.stopped`. Ctrl-C (or a crash,
 * or a kill) ends the runs too, but leaves their beads `running`, their
 * reservations held and the record `running`: prefer `stop`. `recover` (the
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
import { bdRunner, localStateRoot } from "../hearth/routes/dev-api";
import { QUEUE_LOCK_FILE } from "../hearth/routes/queue";
import { isMain } from "../is-main";
import { ledgerPath } from "../ledger/paths";
import { resolveCheckout } from "../ledger/workspace";
import { createHostSampler } from "./host-load";
import type { CliResult } from "./reservations-cli";
import { runShift, type ShiftDeps, type ShiftOptions } from "./shift";
import { prCheckRunner, toolRunner } from "./shift-pr";
import { recoverShift, unfinishedMessage } from "./shift-recover";
import {
  listShiftRecords,
  mintShiftId,
  requestStop,
  SHIFTS_DIR,
} from "./shift-store";
import { createWorktree } from "./worktrees";

const USAGE =
  "run [--for 2h] [--concurrency 2] [--max-beads 4] [--max-usd 10] [--repairs 3] [--epic <id>] [--smith <name>] [--run-timeout <duration>] [--base master] | stop <shift-id> | recover <shift-id> | list";

type Env = Readonly<Record<string, string | undefined>>;

const DURATION = /^([1-9]\d{0,5})(s|m|h)$/;
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000 } as const;

/** `90s`, `30m`, `2h` in ms; null for anything else. */
export function parseDuration(text: string): number | null {
  const match = DURATION.exec(text);
  if (match === null) return null;
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}

/** The checkout this file belongs to: where `bun run pr:check` is defined. */
const HARNESS = resolve(import.meta.dir, "..", "..");

/**
 * The real dependencies for `cwd`: bd in the main checkout; the ledger, the
 * queue lock and the shift records in the harness home; worktrees made by the
 * registry under the main checkout, from the base commit the shift fetched;
 * git and gh from the PATH, and this harness's `pr:check`; the host sampled
 * from this machine. Runs use the providers' own CLIs.
 */
export function shiftCliDeps(cwd: string, env: Env = process.env): ShiftDeps {
  const main = localStateRoot(cwd);
  const home = agentForgeHome(env);
  const sampler = createHostSampler();
  return {
    root: cwd,
    runBd: bdRunner(main),
    ledgerPath: ledgerPath(env),
    lockFile: join(home, QUEUE_LOCK_FILE),
    shiftsDir: join(home, SHIFTS_DIR),
    mainCheckout: main,
    sampleHost: sampler,
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

/** The options `run` was given, or why they are not options. */
function runOptions(
  args: readonly string[],
): { ok: true; value: Partial<ShiftOptions> } | { ok: false; error: string } {
  const options: Partial<ShiftOptions> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i] ?? "";
    const value = args[i + 1];
    if (!Object.hasOwn(RUN_FLAGS, flag))
      return { ok: false, error: `unknown option ${flag}` };
    if (value === undefined || value.startsWith("--"))
      return { ok: false, error: `${flag} needs a value` };
    const name = RUN_FLAGS[flag as keyof typeof RUN_FLAGS];
    if (name === "epic" || name === "smith" || name === "base") {
      options[name] = value;
      continue;
    }
    if (name === "forMs" || name === "runTimeoutMs") {
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
  return { ok: true, value: options };
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
    const shiftId = deps.shiftId ?? mintShiftId(new Date());
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

if (isMain(import.meta)) {
  const result = await runShiftCli(
    process.argv.slice(2),
    shiftCliDeps(process.cwd()),
  );
  console.log(JSON.stringify(result.out, null, 2));
  process.exit(result.exit);
}
