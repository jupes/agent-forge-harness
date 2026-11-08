import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorktreeRecord } from "../../../types/beads";
import { openLedger } from "../../ledger/db";
import { projectCatalogPath } from "../../projects/store";
import {
  FIXTURE_PROJECT_ID,
  projectCatalogFixture,
} from "../../projects/testing";
import { readWorktreeCleanupPreflight } from "../../projects/worktree-cleanup-preflight";
import {
  canonicalCleanupRequest,
  cleanupReceiptSchema,
  cleanupRequestSchema,
} from "../../projects/worktree-cleanup-protocol";
import { readWorktreeCleanupInventory } from "../../projects/worktree-cleanup-store";
import { runOptions } from "../../scheduler/shift-cli-runtime";
import { SHIFTS_DIR, writeShiftRecord } from "../../scheduler/shift-store";
import {
  type GitRun,
  readStrictWorktreeRegistry,
} from "../../scheduler/worktrees";
import {
  createProjectShiftRegistry,
  projectShiftFlags,
} from "../../shifts/registry";
import { startTestHearth, type TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";
import { validateOperatorEnvelope } from "../validate";
import { FIXTURE_SHIFT_START, seedProjectShift } from "./project-shift-fixture";
import { projectSnapshotReader } from "./project-summaries";
import { createProjectWorktreeCleanupRoutes } from "./project-worktree-cleanup";

const projectId = "project-a1000000-0000-4000-8000-000000000001";
const review = {
  requestId: "a1000000-0000-4000-8000-000000000002",
  repository: "/repo",
  expectedCatalogRevision: 1,
  expectedRecord: {
    id: "shift-test-1",
    path: "/repo/trees/shift-test-1",
    branch: "feat/test",
    createdAt: "2026-11-07T00:00:00.000Z",
    beadId: "alpha-task",
  },
  expectedHead: "a".repeat(40),
};
test("cleanup route subject freezes the exact review before audit callbacks", () => {
  const routes = createProjectWorktreeCleanupRoutes({
    home: "/private",
    root: "/repo",
    queueLockFile: "/private/queue-lock.db",
    ledgerPath: "/private/ledger.db",
    runBd: async () => {
      throw Error("Unexpected source access");
    },
  });
  const body = structuredClone(review);
  const parsed = routes.cleanup.validate({
    params: { id: projectId },
    query: new URLSearchParams(),
    headers: {},
    body,
  });
  if (!parsed.ok) throw Error("Expected a complete reviewed request");
  body.expectedRecord.branch = "feat/substituted";
  expect(Object.isFrozen(parsed.value.request)).toBe(true);
  expect(Object.isFrozen(parsed.value.request.expectedRecord)).toBe(true);
  expect(routes.cleanup.subject(parsed.value)).toEqual({
    target: projectId,
    beadId: review.expectedRecord.beadId,
    family: "project-worktree-cleanup",
    requestId: review.requestId,
    inputHash: createHash("sha256")
      .update(canonicalCleanupRequest(projectId, review))
      .digest("hex"),
  });
});

test("cleanup HTTP fixture proves eligible stopped Shift ownership through the actual snapshot reader", async () => {
  const f = await eligibleCleanupFixture();
  const result = await readWorktreeCleanupPreflight(
    {
      home: f.h.home,
      root: f.h.root,
      projectId: FIXTURE_PROJECT_ID,
      worktreeId: f.row.id,
    },
    { git: f.git, readSources: async () => (await f.load()).source },
  );
  expect(f.errors).toEqual([]);
  expect(result).toMatchObject({
    state: "eligible",
    removalAuthorized: false,
    record: f.row,
    head: "a".repeat(40),
    catalogRevision: 1,
  });
  expect(f.exports).toEqual([["export", "--readonly", "--no-memories"]]);
  expect(f.calls.some((args) => args.includes("remove"))).toBe(false);
});

const opened: TestHearth[] = [];
afterEach(async () => {
  for (const h of opened.splice(0)) await h.close();
});
async function eligibleCleanupFixture() {
  const calls: string[][] = [],
    errors: string[] = [],
    exports: string[][] = [];
  const removals: {
    args: string[];
    rows: ReturnType<typeof readWorktreeCleanupInventory>;
  }[] = [];
  let row: WorktreeRecord | undefined,
    root = "";
  const git: GitRun = (args, cwd) => {
    calls.push([...args]);
    if (!row || !root) {
      errors.push("Git read before fixture initialization");
      return { status: 1, stdout: "", stderr: "Fixture not initialized" };
    }
    if (args[0] === "worktree" && args[1] === "remove") {
      let rows: ReturnType<typeof readWorktreeCleanupInventory> = [];
      try {
        rows = readWorktreeCleanupInventory(h.home);
      } catch {
        errors.push("Could not observe durable attempt at native dispatch");
      }
      removals.push({ args: [...args], rows });
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args.includes("config")) return { status: 1, stdout: "", stderr: "" };
    if (args.includes("ls-files") || args.includes("status"))
      return { status: 0, stdout: "", stderr: "" };
    if (args.includes("list"))
      return {
        status: 0,
        stderr: "",
        stdout: `worktree ${root}\0HEAD ${"a".repeat(40)}\0branch refs/heads/master\0\0worktree ${row.path}\0HEAD ${"a".repeat(40)}\0branch refs/heads/${row.branch}\0\0`,
      };
    if (args.includes("--show-toplevel"))
      return { status: 0, stdout: cwd, stderr: "" };
    if (args.includes("--git-common-dir"))
      return { status: 0, stdout: join(root, ".git"), stderr: "" };
    if (args.includes("--verify"))
      return { status: 0, stdout: "a".repeat(40), stderr: "" };
    errors.push("Unexpected Git fixture operation");
    return { status: 1, stdout: "", stderr: "Unexpected fixture operation" };
  };
  const h = await startTestHearth({ api: { git } });
  opened.push(h);
  root = h.root;
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(root)),
  );
  await seedProjectShift(h);
  const intent = createProjectShiftRegistry({ home: h.home, root }).read(
    FIXTURE_PROJECT_ID,
    FIXTURE_SHIFT_START.requestId,
  );
  const bounds = runOptions(projectShiftFlags(intent.request));
  if (!bounds.ok) throw Error("Invalid immutable Shift options");
  const { concurrency, forMs, maxBeads, maxUsd, repairs, base } = bounds.value;
  if (
    concurrency === undefined ||
    forMs === undefined ||
    maxBeads === undefined ||
    maxUsd === undefined ||
    repairs === undefined ||
    base === undefined
  )
    throw Error("Expected complete immutable Shift bounds");
  const beadId = "alpha-task";
  const target: WorktreeRecord = {
    id: `${intent.shiftId}-1`,
    path: join(root, "trees", `${intent.shiftId}-1`),
    branch: "feat/api-cleanup",
    createdAt: intent.createdAt,
    beadId,
  };
  row = target;
  mkdirSync(target.path, { recursive: true });
  writeFileSync(
    join(root, "trees", ".state.json"),
    JSON.stringify({ worktrees: [target] }),
  );
  writeShiftRecord(join(h.home, SHIFTS_DIR), {
    shiftId: intent.shiftId,
    workspace: intent.workspace,
    pid: 1,
    state: "stopped",
    startedAt: intent.createdAt,
    deadline: new Date(Date.parse(intent.createdAt) + forMs).toISOString(),
    endedAt: new Date(Date.parse(intent.createdAt) + 1000).toISOString(),
    options: { concurrency, forMs, maxBeads, maxUsd, repairs, base },
    spentUsd: 0,
    unpriced: 0,
    beads: [
      {
        beadId,
        worktree: target.path,
        branch: target.branch,
        outcome: "review",
        attempts: 1,
        runId: "fixture-cleanup",
      },
    ],
  });
  openLedger(h.ledger);
  h.bd.answer = (args) => {
    exports.push([...args]);
    if (args[0] !== "export") {
      errors.push("Unexpected tracker fixture operation");
      return { status: 1, stdout: "", stderr: "Unexpected fixture operation" };
    }
    return {
      status: 0,
      stderr: "",
      stdout: (
        [
          ["alpha-epic", "epic", "open"],
          [beadId, "task", "closed"],
        ] as const
      )
        .map(([id, type, status]) =>
          JSON.stringify({
            _type: "issue",
            id,
            issue_type: type,
            title: id,
            status,
            labels: ["project:alpha"],
            created_at: intent.createdAt,
            updated_at: intent.createdAt,
            dependencies:
              id === beadId
                ? [
                    {
                      type: "parent-child",
                      issue_id: id,
                      depends_on_id: "alpha-epic",
                    },
                  ]
                : [],
          }),
        )
        .join("\n"),
    };
  };
  const load = projectSnapshotReader(
    h.home,
    {
      root,
      workspace: h.workspace,
      ledgerPath: h.ledger,
      runBd: h.bd.run,
    },
    { membershipOnly: true, includeEmpty: true, omitRuns: true },
  );
  return { h, row: target, git, calls, errors, exports, load, removals };
}

