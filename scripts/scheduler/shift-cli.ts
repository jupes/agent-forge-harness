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

import { isMain } from "../is-main";
import { shiftCliDeps, shiftCliMain } from "./shift-cli-runtime";

export * from "./shift-cli-runtime";

if (isMain(import.meta)) {
  await shiftCliMain(process.argv.slice(2), shiftCliDeps(process.cwd()));
}
