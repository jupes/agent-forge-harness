/**
 * Preloaded by `bun test` (see `bunfig.toml`).
 *
 * Points the test process at a throwaway ledger home, so a test that reaches
 * an emitter without naming a ledger writes there and not under the user's
 * home. A child process is covered only while it inherits this environment: a
 * test that builds a child's environment itself must set `AGENT_FORGE_HOME`
 * in it. `test-isolation.test.ts` checks that in a re-run with the OS home
 * pointed at a scratch directory: for a child that keeps the OS home
 * variable, and, through the spawn probe this preload installs in that re-run
 * (`isolation-probe.ts`), for a child started with `Bun.spawn`,
 * `Bun.spawnSync` or `node:child_process` whose environment names no home at
 * all. Not checked: such a child started through the Bun shell or by another
 * child; the guard's header lists the rest. Tests that assert on ledger
 * contents create their own ledger and pass its path.
 */

import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeLedger } from "./db";
import { ISOLATION_HOME, installIsolationProbe } from "./isolation-probe";

const home = mkdtempSync(join(tmpdir(), "agent-forge test home "));
process.env.AGENT_FORGE_HOME = home;

// Only in the isolation guard's re-run: see `isolation-probe.ts`.
const isolationHome = process.env[ISOLATION_HOME];
if (isolationHome !== undefined) installIsolationProbe(isolationHome);

afterAll(() => {
  closeLedger();
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // A ledger file still held open on Windows: the OS temp directory reclaims it.
  }
});
