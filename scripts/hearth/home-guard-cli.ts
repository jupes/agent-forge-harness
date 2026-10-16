/**
 * `bun scripts/hearth/home-guard-cli.ts <home> [<lock>]`: the home check
 * (`homeWriteProblem` in `home-guard.ts`) as a process, for a runtime that
 * cannot read a Windows ACL itself (the dashboard's Vite, under Node:
 * `checkHomeInBun`). Exits 0 when nobody else can write the home or the
 * lock; `PROBLEM_EXIT` with the refusal on stdout when someone can.
 *
 * A file of its own: Vite bundles `home-guard.ts` as CommonJS, where the
 * `import.meta` an entry check reads is empty.
 */

import { isMain } from "../is-main";
import { homeWriteProblem, PROBLEM_EXIT } from "./home-guard";

if (isMain(import.meta)) {
  const [home, lock] = process.argv.slice(2);
  if (home === undefined) {
    process.stderr.write(
      "usage: bun scripts/hearth/home-guard-cli.ts <home> [<lock>]\n",
    );
    process.exit(2);
  }
  const problem = homeWriteProblem(home, lock);
  if (problem !== null) {
    process.stdout.write(`${problem}\n`);
    process.exit(PROBLEM_EXIT);
  }
}
