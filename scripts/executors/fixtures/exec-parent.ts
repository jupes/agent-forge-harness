#!/usr/bin/env bun
/**
 * A stand-in `forge:exec` process: what `exec-cli.ts`'s main block does
 * (`runExec`, print the envelope, exit with its code), with the Claude adapter
 * run on the fake binary in `hang` mode in place of the real CLI.
 *
 *   bun exec-parent.ts <dir>
 *
 * `<dir>` is a scratch directory of the test's: the harness root (a `.git` of
 * its own), the run's worktree and the ledger are made in it, and the fake
 * writes its dump (with its pid) to `<dir>/dump.json` once it runs. Each line
 * read on stdin that is `SIGINT` or `SIGTERM` is emitted in this process
 * (`process.emit`): on Windows no signal can be sent to a process without
 * ending it outright.
 */

import { mkdirSync } from "fs";
import { join } from "path";
import { claudeAdapter } from "../claude";
import { runExec } from "../exec-cli";

const dir = process.argv[2];
if (dir === undefined) throw new Error("usage: exec-parent.ts <dir>");
mkdirSync(join(dir, ".git"), { recursive: true });
const worktree = join(dir, "wt");
mkdirSync(join(worktree, ".git"), { recursive: true });

void (async () => {
  const decoder = new TextDecoder();
  const reader = Bun.stdin.stream().getReader();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    let end = text.indexOf("\n");
    while (end !== -1) {
      const line = text.slice(0, end).trim();
      text = text.slice(end + 1);
      if (line === "SIGINT" || line === "SIGTERM") process.emit(line);
      end = text.indexOf("\n");
    }
  }
})();

const outcome = await runExec(
  ["--bead", "x-1", "--worktree", worktree, "--prompt", "hi"],
  {
    harnessRoot: dir,
    home: dir,
    cwd: dir,
    ledgerPath: join(dir, "home", "ledger.db"),
    env: { PATH: process.env.PATH },
    adapters: { claude: claudeAdapter },
    command: [
      process.execPath,
      join(import.meta.dir, "fake-cli.ts"),
      "--fake-provider",
      "claude",
      "--fake-mode",
      "hang",
      "--fake-dump",
      join(dir, "dump.json"),
    ],
  },
);
console.log(JSON.stringify(outcome.body, null, 2));
process.exit(outcome.code);
