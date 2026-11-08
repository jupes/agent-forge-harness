import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { WorktreeRecord } from "../../../types/beads";
import { appendEvent } from "../../ledger/append";
import { openLedger } from "../../ledger/db";
import { createProjectStore, projectCatalogPath } from "../../projects/store";
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
import {
  startTestHearth,
  type TestHearth,
  type TestHearthOptions,
} from "../testing";
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
async function eligibleCleanupFixture(
  api: TestHearthOptions["api"] = {},
  native: "complete" | "throw" = "complete",
) {
  const nativeFaults: string[] = [];
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
      if (native === "throw") {
        nativeFaults.push("throw");
        throw Error("Injected native uncertainty after durable attempt");
      }
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
  const h = await startTestHearth({ api: { ...api, git } });
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
  return {
    h,
    row: target,
    git,
    calls,
    errors,
    exports,
    load,
    removals,
    nativeFaults,
  };
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

test.each([
  "unrecorded",
  "mismatched",
] as const)("cleanup HTTP rejects a reported %s audit locator despite a real matching row", async (kind) => {
  let ledgerPath = "",
    canonicalId: number | undefined,
    reportedId: number | undefined;
  const callbackErrors: string[] = [];
  const f = await eligibleCleanupFixture({
    appendEvent: (event) => {
      if (!ledgerPath) {
        callbackErrors.push(
          "Appender called before private fixture initialization",
        );
        return { ok: false, error: "Fixture not initialized" };
      }
      let wrongId: number | undefined;
      if (kind === "mismatched") {
        const wrong = appendEvent(
          { ...event, beadId: "unrelated-task" },
          { path: ledgerPath },
        );
        if (!wrong.ok || !("id" in wrong)) {
          callbackErrors.push("Could not write the mismatched row");
          return wrong;
        }
        wrongId = wrong.id;
      }
      const actual = appendEvent(event, { path: ledgerPath });
      if (!actual.ok || !("id" in actual)) {
        callbackErrors.push("Could not write the actual matching row");
        return actual;
      }
      canonicalId = actual.id;
      reportedId = kind === "unrecorded" ? actual.id + 1000 : wrongId;
      if (reportedId === undefined) {
        callbackErrors.push("Expected a reported row identity");
        return { ok: false, error: "No fixture row identity" };
      }
      return { ...actual, id: reportedId };
    },
  });
  ledgerPath = f.h.ledger;
  const request = fixtureReview(f);
  const response = await postCleanup(f.h, request);
  expect(callbackErrors).toEqual([]);
  expect(f.errors).toEqual([]);
  expect(response.status).toBe(409);
  expect(await apiEnvelope(response)).toMatchObject({
    ok: false,
    data: null,
    error: expect.any(String),
  });
  if (canonicalId === undefined || reportedId === undefined)
    throw Error("Expected reached audit identities");
  const events = f.h.events(["operator.action"]);
  expect(events.find((event) => event.id === canonicalId)).toMatchObject({
    kind: "operator.action",
    beadId: request.expectedRecord.beadId,
    payload: {
      action: "project.worktree.cleanup",
      requestId: request.requestId,
      inputHash: createHash("sha256")
        .update(canonicalCleanupRequest(FIXTURE_PROJECT_ID, request))
        .digest("hex"),
    },
  });
  const reported = events.find((event) => event.id === reportedId);
  if (kind === "unrecorded") expect(reported).toBeUndefined();
  else expect(reported).toMatchObject({ beadId: "unrelated-task" });
  expect(f.exports).toHaveLength(1);
  expect(readWorktreeCleanupInventory(f.h.home)).toEqual([]);
  expect(f.removals).toEqual([]);
});

test("cleanup HTTP rejects strict body query and protection violations before auditing", async () => {
  const f = await eligibleCleanupFixture(),
    request = fixtureReview(f);
  const path = "/projects/" + FIXTURE_PROJECT_ID + "/settings/worktree-cleanup";
  const send = (
    suffix: string,
    body: string,
    headers = f.h.headers(f.h.hearth.token),
  ) =>
    fetch(f.h.api + path + suffix, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(5000),
    });
  const refused = async (response: Response, status = 400) => {
    expect(response.status).toBe(status);
    expect(await apiEnvelope(response)).toMatchObject({
      ok: false,
      data: null,
      error: expect.any(String),
    });
  };
  for (const body of [
    { ...request, force: true },
    { ...request, context: { auditEventId: 1 } },
    { ...request, controls: { git: "request-selected" } },
    { ...request, home: f.h.home },
    { ...request, expectedHead: 17 },
  ])
    await refused(await send("", JSON.stringify(body)));
  const raw = JSON.stringify(request);
  const duplicate = raw.replace(
    '"requestId":',
    '"request\\u0049d":' + JSON.stringify(request.requestId) + ',"requestId":',
  );
  expect(duplicate).toContain("\\u0049");
  await refused(await send("", duplicate));
  const oversized = await send("", " ".repeat(16384) + raw);
  expect(oversized.status).toBe(400);
  expect(await apiEnvelope(oversized)).toMatchObject({
    ok: false,
    data: null,
    error: "Request body exceeds 16384 bytes",
  });
  await refused(await send("?unexpected=1", raw));
  const hash = "a".repeat(64),
    original = "/" + request.requestId;
  for (const suffix of [
    original,
    original + "?requestHash=" + hash + "&requestHash=" + hash,
    original + "?requestHash=" + hash + "&unexpected=1",
    original + "?requestHash=" + "A".repeat(64),
    "/bad?requestHash=" + hash,
  ])
    await refused(
      await fetch(f.h.api + path + suffix, {
        headers: f.h.headers(f.h.hearth.token),
        signal: AbortSignal.timeout(5000),
      }),
    );
  for (const method of ["GET", "POST"])
    await refused(
      await fetch(
        f.h.api +
          path.replace(FIXTURE_PROJECT_ID, "bad") +
          (method === "GET" ? original + "?requestHash=" + hash : ""),
        {
          method,
          headers: f.h.headers(f.h.hearth.token),
          ...(method === "POST" ? { body: raw } : {}),
          signal: AbortSignal.timeout(5000),
        },
      ),
    );
  await refused(
    await fetch(f.h.api + path + original + "?requestHash=" + hash, {
      headers: f.h.headers(),
      signal: AbortSignal.timeout(5000),
    }),
    403,
  );
  await refused(
    await send("", raw, {
      ...f.h.headers(f.h.hearth.token),
      Origin: "http://127.0.0.1:1",
    }),
    403,
  );
  expect(f.h.events(["operator.action"])).toEqual([]);
  expect({
    source: f.exports,
    native: f.removals,
    git: f.calls,
    initialized: existsSync(join(f.h.home, "project-worktree-cleanup")),
  }).toEqual({ source: [], native: [], git: [], initialized: false });
});

