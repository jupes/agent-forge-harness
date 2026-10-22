import { afterEach, expect, test } from "bun:test";
import type { ProjectsHome } from "../../../types/project-summary";
import { createProjectStore } from "../../projects/store";
import { startTestHearth, type TestHearth } from "../testing";

const opened: TestHearth[] = [];
afterEach(async () => {
  for (const h of opened.splice(0)) await h.close();
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
