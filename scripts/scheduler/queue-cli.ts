#!/usr/bin/env bun
/**
 * queue-cli.ts — the approval queue from the command line.
 *
 * Usage:
 *   bun run forge:queue reconcile
 *
 * `reconcile` compares each bead's queue state on Beads with the moves the
 * ledger recorded for it (`queue-reconcile.ts`) and prints where they part: a
 * `gap`, a move made on the bead with no `bead.transitioned` for it, and a
 * `duplicate`, one move recorded twice in a row. It writes nothing, to Beads
 * or to the ledger, and reads under the queue lock, so a move waits for it.
 *
 * Prints `{ ok, data, error }` and exits 1 when `ok` is false; drift found is
 * an answer, not an error. bd runs in the main checkout; the ledger and the
 * lock are the harness home's, the same ones the hearth uses.
 */

import { reconcileQueue } from "./queue-reconcile";
import { type CliDeps, type CliResult, cliDeps } from "./reservations-cli";

const USAGE = "reconcile";

const failed = (error: string): CliResult => ({
  exit: 1,
  out: { ok: false, data: null, error },
});

export async function runQueueCli(
  argv: readonly string[],
  deps: CliDeps,
): Promise<CliResult> {
  const [command, ...rest] = argv;
  if (command !== "reconcile")
    return failed(
      `${command === undefined ? "No command" : `Unknown command: ${command}`}. Usage: ${USAGE}`,
    );
  if (rest.length > 0) return failed(`Usage: ${USAGE}`);
  const read = await reconcileQueue({
    workspace: deps.workspace,
    runBd: deps.runBd,
    ledgerPath: deps.ledgerPath,
    lockFile: deps.lockFile,
  });
  return read.ok
    ? { exit: 0, out: { ok: true, data: read.value, error: null } }
    : failed(read.error);
}

if (import.meta.main) {
  const result = await runQueueCli(
    process.argv.slice(2),
    cliDeps(process.cwd()),
  );
  console.log(JSON.stringify(result.out, null, 2));
  process.exit(result.exit);
}
