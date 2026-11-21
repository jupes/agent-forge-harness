import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorktreeRecord } from "../../types/beads";
import { conversationFile } from "../conversations/paths";
import { createConversationStore } from "../conversations/store";
import { writeOwnerOnly } from "../hearth/token";
import { createRestartIdentityJournal } from "../identities/restart-index";
import { appendEvent } from "../ledger/append";
import { closeLedger, openLedger } from "../ledger/db";
import { runOptions } from "../scheduler/shift-cli-runtime";
import type { GitRun } from "../scheduler/worktrees";
import { createSessionRegistry } from "../sessions/registry";
import {
  createProjectShiftRegistry,
  projectShiftFlags,
} from "../shifts/registry";
import { scratchDirs } from "../test-scratch";
import { workspaceKey } from "./scope";
import { createProjectStore } from "./store";
import type { ProjectSources } from "./summary";
import { readWorktreeCleanupPreflight } from "./worktree-cleanup-preflight";

const scratch = scratchDirs();
afterEach(() => {
  closeLedger();
  scratch.cleanup();
});

async function fixture() {
  const base = realpathSync.native(scratch.make("cleanup-preflight-")),
    root = join(base, "repo"),
    home = join(base, "home");
  mkdirSync(join(root, ".git"), { recursive: true });
  const projects = createProjectStore(home),
    catalog = await projects.create(
      {
        slug: "alpha",
        name: "Alpha",
        description: "",
        icon: "A",
        workspaces: [{ root, repositories: [root], epicIds: ["alpha-epic"] }],
      },
      0,
    ),
    project = catalog.projects[0]!,
    request = {
      requestId: "70000000-0000-4000-8000-000000000001",
      expectedCatalogRevision: 1,
      options: {
        for: "2h",
        concurrency: 1,
        maxBeads: 1,
        maxUsd: 5,
        repairs: 1,
        base: "master",
      },
    },
    { intent } = await createProjectShiftRegistry({ home, root }).reserve(
      project.id,
      request,
      async () => ({ shiftId: "shift-20261107-100000-0001" }),
    );
  const row: WorktreeRecord = {
    id: `${intent.shiftId}-1`,
    path: join(root, "trees", `${intent.shiftId}-1`),
    branch: "feat/alpha",
    createdAt: intent.createdAt,
    beadId: "alpha-task",
  };
  mkdirSync(row.path, { recursive: true });
  const registry = join(root, "trees", ".state.json"),
    saveRegistry = () =>
      writeFileSync(registry, JSON.stringify({ worktrees: [row] }));
  saveRegistry();
  const flags = runOptions(projectShiftFlags(request));
  if (!flags.ok || flags.value.forMs === undefined)
    throw Error("Invalid fixture bounds");
  const shiftFile = join(home, "shifts", `${intent.shiftId}.json`);
  mkdirSync(join(home, "shifts"), { mode: 0o700 });
  const shift = {
    shiftId: intent.shiftId,
    workspace: intent.workspace,
    pid: 1,
    state: "stopped",
    startedAt: intent.createdAt,
    deadline: new Date(
      Date.parse(intent.createdAt) + flags.value.forMs,
    ).toISOString(),
    endedAt: new Date(Date.parse(intent.createdAt) + 1000).toISOString(),
    options: flags.value,
    spentUsd: 0,
    unpriced: 0,
    beads: [
      {
        beadId: row.beadId,
        worktree: row.path,
        branch: row.branch,
        outcome: "review",
        attempts: 1,
        runId: "fixture-run",
      },
    ],
  };
  writeOwnerOnly(shiftFile, JSON.stringify(shift));
  // Match a live hearth: its ledger remains open with protected WAL/SHM until teardown.
  openLedger(join(home, "ledger.db"));
  let status = "",
    locked = false;
  const calls: string[][] = [],
    git: GitRun = (args, cwd) => {
      calls.push([...args]);
      if (args.includes("config")) return { status: 1, stdout: "", stderr: "" };
      if (args.includes("ls-files"))
        return { status: 0, stdout: "", stderr: "" };
      if (args.includes("status"))
        return { status: 0, stdout: status, stderr: "" };
      if (args.includes("list"))
        return {
          status: 0,
          stdout: `worktree ${row.path}\0HEAD ${"a".repeat(40)}\0branch refs/heads/${row.branch}\0${locked ? "locked fixture\0" : ""}\0`,
          stderr: "",
        };
      if (args.includes("--show-toplevel"))
        return { status: 0, stdout: cwd, stderr: "" };
      if (args.includes("--verify"))
        return { status: 0, stdout: "a".repeat(40), stderr: "" };
      if (args.includes("--git-common-dir"))
        return { status: 0, stdout: join(root, ".git"), stderr: "" };
      throw Error("Unexpected Git operation");
    };
  const readSources = (): ProjectSources => ({
    workspace: workspaceKey(root),
    asOf: new Date().toISOString(),
    issues: [
      {
        id: "alpha-epic",
        type: "epic",
        title: "Epic",
        status: "open",
        createdAt: intent.createdAt,
        updatedAt: intent.createdAt,
        labels: ["project:alpha"],
      },
      {
        id: "alpha-task",
        parent: "alpha-epic",
        type: "task",
        title: "Task",
        status: "closed",
        createdAt: intent.createdAt,
        updatedAt: intent.createdAt,
        labels: ["project:alpha"],
      },
    ],
    queue: [],
    sessions: [],
    sessionsComplete: true,
    problems: [],
  });
  const options = { home, root, projectId: project.id, worktreeId: row.id };
  const read = () =>
    readWorktreeCleanupPreflight(options, { git, readSources });
  return {
    root,
    home,
    row,
    registry,
    saveRegistry,
    shiftFile,
    shift,
    projects,
    project,
    calls,
    readSources,
    options,
    git,
    read,
    dirty(value: string) {
      status = value;
    },
    lock() {
      locked = true;
    },
  };
}

