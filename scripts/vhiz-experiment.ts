/**
 * Temporary CI experiment for bead vhiz (removed before the PR is ready).
 *
 * Part A: the synchronous-spawn clock sweep on this OS.
 * Part B: the isolation re-run, repeated, printing every failing file's whole output.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { importGraph } from "./import-graph";
import { resetSpawnClock } from "./spawn-clock";

const part = process.argv[2] ?? "all";

function sweep(): void {
  console.log(`# spawn clock sweep, ${process.platform}, bun ${Bun.version}`);
  const limit = 2000;
  const run = (label: string, fn: () => { status: number | null; detail: string }) => {
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
      return { status: r.status, detail: `signal ${r.signal}, error ${(r.error as NodeJS.ErrnoException | undefined)?.code ?? "none"}` };
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
    run(`reset, then node spawnSync sleep 1.5, limit ${limit}, gap ${gap}`, () => {
      const r = spawnSync("sleep", ["1.5"], { timeout: limit });
      return { status: r.status, detail: `signal ${r.signal}, error ${(r.error as NodeJS.ErrnoException | undefined)?.code ?? "none"}` };
    });
  }
  // The tujw repro: a timed git --version, an async wait past the limit, the same again.
  spawnSync("git", ["--version"], { timeout: limit });
  Bun.sleepSync(3000);
  run("node spawnSync git --version, limit 2000, after 3000 ms", () => {
    const r = spawnSync("git", ["--version"], { timeout: limit, encoding: "utf8" });
    return { status: r.status, detail: `stdout ${JSON.stringify(r.stdout)}, error ${(r.error as NodeJS.ErrnoException | undefined)?.code ?? "none"}` };
  });
}

const REPO = resolve(import.meta.dir, "..");
const SPAWNS =
  /Bun\.spawn|Bun\.\$|child_process|StdioClientTransport|\{[^}]*\$[^}]*\}\s*from\s*["']bun["']/;
function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : testFiles(path);
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

async function rerun(files: string[], round: string): Promise<number> {
  const scratch = mkdtempSync(join(tmpdir(), "ledger isolation home "));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key === "AGENT_FORGE_HOME") continue;
    env[key] = value;
  }
  env.HOME = scratch;
  env.USERPROFILE = scratch;
  env.AGENT_FORGE_ISOLATION_HOME = join(scratch, ".agent-forge");
  const queue = [...files];
  let failures = 0;
  const worker = async (): Promise<void> => {
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
      const child = Bun.spawn([process.execPath, "test", "--timeout", "15000", `./${file}`], {
        cwd: REPO,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [o, e] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      const code = await child.exited;
      if (code !== 0) {
        failures++;
        console.log(`\n===== ${round}: FAILED ${file} exit ${code} =====\n${o}${e}\n===== end ${file} =====`);
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return failures;
}

async function main(): Promise<void> {
  if (part === "sweep" || part === "all") sweep();
  if (part === "rerun" || part === "all") {
    const files = spawning();
    console.log(`# ${files.length} spawning files`);
    const rounds = Number(process.env.VHIZ_ROUNDS ?? "6");
    for (let i = 1; i <= rounds; i++) {
      const t0 = performance.now();
      const n = await rerun(files, `full round ${i}`);
      console.log(`# full round ${i}: ${n} failing files, ${Math.round(performance.now() - t0)} ms`);
    }
    const alone = Array.from({ length: 80 }, () => "scripts/scheduler/worktrees.test.ts");
    const n = await rerun(alone, "worktrees only");
    console.log(`# worktrees.test.ts x80, 4 at a time: ${n} failing`);
  }
}

await main();
