import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateHome } from "../hearth/home-guard";
import { createShiftStarts, type ShiftStarts } from "../hearth/shift-launcher";
import { fakeShifts } from "../hearth/testing";
import { resolveCheckout } from "../ledger/workspace";
import { FIXTURE_PROJECT_ID } from "../projects/testing";
import { scratchDirs } from "../test-scratch";
import { createProjectShiftRegistry } from "./registry";

const scratch = scratchDirs(),
  starts: ShiftStarts[] = [];
afterEach(async () => {
  for (const item of starts.splice(0)) await item.close();
  scratch.cleanup();
});
test("project launches re-read the original and use the trusted packaged command with only original ids, sharing canonical close ownership", async () => {
  const root = scratch.make("project-shift-launcher-"),
    home = join(root, "home");
  mkdirSync(join(root, ".git"));
  ensurePrivateHome(home);
  const workspace = resolveCheckout(root).workspace,
    fake = fakeShifts(),
    registry = createProjectShiftRegistry({ root, home });
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
  const saved = await registry.reserve(
    FIXTURE_PROJECT_ID,
    request,
    async () => ({ shiftId: "shift-20261023-063000-0001" }),
  );
  const service = createShiftStarts({
    root,
    home,
    shiftsDir: join(home, "shifts"),
    workspace,
    environment: {
      PATH: "/fixture/bin",
      ANTHROPIC_API_KEY: "PRIVATE-KEY",
      AGENT_FORGE_OPERATOR_TOKEN: "PRIVATE-OPERATOR",
      AGENT_FORGE_HOME: "/foreign",
    },
    launch: fake.launch,
    stopGraceMs: 0,
    projectCommand: ["/fixture/hearth.exe", "--project-shift-run"],
  });
  starts.push(service);
  expect(service.startProject(FIXTURE_PROJECT_ID, request.requestId).ok).toBe(
    false,
  );
  expect(fake.launches).toEqual([]);
  await registry.markAttempted(
    FIXTURE_PROJECT_ID,
    request.requestId,
    saved.intent.requestHash,
  );
  const launched = service.startProject(FIXTURE_PROJECT_ID, request.requestId);
  expect(launched.ok).toBe(true);
  expect(fake.launches[0]?.spec).toEqual({
    argv: [
      "/fixture/hearth.exe",
      "--project-shift-run",
      FIXTURE_PROJECT_ID,
      request.requestId,
    ],
    cwd: root,
    env: { PATH: "/fixture/bin", AGENT_FORGE_HOME: home },
  });
  expect(JSON.stringify(fake.launches[0]?.spec)).not.toContain("PRIVATE");
  expect(service.startProject(FIXTURE_PROJECT_ID, request.requestId).ok).toBe(
    false,
  );
  expect(
    service.startProject(
      "project-82d7a0b0-e24b-4ea0-8a1c-f378dc31c9f7",
      request.requestId,
    ).ok,
  ).toBe(false);
  await service.close();
  expect(fake.launches[0]?.stopped).toBe(true);
  expect(service.startProject(FIXTURE_PROJECT_ID, request.requestId).ok).toBe(
    false,
  );
  expect(fake.launches).toHaveLength(1);
});
