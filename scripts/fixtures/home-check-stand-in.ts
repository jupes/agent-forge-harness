/**
 * A program that is not the home check, run in its place by home-guard.test.ts
 * (compiled, as `checkHomeInBun`'s `bun`): it exits 0 without the check's
 * answer. Named `…silent…`, it prints nothing, as a CLI whose entry check did
 * not match exits; named `…stale…`, it prints the answer's line with a nonce
 * that is not the one it was given. Told by its own name, not the
 * environment: a variable the test set at run time did not reach the child
 * of Bun's `spawnSync` (seen with Bun 1.3.10 on Windows).
 */
import { basename } from "node:path";

if (basename(process.execPath).includes("stale"))
  process.stdout.write(
    `agent-forge home-guard: trusted ${"0".repeat(32)}\nnone\n`,
  );
