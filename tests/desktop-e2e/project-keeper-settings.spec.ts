import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import { HEARTH_HOME } from "../e2e/servers";
import {
  alpha,
  catalogFile,
  catalog as fixtureCatalog,
  seedKeeper,
  seedProjects,
} from "./project-fixtures";

test("Keeper default saves, reloads and conflicts while retaining the existing conversation", async ({
  page,
}) => {
  const keeperProjectId = `project-${randomUUID()}`;
  seedProjects();
  writeFileSync(
    catalogFile,
    JSON.stringify({
      ...fixtureCatalog,
      projects: fixtureCatalog.projects.map((project) =>
        project.id === alpha.id ? { ...project, id: keeperProjectId } : project,
      ),
    }),
  );
  seedKeeper(
    [
      {
        kind: "process",
        pid: 123,
        smith: "claude-master",
        requestedModel: "fixture",
        requestedEffort: "high",
      },
      { kind: "text", text: "Retained Keeper answer" },
    ],
    keeperProjectId,
  );
  const journal = join(
    HEARTH_HOME,
    "conversations",
    `keeper-${keeperProjectId}.json`,
  );
  const original = readFileSync(journal, "utf8");
  let posts = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/settings/keeper")
    )
      posts++;
  });
  await openSettled(
    page,
    `/index.html#/desktop/project/${keeperProjectId}/project-settings`,
  );
  const section = page.getByRole("region", {
    name: "Forge Keeper",
    exact: true,
  });
  const choice = section.getByRole("combobox", {
    name: "Keeper Smith",
    exact: true,
  });
  await expect(choice).toBeEnabled();
  await choice.focus();
  await expect(choice).toBeFocused();
  await expect(choice).toHaveCSS("outline-style", "solid");
  await choice.selectOption("codex-journeyman");
  const autonomy = section.getByRole("combobox", {
    name: "Keeper autonomy",
    exact: true,
  });
  await autonomy.selectOption("suggest-only");
  await section
    .getByRole("button", { name: "Save Keeper settings", exact: true })
    .click();
  await expect(
    section
      .getByRole("status")
      .filter({ hasText: "Keeper settings read at revision" }),
  ).toContainText("Keeper settings read at revision 2");
  expect(posts).toBe(1);
  expect(readFileSync(journal, "utf8")).toBe(original);
  await reloadSettled(page);
  await expect(choice).toHaveValue("codex-journeyman");
  await expect(autonomy).toHaveValue("suggest-only");
  await expect(section).toContainText("Saved autonomy: Suggest only");
  await expect(section).toContainText(
    "Saved project default: codex-journeyman",
  );
  // A refused concurrent write leaves the draft visible and requires a fresh comparison.
  await page.route("**/__agent-forge/projects/*/settings/keeper", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        data: null,
        error: "Fixture revision conflict",
      }),
    }),
  );
  await choice.selectOption("claude-master");
  await section
    .getByRole("button", { name: "Save Keeper settings", exact: true })
    .click();
  await expect(section).toContainText("The project changed before saving");
  await expect(choice).toHaveValue("claude-master");
  await expect(
    section.getByRole("button", { name: "Save Keeper settings", exact: true }),
  ).toBeDisabled();
  expect(readFileSync(journal, "utf8")).toBe(original);
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: ".tmp/work/keeper-default-browser-spaced.png",
    fullPage: true,
  });
});
