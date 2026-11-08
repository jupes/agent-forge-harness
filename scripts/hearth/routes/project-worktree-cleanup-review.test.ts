import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { WorktreeRecord } from "../../../types/beads";
import { openLedger } from "../../ledger/db";
import { workspaceKey } from "../../projects/scope";
import { createProjectStore, projectCatalogPath } from "../../projects/store";
import {
  FIXTURE_PROJECT_ID,
  projectCatalogFixture,
} from "../../projects/testing";
import { cleanupRequestSchema } from "../../projects/worktree-cleanup-protocol";
import { cleanupReviewSchema } from "../../projects/worktree-cleanup-review-protocol";
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
import {
  createProjectWorktreeCleanupReviewReader,
  createProjectWorktreeCleanupReviewRoute,
} from "./project-worktree-cleanup-review";

test("cleanup advisory reader refuses absent current membership without source or history", async () => {
  const h = await startTestHearth();
  let gitCalls = 0;
  try {
    const read = createProjectWorktreeCleanupReviewReader(
      {
        home: h.home,
        root: h.root,
        ledgerPath: h.ledger,
        runBd: h.bd.run,
      },
      {
        git: () => {
          gitCalls++;
          return { status: 1, stdout: "", stderr: "Unexpected Git read" };
        },
      },
    );
    expect(await read(FIXTURE_PROJECT_ID, "shift-review-1")).toMatchObject({
      projectId: FIXTURE_PROJECT_ID,
      worktreeId: "shift-review-1",
      state: "refused",
      removalAuthorized: false,
    });
    expect({
      gitCalls,
      source: h.bd.calls,
      ledger: existsSync(h.ledger),
      history: existsSync(join(h.home, "project-worktree-cleanup")),
    }).toEqual({ gitCalls: 0, source: [], ledger: false, history: false });
  } finally {
    await h.close();
  }
});

test("cleanup review route validates copied selectors and contains unavailable authority", async () => {
  const callbacks: string[] = [];
  const row = createProjectWorktreeCleanupReviewRoute(
    {
      home: "relative-home",
      root: "relative-root",
      ledgerPath: "relative-ledger",
      runBd: async () => {
        callbacks.push("source");
        return { status: 1, stdout: "", stderr: "" };
      },
    },
    {
      git: () => {
        callbacks.push("Git");
        return { status: 1, stdout: "", stderr: "" };
      },
    },
  );
  const input = {
    params: { id: FIXTURE_PROJECT_ID, worktreeId: "shift-review-1" },
    query: new URLSearchParams(),
    headers: {},
    body: undefined,
  };
  expect(row).toMatchObject({
    kind: "read",
    method: "GET",
    operatorOnly: true,
    path: "/projects/:id/settings/worktree-cleanup-review/:worktreeId",
  });
  for (const invalid of [
    { ...input, params: { ...input.params, id: "bad" } },
    { ...input, params: { ...input.params, worktreeId: "../foreign" } },
    { ...input, query: new URLSearchParams("unexpected=1&unexpected=2") },
  ])
    expect(row.validate(invalid).ok).toBe(false);
  const parsed = row.validate(input);
  if (!parsed.ok) throw Error("Expected valid copied selectors");
  input.params.worktreeId = "changed";
  expect(parsed.value).toEqual({
    projectId: FIXTURE_PROJECT_ID,
    worktreeId: "shift-review-1",
  });
  expect(await row.read(parsed.value)).toMatchObject({
    status: 503,
    error: expect.any(String),
  });
  expect(callbacks).toEqual([]);
});

test("protected cleanup review returns exact eligible proof then freshly refuses active source", async () => {
  const f = await reviewFixture();
  const get = async () => {
    const response = await fetch(
      f.h.api +
        "/projects/" +
        FIXTURE_PROJECT_ID +
        "/settings/worktree-cleanup-review/" +
        f.row.id,
      {
        headers: f.h.headers(f.h.hearth.token),
        signal: AbortSignal.timeout(5000),
      },
    );
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    const checked = validateOperatorEnvelope(body);
    if (!checked.ok || !checked.value.ok)
      throw Error("Expected a strict advisory response");
    return cleanupReviewSchema.parse(checked.value.data);
  };
  const started = Date.now(),
    proof = await get();
  const expected = cleanupRequestSchema.omit({ requestId: true }).parse({
    repository: f.h.root,
    expectedCatalogRevision: 1,
    expectedRecord: f.row,
    expectedHead: "a".repeat(40),
  });
  expect(proof).toMatchObject({
    ...expected,
    projectId: FIXTURE_PROJECT_ID,
    worktreeId: f.row.id,
    state: "eligible",
    reasons: [],
    removalAuthorized: false,
  });
  expect(Date.parse(proof.asOf)).toBeGreaterThanOrEqual(started);
  expect(Date.parse(proof.asOf)).toBeLessThanOrEqual(Date.now());
  f.activate();
  const fresh = await get();
  expect(fresh).toMatchObject({ state: "refused", removalAuthorized: false });
  expect("expectedRecord" in fresh).toBe(false);
  expect(f.errors).toEqual([]);
  expect(f.exports).toEqual([
    ["export", "--readonly", "--no-memories"],
    ["export", "--readonly", "--no-memories"],
  ]);
  expect(
    f.calls.some((args) =>
      ["remove", "add", "prune", "branch", "stash"].some((command) =>
        args.includes(command),
      ),
    ),
  ).toBe(false);
  expect(readStrictWorktreeRegistry(f.h.root)).toEqual({
    ok: true,
    value: [f.row],
  });
  expect(f.h.events(["operator.action"])).toEqual([]);
  expect(existsSync(join(f.h.home, "project-worktree-cleanup"))).toBe(false);
});

