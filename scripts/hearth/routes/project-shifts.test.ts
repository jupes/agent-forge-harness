import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { projectCatalogPath } from "../../projects/store";
import {
  FIXTURE_PROJECT_ID,
  projectCatalogFixture,
} from "../../projects/testing";
import { projectShiftOptionsSchema } from "../../shifts/protocol";
import { startTestHearth, type TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";
import { seedProjectBeadWriteFixture } from "./project-bead-write-fixture";

const opened: TestHearth[] = [];
afterEach(async () => {
  for (const hearth of opened.splice(0)) await hearth.close();
});

test("protected shift options read current project scope without a launch, durable reservation or tracker write", async () => {
  const h = await startTestHearth();
  opened.push(h);
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );
  seedProjectBeadWriteFixture(h);
  const path = `${h.api}/projects/${FIXTURE_PROJECT_ID}/shifts/options`;
  expect((await fetch(path, { headers: h.headers() })).status).toBe(403);
  expect(h.bd.calls).toEqual([]);
  const response = await fetch(path, { headers: h.headers(h.hearth.token) });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.ok).toBe(true);
  const parsed = projectShiftOptionsSchema.safeParse(body.data);
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw Error("Unverified shift options");
  expect(parsed.data.projectId).toBe(FIXTURE_PROJECT_ID);
  expect(parsed.data.epics.map((epic) => epic.id)).toEqual(["alpha-epic"]);
  expect(parsed.data.availability.start).toBe(false);
  expect(JSON.stringify(body)).not.toContain("beta-epic");
  expect(h.shifts.launches).toEqual([]);
  expect(h.bd.calls.every((args) => ["export"].includes(args[0] ?? ""))).toBe(
    true,
  );
  expect(existsSync(join(h.home, "project-shifts"))).toBe(false);
  expect(
    (
      await fetch(`${path}?workspace=/other`, {
        headers: h.headers(h.hearth.token),
      })
    ).status,
  ).toBe(400);
});
