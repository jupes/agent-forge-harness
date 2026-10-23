import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { ProjectsHome } from "../../../types/project-summary";
import { createProjectStore } from "../../projects/store";
import { createSessionRegistry } from "../../sessions/registry";
import { startTestHearth, type TestHearth } from "../testing";

const opened: TestHearth[] = [];
afterEach(async () => {
  for (const h of opened.splice(0)) await h.close();
});

test("a bead-free Codex Task remains a scoped owned observation without acquiring another project's membership", async () => {
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
  const record = await createSessionRegistry(h.home, "codex").reserve(
    project.id,
    randomUUID(),
    "a".repeat(64),
    () => ({
      provider: "codex",
      mode: "task",
      workspace: h.workspace,
      repository: h.workspace,
      worktree: h.workspace,
      smith: "codex-journeyman",
      requestedModel: "fixture-codex",
      requestedEffort: null,
    }),
  );
  h.append({
    kind: "session.started",
    sessionId: record.id,
    payload: { source: "desktop", kind: "headless", worktree: h.workspace },
  });
  const withOther = await createProjectStore(h.home).create(
    {
      slug: "beta",
      name: "Beta",
      description: "",
      icon: "B",
      workspaces: [
        { root: h.root, repositories: [h.root], epicIds: ["beta-epic"] },
      ],
    },
    catalog.revision,
  );
  const otherProject = withOther.projects.find((item) => item.slug === "beta");
  if (!otherProject) throw Error("Missing other fixture project");
  const response = await fetch(`${h.api}/projects/summary`, {
    headers: h.headers(),
  });
  const envelope: { ok: boolean; data: ProjectsHome } = await response.json();
  expect(response.status).toBe(200);
  expect(envelope.ok).toBe(true);
  expect(
    envelope.data.summaries
      .find((item) => item.projectId === project.id)
      ?.sessions.map((item) => item.sessionId),
  ).toEqual([record.id]);
  expect(record.provider).toBe("codex");
  expect(
    envelope.data.summaries.find((item) => item.projectId === otherProject.id)
      ?.sessions,
  ).toEqual([]);
});

test("home summaries use one readonly export and reject partial tracker output as totals", async () => {
  const h = await startTestHearth();
  opened.push(h);
  await createProjectStore(h.home).create(
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
  const row = {
    id: "alpha-epic",
    title: "Epic",
    issue_type: "epic",
    status: "open",
    labels: ["project:alpha"],
    created_at: "2026-10-21T00:00:00Z",
    updated_at: "2026-10-21T00:00:00Z",
  };
  let stdout = JSON.stringify(row);
  h.bd.answer = (args) =>
    args[0] === "export" ? { status: 0, stdout, stderr: "" } : undefined;
  const read = async () => {
    const response = await fetch(`${h.api}/projects/summary`, {
      headers: h.headers(),
    });
    expect(response.status).toBe(200);
    const envelope: { ok: boolean; data: ProjectsHome } = await response.json();
    expect(envelope.ok).toBe(true);
    return envelope.data;
  };
  expect((await read()).summaries[0]?.beads?.open).toBe(1);
  expect(h.bd.calls.filter((args) => args[0] === "export")).toEqual([
    ["export", "--readonly", "--no-memories"],
  ]);
  stdout += "\n{broken";
  expect((await read()).summaries[0]?.beads).toBeNull();
  stdout = `${JSON.stringify(row)}\nnull`;
  expect((await read()).summaries[0]?.beads).toBeNull();
  stdout = JSON.stringify({ ...row, labels: "project:alphabeta" });
  expect((await read()).summaries[0]?.beads).toBeNull();
});
