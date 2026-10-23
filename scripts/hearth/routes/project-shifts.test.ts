import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { projectCatalogPath } from "../../projects/store";
import {
  FIXTURE_PROJECT_ID,
  projectCatalogFixture,
} from "../../projects/testing";
import { projectShiftOptionsSchema } from "../../shifts/protocol";
import { createProjectShiftRegistry } from "../../shifts/registry";
import { startTestHearth, type TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";
import { seedProjectBeadWriteFixture } from "./project-bead-write-fixture";
import {
  FIXTURE_SHIFT_ID,
  FIXTURE_SHIFT_START,
  seedProjectShift,
} from "./project-shift-fixture";

const opened: TestHearth[] = [];
afterEach(async () => {
  for (const hearth of opened.splice(0)) await hearth.close();
});

test("only a correlated project manifest authorizes canonical Stop and Recover, including after archive without mutable source reads", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const catalog = projectCatalogFixture(h.workspace);
  if (catalog.projects[0]) catalog.projects[0].archived = true;
  writeOwnerOnly(projectCatalogPath(h.home), JSON.stringify(catalog));
  h.bd.answer = () => ({ status: 1, stdout: "", stderr: "UNAVAILABLE" });
  const action = async (shiftId: string, control: string) =>
    fetch(
      `${h.api}/projects/${FIXTURE_PROJECT_ID}/shifts/${shiftId}/${control}`,
      {
        method: "POST",
        headers: {
          ...h.headers(h.hearth.token),
          "content-type": "application/json",
        },
        body: "{}",
      },
    );
  expect((await action(FIXTURE_SHIFT_ID, "stop")).status).toBe(404);
  await seedProjectShift(h, "live");
  h.bd.calls.length = 0;
  const stopped = await action(FIXTURE_SHIFT_ID, "stop");
  expect(stopped.status).toBe(200);
  expect((await stopped.json()).data.observation.phase).toBe("stopping");
  expect(h.bd.calls).toEqual([]);
  await seedProjectShift(h, "dead");
  const recovered = await action(FIXTURE_SHIFT_ID, "recover");
  expect(recovered.status).toBe(200);
  const result = await recovered.json();
  expect(result.data.observation.phase).toBe("stopped");
  expect(result.data.intent.request).toEqual(FIXTURE_SHIFT_START);
  expect(result.data.record).toBeUndefined();
  expect(h.shifts.launches).toEqual([]);
});

test("project original/list reads are protected, inert and survive archived or unavailable mutable sources; Start is audited then held until attended", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const request = {
    requestId: "b14cc7eb-3231-4930-a288-d411c5ee0426",
    expectedCatalogRevision: 1,
    options: {
      for: "2h",
      concurrency: 2,
      maxBeads: 4,
      maxUsd: 10,
      repairs: 3,
      base: "master",
    },
  };
  const path = `/projects/${FIXTURE_PROJECT_ID}/shifts`;
  const registry = createProjectShiftRegistry({ home: h.home, root: h.root });
  await registry.reserve(FIXTURE_PROJECT_ID, request, async () => ({
    shiftId: "shift-20261023-063000-0001",
  }));
  expect(
    (
      await fetch(`${h.api}${path}/requests/${request.requestId}`, {
        headers: h.headers(),
      })
    ).status,
  ).toBe(403);
  h.bd.calls.length = 0;
  h.bd.answer = () => ({ status: 1, stdout: "", stderr: "UNAVAILABLE" });
  for (const suffix of ["", `/requests/${request.requestId}`]) {
    const response = await fetch(`${h.api}${path}${suffix}`, {
      headers: h.headers(h.hearth.token),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(JSON.stringify(body.data)).toContain(request.requestId);
  }
  expect(h.bd.calls).toEqual([]);
  expect(h.shifts.launches).toEqual([]);
  const first = await fetch(`${h.api}${path}`, {
    method: "POST",
    headers: {
      ...h.headers(h.hearth.token),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      ...request,
      requestId: "5bb5fd7a-0729-457b-af9d-4f49ca690f01",
    }),
  });
  expect(first.status).toBe(503);
  expect(h.events(["operator.action"]).at(-1)?.payload).toMatchObject({
    action: "shift.start",
    target: "5bb5fd7a-0729-457b-af9d-4f49ca690f01",
  });
  expect(registry.list(FIXTURE_PROJECT_ID)).toHaveLength(1);
  expect(h.shifts.launches).toEqual([]);
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
