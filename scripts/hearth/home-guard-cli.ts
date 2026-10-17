/**
 * `bun scripts/hearth/home-guard-cli.ts <nonce> <home> [<file>]`: the home
 * check and the read of a file in it (`readHomeFile` in `home-guard.ts`) as a
 * process, for a runtime that cannot read a Windows ACL itself (the
 * dashboard's Vite, under Node: `checkHomeInBun`). When nobody else can write
 * the home or the file, it exits 0 with its answer to `<nonce>`
 * (`guardAnswer`: the nonce, then the file's text as it read it, or none);
 * when someone can, `PROBLEM_EXIT` with the refusal on stdout. Exit 0 without
 * that answer is no answer: the caller refuses it.
 *
 * A file of its own: Vite bundles `home-guard.ts` as CommonJS, where the
 * `import.meta` an entry check reads is empty.
 */

import { isMain } from "../is-main";
import {
  guardAnswer,
  isGuardNonce,
  PROBLEM_EXIT,
  readHomeFile,
} from "./home-guard";

if (isMain(import.meta)) {
  const [nonce, home, file] = process.argv.slice(2);
  if (nonce === undefined || !isGuardNonce(nonce) || home === undefined) {
    process.stderr.write(
      "usage: bun scripts/hearth/home-guard-cli.ts <nonce> <home> [<file>]\n",
    );
    process.exit(2);
  }
  const read = readHomeFile(home, file);
  if (read.problem !== null) {
    process.stdout.write(`${read.problem}\n`);
    process.exit(PROBLEM_EXIT);
  }
  process.stdout.write(guardAnswer(nonce, read.text));
}
