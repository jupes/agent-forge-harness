import { afterEach, expect, test } from "bun:test";
import type { ProjectOverview } from "../../../types/project-overview";
import { createProjectStore } from "../../projects/store";
import { startTestHearth, type TestHearth } from "../testing";

const opened: TestHearth[] = [];
afterEach(async () => {
  for (const h of opened.splice(0)) await h.close();
});

test("Overview reads real scoped sources and never joins foreign or unbound usage", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const store = createProjectStore(h.home);
  const one = await store.create(
    {
      slug: "alpha",
      name: "Alpha",
      description: "",
      icon: "A",
      workspaces: [
        { root: h.root, repositories: [h.root], epicIds: ["alpha"] },
      ],
    },
    0,
  );
  const alpha = one.projects[0];
  if (!alpha) throw new Error("Missing fixture project");
  const rows = [
    {
      id: "alpha",
      title: "Alpha epic",
      issue_type: "epic",
      status: "open",
      labels: ["project:alpha"],
    },
    {
      id: "a",
      title: "Alpha bead",
      issue_type: "task",
      status: "closed",
      labels: ["project:alpha"],
      dependencies: [
        { issue_id: "a", depends_on_id: "alpha", type: "parent-child" },
      ],
    },
    {
      id: "b",
      title: "Foreign bead",
      issue_type: "task",
      status: "closed",
      labels: ["project:beta"],
    },
  ];
  h.bd.answer = (args) =>
    args[0] === "export"
      ? {
          status: 0,
          stdout: rows.map((row) => JSON.stringify(row)).join("\n"),
          stderr: "",
        }
      : undefined;
  h.append({
    kind: "session.ended",
    beadId: "a",
    sessionId: "own",
    executor: { provider: "codex", model: "fixture-model" },
    payload: { usage: { inputTokens: 100 } },
  });
  h.append({
    kind: "session.ended",
    beadId: "b",
    sessionId: "foreign",
    executor: { provider: "codex", model: "fixture-model" },
    payload: { usage: { costUsd: 999 } },
  });
  h.append({
    kind: "session.ended",
    sessionId: "unbound",
    executor: { provider: "codex", model: "fixture-model" },
    payload: { usage: { costUsd: 555 } },
  });
  const response = await fetch(`${h.api}/projects/${alpha.id}/overview`, {
    headers: h.headers(),
  });
  expect(response.status).toBe(200);
  const envelope: { ok: boolean; data: ProjectOverview } =
    await response.json();
  expect(envelope.ok).toBe(true);
  expect(envelope.data.beads.map((bead) => bead.id)).toEqual(["alpha", "a"]);
  expect(envelope.data.summary.beads).toMatchObject({ open: 1, closed: 1 });
  expect(envelope.data.usage.data).toEqual([
    { provider: "codex", sessions: 1, usage: { inputTokens: 100 } },
  ]);
  const query = await fetch(
    `${h.api}/projects/${alpha.id}/overview?workspace=elsewhere`,
    { headers: h.headers() },
  );
  expect(query.status).toBe(400);
  const unknown = await fetch(
    `${h.api}/projects/project-00000000-0000-4000-8000-000000000000/overview`,
    { headers: h.headers() },
  );
  expect(unknown.status).toBe(404);
});
