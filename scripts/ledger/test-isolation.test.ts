/**
 * Guard against the test suite writing the ledger under the user's home.
 *
 * Two halves. In this process, the preload has already moved the ledger to a
 * temp directory, so an emitter that names no ledger lands there. For child
 * processes — which may be handed an environment that drops the preload's
 * setting — every test file that can start a process is run again with the OS
 * home pointed at a scratch directory (`HOME` and `USERPROFILE` both) and no
 * `AGENT_FORGE_HOME`: a child that keeps the OS home variable then has the
 * default home `<scratch>/.agent-forge`, and it must not appear. A child whose
 * environment has neither `AGENT_FORGE_HOME` nor the OS home variable
 * (`USERPROFILE` on Windows, `HOME` elsewhere) would take the home of the
 * user's account instead; in the re-run the spawn probe (`isolation-probe.ts`)
 * starts such a child with `AGENT_FORGE_HOME` set to `<scratch>/.agent-forge`
 * when it is started with `Bun.spawn`, `Bun.spawnSync` or a
 * `node:child_process` function (which the MCP stdio client reaches), so it is
 * caught the same way. That directory is the hearth's as well as the ledger's,
 * so a lock or token file written there fails this too.
 *
 * "Can start a process" is decided by a scan, so a new test is covered without
 * being listed here: a `*.test.ts` file under `scripts/` is re-run when it, or
 * any module it loads (followed by `scripts/import-graph.ts`), names one of
 * the primitives in `SPAWNS`. A test that starts a hearth through
 * `scripts/hearth/supervisor.ts` or an executor through `scripts/executors/`
 * is therefore in, though the test file itself spawns nothing.
 *
 * What this does not cover:
 * - a child whose environment names neither `AGENT_FORGE_HOME` nor the OS home
 *   variable and that the spawn probe does not reach: one started through the
 *   Bun shell (`Bun.$` given an environment of its own; no test does that
 *   today, bead `agent-forge-harness-usuz`), and one started by another child,
 *   which runs without the preload and so without the probe. Its OS home comes
 *   from the user's account, so it writes under the real home in this re-run
 *   as in an ordinary run, and the scratch directory never sees it.
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

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { availableParallelism, homedir, tmpdir } from "os";
import { join, relative, resolve, sep } from "path";
import { importGraph, importGraphWithProbe } from "../import-graph";
import { ISOLATION_HOME } from "./isolation-probe";
import { settleIsolationReruns } from "./isolation-reruns";
import { ledgerHome, ledgerPath } from "./paths";
import { rerunReport } from "./rerun-output";

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

/**
 * How many re-run files run at the same time, each in a `bun test` of its own:
 * a quarter of the machine's threads, at least 2 and at most 4. On a 16-thread
 * machine, with two other full runs going, the 62 files took 144 to 153 s one
 * after another in one `bun test`, and 46 to 51 s four at a time (wwj5). One
 * after another, the re-run went past the test's 180 s limit in full runs.
 */
const RERUN_WORKERS = Math.min(
  4,
  Math.max(2, Math.floor(availableParallelism() / 4)),
);

/**
 * Only the aggregate coordinator budget, not an individual test or native
 * process deadline. The suite grew to 360 files / 201 process-reaching files,
 * including 17 actual compile fixtures. A smaller Linux tree took 171.69 s;
 * the expanded Linux run exceeded 180 s without an individual failure, while
 * Windows completed in 210.54 s under its established 600 s policy. Apply
 * that bounded aggregate policy on every platform; keep the worker/exclusive
 * schedule, all selected files and the per-test 15 s limit unchanged.
 */
const RERUN_LIMIT_MS = 600_000;

/**
 * The per-test limit of each re-run file, the one CI gives the whole suite
 * (`bun test scripts --timeout 15000`). With bun's default of 5 s, a test of
 * beads.test.ts that passes in the suite timed out in the re-run on the
 * windows-latest runner.
 */
const RERUN_TEST_TIMEOUT = "15000";

/**
 * A re-run file whose `bun test` did not exit 0: its failing tests' own lines
 * (error and diff) and the end of its output (`rerun-output.ts`).
 */
