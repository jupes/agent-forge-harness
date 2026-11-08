import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { WorktreeRecord } from "../../types/beads";
import { projectRoutes } from "../hearth/routes/projects";
import { writeOwnerOnly } from "../hearth/token";
import { appendEvent } from "../ledger/append";
import { closeLedger, openLedger } from "../ledger/db";
import { createQueue } from "../scheduler/queue";
import { queueTracker } from "../scheduler/queue-fixture";
import { reserve } from "../scheduler/reservations";
import { runOptions } from "../scheduler/shift-cli-runtime";
import { withWorktreeRegistryLock } from "../scheduler/worktree-registry-lock";
import {
  type GitRun,
  readStrictWorktreeRegistry,
} from "../scheduler/worktrees";
import {
  createProjectShiftRegistry,
  projectShiftFlags,
} from "../shifts/registry";
import { scratchDirs } from "../test-scratch";
import { workspaceKey } from "./scope";
import { createProjectStore, projectCatalogPath } from "./store";
import type { ProjectSources } from "./summary";
import { readWorktreeCleanupPreflight } from "./worktree-cleanup-preflight";
import {
  type CleanupRequest,
  canonicalCleanupRequest,
  cleanupReceiptSchema,
  cleanupRequestSchema,
} from "./worktree-cleanup-protocol";
import { createProjectWorktreeCleanupService } from "./worktree-cleanup-service";
import {
  readWorktreeCleanupInventory,
  withWorktreeCleanupLease,
} from "./worktree-cleanup-store";

const scratch = scratchDirs();
afterEach(() => {
  closeLedger();
  scratch.cleanup();
});

const stamp = "2026-11-07T00:00:00.000Z";
const confirmed = {
  projectId: "project-a1000000-0000-4000-8000-000000000001",
  requestId: "a1000000-0000-4000-8000-000000000002",
  requestHash: "a".repeat(64),
  repository: "/repo",
  expectedCatalogRevision: 1,
  expectedRecord: {
    id: "shift-test-1",
    path: "/repo/trees/shift-test-1",
    branch: "shift/test",
    createdAt: stamp,
    beadId: "forge-test.1",
  },
  expectedHead: "b".repeat(40),
  state: "confirmed" as const,
  reason: null,
  attemptedAt: stamp,
  endedAt: "2026-11-07T00:00:01.000Z",
  audit: { eventId: 1, ulid: "0".repeat(26), ts: stamp },
};

test("cleanup receipts retain exact reviewed identity and coherent outcome evidence", () => {
  const unknown = {
    ...confirmed,
    state: "unknown" as const,
    endedAt: null,
    reason: "Cleanup is not confirmed",
  };
  const refused = {
    ...confirmed,
    state: "refused" as const,
    attemptedAt: null,
    reason: "No primitive was invoked",
  };
  for (const value of [
    confirmed,
    refused,
    unknown,
    { ...unknown, attemptedAt: null },
  ])
    expect(cleanupReceiptSchema.parse(value)).toEqual(value);
  const invalid: unknown[] = [
    { ...confirmed, attemptedAt: null },
    { ...confirmed, endedAt: null },
    { ...confirmed, endedAt: "2026-11-06T23:59:59.000Z" },
    { ...confirmed, reason: "Not confirmed" },
    { ...refused, attemptedAt: stamp },
    { ...refused, reason: null },
    { ...unknown, endedAt: stamp },
    { ...unknown, reason: null },
    { ...unknown, reason: "" },
    { ...confirmed, state: "reserved" },
    { ...confirmed, force: false },
    { ...confirmed, requestId: confirmed.requestId.toUpperCase() },
    { ...confirmed, requestHash: "invalid" },
    { ...confirmed, audit: { ...confirmed.audit, eventId: 0 } },
    { ...confirmed, audit: { ...confirmed.audit, eventId: 1.5 } },
    {
      ...confirmed,
      audit: { ...confirmed.audit, eventId: Number.MAX_SAFE_INTEGER + 1 },
    },
    { ...confirmed, audit: { ...confirmed.audit, ulid: "8" + "0".repeat(25) } },
    { ...confirmed, audit: { ...confirmed.audit, ts: "unknown" } },
    { ...confirmed, audit: { ...confirmed.audit, authority: true } },
  ];
  invalid.forEach((value, index) => {
    expect({
      index,
      valid: cleanupReceiptSchema.safeParse(value).success,
    }).toEqual({ index, valid: false });
  });
});

