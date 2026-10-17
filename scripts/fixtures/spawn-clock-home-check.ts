/** A slow successful home-check stand-in, compiled by home-guard.test.ts. */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

// As `checkHomeInBun` runs the check: the CLI, the nonce, the home.
const [nonce, home] = process.argv.slice(3);
if (nonce === undefined || home === undefined)
  throw new Error("the home-check stand-in needs a nonce and a home");
appendFileSync(join(home, "checked.txt"), "started\n");
Bun.sleepSync(22_000);
appendFileSync(join(home, "checked.txt"), "finished\n");
// The check's answer when it passed (`guardAnswer` in home-guard.ts).
process.stdout.write(`agent-forge home-guard: trusted ${nonce}\nnone\n`);
