/**
 * Preloaded by `bun test` (see `bunfig.toml`).
 *
 * Points the whole test process at a throwaway ledger home, so a test that
 * reaches an emitter without naming a ledger can never write the real one
 * under the user's home. It is a safety net only: tests that assert on ledger
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
