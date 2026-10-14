import { expect, type Page, test } from "@playwright/test";
import { dashboardSections } from "../../docs/js/islands/issues-views-model";
import { buildDerivedFromIssuesAndDeps } from "../../scripts/beads-dashboard";
import type { BeadsPayload } from "../../types/beads";
import type { BeadCounts } from "../../types/hearth";
import { BEADS, openSettled, stubSnapshot } from "./fixtures";
import { createFromBuilder, requireStandIn, standInCalls } from "./stand-in";

/**
 * The dashboard's four Beads cards follow the tracker through the hearth.
 *
 * The hearth is the real one the suite started, and its `bd` is the suite's
 * recording stand-in: `GET /beads/counts` runs the stand-in's `export`, which
 * prints the issues the stand-in keeps. A bead is created the way it is in
 * use, from the Bead builder, in a second tab, while the dashboard stays open
 * in the first.
 */

const API = "/__agent-forge";
const DASHBOARD = "/index.html#/dashboard";
const LABELS = ["Open", "In progress", "Blocked", "Closed"] as const;
const FIELDS: Record<(typeof LABELS)[number], keyof BeadCounts> = {
  Open: "open",
  "In progress": "inProgress",
  Blocked: "blocked",
  Closed: "closed",
};

declare global {
  interface Window {
    countsMarker?: string;
  }
}

/** The snapshot fixture with the derived data the snapshot builder would give it. */
const DERIVED_BEADS: BeadsPayload = {
  ...BEADS,
  derived: buildDerivedFromIssuesAndDeps(BEADS.issues, BEADS.deps),
};

function beadCard(page: Page, label: string) {
  return page
    .getByTestId("bead-counts")
    .locator(".af-stat")
    .filter({
      has: page.locator(".af-stat-label", {
        hasText: new RegExp(`^${label}$`),
      }),
    })
    .locator(".af-stat-value");
}

async function expectCards(page: Page, counts: BeadCounts): Promise<void> {
  for (const label of LABELS)
    await expect(beadCard(page, label), label).toHaveText(
      String(counts[FIELDS[label]]),
    );
}

/** What the hearth answers for the counts, read from the page. */
async function trackerCounts(page: Page): Promise<BeadCounts> {
  const answer = await page.evaluate(
    async (url) => (await (await fetch(url)).json()) as { data: BeadCounts },
    `${API}/beads/counts`,
  );
  return answer.data;
}

const isExport = (call: string[]): boolean => call[0] === "export";

test("the Open card counts a bead created from another tab, without a reload", async ({
  page,
  context,
}) => {
  await stubSnapshot(page);
  await openSettled(page, DASHBOARD);
  await expect(page.getByTestId("bead-counts")).toHaveAttribute(
    "data-source",
    "tracker",
  );
  const open = beadCard(page, "Open");
  await expect(open).toHaveText(/^\d+$/);
  const before = Number(await open.textContent());
  await page.evaluate(() => {
    window.countsMarker = "set before the write";
  });
  const exportsBefore = standInCalls().filter(isExport).length;

  const builder = await context.newPage();
  await openSettled(builder, "/index.html#/bead-builder");
  await requireStandIn(builder);
  await createFromBuilder(builder, "Counted on the dashboard in the other tab");
  await builder.close();

  await expect(open).toHaveText(String(before + 1), { timeout: 5000 });
  expect(
    standInCalls().filter(isExport).length,
    "the counts were read from the tracker again",
  ).toBeGreaterThan(exportsBefore);
  expect(
    await page.evaluate(() => window.countsMarker),
    "the dashboard was not reloaded",
  ).toBe("set before the write");
});

test("without a snapshot, the dashboard shows the tracker's Beads counts and the live row", async ({
  page,
}) => {
  await page.route("**/data/beads.json", (route) =>
    route.fulfill({ status: 404, body: "not found" }),
  );
  await openSettled(page, DASHBOARD);

  await expect(page.locator(".af-empty")).toContainText("No snapshot loaded");
  await expect(page.getByTestId("bead-counts")).toHaveAttribute(
    "data-source",
    "tracker",
  );
  await expectCards(page, await trackerCounts(page));
  await expect(page.getByTestId("live-stats")).toBeVisible();
});

test("with an initiative chosen, the Beads cards show the snapshot's counts for it", async ({
  page,
}) => {
  await stubSnapshot(page, DERIVED_BEADS);
  await openSettled(page, DASHBOARD);
  const row = page.getByTestId("bead-counts");
  await expect(row).toHaveAttribute("data-source", "tracker");

  await page.selectOption("#filter-initiative", "demo-epic");
  await expect(row).toHaveAttribute("data-source", "snapshot");
  await expectCards(page, dashboardSections(DERIVED_BEADS, "demo-epic").stats);

  await page.selectOption("#filter-initiative", "all");
  await expect(row).toHaveAttribute("data-source", "tracker");
  await expectCards(page, await trackerCounts(page));
});

test("where no control plane answers, the Beads cards show the snapshot's counts", async ({
  page,
}) => {
  // What a static host answers for the hearth's routes.
  for (const path of [`${API}/stream`, `${API}/beads/counts`])
    await page.route(`**${path}`, (route) =>
      route.fulfill({
        status: 404,
        contentType: "text/plain",
        body: "Not found",
      }),
    );
  await stubSnapshot(page, DERIVED_BEADS);
  await openSettled(page, DASHBOARD);

  await expect(page.getByTestId("bead-counts")).toHaveAttribute(
    "data-source",
    "snapshot",
  );
  await expectCards(page, { open: 3, inProgress: 3, blocked: 2, closed: 1 });
  await expect(page.getByTestId("live-stats")).toHaveCount(0);
});
