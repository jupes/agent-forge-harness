#!/usr/bin/env bun
/**
 * reservations-cli.ts — which queued beads may start, and the file
 * reservations that decide it.
 *
 * Usage:
 *   bun run forge:eligible [--busy <reason>]
 *   bun run forge:reservations list
 *   bun run forge:reservations reserve <bead> <worktree> [--session <id>]
 *   bun run forge:reservations release <bead> <worktree>
 *
 * Every command prints `{ ok, data, error }` and exits 1 when `ok` is false.
 * `eligible` and `list` write nothing. `reserve` reserves the bead's own file
 * map (its description's, else its acceptance criteria's; everything when it
 * has no usable one); `release` frees a reservation by hand, the way out for a
 * shift that died holding one. bd runs in the main checkout; the ledger and
 * the lock are the harness home's, the same ones the hearth uses.
 */

import { join } from "node:path";
import { agentForgeHome } from "../agent-forge-home";
import {
  type BdResult,
  type BdRunner,
  bdRunner,
  localStateRoot,
} from "../hearth/routes/dev-api";
import { QUEUE_LOCK_FILE } from "../hearth/routes/queue";
import { parsed, refusal } from "../hearth/tracker-write";
import { ledgerPath } from "../ledger/paths";
import { activeReservations } from "../ledger/query";
import { resolveCheckout } from "../ledger/workspace";
import { readEligibility, staleOf } from "./eligibility";
import { release, reservationFor, reserve } from "./reservations";

const USAGE =
  "eligible [--busy <reason>] | list | reserve <bead> <worktree> [--session <id>] | release <bead> <worktree>";

type Env = Readonly<Record<string, string | undefined>>;

export interface CliDeps {
  /** The checkout the command runs for. */
  root: string;
  /** Its ledger workspace: the main checkout. */
  workspace: string;
  runBd: BdRunner;
  ledgerPath: string;
  lockFile: string;
}

/** The real dependencies for `cwd`: bd in the main checkout, the harness home's ledger and lock. */
export function cliDeps(
  cwd: string,
  env: Env = process.env,
): CliDeps & { bdRoot: string } {
  const bdRoot = localStateRoot(cwd);
  return {
    root: cwd,
    workspace: resolveCheckout(cwd).workspace,
    bdRoot,
    runBd: bdRunner(bdRoot),
    ledgerPath: ledgerPath(env),
    lockFile: join(agentForgeHome(env), QUEUE_LOCK_FILE),
  };
}

export interface CliResult {
  exit: number;
  out: { ok: boolean; data: unknown; error: string | null };
}

const done = (data: unknown): CliResult => ({
  exit: 0,
  out: { ok: true, data, error: null },
});
const failed = (error: string): CliResult => ({
  exit: 1,
  out: { ok: false, data: null, error },
});

/** Positional arguments and `--name value` options; a known option with no value is an error. */
function parseArgs(
  args: readonly string[],
  known: readonly string[],
):
  | { ok: true; positional: string[]; options: Record<string, string> }
  | { ok: false; error: string } {
  const positional: string[] = [];
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (!known.includes(name))
      return { ok: false, error: `unknown option ${arg}` };
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--"))
      return { ok: false, error: `${arg} needs a value` };
    options[name] = value;
    i++;
  }
  return { ok: true, positional, options };
}

/** The bead's own text, for its file map. */
async function beadText(
  runBd: BdRunner,
  id: string,
): Promise<
  | {
      ok: true;
      bead: { id: string; description?: string; acceptance_criteria?: string };
    }
  | { ok: false; error: string }
> {
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
    ? (rows as Array<{ id?: unknown }>).find((r) => r?.id === id)
    : undefined;
  if (row === undefined)
    return { ok: false, error: `No bead has exactly the id ${id}` };
  const text = row as { description?: unknown; acceptance_criteria?: unknown };
  return {
    ok: true,
    bead: {
      id,
      ...(typeof text.description === "string"
        ? { description: text.description }
        : {}),
      ...(typeof text.acceptance_criteria === "string"
        ? { acceptance_criteria: text.acceptance_criteria }
        : {}),
    },
  };
}

export async function runCli(
  argv: readonly string[],
  deps: CliDeps,
): Promise<CliResult> {
  const [command, ...rest] = argv;
  const store = {
    workspace: deps.workspace,
    ledgerPath: deps.ledgerPath,
    lockFile: deps.lockFile,
  };

  if (command === "eligible") {
    const args = parseArgs(rest, ["busy"]);
    if (!args.ok) return failed(`${args.error}. Usage: ${USAGE}`);
    if (args.positional.length > 0) return failed(`Usage: ${USAGE}`);
    const reason = args.options["busy"];
    const read = await readEligibility({
      root: deps.root,
      runBd: deps.runBd,
      ledgerPath: deps.ledgerPath,
      host: reason !== undefined ? { busy: true, reason } : { busy: false },
    });
    return read.ok ? done(read.value) : failed(read.error);
  }

  if (command === "list") {
    if (rest.length > 0) return failed(`Usage: ${USAGE}`);
    const reservations = activeReservations(
      { workspace: deps.workspace },
      { path: deps.ledgerPath },
    );
    const ids = [...new Set(reservations.map((r) => r.beadId))];
    const stale = await staleOf(deps.runBd, ids);
    if (!stale.ok) return failed(stale.error);
    return done({
      reservations,
      stale: reservations
        .filter((r) => stale.value.has(r.beadId))
        .map((reservation) => ({
          reservation,
          why: stale.value.get(reservation.beadId),
        })),
    });
  }

  if (command === "reserve") {
    const args = parseArgs(rest, ["session"]);
    if (!args.ok) return failed(`${args.error}. Usage: ${USAGE}`);
    const [beadId, worktree, extra] = args.positional;
    if (beadId === undefined || worktree === undefined || extra !== undefined)
      return failed(`Usage: ${USAGE}`);
    const text = await beadText(deps.runBd, beadId);
    if (!text.ok) return failed(text.error);
    const wanted = reservationFor(text.bead);
    const outcome = await reserve(
      {
        beadId,
        worktree,
        globs: wanted.globs,
        sessionId: args.options["session"],
      },
      store,
    );
    return outcome.ok
      ? done({
          ...outcome.value,
          conservative: wanted.conservative,
          reason: wanted.reason ?? null,
        })
      : failed(outcome.error);
  }

  if (command === "release") {
    const [beadId, worktree, extra] = rest;
    if (beadId === undefined || worktree === undefined || extra !== undefined)
      return failed(`Usage: ${USAGE}`);
    const outcome = await release({ beadId, worktree }, store);
    return outcome.ok
      ? done({ released: outcome.value })
      : failed(outcome.error);
  }

  return failed(
    `${command === undefined ? "No command" : `Unknown command: ${command}`}. Usage: ${USAGE}`,
  );
}

if (import.meta.main) {
  const result = await runCli(process.argv.slice(2), cliDeps(process.cwd()));
  console.log(JSON.stringify(result.out, null, 2));
  process.exit(result.exit);
}
