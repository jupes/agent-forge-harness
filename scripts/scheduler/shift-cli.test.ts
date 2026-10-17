import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LedgerEventInput } from "../../types/hearth";
import { loadConfig } from "../config/load";
import { claudeAdapter } from "../executors/claude";
import { ownInterrupts } from "../executors/supervisor";
import type { ExecutorAdapter } from "../executors/types";
import type { BdRunner } from "../hearth/routes/dev-api";
import { appendEvent } from "../ledger/append";
import { closeLedger } from "../ledger/db";
import { activeReservations, queryEvents } from "../ledger/query";
import { resolveCheckout } from "../ledger/workspace";
import type { HostProbe } from "./host-load";
import { createQueue } from "./queue";
import {
  answerQueueList,
  queueTracker,
  type TrackedBead,
} from "./queue-fixture";
import { reserve } from "./reservations";
import type { ShiftDeps } from "./shift";
import { interruptShift, runShiftCli, shiftCliDeps } from "./shift-cli";
import { RUN_PR_BODY } from "./shift-pr";
import {
  listShiftRecords,
  processAlive,
  readShiftRecord,
  type ShiftRecord,
  writeShiftRecord,
} from "./shift-store";
import { comparablePath } from "./worktrees";

const FAKE = join(
  import.meta.dir,
  "..",
  "executors",
  "fixtures",
  "fake-cli.ts",
);
const INTERRUPTIBLE = join(
  import.meta.dir,
  "fixtures",
  "interruptible-shift.ts",
);

const roots: string[] = [];
const ledgers: string[] = [];
afterAll(() => {
  for (const ledger of ledgers) closeLedger(ledger);
  for (const root of roots)
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

/** A short root with a space, as git wants on Windows. */
function scratch(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "sc ")));
  roots.push(root);
  return root;
}

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
};

function identity(dir: string): void {
  git(dir, "config", "user.email", "shift@example.invalid");
  git(dir, "config", "user.name", "shift test");
  git(dir, "config", "commit.gpgsign", "false");
}

