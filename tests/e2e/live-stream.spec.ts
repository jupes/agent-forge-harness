import { existsSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { openSettled, stubSnapshot } from "./fixtures";
import {
  type LivePhase,
  liveRunFiles,
  newLiveSlug,
  removeLiveRun,
  writePhase,
} from "./live-run";

/**
 * The dashboard follows the hearth's event stream.
 *
 * The hearth and the dashboard are the real ones the suite started, and the
 * change the page has to show is made the way it is made in use: the real
 * `forge:phase-gate … --write` command, run for a throwaway run while the page
 * is open (`live-run.ts`). Nothing is stubbed between that command and the
 * page except, in two tests, the Beads snapshot the dashboard view needs.
 *
 * "Within one second" is measured from the time the ledger stamped on the
 * `run.phase.completed` event to the moment an observer in the page first sees
 * the run's phase row. Both are this machine's wall clock. The command's own
 * start-up is before the event and is not part of the page's latency.
 */

const API = "/__agent-forge";
const STREAM = `${API}/stream`;
const DASHBOARD = "/index.html#/dashboard";
const FORGE_RUN = "/index.html#/forge-run";
/** The acceptance bound. */
const WITHIN_MS = 1000;
/** Longer than the client's refetch window, so a measured write is not held back by the page's own first read. */
const CLEAR_OF_FIRST_READ_MS = 400;

const PHASE_LABEL: Record<LivePhase, string> = {
  research: "Research",
  plan: "Plan",
};

declare global {
  interface Window {
    liveMarker?: string;
    liveSeen?: Promise<number>;
  }
}

/** Something a reload would lose. */
async function mark(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.liveMarker = "set before the write";
  });
}

async function expectNoReload(page: Page): Promise<void> {
  expect(
    await page.evaluate(() => window.liveMarker),
    "the page was not reloaded",
  ).toBe("set before the write");
}

/**
 * Start watching the page for the run's card with `phase` shown complete.
 * Refuses when that is already on screen: the test would prove nothing.
 * Resolved by `seenAt`.
 */
async function watchForPhase(
  page: Page,
  slug: string,
  phase: LivePhase,
): Promise<void> {
  await page.evaluate(
    ({ title, label }) => {
      const shown = (): boolean =>
        [...document.querySelectorAll("h2.af-card-title")].some(
          (heading) => heading.textContent?.trim() === title,
        ) &&
        [
          ...document.querySelectorAll(".af-phase-complete .af-phase-title"),
        ].some((row) => row.textContent?.trim() === label);
      window.liveSeen = new Promise<number>((seen, never) => {
        if (shown()) {
          never(new Error(`${title} already shows ${label} complete`));
          return;
        }
        const observer = new MutationObserver(() => {
          if (!shown()) return;
          observer.disconnect();
          seen(Date.now());
        });
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
        });
        setTimeout(() => {
          observer.disconnect();
          never(new Error(`${title} did not show ${label} complete in 15 s`));
        }, 15_000);
      });
      // The rejection is read by `seenAt`; this keeps it from being reported as unhandled first.
      window.liveSeen.catch(() => undefined);
    },
    { title: slug, label: PHASE_LABEL[phase] },
  );
}

/** When the page first showed it, by the page's clock. */
function seenAt(page: Page): Promise<number> {
  return page.evaluate(() => window.liveSeen as Promise<number>);
}

/** When the ledger says the phase was completed: the `ts` of the event the command appended. */
async function recordedAt(
  page: Page,
  slug: string,
  phase: LivePhase,
): Promise<number> {
  const events = await page.evaluate(async (url) => {
    const response = await fetch(url);
    const body = (await response.json()) as {
      data: {
        events: Array<{ ts: string; payload: { phase?: string } }>;
      } | null;
    };
    return body.data?.events ?? [];
  }, `${API}/events?run=${slug}&kind=run.phase.completed&limit=10`);
  const matching = events.filter((event) => event.payload.phase === phase);
  expect(
    matching,
    `one ${phase} event for ${slug} in the suite's ledger`,
  ).toHaveLength(1);
  return Date.parse(matching[0]?.ts ?? "");
}

/** Write a phase with the real command and say how long the page took to show it. */
async function measuredWrite(
  page: Page,
  slug: string,
  phase: LivePhase,
): Promise<number> {
  await page.waitForTimeout(CLEAR_OF_FIRST_READ_MS);
  await watchForPhase(page, slug, phase);
  await writePhase(slug, phase);
  const seen = await seenAt(page);
  const latency = seen - (await recordedAt(page, slug, phase));
  // The measured value belongs in the run's log, CI's included: the bound is a wall-clock claim.
  process.stdout.write(
    `    [live-stream] ${phase} write shown ${latency} ms after the ledger recorded it\n`,
  );
  return latency;
}

