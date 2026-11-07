import { expect, test } from "bun:test";
import { createProjectCreateApi } from "../../apps/desktop/src/project-create-api";
import { projectCatalogFixture } from "../projects/testing";

test("project creation catalog reads accept saved autonomy and reject invalid modes", async () => {
  const catalog = projectCatalogFixture("/fixture");
  catalog.projects[0]!.keeperAutonomy = "suggest-only";
  catalog.projects[0]!.claudeSessionSmith = "claude-journeyman";
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
  data = {
    ...catalog,
    projects: [{ ...catalog.projects[0], keeperAutonomy: "automatic" }],
  };
  await expect(api.catalog()).rejects.toThrow("could not be verified");
});
