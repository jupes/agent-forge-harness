import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { conversationFile } from "../conversations/paths";
import { buildChildEnv } from "../executors/env";
import { liveChildCount } from "../executors/supervisor";
import type { BdRunner } from "../hearth/routes/dev-api";
import { writeOwnerOnly } from "../hearth/token";
import { closeLedger } from "../ledger/db";
import { activeReservations, queryEvents } from "../ledger/query";
import { projectCatalogPath } from "../projects/store";
import { FIXTURE_PROJECT_ID, projectCatalogFixture } from "../projects/testing";
import {
  answerQueueList,
  queueTracker,
  type TrackedBead,
} from "../scheduler/queue-fixture";
import type { ShiftDeps } from "../scheduler/shift";
import {
  processAlive,
  readShiftRecord,
  requestStop,
} from "../scheduler/shift-store";
import { createSessionRegistry } from "../sessions/registry";
import { scratchDirs } from "../test-scratch";
import { createProjectShiftAttemptReader } from "./attempt-read";
import { createAttendedProjectShiftExecutionRuntime } from "./attended-runtime";
import { executeOriginalProjectShift } from "./execution";
import { createProjectShiftRegistry } from "./registry";

const scratch = scratchDirs(),
  ledgers: string[] = [];
afterEach(() => {
  for (const file of ledgers.splice(0)) closeLedger(file);
  scratch.cleanup();
});
const nativeLog = z.object({
  argv: z.array(z.string()),
  stdin: z.string(),
  cwd: z.string(),
  pid: z.number(),
});
async function fixture(
  provider: "claude" | "codex" = "claude",
  mode = "rich",
  beadCount = 1,
) {
  const root = realpathSync.native(scratch.make("actual attended runtime ")),
    home = join(root, "home"),
    configHome = join(root, "config");
  mkdirSync(join(root, ".git"));
  mkdirSync(configHome);
  const providerExe = join(
      root,
      `${provider}${process.platform === "win32" ? ".exe" : ""}`,
    ),
    log = join(root, "actual-provider.json");
  const built = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "--compile",
      join(
        import.meta.dir,
        provider === "claude"
          ? "../sessions/fixtures/compiled-coding-cli.ts"
          : "../sessions/fixtures/compiled-codex-task-runtime-cli.ts",
      ),
      "--outfile",
      providerExe,
    ],
    { stdout: "pipe", stderr: "pipe", timeout: 30000 },
  );
  if (built.exitCode !== 0)
    throw Error("Could not compile inert attended provider");
  writeFileSync(
    join(root, "agent-forge.toml"),
    '[execution.env]\npass=["CODING_FIXTURE_MODE","CODING_FIXTURE_RECORD","CODEX_RUNTIME_MODE","CODEX_RUNTIME_LOG"]\n',
  );
  const catalog = projectCatalogFixture(root);
  writeOwnerOnly(projectCatalogPath(home), JSON.stringify(catalog));
  const beads: TrackedBead[] = [
    {
      id: "alpha-epic",
      title: "Selected epic",
      issueType: "epic",
      labels: ["project:alpha"],
    },
    {
      id: "alpha-work",
      title: "Bounded work",
      parent: { id: "alpha-epic" },
      labels: ["queue:queued", "project:alpha"],
      metadata: { queue_state: "queued" },
      description: "Only planted work.\n\n## Files\nsrc/private/**\n",
    },
  ];
  if (beadCount > 1)
    beads.push({
      id: "alpha-next",
      title: "Next bounded work",
      parent: { id: "alpha-epic" },
      labels: ["queue:queued", "project:alpha"],
      metadata: { queue_state: "queued" },
      description: "More planted work.\n\n## Files\nsrc/next/**\n",
    });
  const tracker = queueTracker(beads),
    calls: string[][] = [];
  const runBd: BdRunner = async (args) => {
    calls.push([...args]);
    if (args[0] === "export")
      return {
        status: 0,
        stderr: "",
        stdout: [...tracker.beads.values()]
          .map((bead) =>
            JSON.stringify({
              id: bead.id,
              title: bead.title ?? bead.id,
              issue_type: bead.issueType ?? "task",
              status: bead.status ?? "open",
              priority: 2,
              labels: bead.labels ?? [],
              metadata: bead.metadata ?? {},
              description: bead.description ?? "",
              created_at: "2026-10-23T00:00:00.000Z",
              updated_at: "2026-10-23T00:00:00.000Z",
              dependencies: bead.parent
                ? [
                    {
                      issue_id: bead.id,
                      depends_on_id: bead.parent.id,
                      type: "parent-child",
                    },
                  ]
                : [],
            }),
          )
          .join("\n"),
      };
    return (
      tracker.answer(args) ??
      tracker.answerComment(args) ??
      answerQueueList(args, [...tracker.beads.values()]) ?? {
        status: 1,
        stdout: "",
        stderr: "Unsupported inert tracker operation",
      }
    );
  };
  const request = {
    requestId: "2230bb02-1119-4c69-adad-c44116b375c1",
    expectedCatalogRevision: 1,
    options: {
      for: "1m",
      concurrency: 1,
      maxBeads: beadCount,
      maxUsd: 5,
      repairs: 1,
      base: "main",
      smith: `${provider}-journeyman`,
    },
  };
  const originals = createProjectShiftRegistry({ root, home }),
    saved = await originals.reserve(FIXTURE_PROJECT_ID, request, async () => ({
      shiftId: "shift-20261023-170000-1234",
    }));
  await originals.markAttempted(
    FIXTURE_PROJECT_ID,
    request.requestId,
    saved.intent.requestHash,
  );
  const ledger = join(home, "ledger.db");
  ledgers.push(ledger);
  let changed = false,
    make: (() => void) | undefined,
    fetch: (() => void) | undefined;
  const deps: ShiftDeps = {
    root,
    runBd,
    ledgerPath: ledger,
    lockFile: join(home, "queue.lock.db"),
    shiftsDir: join(home, "shifts"),
    mainCheckout: root,
    sampleHost: async () => ({ busy: false }),
    makeWorktree: ({ id }) => {
      const path = join(root, "trees", id),
        gitDir = join(root, ".git/worktrees", id);
      mkdirSync(gitDir, { recursive: true });
      mkdirSync(path, { recursive: true });
      writeFileSync(join(gitDir, "commondir"), "../..\n");
      writeFileSync(join(path, ".git"), `gitdir: ${gitDir}\n`);
      for (const dir of ["skills/one", "commands", "agents"])
        mkdirSync(join(path, ".claude", dir), { recursive: true });
      writeFileSync(
        join(path, ".claude/skills/one/SKILL.md"),
        "# Disposable skill\n",
      );
      make?.();
      return { ok: true, path };
    },
    git: async (args) => {
      if (args[0] === "fetch") {
        fetch?.();
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse")
        return { status: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" };
      if (args[0] === "log")
        return { status: 0, stdout: "abc1234 fake work\n", stderr: "" };
      if (args[0] === "push") return { status: 0, stdout: "", stderr: "" };
      return {
        status: 1,
        stdout: "",
        stderr: "Unsupported inert Git operation",
      };
    },
    gh: async () => ({
      status: 0,
      stdout: "https://github.com/example/fixture/pull/1\n",
      stderr: "",
    }),
    checkPrBody: async () => {
      throw Error("Source PR checker must never run in attended composition");
    },
    exec: { command: [providerExe] },
  };
  const environment = {
    ...buildChildEnv(process.env, []),
    CODING_FIXTURE_MODE: mode,
    CODING_FIXTURE_RECORD: log,
    CODEX_RUNTIME_MODE: mode,
    CODEX_RUNTIME_LOG: log,
    TEST_OPERATOR_SECRET: "MUST_NOT_REACH_PROVIDER",
  };
  const runtime = createAttendedProjectShiftExecutionRuntime({
    root,
    home,
    configHome,
    environment,
    dependencies: deps,
  });
  const archive = () => {
    if (changed) return;
    changed = true;
    const project = catalog.projects[0];
    if (!project) throw Error("Missing planted project");
    project.archived = true;
    catalog.revision++;
    writeOwnerOnly(projectCatalogPath(home), JSON.stringify(catalog));
  };
  return {
    root,
    home,
    log,
    request,
    originals,
    runtime,
    tracker,
    calls,
    ledger,
    run: () =>
      executeOriginalProjectShift({
        root,
        home,
        projectId: FIXTURE_PROJECT_ID,
        requestId: request.requestId,
        runtime,
      }),
    archiveOnMake: () => {
      make = archive;
    },
    archiveOnFetch: () => {
      fetch = archive;
    },
  };
}

test("the actual canonical engine privately captures each supervised provider and exact input, then reconciles without replay", async () => {
  for (const provider of ["claude", "codex"] as const) {
    const f = await fixture(provider);
    const receipt = await f.run();
    expect(receipt.observation.phase).toBe("stopped");
    expect(receipt.observation.actual?.admitted).toBe(1);
    expect(f.tracker.beads.get("alpha-work")?.labels).toContain("queue:review");
    expect(
      readShiftRecord(join(f.home, "shifts"), "shift-20261023-170000-1234")
        ?.beads[0],
    ).toMatchObject({
      prUrl: "https://github.com/example/fixture/pull/1",
      prBody: "shift",
    });
    const rows = createSessionRegistry(f.home).listAll(FIXTURE_PROJECT_ID);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw Error("No actual owned provider attempt");
    const page = await createProjectShiftAttemptReader({
      root: f.root,
      home: f.home,
    }).read(FIXTURE_PROJECT_ID, f.request.requestId, row.id, { limit: 100 });
    expect(page.turns[0]?.phase).toBe("completed");
    expect(page.controllable).toBe(false);
    expect(page.binding?.provider).toBe(provider);
    const user = page.frames[0]?.event;
    if (user?.kind !== "user" || !user.shift)
      throw Error("No verified actual input");
    let raw: unknown;
    try {
      const bytes = readFileSync(f.log, "utf8");
      raw =
        provider === "claude"
          ? JSON.parse(bytes)
          : bytes
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line))
              .find((record) => record.kind === "task");
    } catch {
      throw Error("Invalid completed inert provider record");
    }
    const actual = nativeLog.parse(raw);
    expect(user.shift.command.slice(1)).toEqual(actual.argv);
    expect(user.shift.stdin).toBe(actual.stdin);
    expect(user.shift.cwd).toBe(actual.cwd);
    expect(
      page.frames.find((frame) => frame.event.kind === "process")?.event,
    ).toMatchObject({ kind: "process", pid: actual.pid });
    if (provider === "codex") {
      expect(actual.argv).toContain('approval_policy="never"');
      expect(existsSync(join(actual.cwd, ".agents/skills/one/SKILL.md"))).toBe(
        true,
      );
    }
    const file = conversationFile(f.home, FIXTURE_PROJECT_ID, {
        kind: "session",
        projectId: FIXTURE_PROJECT_ID,
        sessionId: row.id,
      }),
      before = readFileSync(file, "utf8"),
      wire = readFileSync(f.log, "utf8");
    await f.run();
    expect(readFileSync(f.log, "utf8")).toBe(wire);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(
      activeReservations({ workspace: f.root }, { path: f.ledger }),
    ).toEqual([]);
    const metadata = JSON.stringify(
      queryEvents({ workspace: f.root }, { path: f.ledger }),
    );
    expect(metadata).not.toContain(actual.stdin);
    expect(metadata).not.toContain("Private reported reasoning");
    expect(metadata).not.toContain("MUST_NOT_REACH_PROVIDER");
    expect(liveChildCount()).toBe(0);
  }
}, 45000);

