/**
 * The Workbench against the suite's real hearth and its `bd` stand-in: a bead
 * is created through the bead builder, put in the queue as proposed (written
 * to the stand-in, as the queue's propose would), and moved on the board. Two
 * tests start from labels written by hand instead: one the queue did not
 * write, which the board's Propose takes in, and a bead paused while running,
 * which Resume puts in Queued.
 */

import { expect, type Page, test } from "@playwright/test";
import { TOKEN_ROUTE } from "../../scripts/hearth/paths";
import type {
  EventsPage,
  OperatorEnvelope,
  SmithsView,
} from "../../types/hearth";
import { readState, writeState } from "./bd-stand-in-state";
import { openSettled, reloadSettled } from "./fixtures";
import { collectErrors } from "./routes";
import { BD_STAND_IN_STATE } from "./servers";
import {
  createFromBuilder,
  requireStandIn,
  seedProposed,
  standInCalls,
} from "./stand-in";

const API = "/__agent-forge";

/**
 * Give a bead the test created these queue labels and this metadata, written
 * to the stand-in's issues by hand: no route writes a label the queue would
 * not, or pauses a bead from running without a shift.
 */
function seedQueue(
  id: string,
  labels: string[],
  metadata?: Record<string, string>,
): void {
  const issues = readState(BD_STAND_IN_STATE);
  const issue = issues[id];
  if (issue === undefined)
    throw new Error(`the stand-in has no issue ${id} to label`);
  issues[id] = {
    ...issue,
    labels: [...(issue.labels ?? []), ...labels],
    ...(metadata !== undefined
      ? { metadata: { ...(issue.metadata ?? {}), ...metadata } }
      : {}),
  };
  writeState(BD_STAND_IN_STATE, issues);
}

/** The queue actions recorded for a bead, as `operator.action` rows name them. */
async function operatorActions(page: Page, id: string): Promise<string[]> {
  const events = await readApi<EventsPage>(
    page,
    `/events?kind=operator.action&bead=${encodeURIComponent(id)}&beadExact=1`,
  );
  return events.events
    .map((event) => (event.payload as { action?: string }).action ?? "")
    .sort();
}

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

test("a queue label the queue did not write offers Propose alone and says why; Propose puts the bead in Proposed, where Approve is offered, with one write and one operator.action", async ({
  page,
}) => {
  const errors = collectErrors(page);
  const id = await createBead(page, `Workbench unbacked ${Date.now()}`);
  // A queue:queued label and no queue_state: as a child inherits it, or a hand adds it.
  seedQueue(id, ["queue:queued"]);
  const callsBefore = standInCalls().length;

  await openSettled(page, "/index.html#/workbench");
  const card = cardIn(page, "queued", id);
  await expect(card).toBeVisible();
  await expect(card.locator(".af-workbench-note")).toContainText(
    "Propose puts it in the queue as proposed",
  );
  await expect(card.getByRole("button")).toHaveText(["Propose"]);

  await page.getByRole("button", { name: `Propose ${id}` }).click();
  await expect(cardIn(page, "proposed", id)).toBeVisible();
  await expect(cardIn(page, "queued", id)).toHaveCount(0);
  await expect(
    cardIn(page, "proposed", id).locator('[data-outcome="done"]'),
  ).toContainText(`Proposed ${id}.`);
  await expect(
    page.getByRole("button", { name: `Approve ${id}` }),
  ).toBeVisible();

  const writes = standInCalls()
    .slice(callsBefore)
    .filter((call) => call[0] === "update" && call.at(-1) === id);
  expect(writes).toEqual([
    [
      "update",
      "--remove-label=queue:queued",
      "--add-label=queue:proposed",
      "--set-metadata=queue_state=proposed",
      "--json",
      "--",
      id,
    ],
  ]);
  expect(await operatorActions(page, id)).toEqual(["queue.propose"]);
  expect(errors).toEqual([]);
});

