import { afterEach, expect, test } from "bun:test";
import type { ProjectsHome } from "../../../types/project-summary";
import { completeTrackerFixture } from "../../projects/complete-tracker-fixture";
import {
  type CompleteBeadRow,
  parseCompleteTracker,
} from "../../projects/complete-tracker-source";
import { createProjectStore } from "../../projects/store";
import { startTestHearth, type TestHearth } from "../testing";

const opened: TestHearth[] = [];
afterEach(async () => {
  for (const h of opened.splice(0)) await h.close();
});
const identity = {
  database: "complete_fixture",
  projectId: "11111111-1111-4111-8111-111111111111",
};
const bead = (id: string, parent?: string): CompleteBeadRow => ({
  id,
  title: id,
  status: "open",
  issue_type: id === "epic" ? "epic" : "task",
  priority: 2,
  description: "Full description",
  acceptance_criteria: "AC",
  notes: "Notes",
  created_at: "2026-11-09T01:00:00Z",
  updated_at: "2026-11-09T02:00:00Z",
  labels: ["project:complete"],
  dependencies: parent
    ? [{ issue_id: id, depends_on_id: parent, type: "parent-child" }]
    : [],
  metadata: {},
});

test("protected served summaries and accepted Scope preview consume the same complete durable/wisp source without CLI fallback", async () => {
  let payload = completeTrackerFixture(
      identity,
      [bead("epic"), bead("task", "epic"), bead("wisp", "task")],
      ["wisp"],
    ),
    cliCalls = 0;
  const h = await startTestHearth({
    api: {
      completeTracker: async () => parseCompleteTracker(payload, identity),
      runBd: async () => {
        cliCalls++;
        throw Error("No production export fallback");
      },
    },
  });
  opened.push(h);
  const store = createProjectStore(h.home);
  const catalog = await store.create(
    {
      slug: "complete",
      name: "Complete",
      description: "",
      icon: "C",
      workspaces: [
        { root: h.workspace, repositories: [h.workspace], epicIds: ["epic"] },
      ],
    },
    0,
  );
  const project = catalog.projects[0]!;
  async function summary() {
    const response = await fetch(h.api + "/projects/summary", {
      headers: h.headers(),
    });
    expect(response.status).toBe(200);
    const body: { ok: boolean; data: ProjectsHome } = await response.json();
    expect(body.ok).toBe(true);
    return body.data.summaries[0]!;
  }
  async function preview() {
    return fetch(
      `${h.api}/projects/${project.id}/settings/scope-preview?revision=${catalog.revision}&epicId=epic`,
      { headers: h.headers(h.hearth.token) },
    );
  }
  expect((await summary()).beads?.open).toBe(3);
  const valid = await preview();
  expect(valid.status).toBe(200);
  expect(await valid.json()).toMatchObject({
    ok: true,
    data: { complete: true, scopeCount: 3 },
  });
  const full = payload;
  for (const part of ["labels", "wisp_dependencies"]) {
    let rows: Array<{ part: string }>;
    try {
      rows = JSON.parse(full);
    } catch {
      throw Error("fixture JSON");
    }
    const index = rows.findIndex((row) => row.part === part);
    expect(index).toBeGreaterThan(0);
    rows.splice(index, 1);
    payload = JSON.stringify(rows);
    expect((await summary()).beads).toBeNull();
    const unavailable = await preview();
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain("Full description");
  }
  payload = full;
  expect((await summary()).beads?.open).toBe(3);
  expect(cliCalls).toBe(0);
});

test("a proven empty served tracker distinguishes empty candidates from missing stored epic scope", async () => {
  let payload = completeTrackerFixture(identity, [
    { ...bead("epic"), labels: [] },
  ]);
  const h = await startTestHearth({
    api: {
      completeTracker: async () => parseCompleteTracker(payload, identity),
    },
  });
  opened.push(h);
  const catalog = await createProjectStore(h.home).create(
    {
      slug: "empty",
      name: "Empty",
      description: "",
      icon: "E",
      workspaces: [
        { root: h.workspace, repositories: [h.workspace], epicIds: ["epic"] },
      ],
    },
    0,
  );
  const response = await fetch(h.api + "/projects/summary", {
    headers: h.headers(),
  });
  const body: { ok: boolean; data: ProjectsHome } = await response.json();
  expect(body.ok).toBe(true);
  expect(body.data.summaries[0]?.beads?.open).toBe(0);
  payload = completeTrackerFixture(identity, []);
  const empty = await fetch(h.api + "/projects/summary", {
    headers: h.headers(),
  });
  expect(await empty.json()).toMatchObject({
    ok: true,
    data: { summaries: [{ beads: null }] },
  });
  const preview = await fetch(
    `${h.api}/projects/${catalog.projects[0]!.id}/settings/scope-preview?revision=${catalog.revision}`,
    { headers: h.headers(h.hearth.token) },
  );
  expect(preview.status).toBe(200);
  expect(await preview.json()).toMatchObject({
    ok: true,
    data: { complete: true, scopeCount: 0 },
  });
});