async function fixture(rootLeaf = "repo") {
  const base = realpathSync.native(scratch.make("cleanup-service-")),
    root = join(base, rootLeaf),
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
    );
  const project = catalog.projects[0];
  if (!project) throw Error("Expected a fixture project");
  const request = {
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
  };
  const { intent } = await createProjectShiftRegistry({ home, root }).reserve(
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
      if (args[0] === "worktree" && args[1] === "remove")
        return { status: 0, stdout: "", stderr: "" };
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

test("cleanup service fixture confirms eligible stopped Shift ownership", async () => {
  const f = await fixture();
  expect(await f.read()).toMatchObject({
    state: "eligible",
    removalAuthorized: false,
  });
});

async function savedCleanup(
  f: Awaited<ReturnType<typeof fixture>>,
  publish = true,
  transform?: (request: CleanupRequest) => CleanupRequest,
) {
  const baseRequest = cleanupRequestSchema.parse({
    requestId: "71000000-0000-4000-8000-000000000001",
    repository: f.root,
    expectedCatalogRevision: 1,
    expectedRecord: f.row,
    expectedHead: "a".repeat(40),
  });
  const request = transform
    ? cleanupRequestSchema.parse(transform(baseRequest))
    : baseRequest;
  const requestHash = createHash("sha256")
    .update(canonicalCleanupRequest(f.project.id, request))
    .digest("hex");
  const createdAt = new Date().toISOString();
  const audit = appendEvent(
    {
      kind: "operator.action",
      workspace: f.root,
      beadId: request.expectedRecord.beadId,
      payload: {
        action: "project.worktree.cleanup",
        surface: "ui",
        target: f.project.id,
        family: "project-worktree-cleanup",
        requestId: request.requestId,
        inputHash: requestHash,
      },
    },
    { path: join(f.home, "ledger.db"), now: () => new Date(createdAt) },
  );
  if (!audit.ok || !("id" in audit))
    throw Error("Expected stored fixture audit");
  const row = {
    original: {
      version: 1 as const,
      projectId: f.project.id,
      request,
      requestHash,
      createdAt,
      audit: { eventId: audit.id, ulid: audit.ulid, ts: createdAt },
    },
    phase: "reserved" as const,
    attemptedAt: null,
    endedAt: null,
    reason: null,
    outcome: null,
  };
  if (publish)
    await withWorktreeCleanupLease(f.home, async (scope) => {
      scope.write(row);
    });
  return row;
}

test("cleanup original reads preserve saved identity without current admission or execution", async () => {
  const f = await fixture(),
    saved = await savedCleanup(f);
  let trackerCalls = 0;
  const host = {
    home: f.home,
    root: f.root,
    queueLockFile: join(f.home, "queue-lock.db"),
    ledgerPath: join(f.home, "ledger.db"),
    runBd: () => {
      trackerCalls++;
      throw Error("Unexpected tracker call");
    },
  };
  const service = createProjectWorktreeCleanupService(host);
  const file = join(f.home, "project-worktree-cleanup", "operations.json");
  const bytes = readFileSync(file, "utf8");
  host.home = join(f.home, "changed");
  host.root = join(f.root, "changed");
  const read = () =>
    service.read(
      f.project.id,
      saved.original.request.requestId,
      saved.original.requestHash,
    );
  const receipt = read();
  expect(receipt).toMatchObject({
    ...saved.original.request,
    projectId: f.project.id,
    requestHash: saved.original.requestHash,
    state: "unknown",
    audit: saved.original.audit,
  });
  receipt.expectedRecord.branch = "changed";
  expect(read().expectedRecord).toEqual(saved.original.request.expectedRecord);
  expect(readFileSync(file, "utf8")).toBe(bytes);
  expect({ trackerCalls, git: f.calls }).toEqual({ trackerCalls: 0, git: [] });
});

async function readonlyExport(
  f: Awaited<ReturnType<typeof fixture>>,
  args: readonly string[],
) {
  expect(args).toContain("--readonly");
  const issues = f.readSources().issues;
  if (!issues) throw Error("Expected complete fixture issues");
  return {
    status: 0,
    stderr: "",
    stdout: issues
      .map((issue) =>
        JSON.stringify({
          _type: "issue",
          id: issue.id,
          title: issue.title,
          status: issue.status,
          issue_type: issue.type,
          labels: issue.labels,
          created_at: issue.createdAt,
          updated_at: issue.updatedAt,
          dependencies: issue.parent
            ? [
                {
                  type: "parent-child",
                  issue_id: issue.id,
                  depends_on_id: issue.parent,
                },
              ]
            : [],
        }),
      )
      .join("\n"),
  };
}

test("guarded cleanup confirms the exact audited original once through the real primitive", async () => {
  const f = await fixture(),
    saved = await savedCleanup(f, false);
  const body = structuredClone(saved.original.request);
  const context = { auditEventId: saved.original.audit.eventId };
  let exports = 0;
  const service = createProjectWorktreeCleanupService(
    {
      home: f.home,
      root: f.root,
      queueLockFile: join(f.home, "queue-lock.db"),
      ledgerPath: join(f.home, "ledger.db"),
      runBd: async (args) => {
        exports++;
        return readonlyExport(f, args);
      },
    },
    {
      git: (args, cwd, timeout) => {
        if (args.includes("status")) {
          body.expectedHead = "b".repeat(40);
          body.expectedRecord.branch = "feat/changed";
          context.auditEventId = 0;
        }
        return f.git(args, cwd, timeout);
      },
    },
  );
  const result = await service.cleanup(f.project.id, body, context);
  expect(result.state).toBe("confirmed");
  expect(result.expectedRecord).toEqual(saved.original.request.expectedRecord);
  expect(result.audit).toEqual(saved.original.audit);
  expect(readStrictWorktreeRegistry(f.root)).toEqual({ ok: true, value: [] });
  const removes = f.calls.filter(
    (args) => args[0] === "worktree" && args[1] === "remove",
  );
  expect(removes).toHaveLength(1);
  expect(removes[0]).not.toContain("--force");
  const before = { calls: f.calls.length, exports };
  expect(
    await service.cleanup(f.project.id, saved.original.request, {
      auditEventId: saved.original.audit.eventId,
    }),
  ).toEqual(result);
  expect({ calls: f.calls.length, exports }).toEqual(before);
});

test.each([
  "relative repository",
  "relative target",
  "outside target",
  "foreign repository",
] as const)("cleanup rejects %s before private initialization or source access", async (kind) => {
  const f = await fixture();
  const saved = await savedCleanup(f, false, (request) =>
    kind === "foreign repository"
      ? {
          ...request,
          repository: join(f.root, "foreign"),
          expectedRecord: {
            ...request.expectedRecord,
            path: join(f.root, "foreign", "trees", request.expectedRecord.id),
          },
        }
      : kind === "relative repository"
        ? { ...request, repository: relative(dirname(f.root), f.root) }
        : {
            ...request,
            expectedRecord: {
              ...request.expectedRecord,
              path:
                kind === "relative target"
                  ? relative(f.root, request.expectedRecord.path)
                  : join(f.root, "outside"),
            },
          },
  );
  if (kind === "relative repository" || kind === "relative target") {
    const path =
      kind === "relative repository"
        ? saved.original.request.repository
        : saved.original.request.expectedRecord.path;
    expect(path.length).toBeGreaterThan(0);
    expect(isAbsolute(path)).toBe(false);
  }
  let exports = 0;
  const service = createProjectWorktreeCleanupService(
    {
      home: f.home,
      root: f.root,
      queueLockFile: join(f.home, "queue-lock.db"),
      ledgerPath: join(f.home, "ledger.db"),
      runBd: (args) => {
        exports++;
        return readonlyExport(f, args);
      },
    },
    { git: f.git },
  );
  const error = await service
    .cleanup(f.project.id, saved.original.request, {
      auditEventId: saved.original.audit.eventId,
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect(error).toMatchObject({
    status: kind === "foreign repository" ? 409 : 400,
  });
  expect({
    git: f.calls,
    exports,
    initialized: existsSync(join(f.home, "project-worktree-cleanup")),
  }).toEqual({ git: [], exports: 0, initialized: false });
});

test.each([
  ["missing event", "missing", ""],
  ["later event cannot replace the requested ID", "later", ""],
  ["zero locator", "locator", "0"],
  ["fractional locator", "locator", "1.5"],
  ["overflow ULID", "ulid", "8" + "0".repeat(25)],
  ["invalid ULID", "ulid", "invalid"],
  ["invalid timestamp", "ts", "unknown"],
  ["wrong kind", "kind", "friction.recorded"],
  ["wrong workspace", "workspace", "/foreign"],
  ["wrong bead", "bead_id", "foreign-task"],
  ["related run", "run_id", "foreign-run"],
  ["related session", "session_id", "foreign-session"],
  ["related executor", "executor", "foreign-provider"],
  ["wrong action", "$.action", "project.archive"],
  ["wrong family", "$.family", "project-shift"],
  ["wrong UUID", "$.requestId", "72000000-0000-4000-8000-000000000001"],
  ["wrong digest", "$.inputHash", "b".repeat(64)],
  ["wrong project", "$.target", "project-72000000-0000-4000-8000-000000000001"],
  ["invalid surface", "$.surface", "untrusted"],
  ["unrelated change kind", "$.changeKind", "archive"],
  ["unrelated selector", "$.selector", "foreign"],
] as const)("cleanup rejects stored audit %s without publishing an original", async (_name, field, value) => {
  const f = await fixture(),
    saved = await savedCleanup(f, false);
  const id = saved.original.audit.eventId,
    db = openLedger(join(f.home, "ledger.db"));
  if (field === "later") await savedCleanup(f, false);
  if (field === "missing" || field === "later")
    db.query("DELETE FROM events WHERE id = ?").run(id);
  else if (field === "executor")
    db.query("UPDATE events SET provider = ?, model = ? WHERE id = ?").run(
      value,
      "foreign-model",
      id,
    );
  else if (field.startsWith("$."))
    db.query(
      "UPDATE events SET payload = json_set(payload, ?, ?) WHERE id = ?",
    ).run(field, value, id);
  else if (field !== "locator")
    db.query(`UPDATE events SET ${field} = ? WHERE id = ?`).run(value, id);
  const service = createProjectWorktreeCleanupService(
    {
      home: f.home,
      root: f.root,
      queueLockFile: join(f.home, "queue-lock.db"),
      ledgerPath: join(f.home, "ledger.db"),
      runBd: (args) => readonlyExport(f, args),
    },
    { git: f.git },
  );
  const error = await service
    .cleanup(f.project.id, saved.original.request, {
      auditEventId: field === "locator" ? Number(value) : id,
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect(error).not.toBeNull();
  expect(readWorktreeCleanupInventory(f.home)).toEqual([]);
  expect(
    f.calls.filter((args) => args[0] === "worktree" && args[1] === "remove"),
  ).toEqual([]);
  expect(readStrictWorktreeRegistry(f.root)).toEqual({
    ok: true,
    value: [f.row],
  });
});

function ownerFor(f: Awaited<ReturnType<typeof fixture>>) {
  return createProjectWorktreeCleanupService(
    {
      home: f.home,
      root: f.root,
      queueLockFile: join(f.home, "queue-lock.db"),
      ledgerPath: join(f.home, "ledger.db"),
      runBd: (args) => readonlyExport(f, args),
    },
    { git: f.git },
  );
}

test.each([
  "stale revision",
  "archived",
  "deleted",
  "missing membership",
] as const)("cleanup current admission rejects %s before source access", async (kind) => {
  const f = await fixture();
  let revision = 1;
  if (kind === "archived" || kind === "deleted") {
    await f.projects.preferences(f.project.id, 1, { archived: true });
    revision = 2;
  }
  if (kind === "deleted") {
    // Trusted fixture bypass models externally removed metadata, not legal deletion of an unknown owner.
    await f.projects.deleteProject(
      f.project.id,
      {
        requestId: "73000000-0000-4000-8000-000000000001",
        expectedRevision: 2,
        confirmName: f.project.name,
      },
      async () => {},
    );
    revision = 3;
  }
  if (kind === "missing membership") {
    const catalog = f.projects.read(),
      project = catalog.projects[0];
    if (!project) throw Error("Expected current project");
    project.workspaces = [
      {
        root: f.root,
        repositories: [join(f.root, "foreign")],
        epicIds: ["alpha-epic"],
      },
    ];
    writeOwnerOnly(projectCatalogPath(f.home), JSON.stringify(catalog));
    expect(f.projects.read().projects).toEqual(catalog.projects);
  }
  const saved = await savedCleanup(f, false, (request) => ({
    ...request,
    expectedCatalogRevision: kind === "stale revision" ? 0 : revision,
  }));
  await expect(
    ownerFor(f).cleanup(f.project.id, saved.original.request, {
      auditEventId: saved.original.audit.eventId,
    }),
  ).rejects.toMatchObject({
    status: kind === "deleted" ? 404 : 409,
  });
  expect({
    calls: f.calls,
    rows: readWorktreeCleanupInventory(f.home),
  }).toEqual({ calls: [], rows: [] });
});

test
  .skipIf(process.platform === "win32")
  .each(["workspace root", "repository"] as const)(
  "cleanup native membership rejects a literal-backslash %s alias",
  async (field) => {
    const f = await fixture("repo/nested"),
      literal = join(f.root, "..", "..", "repo\\nested");
    mkdirSync(literal);
    const catalog = f.projects.read(),
      project = catalog.projects[0],
      scope = project?.workspaces[0];
    if (!project || !scope) throw Error("Expected current workspace");
    if (field === "workspace root") scope.root = literal;
    else scope.repositories = [literal];
    writeOwnerOnly(projectCatalogPath(f.home), JSON.stringify(catalog));
    expect(f.projects.read().projects[0]?.workspaces).toEqual(
      project.workspaces,
    );
    const saved = await savedCleanup(f, false);
    await expect(
      ownerFor(f).cleanup(f.project.id, saved.original.request, {
        auditEventId: saved.original.audit.eventId,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect({
      calls: f.calls,
      rows: readWorktreeCleanupInventory(f.home),
    }).toEqual({ calls: [], rows: [] });
  },
);

test("cleanup recovery validates exact identity and survives archive and trusted metadata loss", async () => {
  const f = await fixture(),
    saved = await savedCleanup(f),
    owner = ownerFor(f);
  const read = () =>
    owner.read(
      f.project.id,
      saved.original.request.requestId,
      saved.original.requestHash,
    );
  for (const [project, uuid, hash, status] of [
    ["bad", saved.original.request.requestId, saved.original.requestHash, 400],
    [f.project.id, "bad", saved.original.requestHash, 400],
    [f.project.id, saved.original.request.requestId, "bad", 400],
    [
      f.project.id,
      "74000000-0000-4000-8000-000000000001",
      saved.original.requestHash,
      404,
    ],
    [
      "project-74000000-0000-4000-8000-000000000001",
      saved.original.request.requestId,
      saved.original.requestHash,
      409,
    ],
    [f.project.id, saved.original.request.requestId, "b".repeat(64), 409],
  ] as const) {
    try {
      owner.read(project, uuid, hash);
      throw Error("Expected identity refusal");
    } catch (error) {
      expect(error).toMatchObject({ status });
    }
  }
  const original = read();
  await f.projects.preferences(f.project.id, 1, { archived: true });
  expect(read()).toEqual(original);
  // Deliberate trusted-store bypass is only an external metadata-loss fixture.
  await f.projects.deleteProject(
    f.project.id,
    {
      requestId: "75000000-0000-4000-8000-000000000001",
      expectedRevision: 2,
      confirmName: f.project.name,
    },
    async () => {},
  );
  expect(read()).toEqual(original);
  expect(f.calls).toEqual([]);
});

test.each([
  false,
  true,
])("cleanup unresolved ownership blocks replacement UUID across projects=%s", async (other) => {
  const f = await fixture(),
    retained = await savedCleanup(f);
  let target = f.project,
    revision = 1;
  if (other) {
    const catalog = await f.projects.create(
      {
        slug: "beta",
        name: "Beta",
        description: "",
        icon: "B",
        workspaces: [
          { root: f.root, repositories: [f.root], epicIds: ["alpha-epic"] },
        ],
      },
      1,
    );
    const project = catalog.projects.find(
      (project) => project.id !== f.project.id,
    );
    if (!project) throw Error("Expected second project");
    target = project;
    revision = catalog.revision;
  }
  const replacement = await savedCleanup(
    { ...f, project: target },
    false,
    (request) => ({
      ...request,
      requestId: "76000000-0000-4000-8000-000000000001",
      expectedCatalogRevision: revision,
      expectedHead: "b".repeat(40),
      expectedRecord: { ...request.expectedRecord, branch: "feat/replacement" },
    }),
  );
  await expect(
    ownerFor(f).cleanup(target.id, replacement.original.request, {
      auditEventId: replacement.original.audit.eventId,
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect(readWorktreeCleanupInventory(f.home)).toEqual([retained]);
  expect(f.calls).toEqual([]);
});

test.each([
  "reserved write failure",
  "reserved readback loss",
  "attempt write failure",
  "attempt readback loss",
  "terminal write failure",
  "terminal save then throw",
  "normal false",
  "runner throws",
  "cache publication lost",
] as const)("cleanup preserves durable evidence after %s", async (kind) => {
  const f = await fixture(),
    saved = await savedCleanup(f, false);
  const journal = join(f.home, "project-worktree-cleanup", "operations.json");
  const failAt = kind.startsWith("reserved")
    ? 1
    : kind.startsWith("attempt")
      ? 2
      : kind.startsWith("terminal")
        ? 3
        : 0;
  let writes = 0,
    removes = 0,
    faultReached = false;
  let reserved:
    | ReturnType<typeof readWorktreeCleanupInventory>[number]
    | undefined;
  let attempted: ReturnType<typeof readWorktreeCleanupInventory> = [];
  let nativeArgs: readonly string[] = [],
    instrumentationError: unknown = null;
  const owner = createProjectWorktreeCleanupService(
    {
      home: f.home,
      root: f.root,
      queueLockFile: join(f.home, "queue-lock.db"),
      ledgerPath: join(f.home, "ledger.db"),
      runBd: (args) => readonlyExport(f, args),
    },
    {
      persistJournal: (file, content) => {
        writes++;
        if (writes === failAt && kind.endsWith("write failure")) {
          faultReached = true;
          throw Error("Injected before-save failure");
        }
        writeOwnerOnly(file, content);
        if (writes === 1) {
          try {
            reserved = readWorktreeCleanupInventory(f.home)[0];
          } catch (error) {
            instrumentationError = error;
          }
        }
        if (writes === failAt && kind.endsWith("readback loss")) {
          unlinkSync(file);
          faultReached = true;
        }
        if (writes === failAt && kind === "terminal save then throw") {
          faultReached = true;
          throw Error("Injected after-save failure");
        }
      },
      git: (args, cwd, timeout) => {
        if (args[0] === "worktree" && args[1] === "remove") {
          removes++;
          nativeArgs = [...args];
          try {
            attempted = readWorktreeCleanupInventory(f.home);
          } catch (error) {
            instrumentationError = error;
          }
          if (kind === "runner throws") {
            faultReached = true;
            throw Error("Injected native uncertainty");
          }
          if (kind === "normal false") {
            faultReached = true;
            return { status: 1, stdout: "", stderr: "Injected refusal" };
          }
          if (kind === "cache publication lost") {
            unlinkSync(f.registry);
            mkdirSync(f.registry);
            faultReached = true;
          }
        }
        return f.git(args, cwd, timeout);
      },
    },
  );
  const attempt = () =>
    owner
      .cleanup(f.project.id, saved.original.request, {
        auditEventId: saved.original.audit.eventId,
      })
      .then(
        (receipt) => ({ receipt, error: null }),
        (error: unknown) => ({ receipt: null, error }),
      );
  const first = await attempt();
  expect(instrumentationError).toBeNull();
  expect(faultReached).toBe(true);
  expect(writes).toBeGreaterThanOrEqual(failAt || 2);
  if (removes > 0) {
    expect(reserved).toBeDefined();
    expect(reserved?.original).toMatchObject({
      projectId: f.project.id,
      request: saved.original.request,
      requestHash: saved.original.requestHash,
      audit: saved.original.audit,
    });
    expect(attempted).toHaveLength(1);
    expect(attempted[0]?.original).toEqual(reserved?.original);
    expect(attempted[0]).toMatchObject({
      phase: "attempted",
      attemptedAt: expect.any(String),
    });
    expect(nativeArgs).not.toContain("--force");
  }
  const unavailable =
    kind === "reserved write failure" || kind.endsWith("readback loss");
  if (unavailable) expect(first.error).toMatchObject({ status: 503 });
  else
    expect(first.receipt?.state).toBe(
      kind === "terminal save then throw" ? "confirmed" : "unknown",
    );
  expect(removes).toBe(
    kind.startsWith("reserved") || kind.startsWith("attempt") ? 0 : 1,
  );
  const before = { removes, calls: f.calls.length };
  // No original was written and no native effect was possible in this distinct prepublication case.
  if (kind === "reserved write failure") {
    expect(readWorktreeCleanupInventory(f.home)).toEqual([]);
    return;
  }
  expect(await attempt()).toEqual(first);
  expect({ removes, calls: f.calls.length }).toEqual(before);
  if (kind !== "terminal save then throw") {
    const replacement = await savedCleanup(f, false, (request) => ({
      ...request,
      requestId: "77000000-0000-4000-8000-000000000001",
    }));
    await expect(
      owner.cleanup(f.project.id, replacement.original.request, {
        auditEventId: replacement.original.audit.eventId,
      }),
    ).rejects.toMatchObject({
      status: kind.endsWith("readback loss") ? 503 : 409,
    });
    expect({ removes, calls: f.calls.length }).toEqual(before);
  }
});

test("cleanup fences actual queue reservation and waiting project producers across a paused source read", async () => {
  const f = await fixture(),
    saved = await savedCleanup(f, false);
  let release = () => {},
    signal = () => {},
    sourceEntered = false;
  const pause = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const watchdog = setTimeout(() => {
    signal();
    release();
  }, 2000);
  const ledgerPath = join(f.home, "ledger.db"),
    lockFile = join(f.home, "queue-lock.db");
  const tracker = queueTracker([{ id: "contender-task", status: "open" }]);
  const queue = createQueue({
    workspace: f.root,
    lockFile,
    lockWaitMs: 40,
    runBd: tracker.run,
    appendEvent: (event) => appendEvent(event, { path: ledgerPath }),
  });
  const reservationDeps = {
    workspace: f.root,
    ledgerPath,
    lockFile,
    lockWaitMs: 40,
  };
  const owner = createProjectWorktreeCleanupService(
    {
      home: f.home,
      root: f.root,
      queueLockFile: lockFile,
      ledgerPath,
      runBd: async (args) => {
        sourceEntered = true;
        signal();
        await pause;
        return readonlyExport(f, args);
      },
    },
    { git: f.git },
  );
  const cleanup = owner
    .cleanup(f.project.id, saved.original.request, {
      auditEventId: saved.original.audit.eventId,
    })
    .then(
      (receipt) => ({ receipt, error: null }),
      (error: unknown) => ({ receipt: null, error }),
    );
  let settled = 0;
  const changes: Promise<{ revision: number; error: unknown }>[] = [];
  try {
    await entered;
    expect(sourceEntered).toBe(true);
    for (let index = 0; index < 2; index++)
      changes.push(
        f.projects.preferences(f.project.id, 1, { pinned: true }).then(
          (catalog) => {
            settled++;
            return { revision: catalog.revision, error: null };
          },
          (error: unknown) => {
            settled++;
            return { revision: 0, error };
          },
        ),
      );
    const [queued, reserved] = await Promise.all([
      queue.move("contender-task", "propose", "operator"),
      reserve(
        {
          beadId: saved.original.request.expectedRecord.beadId,
          worktree: f.row.path,
          globs: ["src/**"],
        },
        reservationDeps,
      ),
    ]);
    expect(queued).toMatchObject({ ok: false, kind: "busy" });
    expect(reserved).toMatchObject({ ok: false, kind: "busy" });
    expect({
      tracker: tracker.calls,
      settled,
      revision: f.projects.read().revision,
    }).toEqual({ tracker: [], settled: 0, revision: 1 });
    expect(readWorktreeCleanupInventory(f.home)).toEqual([]);
  } finally {
    release();
    await Promise.all([cleanup, ...changes]);
    clearTimeout(watchdog);
  }
  const result = await cleanup,
    writes = await Promise.all(changes);
  expect(result.receipt?.state).toBe("confirmed");
  expect(writes.filter((result) => result.revision === 2)).toHaveLength(1);
  expect(writes.filter((result) => result.error !== null)).toMatchObject([
    { error: { status: 409 } },
  ]);
  expect(f.projects.read().revision).toBe(2);
  expect(
    await queue.move("contender-task", "propose", "operator"),
  ).toMatchObject({ ok: true });
  expect(tracker.updates()).toHaveLength(1);
  expect(
    await reserve(
      {
        beadId: saved.original.request.expectedRecord.beadId,
        worktree: f.row.path,
        globs: ["src/**"],
      },
      reservationDeps,
    ),
  ).toMatchObject({ ok: true });
  await f.projects.preferences(f.project.id, 2, { archived: true });
  const next = await savedCleanup(f, false, (request) => ({
    ...request,
    requestId: "78000000-0000-4000-8000-000000000001",
    expectedCatalogRevision: 3,
  }));
  const calls = f.calls.length;
  await expect(
    owner.cleanup(f.project.id, next.original.request, {
      auditEventId: next.original.audit.eventId,
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect(f.calls).toHaveLength(calls);
});

test("cleanup freshly refuses an actual reservation published before admission", async () => {
  const f = await fixture(),
    saved = await savedCleanup(f, false);
  expect(
    await reserve(
      {
        beadId: saved.original.request.expectedRecord.beadId,
        worktree: f.row.path,
        globs: ["src/**"],
      },
      {
        workspace: f.root,
        ledgerPath: join(f.home, "ledger.db"),
        lockFile: join(f.home, "queue-lock.db"),
      },
    ),
  ).toMatchObject({ ok: true });
  const receipt = await ownerFor(f).cleanup(
    f.project.id,
    saved.original.request,
    { auditEventId: saved.original.audit.eventId },
  );
  expect(receipt).toMatchObject({ state: "refused", attemptedAt: null });
  expect(
    f.calls.filter((args) => args[0] === "worktree" && args[1] === "remove"),
  ).toEqual([]);
  expect(readStrictWorktreeRegistry(f.root)).toEqual({
    ok: true,
    value: [f.row],
  });
});

test.each([
  "busy",
  "drift",
] as const)("cleanup retains the reviewed target when registry authority is %s", async (kind) => {
  const f = await fixture(),
    saved = await savedCleanup(f, false);
  let held: Database | undefined,
    published = 0;
  const sourceLockObservations: boolean[] = [];
  if (kind === "busy") {
    held = new Database(join(f.root, ".git", "agent-forge-worktrees.lock.db"), {
      create: true,
    });
    held.exec("BEGIN EXCLUSIVE");
  }
  try {
    const owner = createProjectWorktreeCleanupService(
      {
        home: f.home,
        root: f.root,
        queueLockFile: join(f.home, "queue-lock.db"),
        ledgerPath: join(f.home, "ledger.db"),
        runBd: async (args) => {
          sourceLockObservations.push(
            withWorktreeRegistryLock(f.root, () => ({ ok: true, value: true }))
              .ok,
          );
          return readonlyExport(f, args);
        },
      },
      {
        git: f.git,
        persistJournal: (file, content) => {
          writeOwnerOnly(file, content);
          if (++published === 1 && kind === "drift")
            writeFileSync(
              f.registry,
              JSON.stringify({
                worktrees: [{ ...f.row, branch: "feat/foreign" }],
              }),
            );
        },
      },
    );
    const receipt = await owner.cleanup(f.project.id, saved.original.request, {
      auditEventId: saved.original.audit.eventId,
    });
    expect(receipt).toMatchObject({
      state: "refused",
      attemptedAt: null,
      audit: saved.original.audit,
    });
    expect(sourceLockObservations).toEqual([kind !== "busy"]);
    expect(published).toBe(2);
    expect(readWorktreeCleanupInventory(f.home)).toMatchObject([
      {
        phase: "refused",
        attemptedAt: null,
        original: {
          request: saved.original.request,
          audit: saved.original.audit,
        },
      },
    ]);
    expect(
      f.calls.filter((args) => args[0] === "worktree" && args[1] === "remove"),
    ).toEqual([]);
    expect(readStrictWorktreeRegistry(f.root)).toEqual({
      ok: true,
      value: [kind === "drift" ? { ...f.row, branch: "feat/foreign" } : f.row],
    });
  } finally {
    held?.close();
  }
});

test("cleanup source timeout leaves late readonly completion inert", async () => {
  const f = await fixture(),
    saved = await savedCleanup(f, false);
  let release = () => {},
    complete = () => {},
    sourceEntered = false,
    fallbackReleased = false;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const completed = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const watchdog = setTimeout(() => {
    fallbackReleased = true;
    release();
  }, 8000);
  let lateArgs: readonly string[] = [],
    lateError: unknown = null;
  let lateResult: Awaited<ReturnType<typeof readonlyExport>> | undefined;
  const owner = createProjectWorktreeCleanupService(
    {
      home: f.home,
      root: f.root,
      queueLockFile: join(f.home, "queue-lock.db"),
      ledgerPath: join(f.home, "ledger.db"),
      runBd: async (args) => {
        sourceEntered = true;
        lateArgs = [...args];
        await pending;
        try {
          lateResult = await readonlyExport(f, args);
          return lateResult;
        } catch (error) {
          lateError = error;
          throw error;
        } finally {
          complete();
        }
      },
    },
    { git: f.git },
  );
  const start = performance.now();
  let before: { journal: string; cache: string; calls: number } | undefined;
  try {
    const receipt = await owner.cleanup(f.project.id, saved.original.request, {
      auditEventId: saved.original.audit.eventId,
    });
    expect({ sourceEntered, fallbackReleased }).toEqual({
      sourceEntered: true,
      fallbackReleased: false,
    });
    expect(performance.now() - start).toBeGreaterThanOrEqual(4900);
    expect(receipt).toMatchObject({ state: "refused", attemptedAt: null });
    before = {
      journal: readFileSync(
        join(f.home, "project-worktree-cleanup", "operations.json"),
        "utf8",
      ),
      cache: readFileSync(f.registry, "utf8"),
      calls: f.calls.length,
    };
    expect(
      f.calls.filter((args) => args[0] === "worktree" && args[1] === "remove"),
    ).toEqual([]);
    expect(
      await owner.cleanup(f.project.id, saved.original.request, {
        auditEventId: saved.original.audit.eventId,
      }),
    ).toEqual(receipt);
  } finally {
    release();
    if (sourceEntered) await completed;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    clearTimeout(watchdog);
  }
  expect(lateError).toBeNull();
  expect(lateArgs).toContain("--readonly");
  expect(lateResult).toMatchObject({ status: 0, stderr: "" });
  expect({
    journal: readFileSync(
      join(f.home, "project-worktree-cleanup", "operations.json"),
      "utf8",
    ),
    cache: readFileSync(f.registry, "utf8"),
    calls: f.calls.length,
  }).toEqual(before);
}, 15000);

test.each([
  "relative home",
  "relative root",
  "missing home",
  "missing root",
  "wrong queue",
  "wrong ledger",
] as const)("cleanup rejects trusted host %s without initialization or callbacks", async (kind) => {
  const f = await fixture();
  let calls = 0;
  const host = {
    home: f.home,
    root: f.root,
    queueLockFile: join(f.home, "queue-lock.db"),
    ledgerPath: join(f.home, "ledger.db"),
    runBd: (args: readonly string[]) => {
      calls++;
      return readonlyExport(f, args);
    },
  };
  if (kind === "relative home") host.home = "relative-home";
  if (kind === "relative root") host.root = "relative-root";
  if (kind === "missing home") host.home = join(f.home, "missing");
  if (kind === "missing root") host.root = join(f.root, "missing");
  if (kind === "wrong queue")
    host.queueLockFile = join(f.home, "foreign-queue.db");
  if (kind === "wrong ledger")
    host.ledgerPath = join(f.home, "foreign-ledger.db");
  try {
    createProjectWorktreeCleanupService(host, { git: f.git });
    throw Error("Expected trusted host refusal");
  } catch (error) {
    expect(error).toMatchObject({ status: 503 });
  }
  expect({
    calls,
    git: f.calls,
    initialized: existsSync(join(f.home, "project-worktree-cleanup")),
  }).toEqual({ calls: 0, git: [], initialized: false });
});

test.each([
  "unknown",
  "confirmed",
] as const)("actual lifecycle deletion guard preserves cleanup %s ownership and recovery", async (phase) => {
  const f = await fixture(),
    saved = await savedCleanup(f, phase === "unknown"),
    owner = ownerFor(f);
  if (phase === "unknown")
    await withWorktreeCleanupLease(f.home, async (scope) => {
      scope.write({
        ...saved,
        phase: "unknown",
        reason: "Cleanup completion was not confirmed",
      });
    });
  else
    await owner.cleanup(f.project.id, saved.original.request, {
      auditEventId: saved.original.audit.eventId,
    });
  const read = () =>
    owner.read(
      f.project.id,
      saved.original.request.requestId,
      saved.original.requestHash,
    );
  const original = read(),
    journal = join(f.home, "project-worktree-cleanup", "operations.json");
  expect(original.state).toBe(phase);
  const bytes = readFileSync(journal, "utf8"),
    calls = f.calls.length;
  await f.projects.preferences(f.project.id, 1, { archived: true });
  const routes = projectRoutes(f.home, {
    root: f.root,
    workspace: f.root,
    loadScope: async () => {
      throw Error("Unexpected live scope read");
    },
  });
  // Invoke the existing production deletion guard directly; no transport or authorization is simulated.
  const result = await routes.deleteProject.effect({
    id: f.project.id,
    request: {
      requestId: "79000000-0000-4000-8000-000000000001",
      expectedRevision: 2,
      confirmName: f.project.name,
    },
  });
  expect(result).toMatchObject({ status: phase === "unknown" ? 409 : 200 });
  if (phase === "unknown")
    expect(result).toMatchObject({
      error: expect.stringContaining("cleanup outcome is unknown"),
    });
  expect(f.projects.read().projects).toHaveLength(phase === "unknown" ? 1 : 0);
  expect(read()).toEqual(original);
  expect(readFileSync(journal, "utf8")).toBe(bytes);
  expect(f.calls).toHaveLength(calls);
});
