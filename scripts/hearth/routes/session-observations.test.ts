import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { EventFilter } from "../../ledger/query";
import {
  projectSessionObservationsSchema,
  sessionObservationDetailSchema,
} from "../../projects/session-observations-protocol";
import { createProjectStore } from "../../projects/store";
import { sessionRegistryFile } from "../../sessions/registry";
import { startTestHearth, type TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";
import { projectSnapshotReader } from "./project-summaries";
import { createSessionObservationRoutes } from "./session-observations";

const opened: TestHearth[] = [];
afterEach(async () => {
  for (const h of opened.splice(0)) await h.close();
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
  if (!project) throw Error("Missing project");
  const row = {
    id: "alpha-epic",
    title: "Fixture epic",
    issue_type: "epic",
    status: "open",
    labels: ["project:alpha"],
    created_at: "2026-10-23T17:00:00Z",
    updated_at: "2026-10-23T17:00:00Z",
  };
  h.bd.answer = (args) =>
    args[0] === "export"
      ? { status: 0, stdout: JSON.stringify(row), stderr: "" }
      : undefined;
  h.append({
    kind: "session.started",
    sessionId: "external-parent",
    beadId: row.id,
    payload: { source: "startup", kind: "interactive", worktree: h.workspace },
  });
  h.append({
    kind: "session.started",
    sessionId: "external-child",
    beadId: row.id,
    payload: {
      source: "startup",
      kind: "subagent",
      parentSessionId: "external-parent",
      worktree: h.workspace,
    },
  });
  h.append({
    kind: "tool.called",
    sessionId: "external-child",
    beadId: row.id,
    payload: { tool: "Read", argsHash: "b".repeat(64), durationMs: 17 },
  });
  return { h, project };
}

test("protected observation reads expose exact scoped metadata pages and verified parent identity without private or reconstructed content", async () => {
  const { h, project } = await fixture();
  const path = `${h.api}/projects/${project.id}/session-observations`;
  expect((await fetch(path, { headers: h.headers(null) })).status).toBe(403);
  const response = await fetch(path, { headers: h.headers(h.hearth.token) });
  expect(response.status).toBe(200);
  const envelope = await response.json();
  expect(envelope.ok).toBe(true);
  const index = projectSessionObservationsSchema.parse(envelope.data);
  expect(index.observations.map((row) => row.sessionId).sort()).toEqual([
    "external-child",
    "external-parent",
  ]);
  expect(index.ownership).toEqual({
    available: true,
    records: [],
    reason: null,
  });
  const first = await fetch(`${path}/external-child?after=0&limit=1`, {
    headers: h.headers(h.hearth.token),
  });
  expect(first.status).toBe(200);
  const initial = await first.json();
  expect(initial.ok).toBe(true);
  const page = sessionObservationDetailSchema.parse(initial.data);
  expect(page.parent).toEqual({ id: "external-parent", available: true });
  expect(page.owner).toBeNull();
  expect(page.more).toBe(true);
  expect(page.activity).toHaveLength(1);
  const second = await fetch(
    `${path}/external-child?after=${page.nextAfter}&limit=1`,
    { headers: h.headers(h.hearth.token) },
  );
  const nextEnvelope = await second.json();
  expect(nextEnvelope.ok).toBe(true);
  const next = sessionObservationDetailSchema.parse(nextEnvelope.data);
  expect(next.activity).toEqual([
    {
      id: expect.any(Number),
      at: expect.any(String),
      kind: "tool.called",
      tool: "Read",
      durationMs: 17,
      exitCode: null,
    },
  ]);
  expect(next.more).toBe(false);
  expect(JSON.stringify(next)).not.toMatch(
    /argsHash|frames|transcript|command|filePath|stdin|providerPid/,
  );
  expect(h.events(["operator.action"])).toEqual([]);
});

test("foreign membership and widened cursors refuse before any selected-session event query", async () => {
  const { h, project } = await fixture();
  h.append({
    kind: "tool.called",
    sessionId: "foreign-session",
    beadId: "beta-epic",
    payload: { tool: "Foreign tool metadata", argsHash: "c".repeat(64) },
  });
  const deps = {
    root: h.root,
    workspace: h.workspace,
    ledgerPath: h.ledger,
    runBd: h.bd.run,
  };
  const queries: EventFilter[] = [];
  const routes = createSessionObservationRoutes(
    deps,
    projectSnapshotReader(h.home, deps),
    (filter) => {
      queries.push(filter);
      return { events: [], more: false };
    },
  );
  const foreign = await routes.detail.read({
    projectId: project.id,
    sessionId: "foreign-session",
    after: 0,
    limit: 10,
  });
  expect(foreign.status).toBe(404);
  expect(queries).toEqual([]);
  const own = await routes.detail.read({
    projectId: project.id,
    sessionId: "external-child",
    after: 0,
    limit: 10,
  });
  expect(own.status).toBe(200);
  expect(queries).toEqual([
    {
      workspace: h.workspace,
      sessionId: "external-child",
      kinds: [
        "session.started",
        "session.ended",
        "prompt.submitted",
        "tool.called",
      ],
      afterId: 0,
      limit: 10,
    },
  ]);
  const path = `${h.api}/projects/${project.id}/session-observations`;
  for (const query of [
    "?workspace=/elsewhere",
    "?after=-1",
    "?after=1&after=2",
    "?limit=101",
    "?limit=0",
    "?resume=true",
  ])
    expect(
      (
        await fetch(`${path}/external-child${query}`, {
          headers: h.headers(h.hearth.token),
        })
      ).status,
    ).toBe(400);
  expect(
    (
      await fetch(`${path}?session=foreign-session`, {
        headers: h.headers(h.hearth.token),
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await fetch(`${path}/foreign-session`, {
        headers: h.headers(h.hearth.token),
      })
    ).status,
  ).toBe(404);
});

test("a shared session excludes explicitly foreign bead metadata while retaining untagged activity and advancing across an empty visible page", async () => {
  const { h, project } = await fixture();
  const foreign = h.append({
    kind: "tool.called",
    sessionId: "external-child",
    beadId: "beta-epic",
    payload: { tool: "Foreign project tool", argsHash: "d".repeat(64) },
  });
  h.append({
    kind: "tool.called",
    sessionId: "external-child",
    payload: { tool: "Untagged session tool", argsHash: "e".repeat(64) },
  });
  h.append({
    kind: "tool.called",
    sessionId: "external-child",
    beadId: "alpha-epic",
    payload: { tool: "Current project tool", argsHash: "f".repeat(64) },
  });
  const path = `${h.api}/projects/${project.id}/session-observations/external-child`;
  const read = async (after: number, limit: number) => {
    const response = await fetch(`${path}?after=${after}&limit=${limit}`, {
      headers: h.headers(h.hearth.token),
    });
    expect(response.status).toBe(200);
    const envelope = await response.json();
    expect(envelope.ok).toBe(true);
    return sessionObservationDetailSchema.parse(envelope.data);
  };
  const filtered = await read(foreign - 1, 1);
  expect(filtered.activity).toEqual([]);
  expect(filtered.nextAfter).toBe(foreign);
  expect(filtered.more).toBe(true);
  const next = await read(filtered.nextAfter, 100);
  expect(
    next.activity
      .filter((event) => event.kind === "tool.called")
      .map((event) => event.tool),
  ).toEqual(["Untagged session tool", "Current project tool"]);
  expect(next.more).toBe(false);
  expect(JSON.stringify(await read(0, 100))).not.toContain(
    "Foreign project tool",
  );
});

test("an unreadable registry reports unknown ownership while preserving scoped metadata, and an unserved catalog scope is refused", async () => {
  const { h, project } = await fixture();
  writeOwnerOnly(sessionRegistryFile(h.home), "{corrupt registry");
  const path = `${h.api}/projects/${project.id}/session-observations`;
  const response = await fetch(path, { headers: h.headers(h.hearth.token) });
  const envelope = await response.json();
  expect(envelope.ok).toBe(true);
  const index = projectSessionObservationsSchema.parse(envelope.data);
  expect(index.ownership.available).toBe(false);
  expect(index.ownership.reason).toContain("ownership index is unavailable");
  expect(index.observations).toHaveLength(2);
  const detailResponse = await fetch(`${path}/external-child`, {
    headers: h.headers(h.hearth.token),
  });
  const detailEnvelope = await detailResponse.json();
  expect(detailEnvelope.ok).toBe(true);
  const detail = sessionObservationDetailSchema.parse(detailEnvelope.data);
  expect(detail.ownershipAvailable).toBe(false);
  expect(detail.owner).toBeNull();
  const other = join(h.root, "other-checkout");
  mkdirSync(join(other, ".git"), { recursive: true });
  const catalog = await createProjectStore(h.home).create(
    {
      slug: "other",
      name: "Other",
      description: "",
      icon: "O",
      workspaces: [
        { root: other, repositories: [other], epicIds: ["other-epic"] },
      ],
    },
    1,
  );
  const otherProject = catalog.projects.find((item) => item.slug === "other");
  if (!otherProject) throw Error("Missing foreign fixture project");
  expect(
    (
      await fetch(
        `${h.api}/projects/${otherProject.id}/session-observations/external-child`,
        { headers: h.headers(h.hearth.token) },
      )
    ).status,
  ).toBe(409);
  expect(h.events(["operator.action"])).toEqual([]);
});
