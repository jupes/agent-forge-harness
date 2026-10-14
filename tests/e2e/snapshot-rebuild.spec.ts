import { expect, test } from "@playwright/test";
import type { BeadsPayload } from "../../types/beads";
import { BEADS, openSettled } from "./fixtures";
import { buildStandInRuns } from "./servers";
import { createFromBuilder, requireStandIn } from "./stand-in";

/**
 * A tracker write made through the hearth makes the dashboard rebuild the
 * snapshot (its tracker-write follower), here with the suite's build stand-in.
 * What an open page does then is what this spec checks: it reads the snapshot
 * again in place and keeps what it holds that is not saved.
 */

const UNSENT = "Half-written bead, not sent";

test("a rebuild after a write from another tab leaves the bead builder's unsent title in place, without a reload, and the shell shows the snapshot read again", async ({
  page,
  context,
}) => {
  const rebuilt: BeadsPayload = {
    ...BEADS,
    generatedAt: "2026-10-14T12:34:56.000Z",
  };
  // What `data/beads.json` answers: the first snapshot, until the write below.
  let served: BeadsPayload = BEADS;
  await page.route("**/data/beads.json", (route) =>
    route.fulfill({ json: served }),
  );
  await openSettled(page, "/index.html#/bead-builder");
  await requireStandIn(page);
  const snapshot = page.locator(".af-shell-snapshot");
  await expect(snapshot).toHaveAttribute("title", `ISO: ${BEADS.generatedAt}`);

  // Gone if the document is replaced.
  await page.evaluate(() => {
    document.documentElement.dataset["e2eSameDocument"] = "yes";
  });
  await page.fill("#bb-title", UNSENT);

  served = rebuilt;
  const builds = buildStandInRuns();
  const other = await context.newPage();
  await openSettled(other, "/index.html#/bead-builder");
  await createFromBuilder(other, `Written from another tab ${Date.now()}`);

  await expect
    .poll(buildStandInRuns, {
      message: "the dashboard ran a rebuild after the write",
      timeout: 15_000,
    })
    .toBeGreaterThan(builds);
  await expect(snapshot).toHaveAttribute(
    "title",
    `ISO: ${rebuilt.generatedAt}`,
    { timeout: 15_000 },
  );
  await expect(page.locator("#bb-title")).toHaveValue(UNSENT);
  expect(
    await page.evaluate(
      () => document.documentElement.dataset["e2eSameDocument"],
    ),
  ).toBe("yes");
  await other.close();
});
