import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import { HEARTH_HOME } from "../e2e/servers";
import { alpha, seedKeeper, seedProjects } from "./project-fixtures";

test("Keeper default saves, reloads and conflicts while retaining the existing conversation", async ({
  page,
}) => {
  seedProjects();
  seedKeeper([
    {
      kind: "process",
      pid: 123,
      smith: "claude-master",
      requestedModel: "fixture",
      requestedEffort: "high",
    },
    { kind: "text", text: "Retained Keeper answer" },
  ]);
  const journal = join(HEARTH_HOME, "conversations", `keeper-${alpha.id}.json`);
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
    `/index.html#/desktop/project/${alpha.id}/project-settings`,
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
  await section
    .getByRole("button", { name: "Save Keeper default", exact: true })
    .click();
  await expect(section.getByRole("status")).toContainText(
    "Keeper settings read at revision 2",
  );
  expect(posts).toBe(1);
  expect(readFileSync(journal, "utf8")).toBe(original);
  await reloadSettled(page);
  await expect(choice).toHaveValue("codex-journeyman");
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
    .getByRole("button", { name: "Save Keeper default", exact: true })
    .click();
  await expect(section).toContainText("The project changed before saving");
  await expect(choice).toHaveValue("claude-master");
  await expect(
    section.getByRole("button", { name: "Save Keeper default", exact: true }),
  ).toBeDisabled();
  expect(readFileSync(journal, "utf8")).toBe(original);
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: ".tmp/work/keeper-default-browser-spaced.png",
    fullPage: true,
  });
});
