import { expect, test } from "@playwright/test";
import { FORGE, stubForgeRun, stubRepos } from "./fixtures";
import { collectErrors } from "./routes";

/**
 * Forge run and Repos & knowledge.
 *
 * Most tests serve the fixtures in `./fixtures` through route interception, so
 * every panel and run state is exercised whether or not this machine has that
 * state. One test per page also reads the real dev API. No test records a
 * real review: the POST is always intercepted.
 */

const FORGE_RUN = "/index.html#/forge-run";
const CHECKOUT = FORGE.data.gateScope.checkout;

test.describe("Forge run", () => {
  test("lists checkpoints in dependency order and marks the one in progress", async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await stubForgeRun(page);
    await page.goto(FORGE_RUN, { waitUntil: "networkidle" });

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
    await expect(page.locator(".af-checkpoint.is-next")).toHaveCount(0);

    const items = page.locator(".af-checkpoint");
    await expect(items.nth(2)).toContainText("waiting on demo-primitives");
    await expect(items.nth(3)).toContainText("waiting on demo-shell");
    expect(errors).toEqual([]);
  });

  test("an unstarted run offers no approval, only the next checkpoint to claim", async ({
    page,
  }) => {
    const posts = await stubForgeRun(page, {
      statuses: { "demo-primitives": "open" },
    });
    await page.goto(FORGE_RUN, { waitUntil: "networkidle" });

    const next = page.locator(".af-checkpoint.is-next");
    await expect(next).toHaveCount(1);
    await expect(next).toContainText("Build the primitives");
    await expect(page.locator(".af-checkpoint.is-active")).toHaveCount(0);
    await expect(
      page.locator('.af-checkpoint-state[data-state="ready"]'),
    ).toContainText("bd update demo-primitives --claim");

    await expect(page.locator(".af-review")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Approve checkpoint" }),
    ).toHaveCount(0);
    expect(posts).toEqual([]);
  });

  test("remaining work that nothing can start is not reported as complete", async ({
    page,
  }) => {
    await stubForgeRun(page, { statuses: { "demo-primitives": "blocked" } });
    await page.goto(FORGE_RUN, { waitUntil: "networkidle" });

    const state = page.locator('.af-checkpoint-state[data-state="waiting"]');
    await expect(state).toContainText(
      "3 of 4 checkpoints remain, but none is in progress or ready to start.",
    );
    await expect(state).toContainText(
      "Marked blocked in Beads: demo-primitives.",
    );
    await expect(page.getByText("checkpoints are closed")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Approve checkpoint" }),
    ).toHaveCount(0);
  });

  test("approving records a review on the checkpoint in progress", async ({
    page,
  }) => {
    const posts = await stubForgeRun(page);
    await page.goto(FORGE_RUN, { waitUntil: "networkidle" });

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
    await page.goto(FORGE_RUN, { waitUntil: "networkidle" });

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

  test("with several checkpoints in progress, the reviewer picks which one", async ({
    page,
  }) => {
    const posts = await stubForgeRun(page, {
      statuses: { "demo-shell": "in_progress" },
    });
    await page.goto(FORGE_RUN, { waitUntil: "networkidle" });

    await expect(page.locator(".af-checkpoint.is-active")).toHaveCount(2);
    const picker = page.locator("#forge-review-checkpoint");
    await expect(picker.locator("option")).toHaveCount(2);
    await picker.selectOption("demo-shell");
    await page.getByRole("button", { name: "Approve checkpoint" }).click();

    await expect(page.locator(".af-review-result")).toContainText("demo-shell");
    expect(posts).toEqual([
      { issueId: "demo-shell", decision: "approve", note: "" },
    ]);
  });

  test("a refused review is reported rather than silently dropped", async ({
    page,
  }) => {
    await stubForgeRun(page);
    await page.route("**/__agent-forge/dev-api/forge-run/review", (route) =>
      route.fulfill({
        status: 409,
        json: {
          ok: false,
          data: null,
          error:
            "Only an in-progress checkpoint can be reviewed; demo-primitives is closed in Beads",
        },
      }),
    );
    await page.goto(FORGE_RUN, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Approve checkpoint" }).click();
    await expect(page.locator(".af-review-result.is-error")).toContainText(
      "Only an in-progress checkpoint can be reviewed",
    );
  });

  test("shows the newest quality-gate run for this checkout and forge run", async ({
    page,
  }) => {
    await stubForgeRun(page);
    await page.goto(FORGE_RUN, { waitUntil: "networkidle" });

    await expect(page.locator(".af-gate-check")).toHaveCount(5);
    const failed = page.locator(".af-gate-check.is-failed");
    await expect(failed).toContainText("lint");
    await expect(failed).toContainText("Found 2 errors.");
    await expect(page.locator(".af-gate-check.is-skipped")).toContainText(
      "no test files",
    );

    const scope = page.locator(".af-gate-scope");
    await expect(scope).toContainText(`this checkout (${CHECKOUT})`);
    await expect(scope).toContainText("forge run design-system");
    await expect(scope).toContainText("on feat/design-system");
    await expect(scope).toContainText("for task demo-primitives");
  });

  test("names the checkout and run it searched when no gate run belongs to them", async ({
    page,
  }) => {
    await stubForgeRun(page, { gate: null });
    await page.goto(FORGE_RUN, { waitUntil: "networkidle" });

    const card = page.locator(".af-card", {
      has: page.getByRole("heading", { name: "Quality gate" }),
    });
    await expect(card).toContainText(
      "No quality-gate run recorded for this checkout",
    );
    await expect(card).toContainText(CHECKOUT);
    await expect(card).toContainText("forge run design-system");
    await expect(card).toContainText("Runs from other worktrees");
    await expect(page.locator(".af-gate-check")).toHaveCount(0);
  });

  test("renders the real forge state from this checkout without errors", async ({
    page,
  }) => {
    // Real dev API and real snapshot; what they contain varies by machine, so
    // this checks the panels render, not their rows. Nothing is clicked.
    const errors = collectErrors(page);
    await page.goto(FORGE_RUN, { waitUntil: "networkidle" });
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
