import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createProjectStore, projectCatalogPath } from "../../projects/store";
import {
  FIXTURE_PROJECT_ID,
  projectCatalogFixture,
} from "../../projects/testing";
import { startTestHearth, type TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";

const opened: TestHearth[] = [];
afterEach(async () => {
  for (const hearth of opened.splice(0)) await hearth.close();
});

test("a project Council review reserves against the current project and advertised inert profile without starting a run", async () => {
  const h = await startTestHearth();
  opened.push(h);
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );

  const profileResponse = await fetch(`${h.api}/council-api/profiles`);
  expect(profileResponse.status).toBe(200);
  const envelope: unknown = await profileResponse.json();
  if (
    typeof envelope !== "object" ||
    envelope === null ||
    Array.isArray(envelope) ||
    Object.keys(envelope).length !== 3 ||
    !("ok" in envelope) ||
    envelope.ok !== true ||
    !("error" in envelope) ||
    envelope.error !== null ||
    !("data" in envelope) ||
    !Array.isArray(envelope.data)
  )
    throw new Error("The advertised Council profile response is invalid.");
  const rawProfiles = envelope.data;
  if (
    !Array.isArray(rawProfiles) ||
    rawProfiles.length === 0 ||
    rawProfiles.length > 128
  )
    throw new Error("The advertised Council profile list is invalid.");
  const profile = rawProfiles.find(
    (choice: unknown): choice is Record<string, unknown> =>
      typeof choice === "object" &&
      choice !== null &&
      !Array.isArray(choice) &&
      "id" in choice &&
      choice.id === "default-review",
  );
  if (!profile) throw new Error("The inert demo Council profile is missing.");
  const profilePath = profile["path"],
    readiness = profile["readiness"],
    seats = profile["seats"],
    chair = profile["chair"];
  if (
    typeof profilePath !== "string" ||
    profilePath.length > 4096 ||
    !isAbsolute(profilePath) ||
    !Array.isArray(readiness) ||
    readiness.length === 0 ||
    readiness.length > 32 ||
    !readiness.every(
      (entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        !Array.isArray(entry) &&
        "configured" in entry &&
        entry.configured === true,
    ) ||
    !Array.isArray(seats) ||
    seats.length === 0 ||
    seats.length > 32 ||
    !seats.every(
      (seat: unknown) =>
        typeof seat === "object" &&
        seat !== null &&
        !Array.isArray(seat) &&
        "provider" in seat &&
        seat.provider === "fake",
    ) ||
    typeof chair !== "object" ||
    chair === null ||
    Array.isArray(chair) ||
    !("provider" in chair) ||
    chair.provider !== "fake"
  )
    throw new Error("The advertised Council profile is not inert and valid.");

  const request = {
    sourceChoice: {
      sourceType: "text",
      source: "A bounded inert project review fixture.",
    },
    profileChoice: profilePath,
    maxUsd: 0.25,
    maxBytes: 1024,
    redactSecrets: false,
  };
  const post = () =>
    fetch(`${h.api}/projects/${FIXTURE_PROJECT_ID}/council/reviews`, {
      method: "POST",
      headers: h.headers(h.hearth.token),
      body: JSON.stringify(request),
    });
  const response = await post();
  expect(response.status).toBe(202);
  const reserved: unknown = await response.json();
  if (
    typeof reserved !== "object" || reserved === null || Array.isArray(reserved) ||
    !("data" in reserved) || typeof reserved.data !== "object" ||
    reserved.data === null || Array.isArray(reserved.data) ||
    !("metadata" in reserved.data) || typeof reserved.data.metadata !== "object" ||
    reserved.data.metadata === null || Array.isArray(reserved.data.metadata) ||
    !("requestId" in reserved.data.metadata) || typeof reserved.data.metadata.requestId !== "string" ||
    !("intentHash" in reserved.data.metadata) || typeof reserved.data.metadata.intentHash !== "string"
  )
    throw new Error("The reserved project Council original is missing its identity.");
  const metadata = reserved.data.metadata;
  expect(reserved.data).toMatchObject({ created: true });
  expect(JSON.stringify(reserved.data)).not.toContain(request.sourceChoice.source);

  const retry = await post();
  expect(retry.status).toBe(202);
  expect(await retry.json()).toMatchObject({
    data: { created: false, metadata: { requestId: metadata.requestId, intentHash: metadata.intentHash } },
  });

  const exactResponse = await fetch(
    `${h.api}/projects/${FIXTURE_PROJECT_ID}/council/reviews/${metadata.requestId}`,
    { headers: h.headers(h.hearth.token) },
  );
  expect(exactResponse.status).toBe(200);
  expect(await exactResponse.json()).toMatchObject({
    data: {
      metadata: { requestId: metadata.requestId, state: "reserved" },
      context: { evidence: [{ content: request.sourceChoice.source }] },
    },
  });
  const runResponse = await fetch(
    `${h.api}/projects/${FIXTURE_PROJECT_ID}/council/reviews/${metadata.requestId}/run`,
    { headers: h.headers(h.hearth.token) },
  );
  expect(runResponse.status).toBe(200);
  expect(await runResponse.json()).toMatchObject({
    data: { receipt: { phase: "reserved" }, job: null },
  });
  expect(h.commands.calls).toEqual([]);
  expect(existsSync(join(h.root, "council-runs"))).toBe(false);
  expect(h.events(["council.run.started", "council.run.finished"])).toEqual([]);
});

test("project Council commit refuses a scope change before dispatch and keeps the reviewed original", async () => {
  const h = await startTestHearth();
  opened.push(h);
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );
  const profileResponse = await fetch(`${h.api}/council-api/profiles`);
  expect(profileResponse.status).toBe(200);
  const profileEnvelope: unknown = await profileResponse.json();
  if (
    typeof profileEnvelope !== "object" || profileEnvelope === null ||
    Array.isArray(profileEnvelope) || !("data" in profileEnvelope) ||
    !Array.isArray(profileEnvelope.data)
  )
    throw new Error("The advertised Council profile list is invalid.");
  const profile = profileEnvelope.data.find(
    (choice: unknown): choice is Record<string, unknown> =>
      typeof choice === "object" && choice !== null && !Array.isArray(choice) &&
      "id" in choice && choice.id === "default-review" &&
      "path" in choice && typeof choice.path === "string" &&
      "seats" in choice && Array.isArray(choice.seats) &&
      choice.seats.every((seat: unknown) =>
        typeof seat === "object" && seat !== null && !Array.isArray(seat) &&
        "provider" in seat && seat.provider === "fake",
      ) &&
      "chair" in choice && typeof choice.chair === "object" &&
      choice.chair !== null && !Array.isArray(choice.chair) &&
      "provider" in choice.chair && choice.chair.provider === "fake",
  );
  if (!profile || typeof profile.path !== "string")
    throw new Error("The advertised inert demo Council profile is missing.");

  const source = "Scope drift must hold the reviewed project Council original.";
  const reserve = await fetch(`${h.api}/projects/${FIXTURE_PROJECT_ID}/council/reviews`, {
    method: "POST",
    headers: h.headers(h.hearth.token),
    body: JSON.stringify({
      sourceChoice: { sourceType: "text", source },
      profileChoice: profile.path,
      maxUsd: 0.25,
      maxBytes: 1024,
      redactSecrets: false,
    }),
  });
  expect(reserve.status).toBe(202);
  const reserved: unknown = await reserve.json();
  if (
    typeof reserved !== "object" || reserved === null || Array.isArray(reserved) ||
    !("data" in reserved) || typeof reserved.data !== "object" || reserved.data === null ||
    Array.isArray(reserved.data) || !("metadata" in reserved.data) ||
    typeof reserved.data.metadata !== "object" || reserved.data.metadata === null ||
    Array.isArray(reserved.data.metadata) || !("requestId" in reserved.data.metadata) ||
    typeof reserved.data.metadata.requestId !== "string" ||
    !("intentHash" in reserved.data.metadata) || typeof reserved.data.metadata.intentHash !== "string"
  )
    throw new Error("The project Council original did not return its identity.");
  const { requestId, intentHash } = reserved.data.metadata;

  const catalog = createProjectStore(h.home).read();
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify({ ...catalog, revision: catalog.revision + 1 }),
  );
  const commit = await fetch(
    `${h.api}/projects/${FIXTURE_PROJECT_ID}/council/reviews/${requestId}/commit`,
    {
      method: "POST",
      headers: h.headers(h.hearth.token),
      body: JSON.stringify({ intentHash }),
    },
  );
  expect(commit.status).toBe(409);
  expect(await commit.json()).toMatchObject({ ok: false });
  expect(h.commands.calls).toEqual([]);
  expect(h.events(["council.run.started", "council.run.finished"])).toEqual([]);
  expect(existsSync(join(h.root, "council-runs"))).toBe(false);

  const exact = await fetch(
    `${h.api}/projects/${FIXTURE_PROJECT_ID}/council/reviews/${requestId}`,
    { headers: h.headers(h.hearth.token) },
  );
  expect(exact.status).toBe(200);
  expect(await exact.json()).toMatchObject({
    data: {
      metadata: { requestId, state: "reserved" },
      context: { evidence: [{ content: source }] },
    },
  });
});
