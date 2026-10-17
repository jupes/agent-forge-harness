import { expect, type Locator, type Page, test } from "@playwright/test";
import type { ForgeRunSnapshot } from "../../scripts/dashboard/forge-run-model";
import {
  AWAITING_REVIEW_RUN,
  CHECKOUT,
  EARLIER_GATES,
  HALT_REASON,
  HALTED_RUN,
  LEGACY_GATE,
  LEGACY_VERDICT_GATE,
  openSettled,
  REVISING_RUN,
  SHIP_HALT_REASON,
  SHIP_HALTED_RUN,
  stubForgeRun,
  stubRepos,
  UNLINKED_GATE,
  VERDICT_BOUND_GATE,
} from "./fixtures";
import { collectErrors } from "./routes";

/**
 * Forge run and Repos & knowledge.
 *
 * Most tests serve the fixtures in `./fixtures` through route interception, so
 * every panel and run state is exercised whether or not this machine has that
 * state. One test per page also reads the real dev API, and asserts only what
 * holds on any machine. No test records a real review: the POST is always
 * intercepted.
 */

const FORGE_RUN = "/index.html#/forge-run";
const FORGE_RUN_API = "/__agent-forge/dev-api/forge-run";
// Matched exactly: the gate card's scope line says the same words in passing.
const NO_RUN_TITLE = "No forge run in flight";

/** The runs board's row for `slug`. */
function boardRow(page: Page, slug: string): Locator {
  return page.locator(".af-run-row", {
    has: page.locator(".af-run-slug", { hasText: slug }),
  });
}

/** The panel of the run on show, titled by its slug. */
function runPanel(page: Page, slug: string): Locator {
  return page.locator(".af-card", {
    has: page.getByRole("heading", { name: slug, exact: true }),
  });
}

