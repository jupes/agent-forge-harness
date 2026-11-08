import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import type { WorktreeRecord } from "../../types/beads";
import { writeOwnerOnly } from "../hearth/token";
import { appendEvent } from "../ledger/append";
import { closeLedger, openLedger } from "../ledger/db";
import { runOptions } from "../scheduler/shift-cli-runtime";
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
import { createProjectStore } from "./store";
import type { ProjectSources } from "./summary";
import { readWorktreeCleanupPreflight } from "./worktree-cleanup-preflight";
import {
  type CleanupRequest,
  canonicalCleanupRequest,
  cleanupReceiptSchema,
  cleanupRequestSchema,
} from "./worktree-cleanup-protocol";
import { createProjectWorktreeCleanupService } from "./worktree-cleanup-service";
import { withWorktreeCleanupLease } from "./worktree-cleanup-store";

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

async function fixture() {
  const base = realpathSync.native(scratch.make("cleanup-service-")),
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
        ? { ...request, repository: relative(process.cwd(), f.root) }
        : {
            ...request,
            expectedRecord: {
              ...request.expectedRecord,
              path:
                kind === "relative target"
                  ? relative(process.cwd(), request.expectedRecord.path)
                  : join(f.root, "outside"),
            },
          },
  );
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
