import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { readState, withStateLock, writeState } from "../e2e/bd-stand-in-state";
import { openSettled } from "../e2e/fixtures";
import { BD_STAND_IN_STATE } from "../e2e/servers";
import { alpha, seedProjects } from "./project-fixtures";

test.beforeEach(() => {
  seedProjects();
  withStateLock(BD_STAND_IN_STATE, () => {
    const state = readState(BD_STAND_IN_STATE);
    for (const id of [
      "alpha-council-first",
      "alpha-council-second",
      "alpha-council-third",
    ]) {
      state[id] = {
        id,
        title: `Title ${id}`,
        issue_type: "task",
        status: "open",
        priority: 2,
        labels: ["project:alpha"],
        created_at: alpha.createdAt,
        updated_at: alpha.updatedAt,
        dependencies: [
          { issue_id: id, depends_on_id: "alpha-epic", type: "parent-child" },
        ],
      };
    }
    writeState(BD_STAND_IN_STATE, state);
  });
});

test("source entry, Keep draft, and Replace source preserve options without preparing anything", async ({
  page,
}) => {
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST")
      posts.push(new URL(request.url()).pathname);
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/beads`);
  await page
    .getByRole("button", {
      name: "Inspect alpha-council-first: Title alpha-council-first",
    })
    .click();
  await page.getByRole("button", { name: "Review bead in Council" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/desktop/project/${alpha.id}/reviews$`),
  );

  const sourceType = page.getByLabel("Source type");
  const source = page.getByLabel("Beads issue ID");
  await expect(sourceType).toHaveValue("bead");
  await expect(source).toHaveValue("alpha-council-first");
  const profile = page.getByLabel("Council profile");
  await expect(profile).toHaveValue(/.+/);
  const profileBefore = await profile.inputValue();
  await page.getByLabel("Maximum estimated cost (USD)").fill("12.50");
  await page.getByLabel("Maximum prepared bytes").fill("123456");
  await page
    .getByLabel(
      "Redact detected secrets; otherwise source preparation rejects them",
    )
    .uncheck();
  await page
    .getByLabel("Allow deep discussion when supported by this profile")
    .check();
  await sourceType.selectOption("text");
  await page
    .getByLabel("Document or question")
    .fill("Keep this explicit draft body.");

  await page.getByRole("link", { name: "Beads", exact: true }).click();
  await expect(page).toHaveURL(
    new RegExp(`/desktop/project/${alpha.id}/beads$`),
  );
  await page
    .getByRole("button", {
      name: "Inspect alpha-council-second: Title alpha-council-second",
    })
    .click();
  await page.getByRole("button", { name: "Review bead in Council" }).click();
  const replacementDialog = page.getByRole("dialog", {
    name: "Replace Council draft source?",
  });
  const keep = replacementDialog.getByRole("button", { name: "Keep draft" });
  const replace = replacementDialog.getByRole("button", {
    name: "Replace source",
  });
  await keep.focus();
  await page.keyboard.press("Tab");
  await expect(replace).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(
    new RegExp(`/desktop/project/${alpha.id}/reviews$`),
  );
  await expect(page.getByLabel("Source type")).toHaveValue("text");
  await expect(page.getByLabel("Document or question")).toHaveValue(
    "Keep this explicit draft body.",
  );

  await page.getByRole("link", { name: "Beads", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Inspect alpha-council-third: Title alpha-council-third",
    })
    .click();
  await page.getByRole("button", { name: "Review bead in Council" }).click();
  await page.getByRole("button", { name: "Replace source" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/desktop/project/${alpha.id}/reviews$`),
  );
  await expect(page.getByLabel("Source type")).toHaveValue("bead");
  await expect(page.getByLabel("Beads issue ID")).toHaveValue(
    "alpha-council-third",
  );
  await expect(profile).toHaveValue(profileBefore);
  await expect(page.getByLabel("Maximum estimated cost (USD)")).toHaveValue(
    "12.50",
  );
  await expect(page.getByLabel("Maximum prepared bytes")).toHaveValue("123456");
  await expect(
    page.getByLabel(
      "Redact detected secrets; otherwise source preparation rejects them",
    ),
  ).not.toBeChecked();
  await expect(
    page.getByLabel("Allow deep discussion when supported by this profile"),
  ).toBeChecked();
  expect(posts).toEqual([]);
  expect(new URL(page.url()).search).toBe("");
  expect(new URL(page.url()).hash).not.toContain("alpha-council-third");
  const persistedText = await page.evaluate(() =>
    [
      window.location.href,
      ...Object.values(localStorage),
      ...Object.values(sessionStorage),
    ].join("\n"),
  );
  expect(persistedText).not.toContain("Keep this explicit draft body.");
});

test("project Reviews reserves, convenes, completes, and reloads the verified original and result", async ({
  page,
}) => {
  const councilPosts: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname.includes("/council/"))
      councilPosts.push(url.pathname);
  });

  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/overview`);
  await page.getByRole("link", { name: "Reviews", exact: true }).click();
  await expect(page).toHaveURL(
    new RegExp(`/desktop/project/${alpha.id}/reviews$`),
  );
  await expect(
    page.getByText("No council reviews yet", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New review", exact: true }).click();
  await expect(page.getByLabel("Source type")).toHaveValue("text");
  await expect(page.getByLabel("Document or question")).toBeVisible();
  const prepare = page.getByRole("button", {
    name: "Prepare original for review",
  });
  await expect(prepare).toBeDisabled();
  expect(councilPosts).toEqual([]);

  const source = page.getByLabel("Document or question");
  await source.fill(
    "Exact review body: preserve this sentence and its identity.",
  );
  await expect(prepare).toBeEnabled();
  await page
    .getByLabel(
      "Redact detected secrets; otherwise source preparation rejects them",
    )
    .uncheck();
  await expect(source).toHaveValue(
    "Exact review body: preserve this sentence and its identity.",
  );
  await expect(prepare).toBeEnabled();
  await page
    .getByLabel(
      "Redact detected secrets; otherwise source preparation rejects them",
    )
    .check();
  await prepare.click();
  await expect(
    page.getByRole("heading", { name: "Exact saved original" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Exact review body: preserve this sentence and its identity.",
    ),
  ).toBeVisible();
  const identitySummary = page.getByText("Request identity and scope", {
    exact: true,
  });
  await identitySummary.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Intent hash/)).toBeVisible();
  const shotDir = process.env["SHOT_DIR"];
  if (shotDir) {
    mkdirSync(shotDir, { recursive: true });
    const originalHeading = page.getByRole("heading", {
      name: "Exact saved original",
    });
    await originalHeading.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(shotDir, "council-exact-original.png"),
      animations: "disabled",
    });
  }
  expect(councilPosts).toHaveLength(1);
  expect(councilPosts[0]).toMatch(/\/projects\/.*\/council\/reviews$/);
  expect(councilPosts.some((path) => path.endsWith("/commit"))).toBe(false);
  expect(councilPosts.some((path) => path.includes("/council-api/runs"))).toBe(
    false,
  );

  await page
    .getByRole("button", { name: "Convene this exact original" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Council result" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Verified state: completed")).toBeVisible();
  if (shotDir) {
    const resultHeading = page.getByRole("heading", {
      name: "Council result",
    });
    await resultHeading.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(shotDir, "council-completed-result.png"),
      animations: "disabled",
    });
  }
  expect(councilPosts).toHaveLength(2);
  expect(councilPosts[1]).toMatch(
    /\/projects\/.*\/council\/reviews\/[^/]+\/commit$/,
  );

  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Saved reviews" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open result" }).click();
  await expect(
    page.getByRole("heading", { name: "Council result" }),
  ).toBeVisible();
  await expect(page.getByText("Verified state: completed")).toBeVisible();
  await page.getByText("Show exact saved original", { exact: true }).click();
  await page.getByText("Request identity and scope", { exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Exact saved original" }),
  ).toBeVisible();
  await expect(page.getByText(/Intent hash/)).toBeVisible();
  await expect(
    page.getByText(
      "Exact review body: preserve this sentence and its identity.",
    ),
  ).toBeVisible();
  await page
    .getByText("Inspect complete public Council result", { exact: true })
    .click();
  await expect(page.locator(".af-council-transcript")).toHaveValue(
    /Exact review body: preserve this sentence and its identity\./,
  );
  expect(councilPosts).toHaveLength(2);
});