test.describe("Forge run", () => {
  test("lists checkpoints in dependency order and marks the one in progress", async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await stubForgeRun(page);
    await openSettled(page, FORGE_RUN);

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

  test("the run and each of its checkpoints link to their Timeline", async ({
    page,
  }) => {
    await stubForgeRun(page);
    await openSettled(page, FORGE_RUN);
    // The run's own link; the nav has one named Timeline too.
    await expect(
      page.locator("a.af-timeline-link", { hasText: /^Timeline$/ }),
    ).toHaveAttribute("href", "#/timeline?run=design-system");
    const ids = await page
      .locator(".af-checkpoint .af-checkpoint-meta code")
      .allInnerTexts();
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids)
      await expect(
        page.getByRole("link", { name: `Timeline of ${id}` }),
      ).toHaveAttribute(
        "href",
        `#/timeline?${new URLSearchParams({ bead: id }).toString()}`,
      );
  });

  test("an unstarted run offers no approval, only the next checkpoint to claim", async ({
    page,
  }) => {
    const posts = await stubForgeRun(page, {
      statuses: { "demo-primitives": "open" },
    });
    await openSettled(page, FORGE_RUN);

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
    await openSettled(page, FORGE_RUN);

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
    await openSettled(page, FORGE_RUN);

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
    await openSettled(page, FORGE_RUN);

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
    await openSettled(page, FORGE_RUN);

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
    await openSettled(page, FORGE_RUN);
    await page.getByRole("button", { name: "Approve checkpoint" }).click();
    await expect(page.locator(".af-review-result.is-error")).toContainText(
      "Only an in-progress checkpoint can be reviewed",
    );
  });

  test("a review whose answer never came may have been recorded: the page says how to check and holds both buttons until the operator says they checked", async ({
    page,
  }) => {
    await stubForgeRun(page);
    let sent = 0;
    // The request leaves the page and no answer comes back: as when the
    // control plane acted and its answer arrived after the page's deadline.
    await page.route("**/__agent-forge/dev-api/forge-run/review", (route) => {
      sent++;
      return route.abort("timedout");
    });
    await openSettled(page, FORGE_RUN);
    const approve = page.getByRole("button", { name: "Approve checkpoint" });
    await page.fill("#forge-review-note", "Checked the primitives.");
    await approve.click();

    const result = page.locator(".af-review-result");
    await expect(result).toHaveAttribute("data-outcome", "unknown");
    await expect(result).toContainText("may have been recorded");
    await expect(result).toContainText("bd show demo-primitives");
    // No blind retry: neither button sends a second comment.
    await expect(approve).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Request changes" }),
    ).toBeDisabled();
    expect(sent).toBe(1);

    await page
      .getByRole("button", { name: "I have checked the comments" })
      .click();
    await expect(result).toHaveCount(0);
    await expect(approve).toBeEnabled();
  });

  test("shows the newest quality-gate run for this checkout and forge run", async ({
    page,
  }) => {
    await stubForgeRun(page);
    await openSettled(page, FORGE_RUN);

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
    // The bead comes from the gate's run correlation, and is named as a bead.
    await expect(scope).toContainText("for bead demo-primitives");
    await expect(page.locator(".af-gate-link")).toHaveCount(0);
    // This gate ran no evaluator-verdict check: the card says nothing about one.
    await expect(page.locator(".af-gate-verdict")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Unattributed gate run" }),
    ).toHaveCount(0);
    // A run whose log holds no earlier gate run lists none.
    await expect(page.locator(".af-gate-history")).toHaveCount(0);
  });

  test("lists the run's earlier gate runs under its newest, newest first, each with its checks and its task id", async ({
    page,
  }) => {
    await stubForgeRun(page, { earlierGates: EARLIER_GATES });
    await openSettled(page, FORGE_RUN);

    const card = page.locator(".af-card", {
      has: page.getByRole("heading", { name: "Quality gate", exact: true }),
    });
    // The newest run is drawn as before.
    await expect(card.locator(".af-gate-check")).toHaveCount(5);

    const history = card.locator(".af-gate-history");
    await expect(
      history.getByRole("heading", { name: "Earlier gate runs" }),
    ).toBeVisible();
    const runs = history.locator(".af-gate-history-run");
    await expect(runs).toHaveCount(2);

    const [linked, legacy] = [runs.nth(0), runs.nth(1)];
    await expect(linked.locator("time")).toHaveAttribute(
      "datetime",
      "2026-09-10T18:30:00.000Z",
    );
    await expect(legacy.locator("time")).toHaveAttribute(
      "datetime",
      "2026-09-10T09:15:00.000Z",
    );

    await expect(linked).toHaveClass(/is-passed/);
    await expect(linked).toContainText("passed");
    await expect(linked).toContainText("bead demo-tokens");
    const name = ".af-gate-history-check-name";
    await expect(linked.locator(name)).toHaveText(["typecheck", "lint"]);
    await expect(
      linked.locator(".af-gate-history-check.is-passed"),
    ).toHaveCount(2);

    await expect(legacy).toHaveClass(/is-failed/);
    await expect(legacy).toContainText("failed");
    await expect(legacy).toContainText("legacy");
    // A legacy entry's task field is named as what it is, never as a bead.
    await expect(legacy).toContainText("task field demo-primitives");
    await expect(legacy).not.toContainText("bead demo-primitives");
    const failed = legacy.locator(".af-gate-history-check.is-failed");
    await expect(failed.locator(name)).toHaveText("typecheck");
    await expect(failed).toHaveAttribute(
      "title",
      "error TS2322: Type 'string' is not assignable",
    );
    await expect(
      legacy.locator(".af-gate-history-check.is-skipped").locator(name),
    ).toHaveText("tests");
  });

  test("a gate run with no run correlation is shown beside the run, labelled unlinked, and is not the run's gate", async ({
    page,
  }) => {
    await stubForgeRun(page, { unattributedGate: UNLINKED_GATE });
    await openSettled(page, FORGE_RUN);

    // The run's own card still shows the gate that was correlated to it.
    const own = page.locator(".af-card", {
      has: page.getByRole("heading", { name: "Quality gate", exact: true }),
    });
    await expect(own.locator(".af-gate-check")).toHaveCount(5);
    await expect(own.locator(".af-gate-scope")).toContainText(
      "for bead demo-primitives",
    );
    await expect(own).not.toContainText("unlinked");

    const stray = page.locator(".af-card", {
      has: page.getByRole("heading", { name: "Unattributed gate run" }),
    });
    await expect(stray).toContainText("TeammateIdle");
    await expect(stray).toContainText("unlinked");
    await expect(stray.locator(".af-gate-scope")).toContainText(
      "belongs to none of its forge runs",
    );
    await expect(stray.locator(".af-gate-scope")).not.toContainText("for bead");
    await expect(stray.locator(".af-gate-link")).toContainText(
      "Not correlated to a Beads issue or a forge run: no run correlation was given",
    );
    await expect(stray.locator(".af-gate-check")).toHaveCount(1);
  });

  test("a gate run that bound the run's verdict names who judged and the file it read", async ({
    page,
  }) => {
    await stubForgeRun(page, { gate: VERDICT_BOUND_GATE });
    await openSettled(page, FORGE_RUN);

    const note = page.locator(".af-gate-verdict");
    await expect(note).toContainText(
      "Evaluator verdict by claude/claude-opus-5-5, observed (requested claude/claude-opus-5-5, rank master)",
    );
    await expect(note).toContainText(
      `.tmp/work/evaluations/${"5f2c9a1e".repeat(8)}/verdict.json`,
    );
    await expect(note).toContainText("412 bytes, SHA-256 9b74c9897bac");
    await expect(note).not.toContainText("legacy");
  });

  test("a gate run whose verdict check passed on a verdict naming no run says it is a legacy verdict and not evidence", async ({
    page,
  }) => {
    await stubForgeRun(page, { gate: LEGACY_VERDICT_GATE });
    await openSettled(page, FORGE_RUN);

    const note = page.locator(".af-gate-verdict");
    await expect(note).toContainText("legacy verdict");
    await expect(note).toContainText(
      "It is not evidence that this run was evaluated.",
    );
  });

  test("a gate run logged before entries were versioned is labelled legacy, and its task field is not called a bead", async ({
    page,
  }) => {
    await stubForgeRun(page, { gate: LEGACY_GATE });
    await openSettled(page, FORGE_RUN);

    const card = page.locator(".af-card", {
      has: page.getByRole("heading", { name: "Quality gate", exact: true }),
    });
    await expect(card).toContainText("legacy");
    await expect(card.locator(".af-gate-scope")).not.toContainText("for bead");
    await expect(card.locator(".af-gate-link")).toContainText(
      "its task field read demo-primitives",
    );
    await expect(card.locator(".af-gate-check")).toHaveCount(5);
  });

  test("with no run in flight, an unlinked gate run is the checkout's card and says it is unlinked", async ({
    page,
  }) => {
    await stubForgeRun(page, { empty: true, unattributedGate: UNLINKED_GATE });
    await openSettled(page, FORGE_RUN);

    const card = page.locator(".af-card", {
      has: page.getByRole("heading", { name: "Quality gate", exact: true }),
    });
    await expect(card).toContainText("TeammateIdle");
    await expect(card).toContainText("unlinked");
    await expect(card.locator(".af-gate-scope")).toContainText(
      "with no forge run in flight",
    );
    await expect(
      page.getByRole("heading", { name: "Unattributed gate run" }),
    ).toHaveCount(0);
  });

  test("names the checkout and run it searched when no gate run belongs to them", async ({
    page,
  }) => {
    await stubForgeRun(page, { gate: null });
    await openSettled(page, FORGE_RUN);

    const card = page.locator(".af-card", {
      has: page.getByRole("heading", { name: "Quality gate" }),
    });
    await expect(card).toContainText(
      "No quality-gate run recorded for this checkout",
    );
    await expect(card).toContainText(CHECKOUT);
    await expect(card).toContainText("forge run design-system");
    await expect(card).toContainText("Runs from other worktrees");
    // On a run's card, an uncorrelated gate run is said to live elsewhere.
    await expect(card).toContainText("belongs to no forge run");
    await expect(page.locator(".af-gate-check")).toHaveCount(0);
  });

  test("with no run in flight, says so and still shows this checkout's newest gate run", async ({
    page,
  }) => {
    // What a fresh clone serves: no run to select, but the gate log is shared
    // by every checkout, so its newest entry for this one still belongs here.
    const errors = collectErrors(page);
    await stubForgeRun(page, { empty: true });
    await openSettled(page, FORGE_RUN);

    await expect(page.getByText(NO_RUN_TITLE, { exact: true })).toBeVisible();
    await expect(page.locator(".af-phase")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Checkpoints" }),
    ).toHaveCount(0);

    const scope = page.locator(".af-gate-scope");
    await expect(scope).toContainText(`this checkout (${CHECKOUT})`);
    await expect(scope).toContainText("with no forge run in flight");
    await expect(page.locator(".af-gate-check")).toHaveCount(5);
    expect(errors).toEqual([]);
  });

  test("the board names each run its reviews hold by the hold, says why a halted run stopped, and draws the phase after a halt locked", async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await stubForgeRun(page, {
      extraRuns: [HALTED_RUN, REVISING_RUN, AWAITING_REVIEW_RUN],
    });
    await openSettled(page, FORGE_RUN);

    const halted = boardRow(page, "search-index");
    await expect(halted.locator(".af-run-phase")).toHaveText(
      "Halted in Plan · 2/4",
    );
    await expect(halted.locator(".af-run-reason")).toHaveText(HALT_REASON);
    await expect(halted.locator(".af-run-seg").nth(2)).toHaveClass(
      /af-run-seg-locked/,
    );
    await expect(
      boardRow(page, "billing-export").locator(".af-run-phase"),
    ).toHaveText("Revising Research · 1/4");
    await expect(
      boardRow(page, "audit-log").locator(".af-run-phase"),
    ).toHaveText("Implement awaiting review · 3/4");
    // Only a halt carries a reason, and a run nothing holds reads as before.
    await expect(page.locator(".af-run-reason")).toHaveCount(1);
    await expect(
      boardRow(page, "design-system").locator(".af-run-phase"),
    ).toHaveText("Implement · 2/4");
    expect(errors).toEqual([]);
  });

  test("a run that recorded ship but whose ship review halted is counted in flight and needs attention, not shipped", async ({
    page,
  }) => {
    await stubForgeRun(page, { extraRuns: [SHIP_HALTED_RUN] });
    await openSettled(page, FORGE_RUN);

    await expect(
      page.getByRole("heading", { name: "2 runs · 2 in flight", exact: true }),
    ).toBeVisible();
    const row = boardRow(page, "release-notes");
    await expect(row).toHaveClass(/af-run-row-attention/);
    await expect(row.locator(".af-sr-only")).toHaveText("Needs attention");
    await expect(row.locator(".af-run-phase")).toHaveText(
      "Halted in Ship · 4/4",
    );
  });

  test("a lone run its plan review halted: its panel says it halted in Plan and why, and draws Implement locked, not active", async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await stubForgeRun(page, { alone: HALTED_RUN });
    await openSettled(page, FORGE_RUN);

    // One run, so no board: the panel is the only place the halt can show.
    await expect(page.locator(".af-run-board")).toHaveCount(0);
    const panel = runPanel(page, "search-index");
    await expect(panel.locator(".af-card-kicker")).toHaveText(
      "halted run · auto",
    );
    await expect(panel.locator(".af-run-hold-status")).toHaveText(
      "Halted in Plan",
    );
    await expect(panel.locator(".af-run-hold-reason")).toHaveText(HALT_REASON);

    const implement = page.locator(".af-phase").nth(2);
    await expect(implement).toHaveClass(/af-phase-locked/);
    await expect(implement.locator(".af-phase-head .af-tag")).toHaveText(
      "locked",
    );
    await expect(page.locator(".af-phase-active")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("a lone run that recorded ship but whose ship review halted: its panel's kicker is not shipped, and the panel says it halted in Ship and why", async ({
    page,
  }) => {
    await stubForgeRun(page, { alone: SHIP_HALTED_RUN });
    await openSettled(page, FORGE_RUN);

    await expect(page.locator(".af-run-board")).toHaveCount(0);
    const panel = runPanel(page, "release-notes");
    await expect(panel.locator(".af-card-kicker")).toHaveText(
      "halted run · auto",
    );
    await expect(panel.locator(".af-run-hold-status")).toHaveText(
      "Halted in Ship",
    );
    await expect(panel.locator(".af-run-hold-reason")).toHaveText(
      SHIP_HALT_REASON,
    );
  });

  test("the panel of a run under revision or awaiting a review names the hold and locks the phase after it, and a run nothing holds shows no hold", async ({
    page,
  }) => {
    await stubForgeRun(page, {
      extraRuns: [REVISING_RUN, AWAITING_REVIEW_RUN],
    });
    await openSettled(page, FORGE_RUN);

    const plain = runPanel(page, "design-system");
    await expect(plain.locator(".af-card-kicker")).toHaveText(
      "active run · gated",
    );
    await expect(page.locator(".af-run-hold")).toHaveCount(0);
    await expect(page.locator(".af-phase").nth(2)).toHaveClass(
      /af-phase-active/,
    );

    await boardRow(page, "billing-export").click();
    const revising = runPanel(page, "billing-export");
    await expect(revising.locator(".af-card-kicker")).toHaveText(
      "active run · auto",
    );
    await expect(revising.locator(".af-run-hold-status")).toHaveText(
      "Revising Research",
    );
    await expect(revising.locator(".af-run-hold-reason")).toHaveCount(0);
    await expect(page.locator(".af-phase").nth(1)).toHaveClass(
      /af-phase-locked/,
    );
    await expect(page.locator(".af-phase-active")).toHaveCount(0);

    await boardRow(page, "audit-log").click();
    const awaiting = runPanel(page, "audit-log");
    await expect(awaiting.locator(".af-run-hold-status")).toHaveText(
      "Implement awaiting review",
    );
    await expect(page.locator(".af-phase").nth(3)).toHaveClass(
      /af-phase-locked/,
    );
    await expect(page.locator(".af-phase-active")).toHaveCount(0);
  });

  test("renders the real forge state from this checkout without errors", async ({
    page,
  }) => {
    // Real dev API, through the proxy, from whatever this checkout holds. A
    // fresh clone has no run and a working checkout usually has one, so the
    // page is held to what the API just reported rather than to either case.
    // Nothing is clicked.
    const errors = collectErrors(page);
    const reply = await page.request.get(FORGE_RUN_API);
    expect(reply.ok()).toBe(true);
    const { data } = (await reply.json()) as { data: ForgeRunSnapshot };

    await openSettled(page, FORGE_RUN);

    if (data.selected === null) {
      await expect(page.getByText(NO_RUN_TITLE, { exact: true })).toBeVisible();
      await expect(page.locator(".af-phase")).toHaveCount(0);
    } else {
      await expect(page.locator(".af-phase")).toHaveCount(4);
      await expect(
        page.getByRole("heading", { name: data.selected, exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Checkpoints" }),
      ).toBeVisible();
    }
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
    await openSettled(page, "/index.html#/repos");

    const repos = page
      .getByRole("region", { name: "Registered repositories" })
      .locator("tbody tr");
    await expect(repos).toHaveCount(5);
    // Branches come from defaultBranch, the canonical repos.json field.
    const webClient = repos.filter({ hasText: "web-client" });
    await expect(webClient).toContainText("master");
    await expect(webClient).toContainText("not cloned");
    const mobileApp = repos.filter({ hasText: "mobile-app" });
    await expect(mobileApp).toContainText("develop");
    await expect(mobileApp).toContainText("22d old");
    // A stale knowledge file carries the warning icon...
    const legacyWorker = repos.filter({ hasText: "legacy-worker" });
    await expect(legacyWorker).toContainText("45d old");
    await expect(legacyWorker.locator(".af-tag svg")).toHaveCount(1);
    await expect(legacyWorker).not.toContainText("archived");
    // ...an archived repository is tagged as archived, keeps its age, and has
    // no warning however old the file is.
    const retiredDocs = repos.filter({ hasText: "retired-docs" });
    await expect(retiredDocs).toContainText("archived");
    await expect(retiredDocs).toContainText("120d old");
    // Why, in visible text rather than a tooltip.
    await expect(retiredDocs).toContainText(
      "skipped by bun run repo and /sync-knowledge --all",
    );
    await expect(legacyWorker).not.toContainText("skipped by");
    await expect(retiredDocs.locator(".af-tag svg")).toHaveCount(0);
    await expect(repos.filter({ hasText: "archived" })).toHaveCount(1);

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
    // Every worktree: the main checkout, the ones bun run worktree made, the desktop app's.
    await expect(worktrees).toHaveCount(4);
    await expect(worktrees.first()).toContainText("main checkout");
    const made = worktrees.filter({ hasText: "feat/design-system" });
    await expect(made).toContainText("present");
    await expect(made).toContainText("agent-forge-harness-dg40");
    await expect(made).toContainText("session-design");
    await expect(
      worktrees.filter({ hasText: "fix/stale-login-redirect" }),
    ).toContainText("missing");
    const app = worktrees.filter({ hasText: "claude/queue-work" });
    await expect(app).toContainText("desktop app");
    await expect(app).toContainText("agent-forge-harness-x1gs.5.1");

    await expect(page.locator(".af-notice")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("says when the registries were read from the main checkout", async ({
    page,
  }) => {
    await stubRepos(page, { localStateFrom: "/home/dev/agent-forge-harness" });
    await openSettled(page, "/index.html#/repos");
    await expect(page.locator(".af-notice")).toContainText(
      "main checkout at /home/dev/agent-forge-harness",
    );
  });

  test("parses the real shared conventions from this checkout", async ({
    page,
  }) => {
    await openSettled(page, "/index.html#/repos");
    const conventions = page.getByRole("region", {
      name: "Shared conventions",
    });
    await expect(conventions).toContainText("commit_format.pattern");
    await expect(conventions).toContainText(
      "<type>(<scope>): <short description>",
    );
    await expect(
      page.getByRole("heading", { name: "Worktrees" }),
    ).toBeVisible();
  });
});