test("cleanup missing internal context and foreign native review cannot enter the owner", async () => {
  const f = await eligibleCleanupFixture(),
    request = fixtureReview(f);
  const rows = createProjectWorktreeCleanupRoutes(
    {
      home: f.h.home,
      root: f.h.root,
      queueLockFile: join(f.h.home, "queue-lock.db"),
      ledgerPath: f.h.ledger,
      runBd: f.h.bd.run,
    },
    { git: f.git },
  );
  const parsed = rows.cleanup.validate({
    params: { id: FIXTURE_PROJECT_ID },
    query: new URLSearchParams(),
    headers: {},
    body: request,
  });
  if (!parsed.ok) throw Error("Expected a complete valid review");
  expect(await rows.cleanup.effect(parsed.value)).toMatchObject({
    status: 503,
  });
  expect(f.h.events(["operator.action"])).toEqual([]);
  const repository = join(f.h.root, "foreign");
  const response = await postCleanup(f.h, {
    ...request,
    repository,
    expectedRecord: {
      ...request.expectedRecord,
      path: join(repository, "trees", request.expectedRecord.id),
    },
  });
  expect(response.status).toBe(409);
  expect(await apiEnvelope(response)).toMatchObject({ ok: false, data: null });
  expect(f.h.events(["operator.action"])).toHaveLength(1);
  expect({
    source: f.exports,
    native: f.removals,
    git: f.calls,
    initialized: existsSync(join(f.h.home, "project-worktree-cleanup")),
  }).toEqual({ source: [], native: [], git: [], initialized: false });
});

