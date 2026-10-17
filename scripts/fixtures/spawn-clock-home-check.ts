/** A slow successful home-check stand-in, compiled by home-guard.test.ts. */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const home = process.argv[3];
if (home === undefined) throw new Error("the home-check stand-in needs a home");
appendFileSync(join(home, "checked.txt"), "started\n");
Bun.sleepSync(22_000);
appendFileSync(join(home, "checked.txt"), "finished\n");