test("foreign registry IDs refuse before Git, without changing source or cached ownership", async () => {
  const f = await fixture(),
    before = readFileSync(f.registry, "utf8");
  const result = await readWorktreeCleanupPreflight(
    { ...f.options, worktreeId: "foreign" },
    { git: f.git, readSources: f.readSources },
  );
  expect(result.state).toBe("refused");
  expect(f.calls).toHaveLength(0);
  expect(readFileSync(f.registry, "utf8")).toBe(before);
});

test("tracked, untracked and ignored data and locked Git worktrees are refused without any removal", async () => {
  const f = await fixture();
  for (const status of [" M tracked\0", "?? untracked\0", "!! ignored\0"]) {
    f.dirty(status);
    expect((await f.read()).state).toBe("refused");
  }
  f.dirty("");
  f.lock();
  expect((await f.read()).state).toBe("refused");
  expect(f.calls.some((call) => call.includes("remove"))).toBe(false);
});

test("inactivity alone cannot admit legacy/session trees or an uncorrelated Shift record", async () => {
  const f = await fixture();
  f.row.ownerSessionId = "legacy-owner";
  f.saveRegistry();
  expect((await f.read()).state).toBe("refused");
  delete f.row.ownerSessionId;
  f.saveRegistry();
  for (const beads of [
    [],
    [{ ...f.shift.beads[0]!, branch: "feat/foreign" }],
  ]) {
    writeOwnerOnly(f.shiftFile, JSON.stringify({ ...f.shift, beads }));
    expect((await f.read()).state).toBe("refused");
  }
});

