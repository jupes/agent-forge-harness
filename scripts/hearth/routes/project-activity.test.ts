import { afterEach, expect, test } from "bun:test";
import type { LedgerEventInput } from "../../../types/hearth";
import { openLedger } from "../../ledger/db";
import { activitySessionMembership } from "../../projects/activity-membership";
import { projectActivityPageSchema } from "../../projects/activity-protocol";
import { createProjectStore } from "../../projects/store";
import { sessionRegistryFile } from "../../sessions/registry";
import { startTestHearth, type TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";
import { createProjectActivityRoutes } from "./project-activity";
import { projectSnapshotReader } from "./project-summaries";

const opened: TestHearth[] = [];
afterEach(async () => {
  for (const hearth of opened.splice(0)) await hearth.close();
});

async function fixture() {
  const h = await startTestHearth();
  opened.push(h);
  const catalog = await createProjectStore(h.home).create(
    {
      slug: "alpha",
      name: "Alpha",
      description: "",
      icon: "A",
      workspaces: [
        { root: h.root, repositories: [h.root], epicIds: ["alpha-epic"] },
      ],
    },
    0,
  );
  const project = catalog.projects[0];
  if (!project) throw Error("Missing fixture project");
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
  return { h, project, path: `${h.api}/projects/${project.id}/activity` };
}

test("protected Activity keeps each historical assignment and suppresses later foreign untagged rows without losing the raw cursor", async () => {
  const { h, project, path } = await fixture();
  const start = h.append({
    kind: "session.started",
    sessionId: "shared-session",
    beadId: "alpha-epic",
    payload: { kind: "interactive" },
  });
  const own = h.append({
    kind: "tool.called",
    sessionId: "shared-session",
    payload: { tool: "Read", argsHash: "a".repeat(64), durationMs: 17 },
  });
  const foreign = h.append({
    kind: "tool.called",
    sessionId: "shared-session",
    beadId: "beta-epic",
    payload: { tool: "FOREIGN", argsHash: "f".repeat(64) },
  });
  h.append({
    kind: "tool.called",
    sessionId: "shared-session",
    payload: { tool: "PRIVATE B", argsHash: "b".repeat(64) },
  });
  const response = await fetch(`${path}?after=${own}&limit=1`, {
    headers: h.headers(h.hearth.token),
  });
  expect(response.status).toBe(200);
  const first = await response.json();
  expect(first.ok).toBe(true);
  expect(first.data).toMatchObject({
    projectId: project.id,
    workspace: h.workspace,
    events: [],
    after: own,
    nextAfter: foreign,
    more: true,
  });
  const next = await fetch(`${path}?after=${foreign}&limit=1`, {
    headers: h.headers(h.hearth.token),
  });
  const second = await next.json();
  expect(second.ok).toBe(true);
  expect(second.data.events).toEqual([]);
  expect(second.data.more).toBe(false);
  const eligible = await fetch(`${path}?after=${start}&limit=100`, {
    headers: h.headers(h.hearth.token),
  });
  const history = await eligible.json();
  expect(history.ok).toBe(true);
  expect(history.data.events).toHaveLength(1);
  expect(history.data.events[0]).toMatchObject({
    id: own,
    kind: "tool.called",
    summary: "Read",
    metadata: [
      { key: "tool", value: "Read" },
      { key: "durationMs", value: 17 },
    ],
  });
  expect(JSON.stringify(history)).not.toMatch(/argsHash|FOREIGN|PRIVATE B/);
  const bead = await fetch(`${path}?bead=alpha-epic`, {
    headers: h.headers(h.hearth.token),
  });
  const beadHistory = await bead.json();
  expect(beadHistory.ok).toBe(true);
  expect(
    beadHistory.data.events.map((event: { id: number }) => event.id),
  ).toEqual([start, own]);
  expect((await fetch(path, { headers: h.headers(null) })).status).toBe(403);
  expect(h.events(["operator.action"])).toEqual([]);
});

test("Activity describes recorded gate and verdict metadata while omitting stored opt-in bodies", async () => {
  const { h, path } = await fixture();
  h.append({
    kind: "gate.ran",
    beadId: "alpha-epic",
    executor: { provider: "codex", model: "reported-model" },
    payload: { gate: "lint", passed: false, durationMs: 29, exitCode: 2 },
  });
  const verdict = h.append({
    kind: "verdict.bound",
    beadId: "alpha-epic",
    payload: { verdict: "fail", summary: "PRIVATE STORED VERDICT BODY" },
  });
  const response = await fetch(`${path}?provider=codex&kind=gate.ran`, {
    headers: h.headers(h.hearth.token),
  });
  expect(response.status).toBe(200);
  const page = await response.json();
  expect(page.ok).toBe(true);
  expect(page.data.events).toHaveLength(1);
  expect(page.data.events[0]).toMatchObject({
    summary: "Gate failed: lint",
    actor: {
      provider: "codex",
      model: "reported-model",
      effort: null,
      smith: null,
    },
    metadata: [
      { key: "gate", value: "lint" },
      { key: "passed", value: false },
      { key: "durationMs", value: 29 },
      { key: "exitCode", value: 2 },
    ],
  });
  const detail = await fetch(`${path}/${verdict}`, {
    headers: h.headers(h.hearth.token),
  });
  expect(detail.status).toBe(200);
  const selected = await detail.json();
  expect(selected.ok).toBe(true);
  expect(selected.data.event).toMatchObject({
    id: verdict,
    summary: "Verdict: fail",
    metadata: [{ key: "verdict", value: "fail" }],
  });
  expect(JSON.stringify(selected)).not.toContain("PRIVATE STORED VERDICT BODY");
});

test("Activity covers recorded phases, reviews, queue changes, reservations and scoped outcomes without inventing missing usage", async () => {
  const { h, path } = await fixture();
  const inputs: Array<Omit<LedgerEventInput, "workspace">> = [
    { kind: "run.phase.entered", payload: { phase: "implement" } },
    {
      kind: "run.phase.completed",
      payload: { phase: "implement", artifact: "report.md" },
    },
    {
      kind: "review.recorded",
      payload: {
        phase: "implement",
        round: 2,
        verdict: "FAIL",
        findings: { blocker: 0, high: 1, medium: 0, low: 0 },
        action: "revise",
      },
    },
    { kind: "bead.transitioned", payload: { from: "approved", to: "queued" } },
    {
      kind: "bead.transitioned",
      payload: { action: "comment", hash: "c".repeat(64), length: 23 },
    },
    {
      kind: "reservation.acquired",
      payload: { worktree: "fixture/tree", globs: ["src/**"] },
    },
    {
      kind: "reservation.released",
      payload: { worktree: "fixture/tree", globs: ["src/**"] },
    },
    {
      kind: "shift.started",
      payload: { shiftId: "shift-20261023-120000-ab12", concurrency: 2 },
    },
    {
      kind: "shift.stopped",
      payload: { shiftId: "shift-20261023-120000-ab12", reason: "operator" },
    },
    {
      kind: "council.run.started",
      payload: { councilRunId: "council-fixture", profile: "fixture" },
    },
    {
      kind: "council.run.finished",
      payload: {
        councilRunId: "council-fixture",
        outcome: "fail",
        summary: "PRIVATE COUNCIL BODY",
      },
    },
    {
      kind: "council.verdict.comment",
      payload: { councilRunId: "council-fixture", status: "unknown" },
    },
    {
      kind: "friction.recorded",
      payload: { frictionBeadId: "alpha-friction" },
    },
    {
      kind: "operator.action",
      payload: { action: "queue.approve", surface: "ui", target: "alpha-epic" },
    },
    {
      kind: "session.ended",
      payload: {
        reason: "completed",
        durationMs: 31,
        usage: { inputTokens: 10, cacheReadInputTokens: 4 },
      },
    },
  ];
  for (const input of inputs) h.append({ ...input, beadId: "alpha-epic" });
  const response = await fetch(path, { headers: h.headers(h.hearth.token) });
  expect(response.status).toBe(200);
  const page = await response.json();
  expect(page.ok).toBe(true);
  expect(
    page.data.events.map((event: { summary: string }) => event.summary),
  ).toEqual([
    "Phase started: implement",
    "Phase completed: implement",
    "Review FAIL: implement",
    "Queue: approved → queued",
    "Bead comment recorded",
    "Reservation acquired",
    "Reservation released",
    "Shift start recorded",
    "Shift stopped: operator",
    "Council start recorded",
    "Council finished: fail",
    "Council comment: unknown",
    "Friction recorded",
    "Operator action: queue.approve",
    "Session ended",
  ]);
  const end = page.data.events.at(-1);
  expect(end.metadata).toContainEqual({ key: "inputTokens", value: 10 });
  expect(end.metadata).toContainEqual({
    key: "cacheReadInputTokens",
    value: 4,
  });
  expect(
    end.metadata.some(
      (item: { key: string }) =>
        item.key === "costUsd" || item.key === "outputTokens",
    ),
  ).toBe(false);
  expect(JSON.stringify(page)).not.toContain("PRIVATE COUNCIL BODY");
});

test("membership and parameter refusals precede selected ledger queries; a foreign selected event exposes no metadata", async () => {
  const { h, project, path } = await fixture();
  const deps = {
    root: h.root,
    workspace: h.workspace,
    ledgerPath: h.ledger,
    runBd: h.bd.run,
  };
  let queries = 0;
  const routes = createProjectActivityRoutes(
    deps,
    projectSnapshotReader(h.home, deps),
    () => {
      queries++;
      return { events: [], more: false };
    },
  );
  const filters = {
    kinds: [],
    provider: null,
    beadId: null,
    sessionId: null,
    runId: null,
    shiftId: null,
    since: null,
    until: null,
  };
  expect(
    (
      await routes.list.read({
        projectId: project.id,
        after: 0,
        limit: 100,
        filters: { ...filters, beadId: "beta-epic" },
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await routes.detail.read({
        projectId: "project-015821b4-4b38-4bf3-9326-71ce9c09ff46",
        eventId: 1,
      })
    ).status,
  ).toBe(404);
  h.bd.answer = (args) =>
    args[0] === "export"
      ? { status: 1, stdout: "", stderr: "fixture tracker unavailable" }
      : undefined;
  expect(
    (await routes.detail.read({ projectId: project.id, eventId: 1 })).status,
  ).toBe(503);
  expect(queries).toBe(0);
  const before = h.bd.calls.length;
  for (const query of [
    "?workspace=/other",
    "?limit=201",
    "?limit=0",
    "?after=-1",
    "?after=1&after=2",
    "?kind=not-a-kind",
    "?kind=tool.called,tool.called",
    "?since=yesterday",
    "?since=2026-10-23T13:00:00Z&until=2026-10-23T12:00:00Z",
    "?provider=",
  ]) {
    expect(
      (await fetch(`${path}${query}`, { headers: h.headers(h.hearth.token) }))
        .status,
    ).toBe(400);
  }
  expect(h.bd.calls.length).toBe(before);
  for (const suffix of ["/0", "/-1", "/1?workspace=/other"])
    expect(
      (await fetch(`${path}${suffix}`, { headers: h.headers(h.hearth.token) }))
        .status,
    ).toBe(400);
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
  const foreign = h.append({
    kind: "tool.called",
    beadId: "beta-epic",
    payload: { tool: "FOREIGN SELECTED EVENT", argsHash: "f".repeat(64) },
  });
  const response = await fetch(`${path}/${foreign}`, {
    headers: h.headers(h.hearth.token),
  });
  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain("FOREIGN SELECTED EVENT");
});

test("verified current owned metadata admits untagged activity but cannot override an explicitly foreign bead tag", async () => {
  const { h, project, path } = await fixture();
  const sessionId = "session-015821b4-4b38-4bf3-9326-71ce9c09ff46";
  writeOwnerOnly(
    sessionRegistryFile(h.home),
    JSON.stringify({
      version: 1,
      records: [
        {
          projectId: project.id,
          id: sessionId,
          requestId: "6f60951c-061c-468c-9156-131ebdd92514",
          requestHash: "a".repeat(64),
          createdAt: "2026-10-23T12:00:00.000Z",
          provider: "claude",
          mode: "task",
          workspace: h.workspace,
          repository: h.workspace,
          worktree: h.workspace,
          smith: "fixture",
          requestedModel: "requested-only",
          requestedEffort: null,
        },
      ],
    }),
  );
  h.append({
    kind: "tool.called",
    sessionId,
    beadId: "beta-epic",
    payload: { tool: "FOREIGN", argsHash: "f".repeat(64) },
  });
  const eligible = h.append({
    kind: "tool.called",
    sessionId,
    payload: { tool: "Owned metadata", argsHash: "a".repeat(64) },
  });
  const response = await fetch(path, { headers: h.headers(h.hearth.token) });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.ok).toBe(true);
  const page = projectActivityPageSchema.parse(body.data);
  expect(page.events.map((event) => event.id)).toEqual([eligible]);
  expect(page.events[0]?.actor).toBeNull();
  expect(JSON.stringify(body)).not.toContain("requested-only");
  expect(JSON.stringify(body)).not.toContain("FOREIGN");
});

test("time filters include their actual boundary instants, and unknown roots do not grant project membership", async () => {
  const { h, path } = await fixture();
  const before = h.append({
    kind: "prompt.submitted",
    beadId: "alpha-epic",
    ts: "2026-10-23T12:00:00.000Z",
    payload: { hash: "a".repeat(64), length: 10 },
  });
  h.append({
    kind: "prompt.submitted",
    beadId: "alpha-epic",
    ts: "2026-10-23T12:00:00.123Z",
    payload: { hash: "b".repeat(64), length: 11 },
  });
  h.append({
    kind: "shift.started",
    payload: { shiftId: "shift-20261023-120000-ab12", concurrency: 1 },
  });
  const response = await fetch(
    `${path}?since=2026-10-23T12:00:00Z&until=2026-10-23T12:00:00Z`,
    { headers: h.headers(h.hearth.token) },
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.ok).toBe(true);
  expect(body.data.events.map((event: { id: number }) => event.id)).toEqual([
    before,
  ]);
  const all = await fetch(path, { headers: h.headers(h.hearth.token) });
  const allBody = await all.json();
  expect(allBody.ok).toBe(true);
  expect(allBody.data.events).toHaveLength(2);
  expect(JSON.stringify(allBody)).not.toContain("shift-20261023-120000-ab12");
});

test("bounded historical candidate membership is explicitly incomplete rather than proving omitted sessions external", async () => {
  const { h, path } = await fixture();
  openLedger(h.ledger).transaction(() => {
    for (let i = 0; i < 1001; i++)
      h.append({
        kind: "session.started",
        sessionId: `history-${i}`,
        beadId: "alpha-epic",
        payload: { kind: "interactive" },
      });
  })();
  const read = activitySessionMembership(h.workspace, ["alpha-epic"], h.ledger);
  expect(read.complete).toBe(false);
  expect(read.sessions).toHaveLength(1000);
  expect(read.sessions).not.toContain("history-0");
  expect(read.sessions).toContain("history-1000");
  const response = await fetch(`${path}?session=history-0`, {
    headers: h.headers(h.hearth.token),
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.ok).toBe(true);
  const page = projectActivityPageSchema.parse(body.data);
  expect(page.events.map((event) => event.sessionId)).toEqual(["history-0"]);
  expect(page.more).toBe(false);
  expect(page.membershipComplete).toBe(false);
});

test("a scoped run does not turn an unassigned unowned session into project activity", async () => {
  const { h, project } = await fixture();
  const deps = {
    root: h.root,
    workspace: h.workspace,
    ledgerPath: h.ledger,
    runBd: h.bd.run,
  };
  const load = projectSnapshotReader(h.home, deps);
  const routes = createProjectActivityRoutes(deps, async () => {
    const snapshot = await load();
    return {
      ...snapshot,
      source: {
        ...snapshot.source,
        runs: [
          {
            slug: "known-run",
            phase: "implement",
            completed: [],
            next: "implement",
            halted: null,
            reviewPending: null,
            revising: false,
            complete: false,
            mode: "gated",
            feature: null,
            epic: "alpha-epic",
            checkout: null,
            updatedAt: "2026-10-23T12:00:00.000Z",
          },
        ],
      },
    };
  });
  h.append({
    kind: "tool.called",
    runId: "known-run",
    sessionId: "unassigned-session",
    payload: { tool: "AMBIGUOUS SESSION", argsHash: "a".repeat(64) },
  });
  const gate = h.append({
    kind: "gate.ran",
    runId: "known-run",
    payload: { gate: "lint", passed: true },
  });
  const result = await routes.list.read({
    projectId: project.id,
    after: 0,
    limit: 100,
    filters: {
      kinds: [],
      provider: null,
      beadId: null,
      sessionId: null,
      runId: "known-run",
      shiftId: null,
      since: null,
      until: null,
    },
  });
  expect(result.status).toBe(200);
  if (!("data" in result)) throw Error("Missing Activity page");
  const page = projectActivityPageSchema.parse(result.data);
  expect(page.events.map((event) => event.id)).toEqual([gate]);
});

test("absence from incomplete session or run membership stays unavailable rather than a false not-in-project claim", async () => {
  const { h, project } = await fixture();
  const deps = {
    root: h.root,
    workspace: h.workspace,
    ledgerPath: h.ledger,
    runBd: h.bd.run,
  };
  const load = projectSnapshotReader(h.home, deps);
  let queries = 0;
  const routes = createProjectActivityRoutes(
    deps,
    async () => {
      const snapshot = await load();
      const { runs: _runs, ...source } = snapshot.source;
      return { ...snapshot, source: { ...source, sessionsComplete: false } };
    },
    () => {
      queries++;
      return { events: [], more: false };
    },
  );
  for (const selected of [
    { sessionId: "not-in-bounded-source" },
    { runId: "not-in-available-source" },
  ]) {
    const result = await routes.list.read({
      projectId: project.id,
      after: 0,
      limit: 100,
      filters: {
        kinds: [],
        provider: null,
        beadId: null,
        sessionId: null,
        runId: null,
        shiftId: null,
        since: null,
        until: null,
        ...selected,
      },
    });
    expect(result.status).toBe(503);
    expect("error" in result ? result.error : "").toContain("incomplete");
  }
  expect(queries).toBe(0);
});
