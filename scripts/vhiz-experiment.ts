/**
 * Temporary CI experiment for bead vhiz (removed before the PR is ready).
 *
 * Part A: the synchronous-spawn clock sweep on this OS.
 * Part B: the isolation re-run, repeated, printing every failing file's whole output.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { importGraph } from "./import-graph";
import { resetSpawnClock } from "./spawn-clock";

const part = process.argv[2] ?? "all";

const g0 = (args: string[]): string => {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return `${r.stdout}${r.stderr}`;
};

function sweep(): void {
  console.log(`# spawn clock sweep, ${process.platform}, bun ${Bun.version}`);
  const limit = 2000;
  const run = (
    label: string,
    fn: () => { status: number | null; detail: string },
  ) => {
    const t0 = performance.now();
    const r = fn();
    const ms = Math.round(performance.now() - t0);
    console.log(`${label}: ${ms} ms, status ${r.status}, ${r.detail}`);
  };
  for (const gap of [0, 500, 1000, 1500, 1800, 3000, 6000]) {
    spawnSync("true");
    Bun.sleepSync(gap);
    run(`node spawnSync sleep 1.5, limit ${limit}, gap ${gap}`, () => {
      const r = spawnSync("sleep", ["1.5"], { timeout: limit });
      return {
        status: r.status,
        detail: `signal ${r.signal}, error ${(r.error as NodeJS.ErrnoException | undefined)?.code ?? "none"}`,
      };
    });
  }
  for (const gap of [0, 1000, 1800, 3000]) {
    spawnSync("true");
    Bun.sleepSync(gap);
    run(`Bun.spawnSync sleep 1.5, limit ${limit}, gap ${gap}`, () => {
      const r = Bun.spawnSync(["sleep", "1.5"], { timeout: limit });
      return { status: r.exitCode, detail: `signal ${r.signalCode}` };
    });
  }
  for (const gap of [1800, 3000]) {
    spawnSync("true");
    Bun.sleepSync(gap);
    resetSpawnClock();
    run(
      `reset, then node spawnSync sleep 1.5, limit ${limit}, gap ${gap}`,
      () => {
        const r = spawnSync("sleep", ["1.5"], { timeout: limit });
        return {
          status: r.status,
          detail: `signal ${r.signal}, error ${(r.error as NodeJS.ErrnoException | undefined)?.code ?? "none"}`,
        };
      },
    );
  }
  // The tujw repro: a timed git --version, an async wait past the limit, the same again.
  spawnSync("git", ["--version"], { timeout: limit });
  Bun.sleepSync(3000);
  run("node spawnSync git --version, limit 2000, after 3000 ms", () => {
    const r = spawnSync("git", ["--version"], {
      timeout: limit,
      encoding: "utf8",
    });
    return {
      status: r.status,
      detail: `stdout ${JSON.stringify(r.stdout)}, error ${(r.error as NodeJS.ErrnoException | undefined)?.code ?? "none"}`,
    };
  });
}

const REPO = resolve(import.meta.dir, "..");
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
const seen = new Map<string, boolean>();
const starts = (f: string): boolean => {
  let k = seen.get(f);
  if (k === undefined) {
    k = SPAWNS.test(readFileSync(f, "utf8"));
    seen.set(f, k);
  }
  return k;
};
function spawning(): string[] {
  return testFiles(join(REPO, "scripts"))
    .filter((f) => !f.endsWith("test-isolation.test.ts"))
    .filter((f) => importGraph(f).files.some(starts))
    .map((f) => relative(REPO, f).split(sep).join("/"))
    .sort();
}

async function rerun(
  files: string[],
  round: string,
  scratchHome = true,
): Promise<number> {
  const scratch = mkdtempSync(join(tmpdir(), "ledger isolation home "));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key === "AGENT_FORGE_HOME") continue;
    env[key] = value;
  }
  if (scratchHome) {
    env.HOME = scratch;
    env.USERPROFILE = scratch;
    env.AGENT_FORGE_ISOLATION_HOME = join(scratch, ".agent-forge");
  }
  const queue = [...files];
  let failures = 0;
  const worker = async (): Promise<void> => {
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
      const child = Bun.spawn(
        [process.execPath, "test", "--timeout", "15000", `./${file}`],
        {
          cwd: REPO,
          env,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [o, e] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const code = await child.exited;
      if (code !== 0) {
        failures++;
        console.log(
          `\n===== ${round}: FAILED ${file} exit ${code} =====\n${o}${e}\n===== end ${file} =====`,
        );
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return failures;
}

/**
 * Make a repository the way worktrees.test.ts makeRepo does, then copy it at
 * once, `n` times; count the copies that fail, and list the names in .git
 * that were there straight after the commit and gone 1 s later.
 */
