import { expect, test } from "@playwright/test";
import { runsHref } from "../../apps/desktop/src/project-runs-model";
import { openSettled } from "../e2e/fixtures";
import { alpha, seedProjects } from "./project-fixtures";

const protectedPosts: string[] = [];

test.beforeEach(({ page }) => {
  seedProjects();
  protectedPosts.length = 0;
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (
      request.method() === "POST" &&
      pathname.startsWith("/__agent-forge/")
    )
      protectedPosts.push(pathname);
  });
});

test.afterEach(() => {
  expect(protectedPosts).toEqual([]);
});

test("New forge run opens attended preparation only after the scoped Runs read", async ({
  page,
}) => {
  await openRuns(page);
  const runs = page.getByRole("region", { name: "Project forge runs" });
  const launch = runs.getByRole("button", {
    name: "New forge run",
    exact: true,
  });
  await expect(launch).toBeEnabled();
  await launch.click();

  const preparation = page.getByRole("dialog");
  await expect(preparation).toBeVisible();
  await expect(
    preparation.getByRole("button", { name: "Start", exact: true }),
  ).toHaveCount(0);
});

test("Full and Mini show exact attended prompts, with Unattended visibly locked", async ({
  page,
}) => {
  await openRuns(page);
  await launchPreparation(page);
  const preparation = page.getByRole("dialog");
  await expect(
    preparation.getByRole("radio", { name: "Unattended" }),
  ).toBeDisabled();
  await expect(preparation).toContainText("wait for local model execution");
  const description = preparation.getByLabel("Feature description");
  const exactText = "  Preserve punctuation: (yes)!\nKeep this line.";
  await description.fill(exactText);
  await preparation
    .getByRole("button", { name: "Review generated prompt" })
    .click();
  const prompt = preparation.locator(".af-new-forge-run-prompt");
  await expect(prompt).toHaveText(`/forgemaster --full ${exactText}`);
  await preparation.getByRole("button", { name: "Edit input" }).click();
  await preparation.getByLabel("Run size").selectOption("mini");
  await preparation
    .getByRole("button", { name: "Review generated prompt" })
    .click();
  await expect(prompt).toHaveText(`/forgemaster --mini ${exactText}`);
  await preparation.getByRole("button", { name: "Cancel" }).click();
  await expect(preparation).toHaveCount(0);
});

test("a scoped feature bead becomes the exact reviewed prompt input", async ({
  page,
}) => {
  await openRuns(page);
  await launchPreparation(page);
  const preparation = page.getByRole("dialog");
  await preparation.getByLabel("Use a scoped bead").check();
  const bead = preparation.getByLabel("Feature or epic bead");
  await expect(bead).toBeEnabled();
  await bead.selectOption("alpha-epic");
  await preparation
    .getByRole("button", { name: "Review generated prompt" })
    .click();
  await expect(preparation.locator(".af-new-forge-run-prompt")).toHaveText(
    "/forgemaster --full alpha-epic",
  );
  await expect(preparation).toContainText("Scoped bead: alpha-epic");
  await preparation.getByRole("button", { name: "Cancel" }).click();
});

test("dirty composer drafts require Keep or Replace and are not changed by Keep", async ({
  page,
}) => {
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/sessions`);
  await page
    .getByRole("button", { name: "New session", exact: true })
    .first()
    .click();
  const composer = page.getByRole("dialog");
  const existingPrompt = "Keep my carefully edited draft.";
  await page.getByLabel("Session prompt").fill(existingPrompt);
  const repository = page.getByLabel("Session repository");
  const smith = page.getByLabel("Session smith");
  await expect(repository).toBeEnabled();
  await expect(smith).toBeEnabled();
  const selectedRepository = await repository.inputValue();
  const selectedSmith = await smith.inputValue();
  await composer.getByRole("button", { name: "Cancel", exact: true }).click();

  await navigateToRuns(page);
  await launchPreparation(page);
  let preparation = page.getByRole("dialog");
  await preparation.getByLabel("Feature description").fill("A separate request");
  await preparation
    .getByRole("button", { name: "Review generated prompt" })
    .click();
  await preparation
    .getByRole("button", { name: "Continue to Claude composer" })
    .click();
  await expect(preparation).toContainText("already has a draft");
  await preparation.getByRole("button", { name: "Keep current draft" }).click();
  await expect(page.getByLabel("Session prompt")).toHaveValue(existingPrompt);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();

  await navigateToRuns(page);
  await launchPreparation(page);
  preparation = page.getByRole("dialog");
  await preparation.getByLabel("Feature description").fill("Replace with this");
  await preparation
    .getByRole("button", { name: "Review generated prompt" })
    .click();
  await preparation
    .getByRole("button", { name: "Continue to Claude composer" })
    .click();
  await preparation.getByRole("button", { name: "Replace current draft" }).click();
  await expect(page.getByLabel("Session prompt")).toHaveValue(
    "/forgemaster --full Replace with this",
  );
  await expect(page.getByLabel("Session repository")).toHaveValue(
    selectedRepository,
  );
  await expect(page.getByLabel("Session smith")).toHaveValue(selectedSmith);
});

async function openRuns(page: import("@playwright/test").Page) {
  await openSettled(page, `/index.html${runsHref(alpha.id, null)}`);
  await expect(
    page.getByRole("heading", {
      name: "No forge runs in this served checkout",
      exact: true,
    }),
  ).toBeVisible();
}

async function launchPreparation(page: import("@playwright/test").Page) {
  const runs = page.getByRole("region", { name: "Project forge runs" });
  const launch = runs.getByRole("button", {
    name: "New forge run",
    exact: true,
  });
  await expect(launch).toBeEnabled();
  await launch.click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

async function navigateToRuns(page: import("@playwright/test").Page) {
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, runsHref(alpha.id, null));
  await expect(
    page.getByRole("heading", {
      name: "No forge runs in this served checkout",
      exact: true,
    }),
  ).toBeVisible();
}