test("cleanup HTTP confirms one exact audited original and replays only saved receipts", async () => {
  const f = await eligibleCleanupFixture(),
    request = fixtureReview(f);
  const hash = createHash("sha256")
    .update(canonicalCleanupRequest(FIXTURE_PROJECT_ID, request))
    .digest("hex");
  const receipt = await cleanupReceipt(await postCleanup(f.h, request));
  expect(f.errors).toEqual([]);
  expect(f.removals).toHaveLength(1);
  const removal = f.removals[0],
    attempted = removal?.rows[0];
  if (!removal || !attempted)
    throw Error("Expected the durable attempted original at native dispatch");
  expect(removal.args).toEqual(["worktree", "remove", "--", f.row.path]);
  expect(attempted).toMatchObject({
    phase: "attempted",
    original: {
      projectId: FIXTURE_PROJECT_ID,
      request,
      requestHash: hash,
    },
  });
  const event = f.h
    .events(["operator.action"])
    .find((event) => event.id === attempted.original.audit.eventId);
  if (!event) throw Error("Expected the actual stored audit");
  expect(event).toMatchObject({
    kind: "operator.action",
    beadId: request.expectedRecord.beadId,
    payload: {
      action: "project.worktree.cleanup",
      surface: "api",
      target: FIXTURE_PROJECT_ID,
      family: "project-worktree-cleanup",
      requestId: request.requestId,
      inputHash: hash,
    },
  });
  expect(attempted.original.audit).toEqual({
    eventId: event.id,
    ulid: event.ulid,
    ts: event.ts,
  });
  expect(receipt).toMatchObject({
    ...request,
    projectId: FIXTURE_PROJECT_ID,
    requestHash: hash,
    state: "confirmed",
    attemptedAt: attempted.attemptedAt,
    audit: attempted.original.audit,
  });
  expect(readStrictWorktreeRegistry(f.h.root)).toEqual({ ok: true, value: [] });
  expect(existsSync(f.row.path)).toBe(true); // The fake reports completion; it does not delete user paths.
  const before = {
    git: f.calls.length,
    exports: f.exports.length,
    removals: f.removals.length,
  };
  const audits = f.h.events(["operator.action"]).length;
  expect(await cleanupReceipt(await postCleanup(f.h, request))).toEqual(
    receipt,
  );
  const response = await fetch(
    `${f.h.api}/projects/${FIXTURE_PROJECT_ID}/settings/worktree-cleanup/${request.requestId}?requestHash=${hash}`,
    {
      headers: f.h.headers(f.h.hearth.token),
      signal: AbortSignal.timeout(5000),
    },
  );
  expect(await cleanupReceipt(response)).toEqual(receipt);
  expect({
    git: f.calls.length,
    exports: f.exports.length,
    removals: f.removals.length,
  }).toEqual(before);
  expect(f.h.events(["operator.action"])).toHaveLength(audits + 1);
});

