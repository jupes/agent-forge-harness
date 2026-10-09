/**
 * Preloaded by `bun test` (see `bunfig.toml`).
 *
 * Points the test process at a throwaway ledger home, so a test that reaches
 * an emitter without naming a ledger writes there and not under the user's
 * home. A child process is covered only while it inherits this environment: a
 * test that builds a child's environment itself must set `AGENT_FORGE_HOME`
 * in it (`test-isolation.test.ts` checks that). Tests that assert on ledger
 * contents create their own ledger and pass its path.
 */

import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeLedger } from "./db";

const home = mkdtempSync(join(tmpdir(), "agent-forge test home "));
process.env.AGENT_FORGE_HOME = home;

afterAll(() => {
  closeLedger();
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // A ledger file still held open on Windows: the OS temp directory reclaims it.
  }
});