test("another project's active Keeper blocks without a SessionRegistry row or mirror; settled evidence releases", async () => {
  const f = await fixture(),
    catalog = await f.projects.create(
      {
        slug: "beta",
        name: "Beta",
        description: "",
        icon: "B",
        workspaces: [
          { root: f.root, repositories: [f.root], epicIds: ["beta-epic"] },
        ],
      },
      1,
    ),
    beta = catalog.projects.find((item) => item.slug === "beta")!;
  expect((await f.read()).state).toBe("eligible");
  const conversations = createConversationStore(f.home),
    requestId = "80000000-0000-4000-8000-000000000001",
    owner = "80000000-0000-4000-8000-000000000002";
  await conversations.accept(beta.id, {
    requestId,
    expectedRevision: 0,
    text: "Other project work",
    about: [],
  });
  const file = conversationFile(f.home, beta.id),
    before = readFileSync(file, "utf8");
  expect((await f.read()).state).toBe("refused");
  expect(readFileSync(file, "utf8")).toBe(before);
  await conversations.start(beta.id, requestId, owner);
  await conversations.append(beta.id, requestId, owner, {
    kind: "identity",
    provider: "claude",
    sessionId: "fixture",
    version: "fixture",
  });
  await conversations.finish(beta.id, requestId, owner, "completed", null);
  expect((await f.read()).state).toBe("eligible");
});

test("an active private Keeper absent from the catalog is unknown instead of an empty successful inventory", async () => {
  const f = await fixture(),
    orphan = "project-90000000-0000-4000-8000-000000000001";
  await createConversationStore(f.home).accept(orphan, {
    requestId: "90000000-0000-4000-8000-000000000002",
    expectedRevision: 0,
    text: "Unlocatable owner",
    about: [],
  });
  const file = conversationFile(f.home, orphan),
    before = readFileSync(file, "utf8");
  expect((await f.read()).state).toBe("unknown");
  expect(readFileSync(file, "utf8")).toBe(before);
});

test("complete Start originals protect orphan and other-project pre-registry reserved or attempted work", async () => {
  const f = await fixture(),
    journal = createRestartIdentityJournal(f.home),
    orphan = {
      version: 1 as const,
      address: {
        family: "owned-session-start" as const,
        projectId: "project-90000000-0000-4000-8000-000000000003",
      },
      workspace: workspaceKey(f.root),
      requestId: "90000000-0000-4000-8000-000000000004",
      requestHash: "b".repeat(64),
      provider: "claude" as const,
      mode: "task" as const,
    };
  await journal.reserve(orphan);
  expect((await f.read()).state).toBe("unknown");
  await journal.retireReserved(orphan);
  expect((await f.read()).state).toBe("eligible");
  const catalog = await f.projects.create(
      {
        slug: "beta",
        name: "Beta",
        description: "",
        icon: "B",
        workspaces: [
          { root: f.root, repositories: [f.root], epicIds: ["beta-epic"] },
        ],
      },
      1,
    ),
    beta = catalog.projects.find((item) => item.slug === "beta")!,
    original = {
      ...orphan,
      address: { ...orphan.address, projectId: beta.id },
      requestId: "90000000-0000-4000-8000-000000000005",
    };
  await journal.reserve(original);
  expect((await f.read()).state).toBe("refused");
  await journal.beginAttempt(original);
  expect((await f.read()).state).toBe("unknown");
});

test("an outstanding reservation blocks; only complete released evidence restores eligibility", async () => {
  const f = await fixture(),
    path = join(f.home, "ledger.db");
  const record = (kind: "reservation.acquired" | "reservation.released") => {
    const result = appendEvent(
      {
        kind,
        workspace: f.root,
        beadId: "alpha-task",
        payload: { worktree: f.row.path, globs: ["src/**"] },
      },
      { path },
    );
    if (!result.ok) throw Error(result.error);
  };
  record("reservation.acquired");
  expect((await f.read()).state).toBe("refused");
  record("reservation.released");
  expect((await f.read()).state).toBe("eligible");
  closeLedger();
  writeOwnerOnly(path, "unreadable SQLite");
  expect((await f.read()).state).toBe("unknown");
});

