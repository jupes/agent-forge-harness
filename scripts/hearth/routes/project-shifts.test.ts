import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { projectCatalogPath } from "../../projects/store";
import {
  FIXTURE_PROJECT_ID,
  projectCatalogFixture,
} from "../../projects/testing";
import { projectShiftOptionsSchema } from "../../shifts/protocol";
import {
  createProjectShiftRegistry,
  projectShiftRegistryFile,
} from "../../shifts/registry";
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

test("the installed attended launcher admits one audited original and exact retries read it before changed scope without relaunch", async () => {
  const h = await startTestHearth({ api: { projectShiftRuntime: undefined } });
  opened.push(h);
  const catalog = projectCatalogFixture(h.workspace);
  writeOwnerOnly(projectCatalogPath(h.home), JSON.stringify(catalog));
  seedProjectBeadWriteFixture(h);
  const path = `${h.api}/projects/${FIXTURE_PROJECT_ID}/shifts`;
  const post = (body: unknown, token: string | null = h.hearth.token) =>
    fetch(path, {
      method: "POST",
      headers: { ...h.headers(token), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await post(FIXTURE_SHIFT_START, null)).status).toBe(403);
  expect(h.bd.calls).toEqual([]);
  expect(existsSync(projectShiftRegistryFile(h.home))).toBe(false);
  const options = await fetch(`${path}/options`, {
    headers: h.headers(h.hearth.token),
  });
  expect((await options.json()).data.availability).toEqual({
    start: true,
    reason: null,
  });
  h.bd.calls.length = 0;
  const first = await post(FIXTURE_SHIFT_START);
  expect(first.status).toBe(202);
  const one = (await first.json()).data;
  expect(one.observation.phase).toBe("starting");
  expect(one.observation.actual).toBeNull();
  expect(one.intent.request).toEqual(FIXTURE_SHIFT_START);
  expect(one.intent.attemptedAt).not.toBeNull();
  expect(h.events(["operator.action"]).at(-1)?.payload).toMatchObject({
    action: "shift.start",
    target: FIXTURE_SHIFT_START.requestId,
  });
  expect(h.shifts.launches).toHaveLength(1);
  expect(h.shifts.launches[0]?.spec.argv.slice(-2)).toEqual([
    FIXTURE_PROJECT_ID,
    FIXTURE_SHIFT_START.requestId,
  ]);
  expect(h.bd.calls.some((args) => args[0] === "export")).toBe(true);
  const bytes = readFileSync(projectShiftRegistryFile(h.home), "utf8");
  if (catalog.projects[0]) catalog.projects[0].archived = true;
  catalog.revision++;
  writeOwnerOnly(projectCatalogPath(h.home), JSON.stringify(catalog));
  h.bd.answer = () => ({ status: 1, stdout: "", stderr: "UNAVAILABLE" });
  h.bd.calls.length = 0;
  const repeated = await post(FIXTURE_SHIFT_START);
  expect(repeated.status).toBe(202);
  expect((await repeated.json()).data.intent).toEqual(one.intent);
  expect(h.bd.calls).toEqual([]);
  expect(h.shifts.launches).toHaveLength(1);
  expect(readFileSync(projectShiftRegistryFile(h.home), "utf8")).toBe(bytes);
  expect(
    (
      await post({
        ...FIXTURE_SHIFT_START,
        options: { ...FIXTURE_SHIFT_START.options, maxBeads: 5 },
      })
    ).status,
  ).toBe(409);
  expect(h.shifts.launches).toHaveLength(1);
});

test("a new attended original validates current catalog and archive before reserving or launching", async () => {
  const h = await startTestHearth({ api: { projectShiftRuntime: undefined } });
  opened.push(h);
  const catalog = projectCatalogFixture(h.workspace);
  writeOwnerOnly(projectCatalogPath(h.home), JSON.stringify(catalog));
  seedProjectBeadWriteFixture(h);
  const post = (request = FIXTURE_SHIFT_START) =>
    fetch(`${h.api}/projects/${FIXTURE_PROJECT_ID}/shifts`, {
      method: "POST",
      headers: {
        ...h.headers(h.hearth.token),
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    });
  expect(
    (await post({ ...FIXTURE_SHIFT_START, expectedCatalogRevision: 999 }))
      .status,
  ).toBe(409);
  if (catalog.projects[0]) catalog.projects[0].archived = true;
  writeOwnerOnly(projectCatalogPath(h.home), JSON.stringify(catalog));
  expect((await post()).status).toBe(409);
  expect(existsSync(projectShiftRegistryFile(h.home))).toBe(false);
  expect(h.shifts.launches).toEqual([]);
});

test("failed Start audit refuses before current-scope reads, original persistence or the attended child", async () => {
  const h = await startTestHearth({
    api: {
      projectShiftRuntime: undefined,
      appendEvent: () => ({ ok: false, error: "fixture audit unavailable" }),
    },
  });
  opened.push(h);
  const response = await fetch(
    `${h.api}/projects/${FIXTURE_PROJECT_ID}/shifts`,
    {
      method: "POST",
      headers: {
        ...h.headers(h.hearth.token),
        "content-type": "application/json",
      },
      body: JSON.stringify(FIXTURE_SHIFT_START),
    },
  );
  expect(response.status).toBe(503);
  expect(h.bd.calls).toEqual([]);
  expect(existsSync(projectShiftRegistryFile(h.home))).toBe(false);
  expect(h.shifts.launches).toEqual([]);
});

test("protected startup Stop is original-scoped and audited before cancelling its held child; cleanup survives archive without source reads", async () => {
  const h = await startTestHearth({ api: { projectShiftRuntime: undefined } });
  opened.push(h);
  const catalog = projectCatalogFixture(h.workspace);
  writeOwnerOnly(projectCatalogPath(h.home), JSON.stringify(catalog));
  seedProjectBeadWriteFixture(h);
  const path = `${h.api}/projects/${FIXTURE_PROJECT_ID}/shifts`,
    post = (
      url: string,
      body: unknown = {},
      token: string | null = h.hearth.token,
    ) =>
      fetch(url, {
        method: "POST",
        headers: { ...h.headers(token), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
  const start = await post(path, FIXTURE_SHIFT_START);
  expect(start.status).toBe(202);
  const original = (await start.json()).data,
    id = original.intent.shiftId,
    child = h.shifts.launches[0],
    file = projectShiftRegistryFile(h.home),
    before = readFileSync(file, "utf8");
  if (!child) throw Error("Expected one held fixture child");
  expect(original.observation.phase).toBe("starting");
  if (catalog.projects[0]) catalog.projects[0].archived = true;
  catalog.revision++;
  writeOwnerOnly(projectCatalogPath(h.home), JSON.stringify(catalog));
  h.bd.calls.length = 0;
  h.bd.answer = () => ({ status: 1, stdout: "", stderr: "UNAVAILABLE" });
  const stop = `${path}/${id}/stop`;
  expect((await post(stop, {}, null)).status).toBe(403);
  expect((await post(stop, { pid: child.pid })).status).toBe(400);
  expect(
    (
      await post(
        stop.replace(
          FIXTURE_PROJECT_ID,
          "project-a38c579e-f311-481c-b84e-47e5110024a0",
        ),
      )
    ).status,
  ).toBe(404);
  expect(readFileSync(file, "utf8")).toBe(before);
  expect(child.stopped).toBe(false);
  // The unscoped legacy route still has no startup control authority.
  expect((await post(`${h.api}/shifts/${id}/stop`)).status).toBe(409);
  expect(child.stopped).toBe(false);
  const stopped = await post(stop);
  expect(stopped.status).toBe(202);
  const receipt = (await stopped.json()).data;
  expect(receipt.observation.phase).toBe("stopped");
  expect(receipt.observation.actual).toBeNull();
  expect(receipt.intent.startupStop.completedAt).toBeString();
  expect(receipt.intent.requestHash).toBe(original.intent.requestHash);
  expect(child.stopped).toBe(true);
  expect(h.events(["operator.action"]).at(-1)?.payload).toMatchObject({
    action: "shift.stop",
    target: id,
  });
  expect((await post(stop)).status).toBe(202);
  expect(h.shifts.launches).toHaveLength(1);
  expect(h.bd.calls).toEqual([]);
  expect(existsSync(join(h.home, "shifts", `${id}.json`))).toBe(false);
  expect(existsSync(join(h.home, "shifts", `${id}.stop`))).toBe(false);
});

test("failed startup Stop audit preserves the exact original before any control receipt or held-tree effect", async () => {
  const h = await startTestHearth({
    api: {
      appendEvent: () => ({ ok: false, error: "Stop audit unavailable" }),
    },
  });
  opened.push(h);
  await seedProjectShift(h);
  const registry = createProjectShiftRegistry({ home: h.home, root: h.root }),
    original = registry.read(FIXTURE_PROJECT_ID, FIXTURE_SHIFT_START.requestId);
  await registry.markAttempted(
    FIXTURE_PROJECT_ID,
    FIXTURE_SHIFT_START.requestId,
    original.requestHash,
  );
  const file = projectShiftRegistryFile(h.home),
    before = readFileSync(file, "utf8");
  const response = await fetch(
    `${h.api}/projects/${FIXTURE_PROJECT_ID}/shifts/${FIXTURE_SHIFT_ID}/stop`,
    {
      method: "POST",
      headers: {
        ...h.headers(h.hearth.token),
        "content-type": "application/json",
      },
      body: "{}",
    },
  );
  expect(response.status).toBe(503);
  expect(readFileSync(file, "utf8")).toBe(before);
  expect(h.shifts.launches).toEqual([]);
  expect(h.bd.calls).toEqual([]);
});
