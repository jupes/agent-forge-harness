import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { projectCatalogPath } from "../../projects/store";
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

  const response = await fetch(
    `${h.api}/projects/${FIXTURE_PROJECT_ID}/council/reviews`,
    {
      method: "POST",
      headers: h.headers(h.hearth.token),
      body: JSON.stringify({
        sourceType: "text",
        source: "A bounded inert project review fixture.",
        profile: profilePath,
        maxUsd: 0.25,
        maxBytes: 1024,
        redactSecrets: false,
      }),
    },
  );

  expect(response.status).toBe(202);
  expect(h.commands.calls).toEqual([]);
  expect(existsSync(join(h.root, "council-runs"))).toBe(false);
});