function countStreamRequests(page: Page): () => number {
  let count = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === STREAM) count += 1;
  });
  return () => count;
}

function liveCard(page: Page, label: string) {
  return page
    .getByTestId("live-stats")
    .locator(".af-stat")
    .filter({ hasText: label })
    .locator(".af-stat-value");
}

test.describe("a real phase write reaches the open page", () => {
  let slug = "";

  test.beforeEach(() => {
    slug = newLiveSlug();
  });

  test.afterEach(() => {
    removeLiveRun(slug);
    for (const file of liveRunFiles(slug))
      expect(existsSync(file), `${file} was removed`).toBe(false);
  });

  test("Forge run shows a phase-gate write within one second, without a reload", async ({
    page,
  }) => {
    await stubSnapshot(page);
    await openSettled(page, FORGE_RUN);
    await expect(page.locator("h1")).toHaveText("Forge run");
    await expect(page.getByText(slug)).toHaveCount(0);
    await mark(page);

    // The run does not exist yet: its first write makes it the newest run in flight.
    const appeared = await measuredWrite(page, slug, "research");
    await expect(
      page.locator("h2.af-card-title", { hasText: slug }),
    ).toBeVisible();
    const planRow = page.locator(".af-phase", {
      has: page.locator(".af-phase-title", { hasText: /^Plan$/ }),
    });
    await expect(planRow).toHaveClass(/af-phase-active/);

    // A second write changes a row of a run already on screen.
    const advanced = await measuredWrite(page, slug, "plan");
    await expect(planRow).toHaveClass(/af-phase-complete/);

    expect(appeared, "research write shown within the bound").toBeLessThan(
      WITHIN_MS,
    );
    expect(advanced, "plan write shown within the bound").toBeLessThan(
      WITHIN_MS,
    );
    await expectNoReload(page);
  });

  test("the dashboard's Runs in flight card counts a new run without a reload", async ({
    page,
  }) => {
    await stubSnapshot(page);
    await openSettled(page, DASHBOARD);
    const card = liveCard(page, "Runs in flight");
    await expect(card).toHaveText(/^\d+$/);
    const before = Number(await card.textContent());
    await mark(page);

    await writePhase(slug, "research");
    await expect(card).toHaveText(String(before + 1), { timeout: 5000 });
    await expectNoReload(page);
  });
});

test("one stream connection serves every page of the app", async ({ page }) => {
  const streamRequests = countStreamRequests(page);
  await stubSnapshot(page);
  await openSettled(page, DASHBOARD);
  await expect(page.getByTestId("live-stats")).toBeVisible();

  for (const hash of ["#/forge-run", "#/commands", "#/issues", "#/dashboard"]) {
    await openSettled(page, `/index.html${hash}`);
  }
  await expect(page.getByTestId("live-stats")).toBeVisible();
  await expect(page.getByTestId("live-banner")).toHaveCount(0);
  expect(streamRequests()).toBe(1);
});

test("where nothing serves a stream, the page asks once, says so once, and still works", async ({
  page,
}) => {
  // What a static host answers for both of the hearth's routes this page uses.
  const streamRequests = countStreamRequests(page);
  await page.route(`**${STREAM}`, (route) =>
    route.fulfill({
      status: 404,
      contentType: "text/plain",
      body: "Not found",
    }),
  );
  await page.route("**/__agent-forge/dev-api/forge-run", (route) =>
    route.fulfill({
      status: 404,
      contentType: "text/plain",
      body: "Not found",
    }),
  );
  await stubSnapshot(page);
  await openSettled(page, DASHBOARD);

  const banner = page.getByTestId("live-banner");
  await expect(banner).toHaveCount(1);
  await expect(banner).toContainText("Live updates are off");
  await expect(page.getByTestId("live-stats")).toHaveCount(0);
  // The Beads cards come from the bundled snapshot, as before.
  for (const label of ["Open", "In progress", "Blocked", "Closed"])
    await expect(
      page.locator(".af-stat-label", { hasText: new RegExp(`^${label}$`) }),
    ).toBeVisible();

  // Forge run shows what it showed before there was a stream.
  await openSettled(page, FORGE_RUN);
  await expect(banner).toHaveCount(1);
  await expect(
    page.getByText("Forge run needs the local dashboard"),
  ).toBeVisible();

  // A page that shows nothing live says nothing about it.
  await openSettled(page, "/index.html#/commands");
  await expect(page.locator("h1")).toHaveText("Commands");
  await expect(banner).toHaveCount(0);

  // Long enough for a first retry, had one been scheduled.
  await page.waitForTimeout(1500);
  await openSettled(page, DASHBOARD);
  await expect(banner).toHaveCount(1);
  expect(streamRequests()).toBe(1);
});