/** A repository of its own, with spaces in its path, that ignores trees/ and has one commit. */
function repository(): string {
  const repo = join(scratch(), "main repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "master");
  identity(repo);
  writeFileSync(
    join(repo, ".gitignore"),
    "trees/\n.tmp/\n.agent-forge-session\n",
  );
  writeFileSync(join(repo, "README.md"), "scratch\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "start");
  return repo;
}

/**
 * `repository()` with an origin of its own (a bare repository in the OS temp
 * dir, never the real remote) that moved on after the checkout last fetched,
 * and the checkout on a feature branch with a commit origin does not have.
 */
function withOrigin(): { repo: string; origin: string; originSha: string } {
  const repo = repository();
  const origin = join(scratch(), "origin.git");
  git(repo, "init", "-q", "--bare", "-b", "master", origin);
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "origin", "master");
  const other = join(scratch(), "other clone");
  git(repo, "clone", "-q", origin, other);
  identity(other);
  writeFileSync(join(other, "upstream.txt"), "on origin only\n");
  git(other, "add", ".");
  git(other, "commit", "-q", "-m", "on origin only");
  git(other, "push", "-q", "origin", "master");
  git(repo, "checkout", "-q", "-b", "feature");
  writeFileSync(join(repo, "feature.txt"), "feature only\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "feature only");
  return { repo, origin, originSha: git(origin, "rev-parse", "master").trim() };
}

/** A filled PR body, as a run leaves it. */
const RUN_BODY = [
  "## What Changed",
  "- Added work.txt.",
  "## Why It's Needed",
  "The bead asked for it.",
  "## How It Was Tested",
  "- bun test",
  "## Test Evidence",
  "1 pass",
  "## Risk & Rollback",
  "- Risk level: Low.",
  "## Linked Issues & AC Trace",
  "Closes: cli-1",
  "",
].join("\n");

function trackerRunner(beads: TrackedBead[]) {
  const tracker = queueTracker(beads);
  const runBd: BdRunner = async (args) =>
    tracker.answer(args) ??
    tracker.answerComment(args) ??
    answerQueueList(args, [...tracker.beads.values()]) ?? {
      status: 1,
      stdout: "",
      stderr: "Error: not answered by the test tracker\n",
    };
  return { tracker, runBd };
}

const queued = (id: string): TrackedBead => ({
  id,
  title: `Work for ${id}`,
  labels: ["queue:queued"],
  metadata: { queue_state: "queued" },
  description: `Work.\n\n## Files\nsrc/${id}/**\n`,
});

/** The Claude adapter, refusing any spawn that would run the real binary. */
const guarded: ExecutorAdapter = {
  ...claudeAdapter,
  spawn: (request) => {
    if (request.command === undefined)
      throw new Error("a test reached for the real claude binary");
    return claudeAdapter.spawn(request);
  },
};

/**
 * CLI dependencies for a checkout, with a temp home, a test tracker and a gh
 * that records what it was asked: the real git, and never the real gh.
 */
function cli(root: string, beads: TrackedBead[] = []) {
  const home = join(scratch(), "forge home");
  const env = { PATH: process.env["PATH"] ?? "", AGENT_FORGE_HOME: home };
  const { tracker, runBd } = trackerRunner(beads);
  const gh: Array<{ args: string[]; cwd: string }> = [];
  const deps: ShiftDeps = {
    ...shiftCliDeps(root, env),
    runBd,
    sampleHost: async () => ({ busy: false }),
    exec: { env, home: scratch(), adapters: { claude: guarded } },
    gh: async (args, cwd) => {
      gh.push({ args: [...args], cwd });
      return {
        status: 0,
        stdout: `https://github.com/example/harness/pull/${gh.length}\n`,
        stderr: "",
      };
    },
  };
  ledgers.push(deps.ledgerPath);
  const announced: string[] = [];
  return {
    home,
    env,
    tracker,
    deps,
    gh,
    announced,
    io: { announce: (line: string) => announced.push(line) },
  };
}

describe("forge:shift", () => {
  test("shiftCliDeps puts the ledger, the queue lock and the shift records in the harness home, and worktrees under the main checkout", () => {
    const repo = repository();
    const home = join(scratch(), "forge home");
    const deps = shiftCliDeps(repo, { AGENT_FORGE_HOME: home });
    expect(deps.ledgerPath).toBe(join(home, "ledger.db"));
    expect(deps.lockFile).toBe(join(home, "queue-lock.db"));
    expect(deps.shiftsDir).toBe(join(home, "shifts"));
    expect(comparablePath(deps.mainCheckout)).toBe(comparablePath(repo));
  });

  test("shiftCliDeps's host sampler judges each sample against the threshold the shift passes, not the sampler's default", async () => {
    // What the real sampler reads, held still: half the memory in use, and no
    // CPU time between readings (so memory alone decides).
    const probe: HostProbe = {
      cpus: () => [{ times: { user: 10, nice: 0, sys: 0, idle: 10, irq: 0 } }],
      freemem: () => 50,
      totalmem: () => 100,
    };
    const deps = shiftCliDeps(
      repository(),
      { AGENT_FORGE_HOME: join(scratch(), "forge home") },
      { probe, sleep: async () => undefined },
    );
    // The real sampler answers more than ShiftDeps names: its readings too.
    const busy: unknown = await deps.sampleHost(0.4);
    const idle: unknown = await deps.sampleHost(0.6);
    expect(busy).toEqual({
      busy: true,
      cpu: null,
      memory: 0.5,
      reason: "memory 50% in use is at or above 40%",
    });
    expect(idle).toEqual({ busy: false, cpu: null, memory: 0.5 });
  });

  test("shiftCliDeps makes a worktree at the start point it is given, not at the HEAD of the checkout", () => {
    const { repo, originSha } = withOrigin();
    git(repo, "fetch", "-q", "origin");
    const deps = shiftCliDeps(repo, {
      AGENT_FORGE_HOME: join(scratch(), "forge home"),
    });
    const made = deps.makeWorktree({
      id: "sp-1",
      branch: "shift/shift-20261014-120000-0a0b/sp-1",
      beadId: "sp-1",
      startPoint: originSha,
    });
    if (!made.ok) throw new Error(made.error);
    expect(git(made.path, "rev-parse", "HEAD").trim()).toBe(originSha);
    expect(git(repo, "rev-parse", "HEAD").trim()).not.toBe(originSha);
  }, 60_000);

  test("run with options that are not a shift's exits 1 and writes nothing", async () => {
    const { deps, io, home } = cli(scratch());
    for (const argv of [
      ["run", "--for", "soon"],
      ["run", "--concurrency", "two"],
      ["run", "--max-usd", "0"],
      ["run", "--merge", "yes"],
      ["run", "--epic"],
      ["run", "stray"],
      ["run", "--base", "shift/shift-20261014-120000-0a0b/t-1"],
      ["run", "--base", "-x"],
      ["run", "--id", "shift-nope"],
      ["run", "--id", "SHIFT-20261015-120000-0A0B"],
      ["run", "--id"],
    ]) {
      const result = await runShiftCli(argv, deps, io);
      expect({ argv, exit: result.exit, ok: result.out.ok }).toEqual({
        argv,
        exit: 1,
        ok: false,
      });
    }
    expect(existsSync(join(home, "shifts"))).toBe(false);
  });

  test("run takes each option it was not given from [shift] in agent-forge.toml of the checkout it runs in, else the builtin, and a flag still wins: the record says what applied", async () => {
    const { repo } = withOrigin();
    writeFileSync(
      join(repo, "agent-forge.toml"),
      '[shift]\nconcurrency = 3\nfor = "45m"\nmax_usd = 4\nthrottle = 0.6\n',
    );
    const { deps, io } = cli(repo);
    const result = await runShiftCli(["run", "--max-usd", "6"], deps, io);
    expect(result.exit).toBe(0);
    const data = result.out.data as { reason: string; record: ShiftRecord };
    expect(data.reason).toBe("drained");
    expect(data.record.options).toEqual({
      concurrency: 3,
      forMs: 45 * 60_000,
      maxBeads: 4,
      maxUsd: 6,
      repairs: 3,
      throttle: 0.6,
      base: "master",
    });
  }, 60_000);

  test("--for past its bound is refused in the words [shift] for is refused in, before anything is written", async () => {
    const root = scratch();
    const { deps, io, home } = cli(root);
    const flag = await runShiftCli(["run", "--for", "25h"], deps, io);
    expect(flag.exit).toBe(1);
    expect(flag.out.error).toStartWith(
      "--for: expected a duration of at most 24h. Usage: ",
    );
    const file = join(root, "agent-forge.toml");
    writeFileSync(file, '[shift]\nfor = "25h"\n');
    expect(() =>
      loadConfig({ harnessRoot: root, home: root, env: {} }),
    ).toThrow(`${file}: shift.for: expected a duration of at most 24h`);
    expect(existsSync(join(home, "shifts"))).toBe(false);
  });

  test("run with a [shift] the config loader refuses exits 1 naming the file and the key, and writes no shift", async () => {
    const root = scratch();
    const file = join(root, "agent-forge.toml");
    writeFileSync(file, "[shift]\nconcurrency = 9\n");
    const { deps, io, home } = cli(root);
    const result = await runShiftCli(["run"], deps, io);
    expect(result).toEqual({
      exit: 1,
      out: {
        ok: false,
        data: null,
        error: `the config could not be read: ${file}: shift.concurrency: expected a whole number from 1 to 8`,
      },
    });
    expect(existsSync(join(home, "shifts"))).toBe(false);
  });

  test("run, end to end on the fake binary: the bead's worktree is a git worktree on the shift's branch from origin's master, the provider ran in it, its branch alone is pushed to origin, gh is asked for a draft pull request, and the bead ends in review with its reservation freed and two comments", async () => {
    const { repo, origin, originSha } = withOrigin();
    const { deps, io, tracker, env, announced, gh, home } = cli(repo, [
      queued("cli-1"),
    ]);
    const dump = join(scratch(), "fake dump.json");
    // The run's work: a commit on its branch and its PR body, then the fake binary.
    const working: ExecutorAdapter = {
      ...guarded,
      spawn: (request) => {
        identity(request.worktree);
        writeFileSync(join(request.worktree, "work.txt"), "the run's work\n");
        git(request.worktree, "add", "work.txt");
        git(request.worktree, "commit", "-q", "-m", "the run's work");
        mkdirSync(join(request.worktree, ".tmp", "work"), { recursive: true });
        writeFileSync(join(request.worktree, RUN_PR_BODY), RUN_BODY);
        return guarded.spawn(request);
      },
    };
    deps.exec = {
      ...deps.exec,
      adapters: { claude: working },
      command: [
        process.execPath,
        FAKE,
        "--fake-provider",
        "claude",
        "--fake-mode",
        "ok",
        "--fake-dump",
        dump,
      ],
    };
    const result = await runShiftCli(
      ["run", "--for", "2m", "--concurrency", "1"],
      deps,
      io,
    );
    expect(result.exit).toBe(0);
    const data = result.out.data as {
      shiftId: string;
      reason: string;
      record: ShiftRecord;
    };
    expect(data.reason).toBe("drained");
    // The id was announced before the shift began, with the way to stop it.
    expect(JSON.parse(announced[0] ?? "{}")).toEqual({
      shiftId: data.shiftId,
      stop: `bun run forge:shift stop ${data.shiftId}`,
    });
    const [bead] = data.record.beads;
    expect(bead).toMatchObject({
      beadId: "cli-1",
      outcome: "review",
      attempts: 1,
      branch: `shift/${data.shiftId}/cli-1`,
    });
    const worktree = bead?.worktree ?? "";
    expect(git(repo, "worktree", "list", "--porcelain")).toContain(
      `branch refs/heads/shift/${data.shiftId}/cli-1`,
    );
    expect(comparablePath(worktree)).toBe(
      comparablePath(join(repo, "trees", `${data.shiftId}-1`)),
    );
    // The fake ran in that worktree, with the forgemaster-auto prompt on stdin.
    const ran = JSON.parse(readFileSync(dump, "utf8")) as {
      cwd: string;
      stdin: string;
    };
    expect(comparablePath(ran.cwd)).toBe(comparablePath(worktree));
    expect(ran.stdin.startsWith("/forgemaster-auto cli-1\n")).toBe(true);
    expect(ran.stdin).toContain(RUN_PR_BODY);
    expect(tracker.beads.get("cli-1")?.labels).toEqual(["queue:review"]);
    expect(
      activeReservations(
        { workspace: resolveCheckout(repo).workspace },
        { path: deps.ledgerPath },
      ),
    ).toEqual([]);
    expect(env.AGENT_FORGE_HOME).toBeDefined();

    // Built on origin's master as fetched, not on the feature branch the checkout is on.
    const branch = `shift/${data.shiftId}/cli-1`;
    expect(data.record.baseSha).toBe(originSha);
    expect(git(worktree, "rev-parse", "HEAD~1").trim()).toBe(originSha);
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(
      "feature",
    );
    // Only the shift branch reached origin, as the worktree has it; master is untouched.
    expect(
      git(origin, "for-each-ref", "--format=%(refname)", "refs/heads")
        .trim()
        .split("\n")
        .sort(),
    ).toEqual(["refs/heads/master", `refs/heads/${branch}`]);
    expect(git(origin, "rev-parse", branch).trim()).toBe(
      git(worktree, "rev-parse", "HEAD").trim(),
    );
    expect(git(origin, "rev-parse", "master").trim()).toBe(originSha);
    // gh was asked for a draft pull request into master, once, with the run's
    // body as the shift read it: a copy in the shift's own directory in the
    // harness home, outside the worktree.
    const bodyFile =
      gh[0]?.args
        .find((arg) => arg.startsWith("--body-file="))
        ?.slice("--body-file=".length) ?? "";
    expect(
      comparablePath(bodyFile).startsWith(
        `${comparablePath(join(home, "shifts", data.shiftId))}/`,
      ),
    ).toBe(true);
    expect(readFileSync(bodyFile, "utf8")).toBe(RUN_BODY);
    expect(gh.map((call) => call.args)).toEqual([
      [
        "pr",
        "create",
        "--draft",
        "--base=master",
        `--head=${branch}`,
        "--title=cli-1: Work for cli-1",
        `--body-file=${bodyFile}`,
      ],
    ]);
    expect(bead).toMatchObject({
      prUrl: "https://github.com/example/harness/pull/1",
      prBody: "run",
    });
    expect(bead?.error).toBeUndefined();
    const comments = tracker.beads.get("cli-1")?.comments ?? [];
    expect(comments).toHaveLength(2);
    expect(comments[0]).toContain(`worklog: shift ${data.shiftId} started`);
    expect(comments[1]).toContain(
      "Draft pull request: https://github.com/example/harness/pull/1.",
    );
  }, 60_000);

  test("run --id runs the shift under the id it is given: the announce line, the result and the record name it", async () => {
    const { repo } = withOrigin();
    const { deps, io, announced } = cli(repo, []);
    const id = "shift-20261015-120000-1d1d";
    const result = await runShiftCli(
      ["run", "--id", id, "--for", "2m", "--concurrency", "1"],
      deps,
      io,
    );
    expect(result.exit).toBe(0);
    expect(JSON.parse(announced[0] ?? "{}")).toEqual({
      shiftId: id,
      stop: `bun run forge:shift stop ${id}`,
    });
    expect(result.out.data).toMatchObject({ shiftId: id, reason: "drained" });
    expect(readShiftRecord(deps.shiftsDir, id)).toMatchObject({
      shiftId: id,
      state: "stopped",
      reason: "drained",
      options: { concurrency: 1, forMs: 120_000 },
    });
  }, 60_000);

  test("run --id with a value that is not a shift id exits 1 naming --id, before anything is announced", async () => {
    const { deps, io, announced, home } = cli(scratch());
    for (const id of ["shift-nope", "SHIFT-20261015-120000-0A0B", "../x"])
      expect(await runShiftCli(["run", "--id", id], deps, io)).toEqual({
        exit: 1,
        out: {
          ok: false,
          data: null,
          error: expect.stringContaining(
            "--id: expected a shift id (shift-YYYYMMDD-HHMMSS-xxxx)",
          ),
        },
      });
    expect(announced).toEqual([]);
    expect(existsSync(join(home, "shifts"))).toBe(false);
  });

  test("run --id with an id a record or a stop request already has exits 1 before anything is announced or fetched, and changes neither", async () => {
    const { deps, io, announced, gh } = cli(scratch());
    const recorded = "shift-20261015-120000-2e2e";
    const asked = "shift-20261015-120000-3f3f";
    const old: ShiftRecord = {
      shiftId: recorded,
      pid: 2_000_000_000,
      workspace: "c:/somewhere",
      startedAt: "2026-10-15T12:00:00.000Z",
      deadline: "2026-10-15T14:00:00.000Z",
      state: "stopped",
      reason: "drained",
      options: {
        concurrency: 2,
        forMs: 7_200_000,
        maxBeads: 4,
        maxUsd: 10,
        repairs: 3,
      },
      spentUsd: 0,
      unpriced: 0,
      beads: [],
    };
    writeShiftRecord(deps.shiftsDir, old);
    writeFileSync(join(deps.shiftsDir, `${asked}.stop`), "");
    const before = readFileSync(
      join(deps.shiftsDir, `${recorded}.json`),
      "utf8",
    );
    for (const id of [recorded, asked]) {
      const result = await runShiftCli(["run", "--id", id], deps, io);
      expect(result).toEqual({
        exit: 1,
        out: {
          ok: false,
          data: null,
          error: `--id: ${id} is in use: a shift record or a stop request has it; nothing was started`,
        },
      });
    }
    expect(announced).toEqual([]);
    expect(gh).toEqual([]);
    expect(readFileSync(join(deps.shiftsDir, `${recorded}.json`), "utf8")).toBe(
      before,
    );
    expect(existsSync(join(deps.shiftsDir, `${asked}.json`))).toBe(false);
  });

  test("run --base names the branch fetched from origin: one origin does not have starts nothing, and nothing is written", async () => {
    const { repo } = withOrigin();
    const { deps, io, home, gh } = cli(repo, [queued("cli-2")]);
    const result = await runShiftCli(["run", "--base", "release"], deps, io);
    expect(result.exit).toBe(1);
    expect(result.out.error).toContain(
      "the base could not be fetched (git fetch origin release failed:",
    );
    expect(result.out.error).toContain("nothing was started");
    expect(existsSync(join(home, "shifts"))).toBe(false);
    expect(gh).toEqual([]);
  }, 60_000);

  test("stop asks a running shift to stop; a second stop says it was asked already; an unknown or stopped shift exits 1", async () => {
    const { deps, io } = cli(scratch());
    const record = (
      shiftId: string,
      state: "running" | "stopped",
      startedAt: string,
    ): ShiftRecord => ({
      shiftId,
      pid: process.pid,
      workspace: "c:/somewhere",
      startedAt,
      deadline: "2026-10-14T14:00:00.000Z",
      state,
      options: {
        concurrency: 2,
        forMs: 7_200_000,
        maxBeads: 4,
        maxUsd: 10,
        repairs: 3,
      },
      spentUsd: 0,
      unpriced: 0,
      beads: [],
    });
    writeShiftRecord(
      deps.shiftsDir,
      record(
        "shift-20261014-120000-0001",
        "running",
        "2026-10-14T12:00:00.000Z",
      ),
    );
    writeShiftRecord(
      deps.shiftsDir,
      record(
        "shift-20261014-110000-0001",
        "stopped",
        "2026-10-14T11:00:00.000Z",
      ),
    );
    expect(
      (await runShiftCli(["stop", "shift-20261014-120000-0001"], deps, io)).out,
    ).toEqual({
      ok: true,
      data: { shiftId: "shift-20261014-120000-0001", already: false },
      error: null,
    });
    expect(
      (await runShiftCli(["stop", "shift-20261014-120000-0001"], deps, io)).out
        .data,
    ).toEqual({
      shiftId: "shift-20261014-120000-0001",
      already: true,
    });
    for (const id of [
      "shift-20261014-110000-0001",
      "shift-20261014-100000-0001",
      "nonsense",
    ])
      expect((await runShiftCli(["stop", id], deps, io)).exit).toBe(1);
    expect(
      readShiftRecord(deps.shiftsDir, "shift-20261014-110000-0001")?.state,
    ).toBe("stopped");

    const listed = await runShiftCli(["list"], deps, io);
    expect(listed.exit).toBe(0);
    expect(
      (listed.out.data as Array<{ shiftId: string }>).map(
        (each) => each.shiftId,
      ),
    ).toEqual(["shift-20261014-120000-0001", "shift-20261014-110000-0001"]);
    expect((await runShiftCli(["dance"], deps, io)).exit).toBe(1);
    expect((await runShiftCli([], deps, io)).exit).toBe(1);
  });
});

/**
 * `forge:shift run` in a process of its own (`fixtures/interruptible-shift.ts`:
 * the CLI's main with hermetic dependencies and the fake binary as its run),
 * driven by signals emitted in it.
 */
async function interruptible(mode: "run" | "stuck" | "early", graceMs: number) {
  const dir = scratch();
  const home = join(dir, "home");
  const ledger = join(home, "ledger.db");
  ledgers.push(ledger);
  const proc = Bun.spawn(
    [process.execPath, INTERRUPTIBLE, dir, mode, String(graceMs)],
    {
      env: { ...process.env, AGENT_FORGE_HOME: home },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let stderr = "";
  const stderrRead = (async () => {
    const decoder = new TextDecoder();
    const reader = proc.stderr.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stderr += decoder.decode(value, { stream: true });
    }
  })();
  const stdout = new Response(proc.stdout).text();
  let fakePid: number | undefined;
  const workspace = () => resolveCheckout(join(dir, "root")).workspace;
  return {
    proc,
    home,
    /** The pid of the fake provider, once the shift's run has started it. */
    async ran(): Promise<number> {
      const dump = join(dir, "dump.json");
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && proc.exitCode === null) {
        try {
          fakePid = (JSON.parse(readFileSync(dump, "utf8")) as { pid: number })
            .pid;
          return fakePid;
        } catch {
          await Bun.sleep(25);
        }
      }
      throw new Error(`the shift's run never started; stderr: ${stderr}`);
    },
    send(signal: string): void {
      proc.stdin.write(`${signal}\n`);
      proc.stdin.flush();
    },
    stderr: () => stderr,
    async until(text: string): Promise<void> {
      const deadline = Date.now() + 30_000;
      while (!stderr.includes(text)) {
        if (Date.now() > deadline)
          throw new Error(`stderr never said ${text}: ${stderr}`);
        await Bun.sleep(25);
      }
    },
    /** What it printed on stdout and stderr, once it has exited. */
    async printed(): Promise<{ stdout: string; stderr: string }> {
      await stderrRead;
      return { stdout: await stdout, stderr };
    },
    labels: (): Record<string, string[]> =>
      JSON.parse(readFileSync(join(dir, "labels.json"), "utf8")) as Record<
        string,
        string[]
      >,
    reservations: () =>
      activeReservations({ workspace: workspace() }, { path: ledger }),
    events: () =>
      existsSync(ledger)
        ? queryEvents({ workspace: workspace() }, { path: ledger })
        : [],
    records: () => listShiftRecords(join(home, "shifts")),
    fakePid: () => fakePid,
    /** End what a failed test left running. */
    cleanup(): void {
      if (proc.exitCode === null) proc.kill();
      if (fakePid !== undefined && processAlive(fakePid)) process.kill(fakePid);
    },
  };
}

describe("interruptShift", () => {
  test("owns the process's signals until it is released, and then leaves nothing registered", () => {
    const said: string[] = [];
    const interrupt = interruptShift(
      { say: (line) => said.push(line), exit: () => undefined },
      () => undefined,
      1_000,
    );
    try {
      expect(interrupt.signal.aborted).toBe(false);
      expect(() => ownInterrupts(() => true)).toThrow(
        "an interrupt owner is registered already",
      );
    } finally {
      interrupt.release();
    }
    ownInterrupts(() => true)();
    expect(said).toEqual([]);
  });
});

describe("forge:shift run interrupted (a process of its own, fake binary)", () => {
  for (const signal of ["SIGINT", "SIGTERM"])
    test(`a first ${signal} stops the shift as forge:shift stop does: the run is stopped, its bead back in queued, its reservation freed, shift.stopped recorded, and the process prints the record and exits 0`, async () => {
      const shift = await interruptible("run", 60_000);
      try {
        const pid = await shift.ran();
        expect(processAlive(pid)).toBe(true);
        expect(shift.labels()["int-1"]).toEqual(["queue:running"]);
        expect(shift.reservations()).toHaveLength(1);
        shift.send(signal);
        expect(await shift.proc.exited).toBe(0);
        const { stdout, stderr } = await shift.printed();
        const [record] = shift.records();
        const shiftId = record?.shiftId ?? "";
        expect(stderr).toContain(
          `forge:shift: ${signal}: stopping shift ${shiftId}: its runs are stopped and their beads put back in queued (up to 60s). Press Ctrl-C again to exit now.`,
        );
        expect(JSON.parse(stdout)).toMatchObject({
          ok: true,
          data: { shiftId, reason: "operator", recorded: true },
        });
        expect(record).toMatchObject({
          state: "stopped",
          reason: "operator",
          beads: [{ beadId: "int-1", outcome: "released" }],
        });
        expect(shift.labels()["int-1"]).toEqual(["queue:queued"]);
        expect(shift.reservations()).toEqual([]);
        expect(
          shift
            .events()
            .filter((event) => event.kind === "shift.stopped")
            .map((event) => event.payload),
        ).toEqual([{ shiftId, reason: "operator" }]);
        expect(processAlive(pid)).toBe(false);
      } finally {
        shift.cleanup();
      }
    }, 90_000);

  test("a second signal while the shift stops exits 130 at once, long before the deadline: what the stop had not given back stays held for forge:shift recover", async () => {
    // The stop can never give the bead back (`stuck`), and its deadline is a minute away.
    const shift = await interruptible("stuck", 60_000);
    try {
      await shift.ran();
      shift.send("SIGINT");
      await shift.until("forge:shift: SIGINT: stopping shift");
      const began = Date.now();
      shift.send("SIGINT");
      expect(await shift.proc.exited).toBe(130);
      expect(Date.now() - began).toBeLessThan(20_000);
      const { stdout, stderr } = await shift.printed();
      const [record] = shift.records();
      const shiftId = record?.shiftId ?? "";
      expect(stdout).toBe("");
      expect(stderr).toContain(
        `forge:shift: SIGINT again: exiting now. What the shift still holds stays held: bun run forge:shift recover ${shiftId} gives it back.`,
      );
      expect(record?.state).toBe("running");
      expect(shift.labels()["int-1"]).toEqual(["queue:running"]);
      expect(processAlive(shift.fakePid() ?? 0)).toBe(false);
    } finally {
      shift.cleanup();
    }
  }, 90_000);

  test("a stop that does not end by the deadline is cut short: the process says so and exits 130", async () => {
    const shift = await interruptible("stuck", 1_500);
    try {
      await shift.ran();
      const began = Date.now();
      shift.send("SIGINT");
      expect(await shift.proc.exited).toBe(130);
      expect(Date.now() - began).toBeGreaterThanOrEqual(1_500);
      const { stdout, stderr } = await shift.printed();
      const [record] = shift.records();
      const shiftId = record?.shiftId ?? "";
      expect(stdout).toBe("");
      expect(stderr).toContain(
        `forge:shift: shift ${shiftId} did not stop within 1.5s: exiting now. What the shift still holds stays held: bun run forge:shift recover ${shiftId} gives it back.`,
      );
      expect(record?.state).toBe("running");
      expect(processAlive(shift.fakePid() ?? 0)).toBe(false);
    } finally {
      shift.cleanup();
    }
  }, 90_000);

  test("a signal before the shift has started (while its base is fetched) starts nothing: no record, no shift.started, no run, the bead still queued, and the process exits 1", async () => {
    const shift = await interruptible("early", 60_000);
    try {
      // A shift that ignored the signal would run on: give up on it well
      // inside the test's own limit.
      expect(
        await Promise.race([
          shift.proc.exited,
          Bun.sleep(45_000).then(() => "still running"),
        ]),
      ).toBe(1);
      const { stdout } = await shift.printed();
      expect(JSON.parse(stdout)).toEqual({
        ok: false,
        data: null,
        error:
          "the shift was stopped before it started (SIGINT); nothing was started",
      });
      expect(shift.records()).toEqual([]);
      expect(shift.events()).toEqual([]);
      expect(shift.fakePid()).toBeUndefined();
      expect(shift.labels()["int-1"]).toEqual(["queue:queued"]);
    } finally {
      shift.cleanup();
    }
  }, 90_000);
});

describe("forge:shift recover", () => {
  /**
   * A checkout of its own whose shift `shiftId` died running one bead: the
   * bead started as the scheduler and its reservation taken, each event with
   * the bead's run id, and a record that says running with a pid no process
   * has.
   */
  async function deadShift(shiftId: string, beadId: string) {
    const root = scratch();
    mkdirSync(join(root, ".git"));
    const made = cli(root, [queued(beadId)]);
    const { deps, tracker } = made;
    const { workspace } = resolveCheckout(root);
    const runId = `${beadId}-${shiftId}`;
    const append = (event: LedgerEventInput) =>
      appendEvent({ ...event, runId }, { path: deps.ledgerPath });
    const started = await createQueue({
      workspace,
      runBd: tracker.run,
      appendEvent: append,
      lockFile: deps.lockFile,
    }).move(beadId, "start", "scheduler");
    if (!started.ok) throw new Error(started.error);
    const worktree = join(root, "trees", `${shiftId}-1`);
    const reserved = await reserve(
      { beadId, worktree, globs: [`src/${beadId}/**`] },
      {
        workspace,
        ledgerPath: deps.ledgerPath,
        appendEvent: append,
        lockFile: deps.lockFile,
      },
    );
    if (!reserved.ok) throw new Error(reserved.error);
    const record = (id: string, pid: number): ShiftRecord => ({
      shiftId: id,
      pid,
      workspace,
      startedAt: "2026-10-15T09:00:00.000Z",
      deadline: "2026-10-15T11:00:00.000Z",
      state: "running",
      options: {
        concurrency: 2,
        forMs: 7_200_000,
        maxBeads: 4,
        maxUsd: 10,
        repairs: 3,
      },
      spentUsd: 0,
      unpriced: 0,
      beads:
        id === shiftId
          ? [{ beadId, runId, outcome: "running", attempts: 1, worktree }]
          : [],
    });
    // No process has this id.
    writeShiftRecord(deps.shiftsDir, record(shiftId, 2_000_000_000));
    return { ...made, workspace, record };
  }

  test("recover puts the bead a dead shift still owns back in queued, frees its reservation and closes the record; a second recover, a shift whose process is alive, no id and an extra argument exit 1", async () => {
    const shiftId = "shift-20261015-090000-c1c1";
    const { deps, io, tracker, workspace, record } = await deadShift(
      shiftId,
      "cli-r",
    );
    const result = await runShiftCli(["recover", shiftId], deps, io);
    expect(result.exit).toBe(0);
    expect(result.out).toMatchObject({
      ok: true,
      error: null,
      data: {
        shiftId,
        complete: true,
        stopped: "recorded",
        beads: [{ beadId: "cli-r", outcome: "released" }],
        reservations: [{ beadId: "cli-r", outcome: "released" }],
      },
    });
    expect(tracker.beads.get("cli-r")?.labels).toEqual(["queue:queued"]);
    expect(
      activeReservations({ workspace }, { path: deps.ledgerPath }),
    ).toEqual([]);
    expect(readShiftRecord(deps.shiftsDir, shiftId)).toMatchObject({
      state: "stopped",
      reason: "recovered",
    });

    const again = await runShiftCli(["recover", shiftId], deps, io);
    expect(again.exit).toBe(1);
    expect(again.out.error).toContain("has stopped already (recovered)");
    const alive = "shift-20261015-100000-c2c2";
    writeShiftRecord(deps.shiftsDir, record(alive, process.pid));
    const refused = await runShiftCli(["recover", alive], deps, io);
    expect(refused.exit).toBe(1);
    expect(refused.out.error).toContain(`pid ${process.pid}) is running`);
    expect(readShiftRecord(deps.shiftsDir, alive)?.state).toBe("running");
    for (const argv of [["recover"], ["recover", shiftId, "extra"]])
      expect((await runShiftCli(argv, deps, io)).out).toMatchObject({
        ok: false,
        error: expect.stringContaining("recover <shift-id>"),
      });
  });

  test("a recover of a record it cannot read (a workspace that is not a string) exits 1 with the envelope and says why, and changes nothing", async () => {
    const shiftId = "shift-20261015-090000-c4c4";
    const { deps, io, tracker, record } = await deadShift(shiftId, "cli-u");
    // justification: a field the record's type does not allow is the case under test.
    writeShiftRecord(deps.shiftsDir, {
      ...record(shiftId, 2_000_000_000),
      workspace: 5,
    } as unknown as ShiftRecord);
    const result = await runShiftCli(["recover", shiftId], deps, io);
    expect(result).toEqual({
      exit: 1,
      out: {
        ok: false,
        data: null,
        error: `the record of ${shiftId} is not one recovery can read (workspace: expected a path); nothing was done.`,
      },
    });
    expect(tracker.beads.get("cli-u")?.labels).toEqual(["queue:running"]);
  });

  test("a recover that cannot finish exits 1 with what it did and what is left, and leaves the record running", async () => {
    const shiftId = "shift-20261015-090000-c3c3";
    const { deps, io, tracker } = await deadShift(shiftId, "cli-f");
    const failing: ShiftDeps = {
      ...deps,
      runBd: async (args, options) =>
        args[0] === "update"
          ? { status: 1, stdout: "", stderr: "Error: database is locked\n" }
          : deps.runBd(args, options),
    };
    const result = await runShiftCli(["recover", shiftId], failing, io);
    expect(result.exit).toBe(1);
    expect(result.out.ok).toBe(false);
    expect(result.out.error).toContain(`${shiftId} is not recovered yet`);
    expect(result.out.error).toContain("database is locked");
    expect(result.out.error).toContain("recover it again");
    expect(result.out.data).toMatchObject({
      complete: false,
      beads: [{ beadId: "cli-f", outcome: "pending" }],
    });
    expect(tracker.beads.get("cli-f")?.labels).toEqual(["queue:running"]);
    expect(readShiftRecord(deps.shiftsDir, shiftId)?.state).toBe("running");
  });
});
