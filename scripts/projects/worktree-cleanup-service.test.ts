import { afterEach, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorktreeRecord } from "../../types/beads";
import { writeOwnerOnly } from "../hearth/token";
import { closeLedger, openLedger } from "../ledger/db";
import { runOptions } from "../scheduler/shift-cli-runtime";
import type { GitRun } from "../scheduler/worktrees";
import {
  createProjectShiftRegistry,
  projectShiftFlags,
} from "../shifts/registry";
import { scratchDirs } from "../test-scratch";
import { workspaceKey } from "./scope";
import { createProjectStore } from "./store";
import type { ProjectSources } from "./summary";
import { readWorktreeCleanupPreflight } from "./worktree-cleanup-preflight";
import { cleanupReceiptSchema } from "./worktree-cleanup-protocol";

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