const opened: TestHearth[] = [];
afterEach(async () => {
  for (const h of opened.splice(0)) await h.close();
});
async function reviewFixture(nested = false) {
  const calls: string[][] = [],
    exports: string[][] = [],
    errors: string[] = [];
  let row: WorktreeRecord | undefined,
    root = "",
    active = false,
    dirty = false,
    dirtyReadCount = 0;
  const git: GitRun = (args, cwd) => {
    calls.push([...args]);
    if (!row || !root) {
      errors.push("Git before fixture initialization");
      return { status: 1, stdout: "", stderr: "Fixture not initialized" };
    }
    if (dirty && args.includes("status")) {
      dirtyReadCount++;
      return { status: 0, stdout: " M tracked\0", stderr: "" };
    }
    if (args.includes("config")) return { status: 1, stdout: "", stderr: "" };
    if (args.includes("status") || args.includes("ls-files"))
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
  let tracker: TestHearth["bd"]["run"] | undefined;
  let beforeExport: (() => Promise<void>) | undefined;
  const runBd: TestHearth["bd"]["run"] = async (args, options) => {
    const dispatch = tracker;
    if (!dispatch) {
      errors.push("Tracker before fixture initialization");
      return { status: 1, stdout: "", stderr: "Fixture not initialized" };
    }
    try {
      if (args[0] === "export") await beforeExport?.();
      return await dispatch(args, options);
    } catch (error) {
      errors.push("Tracker fixture callback failed");
      throw error;
    }
  };
  const h = await startTestHearth({ api: { git, runBd } });
  tracker = h.bd.run;
  opened.push(h);
  root = nested ? join(h.root, "plain", "nested") : h.root;
  if (nested) mkdirSync(join(root, ".git"), { recursive: true });
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(root)),
  );
  const selected: TestHearth = { ...h, root, workspace: root };
  await seedProjectShift(selected);
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
    branch: "feat/review",
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
        runId: "review-fixture",
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
          [beadId, "task", active ? "in_progress" : "closed"],
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
  return {
    h,
    root,
    git,
    row: target,
    runBd,
    makeDirty: () => {
      dirty = true;
    },
    dirtyReads: () => dirtyReadCount,
    pauseExport: (hook: () => Promise<void>) => {
      beforeExport = hook;
    },
    calls,
    exports,
    errors,
    activate: () => {
      active = true;
    },
  };
}

test
  .skipIf(process.platform === "win32")
  .each(["workspace", "repository"] as const)(
  "native review reader component rejects a physical literal sibling in current %s membership",
  async (field) => {
    const f = await reviewFixture(true),
      literal = join(f.h.root, "plain\\nested");
    mkdirSync(join(literal, ".git"), { recursive: true });
    expect(workspaceKey(literal)).toBe(workspaceKey(f.root));
    const normal = lstatSync(f.root, { bigint: true }),
      alias = lstatSync(literal, { bigint: true });
    expect([normal.dev, normal.ino]).not.toEqual([alias.dev, alias.ino]);
    const read = createProjectWorktreeCleanupReviewReader(
      {
        home: f.h.home,
        root: f.root,
        ledgerPath: f.h.ledger,
        runBd: f.h.bd.run,
      },
      { git: f.git },
    );
    expect(await read(FIXTURE_PROJECT_ID, f.row.id)).toMatchObject({
      state: "eligible",
      removalAuthorized: false,
    });
    const before = { git: f.calls.length, source: f.exports.length };
    const store = createProjectStore(f.h.home),
      catalog = store.read();
    const project = catalog.projects.find(
        (row) => row.id === FIXTURE_PROJECT_ID,
      ),
      scope = project?.workspaces[0];
    if (!project || !scope) throw Error("Expected a coherent current project");
    if (field === "workspace") scope.root = literal;
    else scope.repositories = [literal];
    writeOwnerOnly(projectCatalogPath(f.h.home), JSON.stringify(catalog));
    expect(store.read().projects).toEqual(catalog.projects);
    const proof = await read(FIXTURE_PROJECT_ID, f.row.id);
    expect(proof).toMatchObject({ state: "refused", removalAuthorized: false });
    expect("expectedRecord" in proof).toBe(false);
    expect({ git: f.calls.length, source: f.exports.length }).toEqual(before);
    expect(f.errors).toEqual([]);
    expect(f.h.events(["operator.action"])).toEqual([]);
    expect(existsSync(join(f.h.home, "project-worktree-cleanup"))).toBe(false);
  },
);

