/**
 * Guard against the test suite writing the ledger under the user's home.
 *
 * Two halves. In this process, the preload has already moved the ledger to a
 * temp directory, so an emitter that names no ledger lands there. For child
 * processes — which may be handed an environment that drops the preload's
 * setting — every test file that can start a process is run again with the OS
 * home pointed at a scratch directory (`HOME` and `USERPROFILE` both) and no
 * `AGENT_FORGE_HOME`: a child that keeps the OS home variable then has the
 * default home `<scratch>/.agent-forge`, and it must not appear. That
 * directory is the hearth's as well as the ledger's, so a lock or token file
 * written there fails this too.
 *
 * "Can start a process" is decided by a scan, so a new test is covered without
 * being listed here: a `*.test.ts` file under `scripts/` is re-run when it, or
 * any module it loads (followed by `scripts/import-graph.ts`), names one of
 * the primitives in `SPAWNS`. A test that starts a hearth through
 * `scripts/hearth/supervisor.ts` or an executor through `scripts/executors/`
 * is therefore in, though the test file itself spawns nothing.
 *
 * What this does not cover:
 * - a child whose environment has neither `AGENT_FORGE_HOME` nor the OS home
 *   variable (`USERPROFILE` on Windows, `HOME` elsewhere). The OS home then
 *   comes from the user's account, not the environment, so that child writes
 *   under the real home in this re-run as in an ordinary run, and the scratch
 *   directory never sees it.
 * - a test file the scan does not list: only `*.test.ts` files under
 *   `scripts/` are read, though `bun test` also runs other names (`.test.tsx`,
 *   `.spec.ts`, `_test.ts`; there are none today). The Playwright specs under
 *   `tests/e2e` are not run by `bun test` at all.
 * - a process started through a primitive that is not in `SPAWNS`, or from
 *   inside a package other than the MCP stdio client;
 * - a module the import scan does not follow (its header lists what it cannot
 *   see, such as a computed specifier);
 * - a child that writes somewhere other than the default home.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, relative, resolve, sep } from "path";
import { importGraph } from "../import-graph";
import { ledgerHome, ledgerPath } from "./paths";

const REPO = resolve(import.meta.dir, "..", "..");
const TEST_ROOT = join(REPO, "scripts");
const SELF = resolve(import.meta.path);

/**
 * The ways code in this repo starts a process: Bun's spawn and shell, Node's
 * `child_process` (whatever is imported from it), and the MCP stdio client,
 * which spawns inside its package.
 */
const SPAWNS =
  /Bun\.spawn|Bun\.\$|child_process|StdioClientTransport|\{[^}]*\$[^}]*\}\s*from\s*["']bun["']/;

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === "node_modules" ? [] : testFiles(path);
    return entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

/** Whether a file names a spawn primitive; each file is read once. */
const spawns = new Map<string, boolean>();
function startsProcesses(file: string): boolean {
  let known = spawns.get(file);
  if (known === undefined) {
    known = SPAWNS.test(readFileSync(file, "utf8"));
    spawns.set(file, known);
  }
  return known;
}

function spawningTestFiles(): string[] {
  return testFiles(TEST_ROOT)
    .filter((file) => resolve(file) !== SELF)
    .filter((file) => importGraph(file).files.some(startsProcesses))
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

  test("the scan finds the test files that start processes, directly or through a module they load", () => {
    const files = spawningTestFiles();
    expect(files).toEqual(
      expect.arrayContaining([
        "scripts/council/safety.test.ts",
        "scripts/forge/ledger-events.test.ts",
        "scripts/forge/stop-hook.test.ts",
        "scripts/ledger/audit-bead.test.ts",
        "scripts/ledger/audit-cli.test.ts",
        "scripts/ledger/db.test.ts",
        "scripts/ledger/hooks.test.ts",
        // Nothing in these files spawns: the modules they load do.
        "scripts/executors/exec-cli.test.ts",
        "scripts/hearth/supervisor.test.ts",
      ]),
    );
    // And it is a selection, not the whole suite.
    expect(files).not.toContain("scripts/ledger/ulid.test.ts");
    expect(files).not.toContain("scripts/ledger/paths.test.ts");
    expect(files).not.toContain("scripts/secret-patterns.test.ts");
  });

  test("every test file that can start a process, re-run with the OS home pointed at a scratch directory, leaves no .agent-forge there", async () => {
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