test("current scope lost before claim or before private input refuses model delivery and preserves owned cleanup", async () => {
  for (const where of ["fetch", "make"]) {
    const f = await fixture();
    if (where === "fetch") f.archiveOnFetch();
    else f.archiveOnMake();
    await f.run();
    expect(existsSync(f.log)).toBe(false);
    expect(createSessionRegistry(f.home).listAll(FIXTURE_PROJECT_ID)).toEqual(
      [],
    );
    expect(f.tracker.beads.get("alpha-work")?.labels).toContain("queue:queued");
    expect(
      activeReservations({ workspace: f.root }, { path: f.ledger }),
    ).toEqual([]);
    if (where === "fetch") expect(f.tracker.updates()).toEqual([]);
    else
      expect(
        readShiftRecord(join(f.home, "shifts"), "shift-20261023-170000-1234")
          ?.reason,
      ).toBe("halted");
    expect(liveChildCount()).toBe(0);
  }
}, 45000);

test("canonical whole-shift Stop waits for supervised fake delivery to settle and cannot authorize a repeat", async () => {
  const f = await fixture("claude", "hang-tree"),
    running = f.run();
  const deadline = Date.now() + 10000;
  let actual: { pid: number; childPid: number | null } | undefined;
  while (!actual && Date.now() < deadline) {
    try {
      const raw: unknown = JSON.parse(readFileSync(f.log, "utf8"));
      actual = z
        .object({ pid: z.number(), childPid: z.number().nullable() })
        .parse(raw);
    } catch {
      await Bun.sleep(20);
    }
  }
  if (!actual)
    throw Error(
      "The inert provider did not publish a complete owned process record",
    );
  expect(
    requestStop(join(f.home, "shifts"), "shift-20261023-170000-1234").ok,
  ).toBe(true);
  const receipt = await running;
  expect(receipt.observation.phase).toBe("stopped");
  expect(receipt.observation.reason).toBe("operator");
  expect(processAlive(actual.pid)).toBe(false);
  if (actual.childPid) expect(processAlive(actual.childPid)).toBe(false);
  const record = readFileSync(f.log, "utf8");
  await f.run();
  expect(readFileSync(f.log, "utf8")).toBe(record);
  expect(f.tracker.beads.get("alpha-work")?.labels).toContain("queue:queued");
  expect(activeReservations({ workspace: f.root }, { path: f.ledger })).toEqual(
    [],
  );
  expect(liveChildCount()).toBe(0);
}, 45000);

test("an actual private protocol failure halts the engine before repair or another claim and releases its owned work", async () => {
  const f = await fixture("claude", "malformed", 2);
  const receipt = await f.run();
  expect(receipt.observation.phase).toBe("stopped");
  expect(receipt.observation.reason).toBe("halted");
  const rows = createSessionRegistry(f.home).listAll(FIXTURE_PROJECT_ID);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.origin?.attempt).toBe(1);
  const record = readShiftRecord(
    join(f.home, "shifts"),
    "shift-20261023-170000-1234",
  );
  expect(record?.beads).toHaveLength(1);
  expect(record?.beads[0]?.attempts).toBe(1);
  expect(f.tracker.beads.get("alpha-next")?.labels).toContain("queue:queued");
  expect(activeReservations({ workspace: f.root }, { path: f.ledger })).toEqual(
    [],
  );
  expect(liveChildCount()).toBe(0);
}, 45000);