test("review HTTP own-Origin token and selector failures never reach observations", async () => {
  const f = await reviewFixture();
  const base =
    "/projects/" + FIXTURE_PROJECT_ID + "/settings/worktree-cleanup-review/";
  for (const [path, token, status] of [
    [base + f.row.id, undefined, 403],
    [base + f.row.id, "wrong-token", 403],
    [base + f.row.id + "?unexpected=1", f.h.hearth.token, 400],
    [base.replace(FIXTURE_PROJECT_ID, "bad") + f.row.id, f.h.hearth.token, 400],
    [base + "bad$id", f.h.hearth.token, 400],
  ] as const) {
    const response = await fetch(f.h.api + path, {
      headers: f.h.headers(token),
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(status);
    const checked = validateOperatorEnvelope(await response.json());
    if (!checked.ok) throw Error("Expected a strict refusal envelope");
    expect(checked.value).toMatchObject({ ok: false, data: null });
  }
  expect({ git: f.calls, source: f.exports, errors: f.errors }).toEqual({
    git: [],
    source: [],
    errors: [],
  });
  expect(f.h.events(["operator.action"])).toEqual([]);
  expect(existsSync(join(f.h.home, "project-worktree-cleanup"))).toBe(false);
});

test("unsupported linked review authority leaves ordinary HTTP reads available", async () => {
  const h = await startTestHearth({ linkedWorktree: true });
  opened.push(h);
  const headers = h.headers(h.hearth.token);
  const response = await fetch(
    h.api +
      "/projects/" +
      FIXTURE_PROJECT_ID +
      "/settings/worktree-cleanup-review/shift-review-1",
    { headers, signal: AbortSignal.timeout(5000) },
  );
  expect(response.status).toBe(503);
  const checked = validateOperatorEnvelope(await response.json());
  if (!checked.ok) throw Error("Expected a strict unavailable envelope");
  expect(checked.value).toMatchObject({ ok: false, data: null });
  const normal = await fetch(h.api + "/config", {
    headers,
    signal: AbortSignal.timeout(5000),
  });
  expect(normal.status).toBe(200);
  const available = validateOperatorEnvelope(await normal.json());
  if (!available.ok) throw Error("Expected the unrelated read envelope");
  expect(available.value).toMatchObject({ ok: true, error: null });
  expect(h.bd.calls).toEqual([]);
  expect(h.events(["operator.action"])).toEqual([]);
  expect(existsSync(join(h.home, "project-worktree-cleanup"))).toBe(false);
});

function assertPrivateChild(parent: string, path: string) {
  const child = relative(parent, resolve(path));
  if (
    !isAbsolute(parent) ||
    !isAbsolute(path) ||
    child === "" ||
    child === ".." ||
    isAbsolute(child) ||
    child.startsWith(".." + sep)
  )
    throw Error("Expected an owned private child path");
}
async function httpReview(h: TestHearth, worktreeId: string) {
  const response = await fetch(
    h.api +
      "/projects/" +
      FIXTURE_PROJECT_ID +
      "/settings/worktree-cleanup-review/" +
      worktreeId,
    {
      headers: h.headers(h.hearth.token),
      signal: AbortSignal.timeout(5000),
    },
  );
  expect(response.status).toBe(200);
  const checked = validateOperatorEnvelope(await response.json());
  if (!checked.ok || !checked.value.ok)
    throw Error("Expected a strict advisory response");
  return cleanupReviewSchema.parse(checked.value.data);
}
test.each([
  "catalog HTTP",
  "native component",
] as const)("paused actual export detects %s drift without publishing reusable proof", async (mode) => {
  const native = mode === "native component",
    f = await reviewFixture(native);
  const read = createProjectWorktreeCleanupReviewReader(
    {
      home: f.h.home,
      root: f.root,
      ledgerPath: f.h.ledger,
      runBd: f.runBd,
    },
    { git: f.git },
  );
  const observe = () =>
    native ? read(FIXTURE_PROJECT_ID, f.row.id) : httpReview(f.h, f.row.id);
  expect(await observe()).toMatchObject({ state: "eligible" });
  let release = () => {},
    signal = () => {},
    reached = false,
    fallback = false,
    moved = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    signal = resolve;
  });
  f.pauseExport(async () => {
    reached = true;
    signal();
    await gate;
  });
  const backup = f.root + "-before-review",
    original = lstatSync(f.root, { bigint: true });
  const watchdog = setTimeout(() => {
    fallback = true;
    signal();
    release();
  }, 3000);
  const work = observe().then(
    (proof) => ({ proof, error: null }),
    (error: unknown) => ({ proof: null, error }),
  );
  let changed = false;
  try {
    await entered;
    expect(reached).toBe(true);
    if (native) {
      assertPrivateChild(f.h.root, f.root);
      assertPrivateChild(f.h.root, backup);
      if (existsSync(backup)) throw Error("Unexpected fixture backup");
      renameSync(f.root, backup);
      moved = true;
      mkdirSync(join(f.root, ".git"), { recursive: true });
      const fresh = lstatSync(f.root, { bigint: true });
      changed = fresh.dev !== original.dev || fresh.ino !== original.ino;
    } else {
      const catalog = await createProjectStore(f.h.home).preferences(
        FIXTURE_PROJECT_ID,
        1,
        { pinned: true },
      );
      expect(catalog.revision).toBe(2);
    }
  } finally {
    release();
    await work;
    clearTimeout(watchdog);
    if (moved) {
      assertPrivateChild(f.h.root, f.root);
      assertPrivateChild(f.h.root, backup);
      assertPrivateChild(f.h.root, join(f.root, ".git"));
      if (existsSync(join(f.root, ".git"))) rmdirSync(join(f.root, ".git"));
      if (existsSync(f.root)) rmdirSync(f.root);
      renameSync(backup, f.root);
    }
  }
  const settled = await work;
  expect({ reached, fallback, error: settled.error }).toEqual({
    reached: true,
    fallback: false,
    error: null,
  });
  expect(settled.proof).toMatchObject({
    state: "unknown",
    removalAuthorized: false,
    reasons: ["Cleanup review observations changed while reading."],
  });
  expect(settled.proof && "expectedRecord" in settled.proof).toBe(false);
  if (native) {
    expect(changed).toBe(true);
    const restored = lstatSync(f.root, { bigint: true });
    expect([restored.dev, restored.ino]).toEqual([original.dev, original.ino]);
  }
  expect(f.errors).toEqual([]);
  expect(readStrictWorktreeRegistry(f.root)).toEqual({
    ok: true,
    value: [f.row],
  });
  expect(f.h.events(["operator.action"])).toEqual([]);
  expect(existsSync(join(f.h.home, "project-worktree-cleanup"))).toBe(false);
}, 15000);