test("cleanup HTTP actual audit append failure prevents owner entry", async () => {
  const f = await eligibleCleanupFixture(),
    request = fixtureReview(f);
  const lock = new Database(f.h.ledger);
  try {
    lock.exec("PRAGMA busy_timeout = 0");
    lock.exec("BEGIN IMMEDIATE");
    const response = await postCleanup(f.h, request);
    expect(response.status).toBe(503);
    expect(await apiEnvelope(response)).toMatchObject({
      ok: false,
      data: null,
      error: expect.any(String),
    });
    expect({
      sources: f.exports,
      native: f.removals,
      git: f.calls,
      initialized: existsSync(join(f.h.home, "project-worktree-cleanup")),
    }).toEqual({ sources: [], native: [], git: [], initialized: false });
  } finally {
    lock.close();
  }
});

function fixtureReview(f: Awaited<ReturnType<typeof eligibleCleanupFixture>>) {
  return cleanupRequestSchema.parse({
    ...review,
    repository: f.h.root,
    expectedRecord: f.row,
  });
}
function postCleanup(h: TestHearth, body: unknown) {
  return fetch(
    `${h.api}/projects/${FIXTURE_PROJECT_ID}/settings/worktree-cleanup`,
    {
      method: "POST",
      headers: h.headers(h.hearth.token),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    },
  );
}
async function apiEnvelope(response: Response) {
  const body: unknown = await response.json();
  const checked = validateOperatorEnvelope(body);
  if (!checked.ok) throw Error("Expected a strict operator envelope");
  return checked.value;
}
async function cleanupReceipt(response: Response) {
  expect(response.status).toBe(200);
  const body = await apiEnvelope(response);
  if (!body.ok) throw Error("Expected a verified cleanup receipt");
  return cleanupReceiptSchema.parse(body.data);
}