test("a session's historical target association remains excluded even after its private turn settled", async () => {
  const f = await fixture(),
    requestId = "a0000000-0000-4000-8000-000000000001",
    owner = "a0000000-0000-4000-8000-000000000002";
  const session = await createSessionRegistry(f.home).reserve(
    f.project.id,
    requestId,
    "c".repeat(64),
    async () => ({
      mode: "task",
      provider: "claude",
      workspace: workspaceKey(f.root),
      repository: f.root,
      worktree: f.row.path,
      smith: "fixture",
      requestedModel: "fixture",
      requestedEffort: null,
    }),
  );
  const conversations = createConversationStore(f.home, undefined, {
    kind: "session",
    projectId: f.project.id,
    sessionId: session.id,
  });
  await conversations.accept(f.project.id, {
    requestId,
    expectedRevision: 0,
    text: "Settled session",
    about: [],
  });
  await conversations.start(f.project.id, requestId, owner);
  await conversations.append(f.project.id, requestId, owner, {
    kind: "identity",
    provider: "claude",
    sessionId: "fixture",
    version: "fixture",
  });
  await conversations.finish(f.project.id, requestId, owner, "completed", null);
  expect((await f.read()).state).toBe("refused");
});

test("catalog or registry changes while a fresh host read is pending cannot produce an eligible snapshot", async () => {
  for (const kind of ["catalog", "registry"]) {
    const f = await fixture();
    const result = await readWorktreeCleanupPreflight(f.options, {
      git: f.git,
      readSources: async () => {
        if (kind === "catalog")
          await f.projects.updateGeneral(f.project.id, 1, {
            name: "Changed",
            description: "",
            icon: "A",
          });
        else
          writeFileSync(
            f.registry,
            JSON.stringify({
              worktrees: [{ ...f.row, branch: "feat/replaced" }],
            }),
          );
        return f.readSources();
      },
    });
    expect(result.state).toBe("unknown");
    expect(f.calls.some((call) => call.includes("remove"))).toBe(false);
  }
});

test("tracked submodules refuse before status rather than running nested repository configuration", async () => {
  const f = await fixture();
  const result = await readWorktreeCleanupPreflight(f.options, {
    readSources: f.readSources,
    git: (args, cwd, timeout) =>
      args.includes("ls-files")
        ? {
            status: 0,
            stdout: `160000 ${"b".repeat(40)} 0\tmodule\0`,
            stderr: "",
          }
        : f.git(args, cwd, timeout),
  });
  expect(result.state).toBe("refused");
  expect(f.calls.some((call) => call.includes("status"))).toBe(false);
});

test("new Git filter configuration during the host read refuses before a second status invocation", async () => {
  const f = await fixture();
  let changed = false,
    unsafeStatus = 0;
  const result = await readWorktreeCleanupPreflight(f.options, {
    readSources: () => {
      changed = true;
      return f.readSources();
    },
    git: (args, cwd, timeout) => {
      if (changed && args.includes("config"))
        return {
          status: 0,
          stdout: "filter.fixture.clean command\n",
          stderr: "",
        };
      if (changed && args.includes("status")) unsafeStatus++;
      return f.git(args, cwd, timeout);
    },
  });
  expect(result.state).toBe("unknown");
  expect(unsafeStatus).toBe(0);
});

test("a host scope read that never answers expires as unknown without granting removal", async () => {
  const f = await fixture();
  const result = await readWorktreeCleanupPreflight(f.options, {
    git: f.git,
    readSources: () => new Promise<ProjectSources>(() => {}),
  });
  expect(result.state).toBe("unknown");
}, 7000);

test("eligible observations are advisory, preserve source bytes, and any session mirror retains the target", async () => {
  const f = await fixture(),
    before = readFileSync(f.registry, "utf8"),
    shift = readFileSync(f.shiftFile, "utf8");
  expect(await f.read()).toMatchObject({
    state: "eligible",
    removalAuthorized: false,
    head: "a".repeat(40),
    record: f.row,
  });
  expect(
    f.calls.every(
      (call) =>
        call.includes("--no-optional-locks") &&
        call.includes("core.fsmonitor=false") &&
        call.includes("core.hooksPath=/dev/null"),
    ),
  ).toBe(true);
  expect(
    f.calls
      .filter((call) => call.includes("status"))
      .every(
        (call) =>
          call.includes("--ignore-submodules=none") &&
          call.includes("--ignored=matching") &&
          call.includes("--untracked-files=all"),
      ),
  ).toBe(true);
  expect(readFileSync(f.registry, "utf8")).toBe(before);
  expect(readFileSync(f.shiftFile, "utf8")).toBe(shift);
  writeFileSync(join(f.row.path, ".agent-forge-session"), "legacy-session\n");
  expect((await f.read()).state).toBe("refused");
});

