import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendEvent } from "../../ledger/append";
import {
  projectRunDetailSchema,
  projectRunsPageSchema,
} from "../../projects/run-protocol";
import { createProjectStore, projectCatalogPath } from "../../projects/store";
import { startTestHearth, type TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";

const opened: TestHearth[] = [];
const releases: Array<() => void> = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const hearth of opened.splice(0)) await hearth.close();
});

test("current project membership is checked after a delayed tracker read before private run metadata is returned", async () => {
  const { h, project, path } = await fixture();
  const original = h.bd.answer;
  let entered: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  h.bd.answer = (args) =>
    args[0] === "export"
      ? (async () => {
          entered();
          await gate;
          const result = await original?.(args);
          if (!result) throw Error("Missing planted export");
          return result;
        })()
      : original?.(args);
  const pending = fetch(`${path}/alpha-run`, {
    headers: h.headers(h.hearth.token),
  });
  await started;
  const changed = createProjectStore(h.home).read();
  const current = changed.projects.find((row) => row.id === project.id);
  if (!current?.workspaces[0]) throw Error("Missing planted scope");
  current.workspaces[0].epicIds = ["foreign-epic"];
  writeOwnerOnly(projectCatalogPath(h.home), JSON.stringify(changed));
  release();
  const response = await pending;
  expect(response.status).toBe(503);
  const envelope = await response.json();
  expect(envelope.ok).toBe(false);
  expect(envelope.data).toBeNull();
  expect(JSON.stringify(envelope)).not.toContain("Build Alpha");
});

async function fixture(linkedWorktree = false) {
  const h = await startTestHearth({ linkedWorktree });
  opened.push(h);
  const catalog = await createProjectStore(h.home).create(
    {
      slug: "alpha",
      name: "Alpha",
      description: "",
      icon: "A",
      workspaces: [
        { root: h.workspace, repositories: [h.root], epicIds: ["alpha-epic"] },
      ],
    },
    0,
  );
  const project = catalog.projects[0];
  if (!project) throw Error("Missing planted project");
  h.bd.answer = (args) =>
    args[0] === "export"
      ? {
          status: 0,
          stdout: JSON.stringify({
            id: "alpha-epic",
            title: "Alpha",
            status: "open",
            issue_type: "epic",
            labels: ["project:alpha"],
          }),
          stderr: "",
        }
      : undefined;
  const directory = join(h.root, ".tmp", "work", "forge-runs");
  mkdirSync(directory, { recursive: true });
  const state = {
    schemaVersion: 2,
    slug: "alpha-run",
    feature: "Build Alpha",
    epic: "alpha-epic",
    phase: "plan",
    completed: ["research", "plan"],
    artifacts: {},
    mode: "gated",
    checkout: h.root,
    updatedAt: "2026-10-23T12:00:00.000Z",
  };
  writeFileSync(join(directory, "alpha-run.json"), JSON.stringify(state));
  return {
    h,
    state,
    directory,
    project,
    path: `${h.api}/projects/${project.id}/runs`,
  };
}

test("a linked worktree's shared ledger workspace cannot authorize a run recorded for the main checkout", async () => {
  const { h, path, state, directory } = await fixture(true);
  expect(h.workspace).not.toBe(h.root);
  const get = () =>
    fetch(`${path}/alpha-run`, { headers: h.headers(h.hearth.token) });
  expect((await get()).status).toBe(200);
  writeFileSync(
    join(directory, "alpha-run.json"),
    JSON.stringify({ ...state, checkout: h.workspace }),
  );
  expect((await get()).status).toBe(404);
});

test("protected project Runs reads the served checkout without migrating legacy state or dispatching a write", async () => {
  const { h, path, state } = await fixture();
  const legacy = join(h.root, ".tmp", "work", "forge-state.json");
  const legacyBytes = JSON.stringify({ ...state, slug: "legacy-run" });
  writeFileSync(legacy, legacyBytes);
  const response = await fetch(path, { headers: h.headers(h.hearth.token) });
  expect(response.status).toBe(200);
  const page = await response.json();
  expect(page.ok).toBe(true);
  expect(projectRunsPageSchema.safeParse(page.data).success).toBe(true);
  expect(page.data).toMatchObject({
    version: 1,
    workspace: h.workspace,
    coverage: "served-checkout-only",
    runs: [{ slug: "alpha-run", mode: "gated" }],
  });
  const detail = await fetch(`${path}/alpha-run`, {
    headers: h.headers(h.hearth.token),
  });
  expect(detail.status).toBe(200);
  const checked = projectRunDetailSchema.parse((await detail.json()).data);
  expect(checked.run.phases).toEqual([
    expect.objectContaining({ id: "research", state: "complete" }),
    expect.objectContaining({ id: "plan", state: "complete" }),
    expect.objectContaining({ id: "implement", state: "active" }),
    expect.objectContaining({ id: "ship", state: "locked" }),
  ]);
  expect((await fetch(path, { headers: h.headers(null) })).status).toBe(403);
  expect(readFileSync(legacy, "utf8")).toBe(legacyBytes);
  expect(existsSync(join(h.root, ".tmp/work/forge-runs/legacy-run.json"))).toBe(
    false,
  );
  expect(h.events(["operator.action"])).toEqual([]);
  expect(h.bd.calls.every((args) => args[0] === "export")).toBe(true);
});