test("unknown cleanup HTTP recovery retains exact evidence and captured host authority", async () => {
  const f = await eligibleCleanupFixture({}, "throw"),
    request = fixtureReview(f);
  const receipt = await cleanupReceipt(await postCleanup(f.h, request));
  const attempted = f.removals[0]?.rows[0];
  if (!attempted)
    throw Error("Expected attempted evidence before native uncertainty");
  expect(f.nativeFaults).toEqual(["throw"]);
  expect(f.errors).toEqual([]);
  expect(receipt).toMatchObject({
    ...request,
    projectId: FIXTURE_PROJECT_ID,
    state: "unknown",
    audit: attempted.original.audit,
    attemptedAt: attempted.attemptedAt,
    requestHash: attempted.original.requestHash,
  });
  const identity = {
    projectId: FIXTURE_PROJECT_ID,
    requestId: request.requestId,
    requestHash: receipt.requestHash,
  };
  const get = (hash = receipt.requestHash, project = FIXTURE_PROJECT_ID) =>
    fetch(
      f.h.api +
        "/projects/" +
        project +
        "/settings/worktree-cleanup/" +
        request.requestId +
        "?requestHash=" +
        hash,
      {
        headers: f.h.headers(f.h.hearth.token),
        signal: AbortSignal.timeout(5000),
      },
    );
  const trace = () => ({
    git: f.calls.length,
    source: f.exports.length,
    native: f.removals.length,
  });
  const before = trace();
  expect(await cleanupReceipt(await postCleanup(f.h, request))).toEqual(
    receipt,
  );
  expect(await cleanupReceipt(await get())).toEqual(receipt);
  const replacement = await postCleanup(f.h, {
    ...request,
    requestId: "a1000000-0000-4000-8000-000000000003",
  });
  expect(replacement.status).toBe(409);
  expect(await apiEnvelope(replacement)).toMatchObject({
    ok: false,
    data: null,
  });
  const audits = f.h.events(["operator.action"]).length;
  for (const response of [
    await get("b".repeat(64)),
    await get(receipt.requestHash, projectId),
  ]) {
    expect(response.status).toBe(409);
    expect(await apiEnvelope(response)).toMatchObject({
      ok: false,
      data: null,
    });
  }
  const originalHost = {
    home: f.h.home,
    root: f.h.root,
    queueLockFile: join(f.h.home, "queue-lock.db"),
    ledgerPath: f.h.ledger,
    runBd: f.h.bd.run,
  };
  const host = { ...originalHost },
    controls = { git: f.git };
  const captured = createProjectWorktreeCleanupRoutes(host, controls);
  host.home = host.root = host.queueLockFile = host.ledgerPath = "/changed";
  host.runBd = () => {
    throw Error("Unexpected mutated source");
  };
  controls.git = () => {
    throw Error("Unexpected mutated Git");
  };
  const saved = await captured.receipt.read(identity);
  expect(saved.status).toBe(200);
  if (!("data" in saved))
    throw Error("Expected a saved cleanup receipt response");
  expect(cleanupReceiptSchema.parse(saved.data)).toEqual(receipt);
  const other = await startTestHearth();
  opened.push(other);
  expect(
    await createProjectWorktreeCleanupRoutes(
      { ...originalHost, root: other.root },
      { git: f.git },
    ).receipt.read(identity),
  ).toMatchObject({ status: 409 });
  const journal = join(f.h.home, "project-worktree-cleanup", "operations.json");
  const bytes = readFileSync(journal, "utf8"),
    projects = createProjectStore(f.h.home);
  await projects.preferences(FIXTURE_PROJECT_ID, 1, { archived: true });
  expect(await cleanupReceipt(await get())).toEqual(receipt);
  // Trusted external metadata-loss fixture tests history recovery, not legal project deletion.
  const catalog = projects.read();
  catalog.projects = [];
  writeOwnerOnly(projectCatalogPath(f.h.home), JSON.stringify(catalog));
  expect(await cleanupReceipt(await get())).toEqual(receipt);
  expect(readFileSync(journal, "utf8")).toBe(bytes);
  for (const lost of [true, false]) {
    if (lost) unlinkSync(journal);
    else writeOwnerOnly(journal, "{broken");
    const response = await get();
    expect(response.status).toBe(503);
    expect(await apiEnvelope(response)).toMatchObject({
      ok: false,
      data: null,
    });
    if (lost) expect(existsSync(journal)).toBe(false);
    else expect(readFileSync(journal, "utf8")).toBe("{broken");
  }
  expect(trace()).toEqual(before);
  expect(f.h.events(["operator.action"])).toHaveLength(audits);
});

test("unsupported linked cleanup authority is isolated from ordinary Hearth reads", async () => {
  const h = await startTestHearth({ linkedWorktree: true });
  opened.push(h);
  const response = await fetch(
    h.api +
      "/projects/" +
      FIXTURE_PROJECT_ID +
      "/settings/worktree-cleanup/" +
      review.requestId +
      "?requestHash=" +
      "a".repeat(64),
    { headers: h.headers(h.hearth.token), signal: AbortSignal.timeout(5000) },
  );
  expect(response.status).toBe(503);
  expect(await apiEnvelope(response)).toMatchObject({ ok: false, data: null });
  const normal = await fetch(h.api + "/config", {
    headers: h.headers(h.hearth.token),
    signal: AbortSignal.timeout(5000),
  });
  expect(normal.status).toBe(200);
  expect(await apiEnvelope(normal)).toMatchObject({ ok: true, error: null });
  expect(h.bd.calls).toEqual([]);
  expect(h.shifts.launches).toEqual([]);
  expect(existsSync(join(h.home, "project-worktree-cleanup"))).toBe(false);
});