test("a bead paused while running says Resume puts it in Queued, and Resume does: it never goes back to Running", async ({
  page,
}) => {
  const errors = collectErrors(page);
  const id = await createBead(page, `Workbench paused running ${Date.now()}`);
  seedQueue(id, ["queue:paused"], {
    queue_state: "paused",
    queue_resume: "running",
  });

  await openSettled(page, "/index.html#/workbench");
  const card = cardIn(page, "paused", id);
  await expect(card).toBeVisible();
  await expect(card.locator('[data-resume-to="queued"]')).toHaveText(
    "Resume puts it in Queued, where a shift starts it. A bead paused while it was running goes there too: nothing runs it after a pause.",
  );

  await page.getByRole("button", { name: `Resume ${id}` }).click();
  await expect(cardIn(page, "queued", id)).toBeVisible();
  await expect(
    cardIn(page, "queued", id).locator('[data-outcome="done"]'),
  ).toContainText(`Resumed ${id} to Queued.`);
  await expect(cardIn(page, "running", id)).toHaveCount(0);
  await expect(cardIn(page, "paused", id)).toHaveCount(0);
  expect(await operatorActions(page, id)).toEqual(["queue.resume"]);
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

test("a move whose operator token cannot be had says on the card it was not sent; no move is posted, the card stays, and bd gets no update for the bead", async ({
  page,
}) => {
  const errors = collectErrors(page);
  const id = await createBead(page, `Workbench not sent ${Date.now()}`);
  seedProposed(id);
  await openSettled(page, "/index.html#/workbench");
  // A new document: the token the bead builder's create fetched would otherwise stay.
  await reloadSettled(page);
  await expect(cardIn(page, "proposed", id)).toBeVisible();
  const callsBefore = standInCalls().length;
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST") posts.push(request.url());
  });
  // The page's request for the token is refused, as while the control plane starts.
  await page.route(`**${TOKEN_ROUTE}`, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        data: null,
        error: "the control plane is starting",
      }),
    }),
  );
  await page.getByRole("button", { name: `Approve ${id}` }).click();

  await expect(
    cardIn(page, "proposed", id).locator('[data-outcome="failed"]'),
  ).toHaveText(
    "Not sent (approve): the page could not get an operator token from the control plane (the control plane is starting). Nothing was changed.",
  );
  await expect(cardIn(page, "approved", id)).toHaveCount(0);
  expect(posts).toEqual([]);
  expect(
    standInCalls()
      .slice(callsBefore)
      .filter((call) => call[0] === "update" && call.includes(id)),
  ).toEqual([]);
  expect(
    errors.filter((text) => !/Failed to load resource.*503/.test(text)),
  ).toEqual([]);
});

test("with no event stream, an approve and a reassign still show: the page reads the queue again after its own answer", async ({
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

test("a child created in the bead builder under a proposed bead carries the queue label bd copied from its parent, and the board shows it as a label the queue did not write", async ({
  page,
}) => {
  const errors = collectErrors(page);
  const parent = await createBead(page, `Workbench parent ${Date.now()}`);
  seedProposed(parent);

  await page.getByRole("button", { name: "Clear form" }).click();
  await page.fill("#bb-parent", parent);
  const child = await createFromBuilder(page, `Workbench child ${Date.now()}`);
  expect(child).toBe(`${parent}.1`);
  // The created card shows the labels bd printed for the child.
  await expect(
    page
      .locator("#bead-created-card .af-detail-row")
      .filter({ has: page.locator("dt", { hasText: "Labels" }) })
      .locator("dd .af-tag"),
  ).toHaveText(["queue:proposed"]);

  await openSettled(page, "/index.html#/workbench");
  await expect(cardIn(page, "proposed", parent)).toBeVisible();
  const card = cardIn(page, "proposed", child);
  await expect(card).toBeVisible();
  await expect(card.locator(".af-workbench-note")).toContainText(
    "The queue did not write this label",
  );
  // Approval is not inherited: the child is offered no approve.
  await expect(
    page.getByRole("button", { name: `Approve ${child}` }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});