function race(label: string, home: string, extra: string[][], n: number): void {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const g = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };
  let failed = 0;
  const transient = new Map<string, number>();
  const walk = (d: string, base = d): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? walk(join(d, e.name), base)
        : [relative(base, join(d, e.name))],
    );
  for (let i = 0; i < n; i++) {
    const root = mkdtempSync(join(tmpdir(), "race "));
    const dir = join(root, "repo x");
    mkdirSync(dir);
    g(dir, "init", "-q", "-b", "master");
    g(dir, "config", "user.email", "test@example.invalid");
    g(dir, "config", "user.name", "worktree test");
    g(dir, "config", "commit.gpgsign", "false");
    for (const args of extra) g(dir, ...args);
    writeFileSync(join(dir, "readme.txt"), "scratch\n");
    g(dir, "add", ".");
    g(dir, "commit", "-q", "-m", "first");
    if (i % 2 === 0) {
      try {
        cpSync(dir, join(root, "copy"), { recursive: true });
      } catch (error) {
        failed++;
        if (failed <= 3)
          console.log(`${label}: copy ${i} failed: ${String(error)}`);
      }
    } else {
      // Poll .git for 500 ms: every name seen that is not there at the end.
      const seenNames = new Set<string>();
      const until = performance.now() + 500;
      while (performance.now() < until) {
        try {
          for (const name of walk(join(dir, ".git"))) seenNames.add(name);
        } catch {
          // A directory gone mid-walk.
        }
      }
      Bun.sleepSync(500);
      const later = new Set(walk(join(dir, ".git")));
      for (const name of seenNames)
        if (!later.has(name))
          transient.set(name, (transient.get(name) ?? 0) + 1);
    }
    rmSync(root, { recursive: true, force: true });
  }
  console.log(
    `# race ${label}: ${failed}/${n} copies failed; gone within 1 s: ${JSON.stringify(Object.fromEntries(transient))}`,
  );
}

async function main(): Promise<void> {
  if (part === "sweep" || part === "all") sweep();
  if (part === "race" || part === "all") {
    console.log(g0(["--version"]));
    console.log(
      `global config (real HOME):\n${g0(["config", "--global", "--list", "--show-origin"])}`,
    );
    console.log(
      `system config:\n${g0(["config", "--system", "--list", "--show-origin"])}`,
    );
    // What a commit starts.
    const t = mkdtempSync(join(tmpdir(), "trace "));
    for (const args of [
      ["init", "-q", "-b", "master"],
      ["config", "user.email", "t@example.invalid"],
      ["config", "user.name", "t"],
    ])
      spawnSync("git", args, { cwd: t });
    writeFileSync(join(t, "a.txt"), "a\n");
    spawnSync("git", ["add", "."], { cwd: t });
    const traced = spawnSync("git", ["commit", "-q", "-m", "first"], {
      cwd: t,
      env: { ...process.env, GIT_TRACE: "1" },
      encoding: "utf8",
    });
    console.log(`GIT_TRACE of the commit:\n${traced.stderr}`);
    // Four racers at once per variant, so each runs under the others' load.
    for (const variant of ["default", "maintenance-off"]) {
      const kids = Array.from({ length: 4 }, () =>
        Bun.spawn(
          [process.execPath, import.meta.path, "race-worker", variant],
          { stdout: "inherit", stderr: "inherit" },
        ),
      );
      await Promise.all(kids.map((k) => k.exited));
    }
  }
  if (part === "race-worker") {
    const variant = process.argv[3] ?? "default";
    race(
      variant,
      process.env.HOME ?? "",
      variant === "maintenance-off"
        ? [["config", "maintenance.auto", "false"]]
        : [],
      60,
    );
  }
  if (part === "worktrees") {
    const alone = Array.from(
      { length: 80 },
      () => "scripts/scheduler/worktrees.test.ts",
    );
    const s = await rerun(alone, "worktrees, scratch HOME");
    console.log(`# worktrees.test.ts x80, scratch HOME: ${s} failing`);
    const r = await rerun(alone, "worktrees, real HOME", false);
    console.log(`# worktrees.test.ts x80, real HOME: ${r} failing`);
  }
  if (part === "rerun" || part === "all") {
    const files = spawning();
    console.log(`# ${files.length} spawning files`);
    const rounds = Number(process.env.VHIZ_ROUNDS ?? "6");
    for (let i = 1; i <= rounds; i++) {
      const t0 = performance.now();
      const n = await rerun(files, `full round ${i}`);
      console.log(
        `# full round ${i}: ${n} failing files, ${Math.round(performance.now() - t0)} ms`,
      );
    }
    const alone = Array.from(
      { length: 80 },
      () => "scripts/scheduler/worktrees.test.ts",
    );
    const n = await rerun(alone, "worktrees only");
    console.log(`# worktrees.test.ts x80, 4 at a time: ${n} failing`);
  }
}

await main();
