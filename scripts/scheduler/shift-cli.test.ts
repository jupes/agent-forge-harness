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
import { claudeAdapter } from "../executors/claude";
import type { ExecutorAdapter } from "../executors/types";
import type { BdRunner } from "../hearth/routes/dev-api";
import { closeLedger } from "../ledger/db";
import { activeReservations } from "../ledger/query";
import { resolveCheckout } from "../ledger/workspace";
import {
  answerQueueList,
  queueTracker,
  type TrackedBead,
} from "./queue-fixture";
import type { ShiftDeps } from "./shift";
import { parseDuration, runShiftCli, shiftCliDeps } from "./shift-cli";
import {
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

/** A repository of its own, with spaces in its path, that ignores trees/ and has one commit. */
function repository(): string {
  const repo = join(scratch(), "main repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "master");
  git(repo, "config", "user.email", "shift@example.invalid");
  git(repo, "config", "user.name", "shift test");
  writeFileSync(
    join(repo, ".gitignore"),
    "trees/\n.tmp/\n.agent-forge-session\n",
  );
  writeFileSync(join(repo, "README.md"), "scratch\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "start");
  return repo;
}

function trackerRunner(beads: TrackedBead[]) {
  const tracker = queueTracker(beads);
  const runBd: BdRunner = async (args) =>
    tracker.answer(args) ??
    answerQueueList(args, [...tracker.beads.values()]) ?? {
      status: 1,
      stdout: "",
      stderr: "Error: not answered by the test tracker\n",
    };
  return { tracker, runBd };
}

const queued = (id: string): TrackedBead => ({
  id,
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

/** CLI dependencies for a checkout, with a temp home and a test tracker. */
function cli(root: string, beads: TrackedBead[] = []) {
  const home = join(scratch(), "forge home");
  const env = { PATH: process.env["PATH"] ?? "", AGENT_FORGE_HOME: home };
  const { tracker, runBd } = trackerRunner(beads);
  const deps: ShiftDeps = {
    ...shiftCliDeps(root, env),
    runBd,
    sampleHost: async () => ({ busy: false }),
    exec: { env, home: scratch(), adapters: { claude: guarded } },
  };
  ledgers.push(deps.ledgerPath);
  const announced: string[] = [];
  return {
    home,
    env,
    tracker,
    deps,
    announced,
    io: { announce: (line: string) => announced.push(line) },
  };
}

describe("parseDuration", () => {
  test("whole seconds, minutes and hours", () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("2h")).toBe(7_200_000);
  });

  test("anything else is no duration", () => {
    for (const text of ["soon", "0m", "-1h", "2 h", "1.5h", "2", "h", "2d", ""])
      expect(parseDuration(text)).toBeNull();
  });
});

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

  test("run with options that are not a shift's exits 1 and writes nothing", async () => {
    const { deps, io, home } = cli(scratch());
    for (const argv of [
      ["run", "--for", "soon"],
      ["run", "--concurrency", "two"],
      ["run", "--max-usd", "0"],
      ["run", "--merge", "yes"],
      ["run", "--epic"],
      ["run", "stray"],
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

  test("run, end to end on the fake binary: the bead's worktree is a git worktree on the shift's branch, the provider ran in it, and the bead ends in review with its reservation freed", async () => {
    const repo = repository();
    const { deps, io, tracker, env, announced } = cli(repo, [queued("cli-1")]);
    const dump = join(scratch(), "fake dump.json");
    deps.exec = {
      ...deps.exec,
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
    expect(tracker.beads.get("cli-1")?.labels).toEqual(["queue:review"]);
    expect(
      activeReservations(
        { workspace: resolveCheckout(repo).workspace },
        { path: deps.ledgerPath },
      ),
    ).toEqual([]);
    expect(env.AGENT_FORGE_HOME).toBeDefined();
  }, 30_000);

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
