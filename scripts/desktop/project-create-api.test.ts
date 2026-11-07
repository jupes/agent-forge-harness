import { expect, test } from "bun:test";
import { createProjectCreateApi } from "../../apps/desktop/src/project-create-api";
import { NO_PROJECT_NOTIFICATIONS } from "../projects/project-notifications-protocol";
import { projectCatalogFixture } from "../projects/testing";

test("project creation catalog reads accept saved autonomy and reject invalid modes", async () => {
  const catalog = projectCatalogFixture("/fixture");
  catalog.projects[0]!.keeperAutonomy = "suggest-only";
  catalog.projects[0]!.claudeSessionSmith = "claude-journeyman";
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