interface FailedRerun {
  file: string;
  exitCode: number;
  failures: string;
  tail: string;
}

/**
 * Run each file in its own `bun test` with `env`, `RERUN_WORKERS` at a time.
 * The timed append file gets an exclusive phase first: Windows CI stored all
 * 10,000 rows but exceeded its unchanged 60s bound under concurrent disk work.
 * Every file still runs with the scratch home, so a default home written by
 * any of them is still found; running them apart also names the file that
 * failed. The `./` makes bun take the path as a file, not a name filter.
 */
async function rerunEach(
  files: string[],
  env: Record<string, string>,
): Promise<FailedRerun[]> {
  console.error(
    `[home-isolation] ${JSON.stringify({
      event: "plan",
      files: files.length,
      workers: RERUN_WORKERS,
      aggregateLimitMs: RERUN_LIMIT_MS,
      perTestLimitMs: Number(RERUN_TEST_TIMEOUT),
    })}`,
  );
  const results = await settleIsolationReruns(
    files,
    RERUN_WORKERS,
    async (file): Promise<FailedRerun | null> => {
      const child = Bun.spawn(
        [
          process.execPath,
          "test",
          "--timeout",
          RERUN_TEST_TIMEOUT,
          `./${file}`,
        ],
        {
          cwd: REPO,
          env,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const exitCode = await child.exited;
      return exitCode === 0
        ? null
        : { file, exitCode, ...rerunReport(`${stdout}${stderr}`) };
    },
    (progress) => {
      console.error(`[home-isolation] ${JSON.stringify(progress)}`);
    },
  );
  const failed: FailedRerun[] = results.flatMap((result, index) =>
    result.status === "fulfilled"
      ? result.value === null
        ? []
        : [result.value]
      : [
          {
            file: files[index] ?? "unknown file",
            exitCode: -1,
            failures:
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason),
            tail: "",
          },
        ],
  );
  return failed.sort((a, b) => a.file.localeCompare(b.file));
}

function testFiles(
  dir: string,
  counts?: { directories: number; candidates: number },
): string[] {
  if (counts) counts.directories++;
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === "node_modules" ? [] : testFiles(path, counts);
    if (!entry.name.endsWith(".test.ts")) return [];
    if (counts) counts.candidates++;
    return [path];
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
  const diagnose = process.env["AGENT_FORGE_TEST_PROBE_DIAGNOSTICS"] === "1",
    scanStarted = performance.now(),
    counts = { directories: 0, candidates: 0 },
    enumerationStarted = performance.now(),
    candidates = testFiles(TEST_ROOT, diagnose ? counts : undefined),
    enumerationMs = Math.round(performance.now() - enumerationStarted),
    selected: string[] = [],
    slowRoots: Array<{ file: string; elapsedMs: number }> = [];
  let roots = 0,
    graphFiles = 0,
    sourceReads = 0,
    resolutionProbes = 0;
  for (const file of candidates) {
    if (resolve(file) === SELF) continue;
    const rootStarted = performance.now();
    if (diagnose) {
      const { graph, probe } = importGraphWithProbe(file);
      graphFiles += graph.files.length;
      sourceReads += probe.sourceReads;
      resolutionProbes += probe.resolutionProbes;
      if (graph.files.some(startsProcesses)) selected.push(file);
      const elapsedMs = Math.round(performance.now() - rootStarted);
      slowRoots.push({ file: relative(REPO, file).split(sep).join("/"), elapsedMs });
      slowRoots.sort((a, b) => b.elapsedMs - a.elapsedMs);
      slowRoots.length = Math.min(slowRoots.length, 5);
      roots++;
      if (roots % 32 === 0) console.error(`[isolation-scan] ${JSON.stringify({ roots, candidates: counts.candidates, elapsedMs: Math.round(performance.now() - scanStarted) })}`);
    } else if (importGraph(file).files.some(startsProcesses)) selected.push(file);
  }
  if (diagnose) console.error(`[isolation-scan] ${JSON.stringify({ event: "complete", directories: counts.directories, candidates: counts.candidates, roots, enumerationMs, elapsedMs: Math.round(performance.now() - scanStarted), graphFiles, sourceReads, resolutionProbes, slowRoots })}`);
  return selected.map((file) => relative(REPO, file).split(sep).join("/")).sort();
}

interface Rerun {
  exitCode: number;
  /** The failing tests' own lines, for a failure message. */
  failures: string;
  /** The end of the run's output, for a failure message. */
  tail: string;
  /** What `<scratch>/.agent-forge` holds after the run, or null when it was never created. */
  home: string[] | null;
  /** The session ids of the events in that directory's ledger, if it has one. */
  sessions: string[];
}

/** The distinct session ids in a ledger file; none when there is no file. */
function sessionsIn(path: string): string[] {
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true });
  try {
    return db
      .query<{ session: string | null }, []>(
        "SELECT DISTINCT session_id AS session FROM events ORDER BY session_id",
      )
      .all()
      .flatMap((row) => (row.session === null ? [] : [row.session]));
  } finally {
    db.close();
  }
}