test("protected run detail returns the exact recorded session.started association", async () => {
  const { h, path } = await fixture();
  const startedAt = "2026-10-23T12:30:00.000Z";
  const eventId = h.append({
    kind: "session.started",
    beadId: "alpha-epic",
    runId: "alpha-run",
    sessionId: "recorded-run-session",
    ts: startedAt,
    payload: {
      source: "headless:claude",
      kind: "headless",
      worktree: h.root,
    },
  });

  const response = await fetch(`${path}/alpha-run`, {
    headers: h.headers(h.hearth.token),
  });

  expect(response.status).toBe(200);
  const envelope = await response.json();
  expect(envelope.ok).toBe(true);
  expect(envelope.data.sessionHistory).toEqual({
    status: "available",
    after: 0,
    nextAfter: eventId,
    more: false,
    membershipKey: expect.stringMatching(/^[0-9a-f]{64}$/),
    sessions: [
      {
        sessionId: "recorded-run-session",
        startedAt,
        kind: "headless",
        detailsAvailable: true,
      },
    ],
  });
});

test("run session pages preserve the raw cursor while excluding foreign and unrelated rows", async () => {
  const { h, path } = await fixture();
  const exactId = h.append({
    kind: "session.started",
    beadId: "alpha-epic",
    runId: "alpha-run",
    sessionId: "alpha-recorded-session",
    ts: "2026-10-23T12:31:00.000Z",
    payload: { kind: "headless" },
  });
  const foreignId = h.append({
    kind: "session.started",
    beadId: "foreign-bead",
    runId: "alpha-run",
    sessionId: "foreign-recorded-session",
    payload: { kind: "headless" },
  });
  const untaggedId = h.append({
    kind: "session.started",
    runId: "alpha-run",
    sessionId: "untagged-recorded-session",
    payload: { kind: "headless" },
  });
  const missingSessionId = h.append({
    kind: "session.started",
    beadId: "alpha-epic",
    runId: "alpha-run",
    payload: { kind: "headless" },
  });
  h.append({
    kind: "session.started",
    beadId: "alpha-epic",
    runId: "another-run",
    sessionId: "another-run-session",
    payload: { kind: "headless" },
  });
  h.append({
    kind: "tool.called",
    beadId: "alpha-epic",
    runId: "alpha-run",
    sessionId: "tool-only-session",
    payload: { tool: "read", argsHash: "a".repeat(64) },
  });
  const otherWorkspace = appendEvent(
    {
      kind: "session.started",
      workspace: join(h.root, "foreign-workspace"),
      beadId: "alpha-epic",
      runId: "alpha-run",
      sessionId: "foreign-workspace-session",
      payload: { kind: "headless" },
    },
    { path: h.ledger },
  );
  if (!otherWorkspace.ok || !("id" in otherWorkspace))
    throw Error(
      "The foreign-workspace event was not recorded in the fixture ledger",
    );

  const read = (after: number) =>
    fetch(`${path}/alpha-run?after=${after}&limit=1`, {
      headers: h.headers(h.hearth.token),
    });
  const first = await read(0);
  expect(first.status).toBe(200);
  const firstBody = await first.json();
  expect(firstBody.data.sessionHistory).toMatchObject({
    status: "available",
    after: 0,
    nextAfter: exactId,
    more: true,
    membershipKey: expect.stringMatching(/^[0-9a-f]{64}$/),
    sessions: [{ sessionId: "alpha-recorded-session", detailsAvailable: true }],
  });
  const membershipKey = firstBody.data.sessionHistory.membershipKey;

  const suppressed = await read(exactId);
  expect(suppressed.status).toBe(200);
  const suppressedBody = await suppressed.json();
  expect(suppressedBody.data.sessionHistory).toMatchObject({
    after: exactId,
    nextAfter: foreignId,
    more: true,
    membershipKey,
    sessions: [],
  });

  const final = await fetch(`${path}/alpha-run?after=${foreignId}&limit=100`, {
    headers: h.headers(h.hearth.token),
  });
  expect(final.status).toBe(200);
  const finalBody = await final.json();
  expect(finalBody.data.sessionHistory).toMatchObject({
    after: foreignId,
    nextAfter: missingSessionId,
    more: false,
    membershipKey,
    sessions: [
      { sessionId: "untagged-recorded-session", detailsAvailable: false },
    ],
  });
  const result = JSON.stringify(finalBody.data.sessionHistory);
  expect(result).not.toContain("foreign-recorded-session");
  expect(result).not.toContain("another-run-session");
  expect(result).not.toContain("tool-only-session");
  expect(result).not.toContain("foreign-workspace-session");
});

