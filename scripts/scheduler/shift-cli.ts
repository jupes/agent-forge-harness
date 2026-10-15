#!/usr/bin/env bun
/**
 * shift-cli.ts — run a shift, stop one, list them.
 *
 * Usage:
 *   bun run forge:shift run [--for 2h] [--concurrency 2] [--max-beads 4]
 *       [--max-usd 10] [--repairs 3] [--epic <id>] [--smith <name>]
 *       [--run-timeout <duration>]
 *   bun run forge:shift stop <shift-id>
 *   bun run forge:shift list
 *
 * A duration is a whole number of seconds, minutes or hours: `90s`, `30m`,
 * `2h`. `run` writes one line to stderr before it starts, the shift's id and
 * the command that stops it, then runs until the shift stops and prints the
 * shift's record. It takes only beads in `queued` (an operator approved and
 * queued them), never merges, never pushes, and opens no pull request: a bead
 * whose run succeeds ends in `review` with its work committed on the branch
 * `shift/<shift-id>/<bead>`, in a worktree under `trees/` that is kept.
 *
 * `stop` asks a running shift to stop (the hearth's `POST /shifts/:id/stop`
 * does the same): it stops every run, puts their beads back in `queued`,
 * frees their reservations and records `shift.stopped`. Ctrl-C kills the
 * runs too, but leaves their beads `running` and their reservations held:
 * prefer `stop`.
 *
 * Every command prints `{ ok, data, error }` and exits 1 when `ok` is false.
 * bd runs in the main checkout; the ledger, the queue lock and the shift
 * records are the harness home's, the same ones the hearth uses.
 */

import { join } from "node:path";
import { agentForgeHome } from "../agent-forge-home";
import { bdRunner, localStateRoot } from "../hearth/routes/dev-api";
import { QUEUE_LOCK_FILE } from "../hearth/routes/queue";
import { isMain } from "../is-main";
import { ledgerPath } from "../ledger/paths";
import { createHostSampler } from "./host-load";
import type { CliResult } from "./reservations-cli";
import { runShift, type ShiftDeps, type ShiftOptions } from "./shift";
import {
  listShiftRecords,
  mintShiftId,
  requestStop,
  SHIFTS_DIR,
} from "./shift-store";
import { createWorktree } from "./worktrees";

const USAGE =
  "run [--for 2h] [--concurrency 2] [--max-beads 4] [--max-usd 10] [--repairs 3] [--epic <id>] [--smith <name>] [--run-timeout <duration>] | stop <shift-id> | list";

type Env = Readonly<Record<string, string | undefined>>;

const DURATION = /^([1-9]\d{0,5})(s|m|h)$/;
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000 } as const;

/** `90s`, `30m`, `2h` in ms; null for anything else. */
export function parseDuration(text: string): number | null {
  const match = DURATION.exec(text);
  if (match === null) return null;
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}

/**
 * The real dependencies for `cwd`: bd in the main checkout; the ledger, the
 * queue lock and the shift records in the harness home; worktrees made by the
 * registry under the main checkout, from the HEAD of `cwd`; the host sampled
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
    makeWorktree: ({ id, branch, beadId }) => {
      const made = createWorktree(
        main,
        cwd,
        { branch, beadId },
        { newId: () => id },
      );
      return made.ok
        ? { ok: true, path: made.value.path }
        : { ok: false, error: made.error };
    },
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
    if (name === "epic" || name === "smith") {
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
