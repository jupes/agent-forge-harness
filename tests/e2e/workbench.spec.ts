/**
 * The Workbench against the suite's real hearth and its `bd` stand-in: a bead
 * is created through the bead builder, put in the queue as proposed (as the
 * scheduler's propose would; no route proposes), and moved on the board.
 */

import { expect, type Page, test } from "@playwright/test";
import type {
  EventsPage,
  OperatorEnvelope,
  SmithsView,
} from "../../types/hearth";
import { openSettled, reloadSettled } from "./fixtures";
import { collectErrors } from "./routes";
import { requireStandIn, seedProposed, standInCalls } from "./stand-in";

const API = "/__agent-forge";

/** A read of the operator API, made from the page as the API requires. */
async function readApi<T>(page: Page, path: string): Promise<T> {
  const envelope = await page.evaluate(
    async (url) => (await fetch(url)).json(),
    `${API}${path}`,
  );
  const answer = envelope as OperatorEnvelope<T>;
  if (!answer.ok || answer.data === null)
    throw new Error(`${path} answered: ${answer.error}`);
  return answer.data;
}

async function createBead(page: Page, title: string): Promise<string> {
  await openSettled(page, "/index.html#/bead-builder");
  await requireStandIn(page);
  await page.fill("#bb-title", title);
  const create = page.getByRole("button", { name: "Create bead" });
  await expect(create).toBeEnabled();
  await create.click();
  await expect(page.locator("#bead-created-card")).toContainText(title);
  return (
    await page
      .locator("#bead-created-card .issue-id-copy code")
      .first()
      .innerText()
  ).trim();
}

const cardIn = (page: Page, column: string, id: string) =>
  page.locator(`[data-column="${column}"] [data-bead="${id}"]`);

test("a proposed bead approved on the Workbench moves columns; queue, pause and resume move it on; a reassign shows the smith; each move is an operator.action", async ({
  page,
}) => {
  const errors = collectErrors(page);
  const id = await createBead(page, `Workbench bead ${Date.now()}`);
  seedProposed(id);
  const callsBefore = standInCalls().length;

  await openSettled(page, "/index.html#/workbench");
  await expect(
    page.getByRole("heading", { name: "Workbench" }).first(),
  ).toBeVisible();
  await expect(cardIn(page, "proposed", id)).toBeVisible();

  // Approve: the card leaves Proposed for Approved.
  await page.getByRole("button", { name: `Approve ${id}` }).click();
  await expect(cardIn(page, "approved", id)).toBeVisible();
  await expect(cardIn(page, "proposed", id)).toHaveCount(0);
  await expect(
    cardIn(page, "approved", id).locator('[data-outcome="done"]'),
  ).toContainText(`Approved ${id}.`);

  // Queue, pause and resume move it on, and back to where it was paused from.
  for (const [move, column] of [
    ["Queue", "queued"],
    ["Pause", "paused"],
    ["Resume", "queued"],
  ] as const) {
    await page.getByRole("button", { name: `${move} ${id}` }).click();
    await expect(cardIn(page, column, id)).toBeVisible();
  }

  // Reassign to an enabled smith that is neither the card's nor the default.
  const smiths = await readApi<SmithsView>(page, "/smiths");
  const smith = smiths.smiths.find(
    (s) => s.enabled && s.name !== smiths.defaultSmith,
  )?.name;
  expect(smith, "an enabled smith other than the default").toBeDefined();
  await page.getByLabel(`Smith for ${id}`).selectOption(smith ?? "");
  await page.getByRole("button", { name: `Reassign ${id}` }).click();
  await expect(
    cardIn(page, "queued", id).locator(".af-workbench-smith"),
  ).toHaveText(`smith ${smith}`);

  // Each move is an operator.action naming the bead and the move.
  const events = await readApi<EventsPage>(
    page,
    `/events?kind=operator.action&bead=${encodeURIComponent(id)}&beadExact=1`,
  );
  expect(
    events.events
      .map((event) => (event.payload as { action?: string }).action)
      .sort(),
  ).toEqual(
    [
      "queue.approve",
      "queue.pause",
      "queue.queue",
      "queue.reassign",
      "queue.resume",
    ].sort(),
  );

  // Five writes reached bd for the bead, one per move.
  const writes = standInCalls()
    .slice(callsBefore)
    .filter((call) => call[0] === "update" && call.at(-1) === id);
  expect(writes.length).toBe(5);
  expect(writes.at(-1)).toContain(`--set-metadata=smith=${smith}`);
  expect(errors).toEqual([]);
});

test("a move the hearth refuses says why on the card, and nothing moves", async ({
  page,
}) => {
  const errors = collectErrors(page);
  const id = await createBead(page, `Workbench refused ${Date.now()}`);
  seedProposed(id);
  await openSettled(page, "/index.html#/workbench");
  await expect(cardIn(page, "proposed", id)).toBeVisible();
  // The hearth's answer to this one post is a refusal of the table.
  await page.route(`**${API}/queue/${id}/approve`, (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        data: null,
        error: `${id} is queue:approved: "approve" is not a move from there.`,
      }),
    }),
  );
  await page.getByRole("button", { name: `Approve ${id}` }).click();
  await expect(
    cardIn(page, "proposed", id).locator('[data-outcome="failed"]'),
  ).toContainText('"approve" is not a move from there');
  await expect(cardIn(page, "approved", id)).toHaveCount(0);
  expect(
    errors.filter((text) => !/Failed to load resource.*409/.test(text)),
  ).toEqual([]);
});

test("with no event stream, each move still shows: the page reads the queue again after its own answer", async ({
  page,
}) => {
  const id = await createBead(page, `Workbench no stream ${Date.now()}`);
  seedProposed(id);
  // What a static host answers for the stream: live updates turn off, so
  // only the page's own read after an answer can show a move.
  await page.route(`**${API}/stream`, (route) =>
    route.fulfill({
      status: 404,
      contentType: "text/plain",
      body: "Not found",
    }),
  );
  await openSettled(page, "/index.html#/workbench");
  // A new document: the stream the bead builder opened would otherwise stay.
  await reloadSettled(page);
  await expect(cardIn(page, "proposed", id)).toBeVisible();
  await page.getByRole("button", { name: `Approve ${id}` }).click();
  await expect(cardIn(page, "approved", id)).toBeVisible();
  const smiths = await readApi<SmithsView>(page, "/smiths");
  const smith = smiths.smiths.find(
    (s) => s.enabled && s.name !== smiths.defaultSmith,
  )?.name;
  await page.getByLabel(`Smith for ${id}`).selectOption(smith ?? "");
  await page.getByRole("button", { name: `Reassign ${id}` }).click();
  await expect(
    cardIn(page, "approved", id).locator(".af-workbench-smith"),
  ).toHaveText(`smith ${smith}`);
});

test("when the eligibility read fails, the board says so instead of showing no reasons", async ({
  page,
}) => {
  await page.route(`**${API}/eligibility`, (route) =>
    route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        data: null,
        error: "bd list failed: database is locked",
      }),
    }),
  );
  await openSettled(page, "/index.html#/workbench");
  await reloadSettled(page);
  await expect(page.locator(".af-notice[role=status]")).toContainText(
    "the eligibility read failed (bd list failed: database is locked)",
  );
});