test("run session membership key stays stable for the same authority and changes when admitted sessions change", async () => {
  const { h, path } = await fixture();
  const firstId = h.append({
    kind: "session.started",
    beadId: "alpha-epic",
    runId: "alpha-run",
    sessionId: "first-admitted-session",
    payload: { kind: "headless" },
  });
  const read = (after: number) =>
    fetch(`${path}/alpha-run?after=${after}&limit=1`, {
      headers: h.headers(h.hearth.token),
    });
  const first = await read(0);
  const firstBody = await first.json();
  const initialKey = firstBody.data.sessionHistory.membershipKey;
  expect(initialKey).toMatch(/^[0-9a-f]{64}$/);

  const same = await read(firstId);
  const sameBody = await same.json();
  expect(sameBody.data.sessionHistory.membershipKey).toBe(initialKey);

  h.append({
    kind: "session.started",
    beadId: "alpha-epic",
    runId: "alpha-run",
    sessionId: "second-admitted-session",
    payload: { kind: "headless" },
  });
  const changed = await read(firstId);
  const changedBody = await changed.json();
  expect(changedBody.data.sessionHistory.membershipKey).not.toBe(initialKey);
});

test("run session cursor query rejects repeated, malformed and unknown parameters", async () => {
  const { h, path } = await fixture();
  for (const query of [
    "after=-1",
    "after=9007199254740992",
    "after=1&after=2",
    "limit=0",
    "limit=101",
    "other=value",
  ]) {
    const response = await fetch(`${path}/alpha-run?${query}`, {
      headers: h.headers(h.hearth.token),
    });
    expect(response.status).toBe(400);
  }
});

test("protected artifact read returns the exact completed canonical research body without an audit write", async () => {
  const { h, path, state, directory, project } = await fixture();
  const detailResponse = await fetch(`${path}/alpha-run`, {
    headers: h.headers(h.hearth.token),
  });
  expect(detailResponse.status).toBe(200);
  const detailEnvelope: unknown = await detailResponse.json();
  if (
    !detailEnvelope ||
    typeof detailEnvelope !== "object" ||
    Array.isArray(detailEnvelope) ||
    !("ok" in detailEnvelope) ||
    detailEnvelope.ok !== true ||
    !("data" in detailEnvelope)
  )
    throw Error("Protected run detail was not verified.");
  const verifiedDetail = projectRunDetailSchema.parse(detailEnvelope.data);
  const relativeArtifact = "plans/research/alpha-run.md";
  const body = "# Alpha research\n\nThe verified original body.\n";
  mkdirSync(join(h.root, "plans", "research"), { recursive: true });
  writeFileSync(join(h.root, relativeArtifact), body);
  writeFileSync(
    join(directory, "alpha-run.json"),
    JSON.stringify({
      ...state,
      phase: "research",
      completed: ["research"],
      artifacts: { research: relativeArtifact },
    }),
  );

  const response = await fetch(`${path}/alpha-run/artifacts/research`, {
    headers: h.headers(h.hearth.token),
  });

  expect(response.status).toBe(200);
  const answer: unknown = await response.json();
  expect(answer).toMatchObject({
    ok: true,
    error: null,
    data: {
      version: 1,
      projectId: project.id,
      workspace: verifiedDetail.workspace,
      checkout: verifiedDetail.checkout,
      slug: "alpha-run",
      kind: "research",
      artifact: relativeArtifact,
      bytes: Buffer.byteLength(body),
      sha256: createHash("sha256").update(body).digest("hex"),
      content: body,
    },
  });
  expect(h.events(["operator.action"])).toEqual([]);
  expect(h.bd.calls.every((args) => args[0] === "export")).toBe(true);
});

