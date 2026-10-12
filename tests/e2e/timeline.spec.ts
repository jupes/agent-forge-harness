import { expect, type Page, test } from "@playwright/test";
import { BEADS, openSettled, reloadSettled, stubSnapshot } from "./fixtures";
import { createFromBuilder, requireStandIn } from "./stand-in";

/**
 * The Timeline: one bead's or one run's ledger events, in ledger order.
 *
 * The first tests read the suite's real hearth, whose ledger holds what the
 * page's own writes recorded: a bead created and commented on through the
 * bead builder has three events under `bead=<id>` (the create's
 * `bead.transitioned`; the comment's `operator.action` and
 * `bead.transitioned`). The create's `operator.action` names no bead, since
 * none existed yet, and no operator write carries a session, so nothing else
 * joins.
 */

/** A bead bd knows, with one comment, created through the page; and a snapshot that lists it. */
async function beadWithComment(page: Page, title: string): Promise<string> {
  await openSettled(page, "/index.html#/bead-builder");
  await requireStandIn(page);
  const id = await createFromBuilder(page, title);
  const actions = page
    .locator("#bead-created-card")
    .getByRole("region", { name: `Actions on ${id}` });
  await actions.getByLabel("Comment").fill("worklog: on the timeline");
  await actions.getByRole("button", { name: "Add comment" }).click();
  await expect(actions.getByRole("status")).toContainText(
    `Comment added to ${id}`,
  );
  await stubSnapshot(page, {
    ...BEADS,
    issues: [
      ...BEADS.issues,
      {
        id,
        type: "task",
        title,
        status: "open",
        createdAt: "2026-10-12T00:00:00.000Z",
        updatedAt: "2026-10-12T00:00:00.000Z",
      },
    ],
  });
  return id;
}

const rows = (page: Page) => page.locator(".af-timeline-row");

async function kindsShown(page: Page): Promise<string[]> {
  return rows(page).evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-kind") ?? ""),
  );
}

test("a bead opened from its issue detail's Timeline link shows its events from the hearth, in ledger order", async ({
  page,
}) => {
  const id = await beadWithComment(page, "Timeline tracer");

  // The snapshot is read when a document loads: go to the list, then reload.
  await openSettled(page, "/index.html#/issues");
  await reloadSettled(page);
  await page.locator(`[data-issue-id="${id}"]`).click();
  await page
    .locator(".af-detail")
    .getByRole("link", { name: "Timeline" })
    .click();

  await expect(page).toHaveURL(
    new RegExp(`#/timeline\\?bead=${id.replace(".", "\\.")}$`),
  );
  await expect(page.locator("h1")).toHaveText("Timeline");
  await expect(rows(page)).toHaveCount(3);
  expect(await kindsShown(page)).toEqual([
    "bead.transitioned",
    "operator.action",
    "bead.transitioned",
  ]);
  await expect(rows(page).nth(0)).toContainText("create");
  await expect(rows(page).nth(2)).toContainText("comment");
  // Every row is this bead's, in ledger order.
  const shown = await rows(page).evaluateAll((elements) =>
    elements.map((element) => Number(element.getAttribute("data-event-id"))),
  );
  expect(shown).toEqual([...shown].sort((a, b) => a - b));
});

test("choosing a kind narrows the rows to that kind, puts it in the address, survives a reload, and reads nothing more", async ({
  page,
}) => {
  const id = await beadWithComment(page, "Timeline kinds");
  await openSettled(page, `/index.html#/timeline?bead=${id}`);
  await expect(rows(page)).toHaveCount(3);

  const kinds = page.getByRole("group", { name: "Kinds" });
  const action = kinds.getByRole("button", { name: /^operator\.action/ });
  await expect(action).toHaveAttribute("aria-pressed", "false");
  await expect(action).toContainText("1");
  await expect(
    kinds.getByRole("button", { name: /^bead\.transitioned/ }),
  ).toContainText("2");

  const reads: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/__agent-forge/events"))
      reads.push(request.url());
  });
  await action.click();
  await expect(action).toHaveAttribute("aria-pressed", "true");
  await expect(rows(page)).toHaveCount(1);
  expect(await kindsShown(page)).toEqual(["operator.action"]);
  expect(page.url()).toContain(`#/timeline?bead=${id}&kind=operator.action`);
  expect(reads, "a kind change is applied to what was read").toEqual([]);

  await reloadSettled(page);
  await expect(rows(page)).toHaveCount(1);
  await expect(
    page
      .getByRole("group", { name: "Kinds" })
      .getByRole("button", { name: /^operator\.action/ }),
  ).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Every kind" }).click();
  await expect(rows(page)).toHaveCount(3);
  expect(page.url().endsWith(`#/timeline?bead=${id}`)).toBe(true);
});

test("at phone width the filled list and its kind chips fit the screen, and the page does not scroll sideways @mobile", async ({
  page,
}) => {
  const id = await beadWithComment(page, "Timeline at 375px");
  await openSettled(page, `/index.html#/timeline?bead=${id}`);
  await expect(rows(page)).toHaveCount(3);
  const width = page.viewportSize()?.width ?? 0;
  expect(width).toBe(375);
  for (const part of [
    page.locator(".af-timeline-list"),
    page.getByRole("group", { name: "Kinds" }),
  ]) {
    const box = await part.boundingBox();
    expect(box, "the part is laid out").not.toBeNull();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? Infinity)).toBeLessThanOrEqual(width);
  }
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});