/**
 * Runs `bun test` on the given files from the repo root, with the OS home
 * (`HOME` and `USERPROFILE`) pointed at a scratch directory and no
 * `AGENT_FORGE_HOME`, and reports what the run left in
 * `<scratch>/.agent-forge`. `ISOLATION_HOME` names that directory, so the
 * preload installs the spawn probe (`isolation-probe.ts`): a child started
 * with an environment that names no home is given it as `AGENT_FORGE_HOME`.
 */
async function rerunWithScratchHome(files: string[]): Promise<Rerun> {
  const scratch = mkdtempSync(join(tmpdir(), "ledger isolation home "));
  try {
    const home = join(scratch, ".agent-forge");
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined || key === "AGENT_FORGE_HOME") continue;
      env[key] = value;
    }
    env.HOME = scratch;
    env.USERPROFILE = scratch;
    env[ISOLATION_HOME] = home;

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
    return {
      exitCode,
      ...rerunReport(`${stdout}${stderr}`),
      home: existsSync(home) ? readdirSync(home).sort() : null,
      sessions: sessionsIn(join(home, "ledger.db")),
    };
  } finally {
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      // A file a child still holds on Windows: the OS temp directory reclaims it.
    }
  }
}

/** A test file that starts a child with only PATH in its environment and runs a ledger emitter there. */
const HOME_LESS_CHILD = "./scripts/ledger/fixtures/home-less-child.ts";

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

  test(
    "every test file that can start a process, re-run with the OS home pointed at a scratch directory and a child that names no home given <scratch>/.agent-forge as AGENT_FORGE_HOME, leaves no .agent-forge there",
    async () => {
      const scratch = mkdtempSync(join(tmpdir(), "ledger isolation home "));
      try {
        const home = join(scratch, ".agent-forge");
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
          if (value === undefined || key === "AGENT_FORGE_HOME") continue;
          env[key] = value;
        }
        env.HOME = scratch;
        env.USERPROFILE = scratch;
        env[ISOLATION_HOME] = home;

        const files = spawningTestFiles();
        // A failing inner run could have stopped short of the spawn it guards.
        expect(await rerunEach(files, env)).toEqual([]);
        expect(existsSync(home)).toBe(false);
      } finally {
        try {
          rmSync(scratch, { recursive: true, force: true });
        } catch {
          // A file a child still holds on Windows: the OS temp directory reclaims it.
        }
      }
    },
    RERUN_LIMIT_MS,
  );

  test("a test file that starts children with no home variable and no AGENT_FORGE_HOME, through Bun.spawn and through node:child_process, and runs an emitter in each, is caught by the re-run: both emitters' events land in the scratch .agent-forge", async () => {
    const { exitCode, failures, tail, home, sessions } =
      await rerunWithScratchHome([HOME_LESS_CHILD]);
    expect({
      exitCode,
      failures,
      tail,
      home: home !== null,
      sessions,
    }).toEqual({
      exitCode: 0,
      failures: "",
      tail: expect.any(String),
      home: true,
      sessions: ["home-less-bun-spawn", "home-less-child-process"],
    });
  }, 60_000);
});
