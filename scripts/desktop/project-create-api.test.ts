import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createProjectCreateApi } from "../../apps/desktop/src/project-create-api";
import { NO_PROJECT_NOTIFICATIONS } from "../projects/project-notifications-protocol";
import { projectCatalogFixture } from "../projects/testing";

test("project creation catalog reads accept saved autonomy and reject invalid modes", async () => {
  const catalog = projectCatalogFixture("/fixture");
  catalog.projects[0]!.keeperAutonomy = "suggest-only";
  catalog.projects[0]!.claudeSessionSmith = "claude-journeyman";
  catalog.projects[0]!.budgets = { shiftSpendCapUsd: 5, dailyApiKeyCapUsd: 10 };
  catalog.projects[0]!.notifications = {
    ...NO_PROJECT_NOTIFICATIONS,
    "failed-gate": true,
  };
  let data: unknown = catalog;
  const api = createProjectCreateApi({
    read: async () => Response.json({ ok: true, data, error: null }),
    post: async () => {
      throw Error("Read only fixture");
    },
  });
  expect((await api.catalog()).projects[0]?.keeperAutonomy).toBe(
    "suggest-only",
  );
  expect((await api.catalog()).projects[0]?.claudeSessionSmith).toBe(
    "claude-journeyman",
  );
  expect(
    (await api.catalog()).projects[0]?.notifications?.["failed-gate"],
  ).toBe(true);
  data = {
    ...catalog,
    projects: [{ ...catalog.projects[0], keeperAutonomy: "automatic" }],
  };
  await expect(api.catalog()).rejects.toThrow("could not be verified");
});

test("Keeper visibility public creation catalog preserves optional modes and strict private boundaries without posting", async () => {
  const catalog = projectCatalogFixture("/fixture");
  let data: unknown = catalog,
    posts = 0;
  const api = createProjectCreateApi({
    read: async () => Response.json({ ok: true, data, error: null }),
    post: async () => {
      posts++;
      throw Error("Catalog read must not POST");
    },
  });
  const absent = await api.catalog();
  expect(absent.projects).toHaveLength(1);
  expect(Object.hasOwn(absent.projects[0] ?? {}, "keeperVisibility")).toBe(
    false,
  );
  for (const mode of ["project-metadata", "conversation-only"] as const) {
    data = {
      ...catalog,
      projects: catalog.projects.map((project) => ({
        ...project,
        keeperVisibility: mode,
      })),
    };
    expect((await api.catalog()).projects[0]).toMatchObject({
      keeperVisibility: mode,
    });
  }
  for (const fields of [
    { keeperVisibility: "automatic" },
    { keeperVisibility: null },
    { keeperVisibility: "conversation-only", unknown: true },
  ]) {
    data = {
      ...catalog,
      projects: catalog.projects.map((project) => ({ ...project, ...fields })),
    };
    await expect(api.catalog()).rejects.toThrow("could not be verified");
  }
  data = { ...catalog, createOperations: [] };
  await expect(api.catalog()).rejects.toThrow("could not be verified");
  expect(posts).toBe(0);
});

test("Keeper schedule public catalog accepts only canonical saved values without widening private or create inputs", async () => {
  const catalog = projectCatalogFixture("/fixture");
  const saved = {
    kind: "daily" as const,
    atUtc: "09:30",
    generation: randomUUID(),
    activatedAt: "2026-11-08T09:00:00.000Z",
  };
  let data: unknown = catalog,
    posts = 0;
  const api = createProjectCreateApi({
    read: async () => Response.json({ ok: true, data, error: null }),
    post: async () => {
      posts++;
      throw Error("Read must never write");
    },
  });
  expect(
    Object.hasOwn((await api.catalog()).projects[0] ?? {}, "keeperSchedule"),
  ).toBe(false);
  for (const keeperSchedule of [{ kind: "off" as const }, saved]) {
    data = {
      ...catalog,
      projects: catalog.projects.map((project) => ({
        ...project,
        keeperSchedule,
      })),
    };
    expect((await api.catalog()).projects[0]?.keeperSchedule).toEqual(
      keeperSchedule,
    );
  }
  for (const keeperSchedule of [
    null,
    { kind: "daily", atUtc: "09:30" },
    { ...saved, generation: "invalid" },
    { ...saved, atUtc: "24:00" },
    { ...saved, activatedAt: "2026-02-30T09:00:00.000Z" },
    { ...saved, extra: true },
    { kind: "off", generation: randomUUID() },
  ]) {
    data = {
      ...catalog,
      projects: catalog.projects.map((project) => ({
        ...project,
        keeperSchedule,
      })),
    };
    await expect(api.catalog()).rejects.toThrow("could not be verified");
  }
  data = { ...catalog, createOperations: [] };
  await expect(api.catalog()).rejects.toThrow("could not be verified");
  expect(posts).toBe(0);
});
