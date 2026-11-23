#!/usr/bin/env bun
/**
 * exec-cli.ts — run one bounded task through a smith's provider CLI.
 *
 *   bun run forge:exec --bead <id> --worktree <dir> --prompt <text>
 *       [--smith <name>] [--bead-smith <name>] [--complexity low|medium|high]
 *       [--run <slug>] [--timeout-ms <n>] [--prompt-file <path>] [--json]
 *
 * Smith resolution: --smith, then --bead-smith, then the bench for
 * --complexity, then workflow.default_crew. The child gets only allowlisted
 * variables of this process's environment, plus the ones its adapter sets
 * itself (`env.ts`) and, with --run, the correlation pointer described below.
 *
 * The run's events (`session.started`, one `tool.called` per tool,
 * `session.ended`) go to the ledger; read them with
 * `bun run forge:audit --bead <id>`. An event the ledger does not take never
 * stops the provider: the envelope reports `recorded`, `notRecorded` and the
 * first `ledgerError`, and `ledger` names the file written.
 *
 * A --run value that is not a Forge run id (a run's slug) is refused before
 * anything is started or written. With --run, the run's correlation
 * (`scripts/run-correlation.ts`) is written in the worktree and its path put
 * in the child's environment, so a quality gate that runs inside the child is
 * linked to this bead and run. The worktree must be a checkout's top level for
 * that. A run already correlated to another bead is left alone. Whenever no
 * pointer is handed on, a gate inside the child runs unlinked and
 * `data.correlationNote` says why. The child still runs, and the run's ledger
 * events and the adapter's variables still carry --bead and --run: a run moves
 * from one bead to the next (`.claude/workflows/forge.md`), so they record the
 * bead this session was launched for, while the correlation records the bead a
 * gate in the run is checked against. The child never inherits a pointer from
 * this process.
 *
 * Exit code 0 when the provider exits 0 and reported no error in its stream,
 * 2 otherwise — whatever the ledger did. A provider that exits 0 after
 * reporting an error (one whose tool host was missing did) is not a success.
 * `error` gives the provider's own reason after its exit code: the first
 * error it reported, else the last line of its stderr. `data.providerErrors`
 * and `data.stderr` (its end) hold that text, which never reaches the ledger:
 * `session.ended` records `failed: exit <n>`, or
 * `failed: exit 0, provider reported an error`.
 *
 * When the provider's stream names the model its responses came from (the
 * Claude adapter reads an assistant message's `message.model`), that model is
 * cached in the same ledger for the run's session, as the hooks cache an
 * interactive session's: it is what `forge:verdict`, run inside the child,
 * records as observed. The run's events keep the smith that was asked for.
 */

import { join } from "node:path";
import { isMain } from "../is-main";
import { runExec } from "./exec-runtime";

export * from "./exec-runtime";

if (isMain(import.meta)) {
  const harnessRoot = join(import.meta.dir, "..", "..");
  const outcome = await runExec(process.argv.slice(2), { harnessRoot });
  console.log(JSON.stringify(outcome.body, null, 2));
  process.exit(outcome.code);
}
