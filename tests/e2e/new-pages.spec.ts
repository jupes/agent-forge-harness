import { expect, test } from "@playwright/test";
import { stubForgeRun, stubRepos } from "./fixtures";
import { collectErrors } from "./routes";

/**
 * Forge run and Repos & knowledge.
 *
 * Most tests serve the fixtures in `./fixtures` through route interception, so
 * every panel — checkpoints, quality gate, review actions, worktrees — is
 * exercised whether or not this machine has that state. One test per page
 * also reads the real dev API. No test records a real review: the POST is
 * always intercepted.
 */

test.describe("Forge run", () => {
  test("lists checkpoints in dependency order with the active one marked", async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await stubForgeRun(page);
    await page.goto("/index.html#/forge-run", { waitUntil: "networkidle" });

    // The fixture ids sort the other way round, so id order would fail this.
    await expect(page.locator(".af-checkpoint-title")).toHaveText([
      "Write the design tokens",
      "Build the primitives",
      "Wire the application shell",
      "Migrate the issue views",
    ]);
    await expect(page.locator(".af-checkpoint-progress")).toHaveText(
      "1 of 4 complete",
    );

    const active = page.locator(".af-checkpoint.is-active");
    await expect(active).toHaveCount(1);
    await expect(active).toContainText("Build the primitives");
    await expect(active).toHaveAttribute("aria-current", "step");

    const items = page.locator(".af-checkpoint");
    await expect(items.nth(2)).toContainText("waiting on demo-primitives");
    await expect(items.nth(3)).toContainText("waiting on demo-shell");
    expect(errors).toEqual([]);
  });

  test("shows the latest quality-gate run", async ({ page }) => {
    await stubForgeRun(page);
    await page.goto("/index.html#/forge-run", { waitUntil: "networkidle" });

    await expect(page.locator(".af-gate-check")).toHaveCount(5);
    const failed = page.locator(".af-gate-check.is-failed");
    await expect(failed).toContainText("lint");
    await expect(failed).toContainText("Found 2 errors.");
    await expect(page.locator(".af-gate-check.is-skipped")).toContainText(
      "no test files",
    );
  });

  test("approving records a review on the active checkpoint", async ({
    page,
  }) => {
    const posts = await stubForgeRun(page);
    await page.goto("/index.html#/forge-run", { waitUntil: "networkidle" });

    await page.getByRole("button", { name: "Approve checkpoint" }).click();

    await expect(page.locator(".af-review-result")).toContainText(
      "demo-primitives",
    );
    expect(posts).toEqual([
      { issueId: "demo-primitives", decision: "approve", note: "" },
    ]);
  });

  test("requesting changes needs a note, then sends it", async ({ page }) => {
    const posts = await stubForgeRun(page);
    await page.goto("/index.html#/forge-run", { waitUntil: "networkidle" });

    const requestChanges = page.getByRole("button", {
      name: "Request changes",
    });
    await expect(requestChanges).toBeDisabled();

    await page.fill("#forge-review-note", "Split the table primitive");
    await expect(requestChanges).toBeEnabled();
    await requestChanges.click();

    await expect(page.locator(".af-review-result")).toBeVisible();
    expect(posts).toEqual([
      {
        issueId: "demo-primitives",
        decision: "request-changes",
        note: "Split the table primitive",
      },
    ]);
  });

  test("a failed review is reported rather than silently dropped", async ({
    page,
  }) => {
    await stubForgeRun(page);
    await page.route("**/__agent-forge/dev-api/forge-run/review", (route) =>
      route.fulfill({
        status: 502,
        json: {
          ok: false,
          data: null,
          error: "bd comments add failed: issue not found",
        },
      }),
    );
    await page.goto("/index.html#/forge-run", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Approve checkpoint" }).click();
    await expect(page.locator(".af-review-result.is-error")).toContainText(
      "issue not found",
    );
  });

  test("renders the real forge state from this checkout without errors", async ({
    page,
  }) => {
    // Real dev API and real snapshot; what they contain varies by machine, so
    // this checks the panels render, not their rows. Nothing is clicked.
    const errors = collectErrors(page);
    await page.goto("/index.html#/forge-run", { waitUntil: "networkidle" });
    await expect(page.locator(".af-phase")).toHaveCount(4);
    await expect(
      page.getByRole("heading", { name: "Checkpoints" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Quality gate" }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe("Repos & knowledge", () => {
  test("renders repositories, conventions and worktrees", async ({ page }) => {
    const errors = collectErrors(page);
    await stubRepos(page);
    await page.goto("/index.html#/repos", { waitUntil: "networkidle" });

    const repos = page
      .getByRole("region", { name: "Registered repositories" })
      .locator("tbody tr");
    await expect(repos).toHaveCount(4);
    // Branches come from defaultBranch, the canonical repos.json field.
    const webClient = repos.filter({ hasText: "web-client" });
    await expect(webClient).toContainText("master");
    await expect(webClient).toContainText("not cloned");
    const mobileApp = repos.filter({ hasText: "mobile-app" });
    await expect(mobileApp).toContainText("develop");
    await expect(mobileApp).toContainText("22d old");

    const conventions = page.getByRole("region", {
      name: "Shared conventions",
    });
    await expect(conventions.locator("tbody tr")).toHaveCount(4);
    await expect(conventions).toContainText(
      "<type>(<scope>): <short description>",
    );

    const worktrees = page
      .getByRole("region", { name: "Worktrees" })
      .locator("tbody tr");
    await expect(worktrees).toHaveCount(2);
    await expect(
      worktrees.filter({ hasText: "feat/design-system" }),
    ).toContainText("present");
    await expect(
      worktrees.filter({ hasText: "fix/stale-login-redirect" }),
    ).toContainText("path missing");

    await expect(page.locator(".af-notice")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("says when the registries were read from the main checkout", async ({
    page,
  }) => {
    await stubRepos(page, { localStateFrom: "/home/dev/agent-forge-harness" });
    await page.goto("/index.html#/repos", { waitUntil: "networkidle" });
    await expect(page.locator(".af-notice")).toContainText(
      "main checkout at /home/dev/agent-forge-harness",
    );
  });

  test("parses the real shared conventions from this checkout", async ({
    page,
  }) => {
    await page.goto("/index.html#/repos", { waitUntil: "networkidle" });
    const conventions = page.getByRole("region", {
      name: "Shared conventions",
    });
    await expect(conventions).toContainText("commit_format.pattern");
    await expect(conventions).toContainText(
      "<type>(<scope>): <short description>",
    );
    await expect(page.getByRole("heading", { name: "Worktrees" })).toBeVisible();
  });
});
