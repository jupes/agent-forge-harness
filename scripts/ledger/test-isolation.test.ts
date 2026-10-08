/**
 * Guard: the test suite cannot write the ledger under the user's home.
 *
 * Two halves. In this process, the preload has already moved the ledger to a
 * temp directory, so an emitter that names no ledger lands there. For child
 * processes — which may be handed an environment that drops the preload's
 * setting — every test file that starts a process is run again with the OS
 * home pointed at a scratch directory and no `AGENT_FORGE_HOME`: the default
 * ledger location is then `<scratch>/.agent-forge`, and it must not appear.
 *
 * The files are found by scanning for the ways a test starts a process, so a
 * new spawning test is covered without being listed here. What this does not
 * cover: a process started through a primitive that is not in `SPAWNS`.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, relative, resolve, sep } from "path";
import { ledgerHome, ledgerPath } from "./paths";

const REPO = resolve(import.meta.dir, "..", "..");
const TEST_ROOT = join(REPO, "scripts");
const SELF = resolve(import.meta.path);

/** Every way a test in this repo starts a process. */
const SPAWNS =
  /Bun\.spawn|\bspawn(?:Sync)?\(|\bexec(?:File)?(?:Sync)?\(|child_process|StdioClientTransport|Bun\.\$|\$`/;

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === "node_modules" ? [] : testFiles(path);
    return entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

function spawningTestFiles(): string[] {
  return testFiles(TEST_ROOT)
    .filter((file) => resolve(file) !== SELF)
    .filter((file) => SPAWNS.test(readFileSync(file, "utf8")))
    .map((file) => relative(REPO, file).split(sep).join("/"))
    .sort();
}

describe("the test suite and the ledger under the user's home", () => {
  test("in the test process the default ledger is a temp directory, not the OS home", () => {
    const home = resolve(ledgerHome());
    expect(home.startsWith(resolve(tmpdir()) + sep)).toBe(true);
    expect(home).not.toBe(resolve(join(homedir(), ".agent-forge")));
    expect(resolve(ledgerPath())).toBe(join(home, "ledger.db"));
  });

  test("the scan finds the test files known to start processes", () => {
    expect(spawningTestFiles()).toEqual(
      expect.arrayContaining([
        "scripts/council/safety.test.ts",
        "scripts/forge/ledger-events.test.ts",
        "scripts/forge/stop-hook.test.ts",
        "scripts/ledger/audit-bead.test.ts",
        "scripts/ledger/audit-cli.test.ts",
        "scripts/ledger/db.test.ts",
        "scripts/ledger/hooks.test.ts",
      ]),
    );
  });

  test("every test file that starts a process, re-run with the OS home pointed at a scratch directory, leaves no .agent-forge there", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "ledger isolation home "));
    try {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value === undefined || key === "AGENT_FORGE_HOME") continue;
        env[key] = value;
      }
      env.HOME = scratch;
      env.USERPROFILE = scratch;

      const files = spawningTestFiles();
      const child = Bun.spawn([process.execPath, "test", ...files], {
        cwd: REPO,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const exitCode = await child.exited;

      // A failing inner run could have stopped short of the spawn it guards.
      expect({ exitCode, tail: `${stdout}${stderr}`.slice(-1500) }).toEqual({
        exitCode: 0,
        tail: expect.any(String),
      });
      expect(existsSync(join(scratch, ".agent-forge"))).toBe(false);
    } finally {
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch {
        // A file a child still holds on Windows: the OS temp directory reclaims it.
      }
    }
  }, 180_000);
});