test("retained deleted-project originals still protect an active Keeper's ownership", async () => {
  const f = await fixture(),
    catalog = await f.projects.create(
      {
        slug: "beta",
        name: "Beta",
        description: "",
        icon: "B",
        workspaces: [
          { root: f.root, repositories: [f.root], epicIds: ["beta-epic"] },
        ],
      },
      1,
    ),
    beta = catalog.projects.find((item) => item.slug === "beta")!;
  await f.projects.preferences(beta.id, 2, { archived: true });
  await f.projects.deleteProject(
    beta.id,
    {
      requestId: "b0000000-0000-4000-8000-000000000001",
      expectedRevision: 3,
      confirmName: beta.name,
    },
    async () => {},
  );
  await createConversationStore(f.home).accept(beta.id, {
    requestId: "b0000000-0000-4000-8000-000000000002",
    expectedRevision: 0,
    text: "Retained owner",
    about: [],
  });
  expect((await f.read()).state).toBe("refused");
  expect(f.projects.read().projects.some((item) => item.id === beta.id)).toBe(
    false,
  );
});

test("fresh scoped membership and queue evidence are required; partial or stale reads remain unknown", async () => {
  const f = await fixture();
  for (const kind of ["membership", "queue", "partial", "stale"]) {
    const result = await readWorktreeCleanupPreflight(f.options, {
      git: f.git,
      readSources: () => {
        const source = f.readSources();
        if (kind === "membership") source.issues![1]!.labels = [];
        if (kind === "queue")
          source.queue!.push({
            beadId: "alpha-task",
            title: "Task",
            state: "running",
            status: "in_progress",
            backed: true,
          });
        if (kind === "partial") source.problems.push("Incomplete tracker read");
        if (kind === "stale") source.asOf = "1970-01-01T00:00:00.000Z";
        return source;
      },
    });
    expect(result.state).toBe(
      ["partial", "stale"].includes(kind) ? "unknown" : "refused",
    );
  }
});

test("an in-progress Bead refuses even when stale backed queue metadata says halted", async () => {
  const f = await fixture();
  const result = await readWorktreeCleanupPreflight(f.options, {
    git: f.git,
    readSources: () => {
      const source = f.readSources();
      source.issues![1]!.status = "in_progress";
      source.queue!.push({
        beadId: "alpha-task",
        title: "Task",
        state: "halted",
        status: "in_progress",
        backed: true,
      });
      return source;
    },
  });
  expect(result.state).toBe("refused");
});

test("a reservation for the cached Bead in another worktree still prevents eligibility", async () => {
  const f = await fixture();
  const saved = appendEvent(
    {
      kind: "reservation.acquired",
      workspace: f.root,
      beadId: "alpha-task",
      payload: {
        worktree: join(f.root, "trees", "another-owner"),
        globs: ["src/**"],
      },
    },
    { path: join(f.home, "ledger.db") },
  );
  if (!saved.ok) throw Error(saved.error);
  expect((await f.read()).state).toBe("refused");
});

test("clean status cannot conceal tracked files through skip-worktree or assume-unchanged flags", async () => {
  const f = await fixture();
  for (const flag of ["S", "h", "s"]) {
    const result = await readWorktreeCleanupPreflight(f.options, {
      readSources: f.readSources,
      git: (args, cwd, timeout) =>
        args.includes("ls-files") && args.includes("-v")
          ? { status: 0, stdout: `${flag} hidden.txt\0`, stderr: "" }
          : f.git(args, cwd, timeout),
    });
    expect(result.state).toBe("refused");
  }
});
