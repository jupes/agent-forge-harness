import { afterEach, expect, test } from "bun:test";
import { SupervisorOwnershipRefusalError } from "../../executors/supervisor";
import { projectCatalogPath } from "../../projects/store";
import {
  FIXTURE_PROJECT_ID,
  projectCatalogFixture,
} from "../../projects/testing";
import {
  createProviderInspector,
  type ProviderInspector,
} from "../../providers/inspect";
import { providerReadinessPageSchema } from "../../providers/protocol";
import { startTestHearth, type TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";
import { seedProjectBeadWriteFixture } from "./project-bead-write-fixture";

const opened: TestHearth[] = [];
afterEach(async () => {
  for (const h of opened.splice(0)) await h.close();
});

test("doctor runs after its persisted audit and refreshes one coalesced factual report; local counts stay scoped and partial", async () => {
  let h: TestHearth | undefined;
  const recorded: string[][] = [];
  let requireAudit = false;
  const inspector = createProviderInspector({
    root: "/fixture",
    home: "/private-fixture",
    environment: {},
    which: (binary) => (binary === "claude" ? "/fixture/claude" : null),
    run: async (command) => {
      if (requireAudit)
        expect(
          h
            ?.events(["operator.action"])
            .some(
              (event) =>
                event.kind === "operator.action" &&
                event.payload.action === "provider.doctor",
            ),
        ).toBe(true);
      recorded.push([...command]);
      return command.includes("--version")
        ? { exitCode: 0, stdout: "2.1.296", valid: true }
        : {
            exitCode: 0,
            stdout:
              '{"authMethod":"claude.ai","loggedIn":true,"email":"private@example.test","token":"never-forward"}',
            valid: true,
          };
    },
  });
  h = await startTestHearth({ api: { providerInspector: inspector } });
  opened.push(h);
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );
  seedProjectBeadWriteFixture(h);
  for (const [sessionId, beadId, inputTokens] of [
    ["own", "alpha-task", 2],
    ["own", "alpha-task", 3],
    ["foreign", "beta-task", 500],
  ] as const)
    h.append({
      kind: "session.ended",
      sessionId,
      beadId,
      executor: { provider: "claude", model: "fixture" },
      payload: { usage: { inputTokens } },
    });
  const url = `${h.api}/providers/readiness`,
    headers = h.headers(h.hearth.token);
  expect((await fetch(url, { headers: h.headers() })).status).toBe(403);
  expect(recorded).toEqual([]);
  const [one, two] = await Promise.all([
    fetch(url, { headers }),
    fetch(url, { headers }),
  ]);
  const body = await one.json();
  expect(body.ok).toBe(true);
  expect(two.status).toBe(200);
  const page = providerReadinessPageSchema.parse(body.data);
  expect(page.providers[0]?.state).toBe("subscription");
  expect(
    page.providers[0]?.usage.find((row) => row.id === "local-inputTokens")
      ?.used,
  ).toBe(503);
  expect(
    page.providers[0]?.usage.every((row) => row.percentUsed === null),
  ).toBe(true);
  const own = page.localUsage.projects?.find(
    (project) => project.projectId === FIXTURE_PROJECT_ID,
  )?.providers[0];
  expect(own?.inputTokens).toBe(3);
  expect(own?.outputTokens).toBeNull();
  expect(own?.costUsd).toBeNull();
  expect(recorded).toHaveLength(2);
  expect(JSON.stringify(page)).not.toContain("never-forward");
  expect(JSON.stringify(page)).not.toContain("private@example.test");
  const doctor = `${h.api}/providers/claude/doctor`;
  expect(
    (
      await fetch(doctor, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: '{"task":true}',
      })
    ).status,
  ).toBe(400);
  expect(recorded).toHaveLength(2);
  requireAudit = true;
  expect(
    (
      await fetch(doctor, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
  ).toBe(200);
  expect(recorded).toHaveLength(4);
});

test("provider reports are protected, bounded and factual; reads never run paid tasks or expose credential fields", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const url = `${h.api}/providers/readiness`;
  expect((await fetch(url, { headers: h.headers() })).status).toBe(403);
  const response = await fetch(url, { headers: h.headers(h.hearth.token) });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.ok).toBe(true);
  const parsed = providerReadinessPageSchema.safeParse(body.data);
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw Error("Unverified provider report");
  expect(parsed.data.providers.map((item) => item.provider)).toEqual([
    "claude",
    "codex",
    "gemini",
    "grok",
    "openrouter",
  ]);
  expect(
    parsed.data.providers.every((item) => item.installation.found === false),
  ).toBe(true);
  expect(
    parsed.data.providers.every(
      (item) => item.authentication.mode === "unknown",
    ),
  ).toBe(true);
  expect(parsed.data.providers.every((item) => item.usage.length === 0)).toBe(
    true,
  );
  expect(
    (await fetch(`${url}?key=secret`, { headers: h.headers(h.hearth.token) }))
      .status,
  ).toBe(400);
});

test("readiness ownership refusal is a generic 503 and does not cache an invalid report", async () => {
  let refuseClaude = true;
  let claudeInspections = 0;
  const unavailable = createProviderInspector({
    root: "/fixture",
    home: "/private-fixture",
    environment: {},
    which: () => null,
  });
  const inspector: ProviderInspector = {
    async inspect(provider, envPass) {
      if (provider === "claude") {
        claudeInspections++;
        if (refuseClaude)
          throw new SupervisorOwnershipRefusalError(
            "Interactive child ownership could not be established.",
          );
      }
      return unavailable.inspect(provider, envPass);
    },
  };
  const h = await startTestHearth({ api: { providerInspector: inspector } });
  opened.push(h);
  const url = `${h.api}/providers/readiness`;
  expect((await fetch(url, { headers: h.headers() })).status).toBe(403);
  expect(claudeInspections).toBe(0);

  const refused = await fetch(url, { headers: h.headers(h.hearth.token) });
  expect(refused.status).toBe(503);
  const refusedBody = await refused.json();
  expect(refusedBody).toEqual({
    ok: false,
    data: null,
    error:
      "Provider readiness could not be verified. Refresh before relying on this report.",
  });
  expect(JSON.stringify(refusedBody)).not.toContain(
    "Interactive child ownership could not be established.",
  );
  expect(claudeInspections).toBe(1);

  refuseClaude = false;
  const recovered = await fetch(url, { headers: h.headers(h.hearth.token) });
  expect(recovered.status).toBe(200);
  const recoveredBody = await recovered.json();
  expect(recoveredBody.ok).toBe(true);
  const report = providerReadinessPageSchema.parse(recoveredBody.data);
  expect(report.providers[0]?.installation.found).toBe(false);
  expect(claudeInspections).toBe(2);
});
