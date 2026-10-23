import { afterEach, expect, test } from "bun:test";
import { projectCatalogPath } from "../../projects/store";
import {
  FIXTURE_PROJECT_ID,
  projectCatalogFixture,
} from "../../projects/testing";
import { projectWorkbenchPageSchema } from "../../projects/workbench-protocol";
import { startTestHearth, type TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";
import { seedProjectBeadWriteFixture } from "./project-bead-write-fixture";

const opened: TestHearth[] = [];
afterEach(async () => {
  for (const h of opened.splice(0)) await h.close();
});

test("Workbench is protected and project-scoped; read refreshes are inert and foreign/query scope is refused", async () => {
  const h = await startTestHearth();
  opened.push(h);
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );
  seedProjectBeadWriteFixture(h);
  for (const id of ["alpha-task", "beta-epic"]) {
    const row = h.bd.issues.get(id);
    if (!row) throw Error("Missing queue fixture");
    h.bd.issues.set(id, {
      ...row,
      labels: [...(row.labels ?? []), "queue:proposed"],
      metadata: { queue_state: "proposed" },
    });
  }
  const path = `${h.api}/projects/${FIXTURE_PROJECT_ID}/workbench`;
  const mark = h.bd.calls.length;
  expect((await fetch(path, { headers: h.headers() })).status).toBe(403);
  expect(h.bd.calls.length).toBe(mark);
  const response = await fetch(path, { headers: h.headers(h.hearth.token) });
  expect(response.status).toBe(200);
  const reply = await response.json();
  expect(reply.ok).toBe(true);
  const parsed = projectWorkbenchPageSchema.safeParse(reply.data);
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw Error("Unverified Workbench reply");
  expect(parsed.data.cards.map((card) => card.entry.beadId)).toEqual([
    "alpha-task",
  ]);
  expect(parsed.data.cards[0]?.moves).toEqual(["approve", "pause", "reassign"]);
  expect(JSON.stringify(reply)).not.toContain("beta-epic");
  expect(
    h.bd.calls.some((args) => args[0] === "update" || args[0] === "create"),
  ).toBe(false);
  expect(
    (
      await fetch(`${path}?workspace=/other`, {
        headers: h.headers(h.hearth.token),
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await fetch(
        `${h.api}/projects/project-b5832fa0-7a21-403b-8184-44892f0d8d86/workbench`,
        { headers: h.headers(h.hearth.token) },
      )
    ).status,
  ).toBe(404);
});