test("artifact reads refuse query paths, incomplete or noncanonical references and unsafe complete files", async () => {
  const { h, path, state, directory, project } = await fixture();
  const relative = "plans/research/alpha-run.md";
  const full = join(h.root, relative);
  mkdirSync(join(h.root, "plans", "research"), { recursive: true });
  writeFileSync(full, "# Verified\n");
  const url = `${path}/alpha-run/artifacts/research`;
  const get = (target = url) =>
    fetch(target, { headers: h.headers(h.hearth.token) });
  writeFileSync(
    join(directory, "alpha-run.json"),
    JSON.stringify({ ...state, completed: [], artifacts: {} }),
  );
  expect((await get()).status).toBe(404);
  expect((await get(`${url}?path=${encodeURIComponent(full)}`)).status).toBe(
    400,
  );
  expect((await get(`${path}/alpha-run/artifacts/implement`)).status).toBe(400);

  writeFileSync(
    join(directory, "alpha-run.json"),
    JSON.stringify({
      ...state,
      phase: "research",
      completed: ["research"],
      artifacts: { research: "plans/research/other.md" },
    }),
  );
  expect((await get()).status).toBe(404);
  writeFileSync(
    join(directory, "alpha-run.json"),
    JSON.stringify({
      ...state,
      phase: "research",
      completed: ["research"],
      artifacts: { research: relative },
    }),
  );
  writeFileSync(full, "# unsafe\u0000body");
  const unsafe = await get();
  expect(unsafe.status).toBe(503);
  const answer: unknown = await unsafe.json();
  expect(JSON.stringify(answer)).not.toContain("unsafe");
  expect(JSON.stringify(answer)).not.toContain(h.root);
  expect(h.events(["operator.action"])).toEqual([]);
});

test("foreign labels, stored checkout and an unserved project workspace never authorize run metadata", async () => {
  const { h, path, state, directory, project } = await fixture();
  const request = () =>
    fetch(`${path}/alpha-run`, { headers: h.headers(h.hearth.token) });
  writeFileSync(
    join(directory, "alpha-run.json"),
    JSON.stringify({ ...state, checkout: join(h.root, "foreign") }),
  );
  expect((await request()).status).toBe(404);
  writeFileSync(join(directory, "alpha-run.json"), JSON.stringify(state));
  h.bd.answer = (args) =>
    args[0] === "export"
      ? {
          status: 0,
          stdout: JSON.stringify({
            id: "alpha-epic",
            title: "Foreign",
            status: "open",
            issue_type: "epic",
            labels: ["project:foreign"],
          }),
          stderr: "",
        }
      : undefined;
  expect((await request()).status).toBe(404);
  const changed = createProjectStore(h.home).read();
  const current = changed.projects.find((row) => row.id === project.id);
  if (!current?.workspaces[0]) throw Error("Missing planted scope");
  current.workspaces[0].root = join(h.root, "unserved");
  writeOwnerOnly(projectCatalogPath(h.home), JSON.stringify(changed));
  writeFileSync(join(directory, "alpha-run.json"), "malformed-private-state");
  // Refuse current scope before attempting that malformed private source.
  expect((await request()).status).toBe(409);
  expect(readFileSync(join(directory, "alpha-run.json"), "utf8")).toBe(
    "malformed-private-state",
  );
});

test("only this project's matching run and checkout determine gate truth while retained legacy history stays explicit", async () => {
  const { h, path } = await fixture();
  const folder = join(h.home, "fixture-gate-logs", "2026-10-23");
  mkdirSync(folder, { recursive: true });
  const gate = {
    schemaVersion: 2,
    event: "TaskCompleted",
    timestamp: "2026-10-23T13:00:00.000Z",
    checkout: h.root,
    branch: "feature/alpha",
    beadsIssueId: "alpha-epic",
    executionRunId: "alpha-run",
    passed: false,
    checks: [
      {
        name: "lint",
        passed: false,
        output: "Found 2 errors\nPRIVATE EXTRA OUTPUT",
      },
      {
        name: "tests",
        passed: true,
        skipped: true,
        skipReason: "No test files",
      },
    ],
  };
  writeFileSync(
    join(folder, "quality-gate.jsonl"),
    [
      {
        event: "TaskCompleted",
        checkout: h.root,
        forgeSlug: "alpha-run",
        timestamp: "2026-10-23T12:00:00.000Z",
        passed: true,
        checks: [],
      },
      gate,
      { ...gate, beadsIssueId: "foreign-epic", passed: true },
      { ...gate, checkout: join(h.root, "foreign"), passed: true },
      { ...gate, beadsIssueId: null, executionRunId: null, passed: true },
    ]
      .map((item) => JSON.stringify(item))
      .join("\n"),
  );
  const response = await fetch(`${path}/alpha-run`, {
    headers: h.headers(h.hearth.token),
  });
  expect(response.status).toBe(200);
  const detail = (await response.json()).data;
  expect(detail.run.gatePassed).toBe(false);
  expect(detail.run.health).toBe("attention");
  expect(detail.gateHistory).toHaveLength(2);
  expect(detail.gateHistory[0]).toMatchObject({
    link: "linked",
    passed: false,
    checks: [
      { name: "lint", passed: false, skipped: false, detail: "Found 2 errors" },
      { name: "tests", passed: true, skipped: true, detail: "No test files" },
    ],
  });
  expect(detail.gateHistory[1].link).toBe("legacy");
  expect(JSON.stringify(detail)).not.toMatch(
    /PRIVATE EXTRA OUTPUT|foreign-epic/,
  );
});
