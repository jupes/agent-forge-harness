#!/usr/bin/env bun
/**
 * worktree.ts — Git worktrees for parallel work, over the registry in
 * scripts/scheduler/worktrees.ts.
 *
 * Usage:
 *   bun run worktree create <branch> [--bead <id>] [--session <id>]
 *   bun run worktree list
 *   bun run worktree cleanup <id> [--force]
 *   bun run worktree cleanup-all
 *
 * Every command prints one JSON object and exits 1 when it is `ok: false`.
 * The registry is the main checkout's, wherever this is run from. `list`
 * shows every worktree of the repository; `cleanup` removes only the ones
 * `create` made, and keeps one with changes unless `--force` is given.
 */

import type { WorktreeResult } from "../types/beads";
import {
  createWorktree,
  gitRun,
  listWorktrees,
  mainCheckoutOf,
  removeWorktree,
  STASH_WARNING,
} from "./scheduler/worktrees";

const USAGE =
  "worktree create <branch> [--bead <id>] [--session <id>] | list | cleanup <id> [--force] | cleanup-all";

type Printed = WorktreeResult & Record<string, unknown>;

function print(result: Printed): never {
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}

/** The positional arguments and the `--name value` options; a flag with no value is an error. */
function parseArgs(
  args: readonly string[],
  valued: readonly string[],
  flags: readonly string[],
):
  | {
      ok: true;
      positional: string[];
      options: Record<string, string>;
      set: Set<string>;
    }
  | { ok: false; error: string } {
  const positional: string[] = [];
  const options: Record<string, string> = {};
  const set = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const name = arg.slice(2);
    if (arg.startsWith("--") && valued.includes(name)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--"))
        return { ok: false, error: `${arg} needs a value` };
      options[name] = value;
      i++;
    } else if (arg.startsWith("--") && flags.includes(name)) set.add(name);
    else if (arg.startsWith("--"))
      return { ok: false, error: `unknown option ${arg}` };
    else positional.push(arg);
  }
  return { ok: true, positional, options, set };
}

const [, , command, ...rest] = process.argv;
const cwd = process.cwd();
const main = mainCheckoutOf(cwd, gitRun);
if (main === null)
  print({ ok: false, error: `${cwd} is not inside a git repository` });

if (command === "create") {
  const parsed = parseArgs(rest, ["bead", "session"], []);
  if (!parsed.ok) print({ ok: false, error: parsed.error, usage: USAGE });
  const [branch, extra] = parsed.positional;
  if (branch === undefined || extra !== undefined)
    print({ ok: false, error: `Usage: ${USAGE}` });
  const created = createWorktree(main, cwd, {
    branch,
    beadId: parsed.options["bead"],
    sessionId: parsed.options["session"],
  });
  print(
    created.ok
      ? { ok: true, worktree: created.value, warnings: [STASH_WARNING] }
      : { ok: false, error: created.error },
  );
} else if (command === "list") {
  const listed = listWorktrees(main);
  print(
    listed.ok
      ? { ok: true, worktrees: listed.entries, warnings: [STASH_WARNING] }
      : { ok: false, error: listed.error },
  );
} else if (command === "cleanup") {
  const parsed = parseArgs(rest, [], ["force"]);
  if (!parsed.ok) print({ ok: false, error: parsed.error, usage: USAGE });
  const [id, extra] = parsed.positional;
  if (id === undefined || extra !== undefined)
    print({ ok: false, error: `Usage: ${USAGE}` });
  const removed = removeWorktree(main, id, { force: parsed.set.has("force") });
  print(
    removed.ok
      ? { ok: true, removed: removed.value }
      : { ok: false, error: removed.error },
  );
} else if (command === "cleanup-all") {
  const listed = listWorktrees(main);
  if (!listed.ok) print({ ok: false, error: listed.error });
  const results = listed.entries
    .filter((entry) => entry.id !== undefined)
    .map((entry) => {
      const removed = removeWorktree(main, entry.id as string, {
        force: false,
      });
      return removed.ok
        ? { id: entry.id, ok: true }
        : { id: entry.id, ok: false, error: removed.error };
    });
  print({
    ok: results.every((result) => result.ok),
    removed: results,
  });
} else {
  print({
    ok: false,
    error: `Unknown command: ${command ?? "(none)"}`,
    usage: USAGE,
  });
}