test.each([
  "dirty Git",
  "malformed export",
] as const)("review HTTP withholds proof after actual %s observation", async (mode) => {
  const f = await reviewFixture();
  expect(await httpReview(f.h, f.row.id)).toMatchObject({ state: "eligible" });
  let reached = false,
    delegated = "";
  if (mode === "dirty Git") f.makeDirty();
  else {
    const answer = f.h.bd.answer;
    if (!answer) throw Error("Expected actual export fixture");
    f.h.bd.answer = async (args) => {
      const result = await answer(args);
      reached = true;
      delegated = result?.stdout ?? "";
      return { status: 0, stdout: "not JSON", stderr: "" };
    };
  }
  const proof = await httpReview(f.h, f.row.id);
  expect(proof).toMatchObject({
    state: mode === "dirty Git" ? "refused" : "unknown",
    removalAuthorized: false,
  });
  expect("expectedRecord" in proof).toBe(false);
  if (mode === "dirty Git") expect(f.dirtyReads()).toBeGreaterThan(0);
  else {
    expect(reached).toBe(true);
    expect(delegated).toContain("alpha-task");
  }
  expect(f.errors).toEqual([]);
  expect(
    f.calls.some((args) =>
      ["remove", "add", "prune", "branch", "stash"].some((command) =>
        args.includes(command),
      ),
    ),
  ).toBe(false);
  expect(readStrictWorktreeRegistry(f.root)).toEqual({
    ok: true,
    value: [f.row],
  });
  expect(f.h.events(["operator.action"])).toEqual([]);
  expect(existsSync(join(f.h.home, "project-worktree-cleanup"))).toBe(false);
});
