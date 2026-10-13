import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  OPERATOR_HEADER,
  SURFACE_HEADER,
  TOKEN_ROUTE,
} from "../../scripts/hearth/paths";
import { BEADS, openSettled, reloadSettled, stubSnapshot } from "./fixtures";
import { BD_STAND_IN_STATE } from "./servers";
import {
  createButton,
  createdId,
  createFromBuilder,
  isList,
  requireStandIn,
  standInCalls,
} from "./stand-in";

/**
 * The builders: the clipboard fallback and feedback of both, and, for the
 * bead builder, writing to the tracker through the control plane (further
 * down, with the issue detail panel's actions).
 *
 * The builders' clipboard fallback and feedback.
 *
 * The fallback only appears when the clipboard is unavailable, which a normal
 * browser run never exercises — so force it. The original PR's check read the
 * textarea's value, which still worked while readOnly, its ref and the
 * auto-selection had all silently stopped working.
 */

async function denyClipboard(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () => Promise.reject(new Error("clipboard denied in test")),
      },
    });
  });
}

async function selectionOf(page: Page, selector: string) {
  return page.locator(selector).evaluate((el) => {
    const textarea = el as HTMLTextAreaElement;
    return {
      readOnly: textarea.readOnly,
      start: textarea.selectionStart,
      end: textarea.selectionEnd,
      length: textarea.value.length,
      value: textarea.value,
      focused: document.activeElement === textarea,
    };
  });
}

test("bead builder fallback is read-only, focused and fully selected", async ({
  page,
}) => {
  await denyClipboard(page);
  await openSettled(page, "/index.html#/bead-builder");
  await page.fill("#bb-title", "Fallback check");
  await page.click("button[type=submit]");

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading")).toHaveText("Copy this command");

  await expect
    .poll(() => selectionOf(page, "#bb-modal-textarea"))
    .toMatchObject({ readOnly: true, start: 0, focused: true });
  const selection = await selectionOf(page, "#bb-modal-textarea");
  expect(selection.value).toContain("bd create");
  expect(selection.end).toBe(selection.length);
});

test("skill builder fallback is read-only, focused and fully selected", async ({
  page,
}) => {
  await denyClipboard(page);
  await openSettled(page, "/index.html#/skill-builder");
  await page.fill("#sb-skill-name", "deploy staging");
  await page.fill("#sb-description", "Deploy to staging");
  await page.click("button[type=submit]");

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading")).toHaveText("Copy this prompt");

  await expect
    .poll(() => selectionOf(page, "#sb-modal-textarea"))
    .toMatchObject({ readOnly: true, start: 0, focused: true });
  const selection = await selectionOf(page, "#sb-modal-textarea");
  expect(selection.value).toContain("authoring-agent-skills");
  expect(selection.end).toBe(selection.length);
});

test("the fallback text cannot be edited", async ({ page }) => {
  await denyClipboard(page);
  await openSettled(page, "/index.html#/bead-builder");
  await page.fill("#bb-title", "Read-only check");
  await page.click("button[type=submit]");

  const textarea = page.locator("#bb-modal-textarea");
  await expect(textarea).toBeVisible();
  const before = await textarea.inputValue();
  await textarea.press("End");
  await page.keyboard.type("tampered");
  await expect(textarea).toHaveValue(before);
});

for (const [route, card, fill] of [
  ["bead-builder", "#bead-form-card", ["#bb-title", "Flash check"]],
  ["skill-builder", "#skill-form-card", ["#sb-skill-name", "flash"]],
] as const) {
  test(`${route} success flash lands on its card and clears`, async ({
    page,
  }) => {
    await openSettled(page, `/index.html#/${route}`);
    const target = page.locator(card);
    await expect(target).toHaveCount(1);

    await page.fill(fill[0], fill[1]);
    if (route === "skill-builder") {
      await page.fill("#sb-description", "flash description");
    }
    await page.click("button[type=submit]");

    await expect(target).toHaveClass(/is-success-flash/);
    await expect(target).not.toHaveClass(/is-success-flash/, {
      timeout: 5_000,
    });
  });
}

/*
 * Writing to the tracker from the page.
 *
 * These run against the hearth the suite started, whose `bd` is the recording
 * stand-in (`bd-stand-in.ts`): nothing here reaches a tracker. Every step is
 * taken through the page's own controls. What is checked is what the page
 * shows, the argument arrays the stand-in was given, and what the hearth wrote
 * to its ledger.
 */

const API = "/__agent-forge";

interface Recorded {
  id: number;
  kind: string;
  beadId?: string;
  payload: Record<string, unknown>;
}

/** What the hearth has recorded about tracker writes, oldest first. */
async function recorded(page: Page): Promise<Recorded[]> {
  const answer = await page.evaluate(async (url) => {
    const response = await fetch(url);
    return { status: response.status, body: await response.json() };
  }, `${API}/events?limit=1000&kind=operator.action,bead.transitioned`);
  expect(answer.status).toBe(200);
  return (answer.body as { data: { events: Recorded[] } }).data.events;
}

/**
 * Open the issue list on a freshly loaded page. Going there from another view
 * only changes the hash, and the snapshot is read when the page loads: a
 * snapshot served from here on would not be the one on screen.
 */
async function openIssues(page: Page): Promise<void> {
  await openSettled(page, "/index.html#/issues");
  await reloadSettled(page);
}

/**
 * Close the builder's dialog and wait until the page behind it is usable
 * again: the dialog gone, and focus back on the button that opened it. Until
 * then a field that is typed into loses the focus to that hand-back, and the
 * typing goes nowhere without an error.
 */
async function closeDialog(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Close" }).first().click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("button[type=submit]")).toBeFocused();
}

test("create, claim and comment from the bead builder go through the control plane to bd, and are recorded", async ({
  page,
}) => {
  await openSettled(page, "/index.html#/bead-builder");
  await requireStandIn(page);
  const callsBefore = standInCalls().length;
  const lastEvent = (await recorded(page)).at(-1)?.id ?? 0;
  const token = await page.evaluate(async (url) => {
    const body = (await (await fetch(url)).json()) as {
      data: { token: string };
    };
    return body.data.token;
  }, TOKEN_ROUTE);

  // A parent: an epic, so the type that reaches bd is not the default.
  await page.selectOption("#bb-type", "epic");
  const posted = page.waitForRequest(
    (request) =>
      request.method() === "POST" && request.url().endsWith(`${API}/beads`),
  );
  const parentId = await createFromBuilder(page, "Round trip parent");
  const request = await posted;
  expect(request.headers()[OPERATOR_HEADER]).toBe(token);
  expect(request.headers()[SURFACE_HEADER]).toBe("ui");
  expect((await request.response())?.status()).toBe(201);

  // Typed for the parent and never sent: it must not be waiting in the fields
  // of the next bead this card shows, one press away from the wrong issue.
  const parentCard = page.locator("#bead-created-card");
  await parentCard.getByLabel("Comment").fill("typed for the parent");
  await parentCard
    .getByLabel("Reason for closing")
    .fill("a reason typed for the parent");

  // A child of it, with a type and a priority that are not the defaults. A
  // label is typed and cleared in between: the form re-renders, and what was
  // chosen must still be what is sent.
  await page.getByRole("button", { name: "Clear form" }).click();
  await page.selectOption("#bb-type", "bug");
  await page.selectOption("#bb-priority", "P1");
  await page.fill("#bb-parent", parentId);
  await page.fill("#bb-labels", "dashboard");
  await expect(createButton(page)).toBeDisabled();
  await expect(page.locator("#bb-create-reason")).toContainText("Labels");
  await page.fill("#bb-labels", "");
  await page.fill(
    "#bb-description",
    "Why this child exists\nand a second line",
  );
  await page.fill("#bb-ac", "it is created\n\n  it is claimed  ");
  const childId = await createFromBuilder(page, "Round trip child");
  expect(childId).toBe(`${parentId}.1`);

  const card = page.locator("#bead-created-card");
  const actions = card.getByRole("region", { name: `Actions on ${childId}` });
  await expect(actions.getByLabel("Comment")).toHaveValue("");
  await expect(actions.getByLabel("Reason for closing")).toHaveValue("");

  await actions.getByRole("button", { name: "Claim", exact: true }).click();
  await expect(actions.getByRole("status")).toContainText(`Claimed ${childId}`);
  await expect(card).toContainText("in progress");
  await expect(
    actions.getByRole("button", { name: "Claim", exact: true }),
  ).toBeDisabled();

  await actions.getByLabel("Comment").fill("worklog: round trip comment");
  await actions.getByRole("button", { name: "Add comment" }).click();
  await expect(actions.getByRole("status")).toContainText(
    `Comment added to ${childId}`,
  );
  await expect(card.locator(".af-detail-comments")).toContainText(
    "worklog: round trip comment",
  );

  // Exactly these calls reached bd, as argument arrays, in this order.
  expect(
    standInCalls()
      .slice(callsBefore)
      .filter((call) => !isList(call)),
  ).toEqual([
    [
      "create",
      "--title=Round trip parent",
      "--type=epic",
      "--priority=2",
      "--json",
    ],
    [
      "create",
      "--title=Round trip child",
      "--type=bug",
      "--priority=1",
      `--parent=${parentId}`,
      "--description=Why this child exists\nand a second line",
      "--acceptance=it is created\nit is claimed",
      "--json",
    ],
    ["update", "--claim", "--json", "--", childId],
    ["comments", "add", "--json", "--", childId, "worklog: round trip comment"],
  ]);

  // The hearth recorded each attempt, then each outcome, and no text of either.
  const events = (await recorded(page)).filter((event) => event.id > lastEvent);
  expect(
    events.map((event) => ({
      kind: event.kind,
      beadId: event.beadId,
      action: event.payload["action"],
      surface: event.payload["surface"],
      target: event.payload["target"],
    })),
  ).toEqual([
    {
      kind: "operator.action",
      beadId: undefined,
      action: "bead.create",
      surface: "ui",
      target: undefined,
    },
    {
      kind: "bead.transitioned",
      beadId: parentId,
      action: "create",
      surface: undefined,
      target: undefined,
    },
    {
      kind: "operator.action",
      beadId: parentId,
      action: "bead.create",
      surface: "ui",
      target: parentId,
    },
    {
      kind: "bead.transitioned",
      beadId: childId,
      action: "create",
      surface: undefined,
      target: undefined,
    },
    {
      kind: "operator.action",
      beadId: childId,
      action: "bead.claim",
      surface: "ui",
      target: childId,
    },
    {
      kind: "bead.transitioned",
      beadId: childId,
      action: "claim",
      surface: undefined,
      target: undefined,
    },
    {
      kind: "operator.action",
      beadId: childId,
      action: "bead.comment",
      surface: "ui",
      target: childId,
    },
    {
      kind: "bead.transitioned",
      beadId: childId,
      action: "comment",
      surface: undefined,
      target: undefined,
    },
  ]);
  const serialized = JSON.stringify(events);
  for (const text of ["Round trip", "Why this child", "round trip comment"])
    expect(serialized).not.toContain(text);
  expect(events.at(-1)?.payload).toMatchObject({
    length: "worklog: round trip comment".length,
    hash: expect.stringMatching(/^[0-9a-f]{64}$/),
  });

  // A reload does not lose what was done: the dev server reloads the page
  // when the tracker changes, and a lost id would invite a second create.
  await reloadSettled(page);
  const again = page.locator("#bead-created-card");
  await expect(again.locator(".issue-id-copy code").first()).toHaveText(
    childId,
  );
  await expect(again).toContainText("in progress");
  await expect(again.locator(".af-detail-comments")).toContainText(
    "worklog: round trip comment",
  );
  await expect(again).toContainText(parentId);
});

test("claim, comment and close from the issue detail panel; what was changed is still shown when the row is reopened and after a reload", async ({
  page,
}) => {
  // A bead bd knows: created through the builder, so each run has its own.
  await openSettled(page, "/index.html#/bead-builder");
  await requireStandIn(page);
  const id = await createFromBuilder(page, "Panel bead");
  const callsBefore = standInCalls().length;

  // Then the snapshot a rebuild from the tracker would give: it holds the bead.
  await stubSnapshot(page, {
    ...BEADS,
    issues: [
      ...BEADS.issues,
      {
        id,
        type: "task",
        title: "Panel bead",
        status: "open",
        createdAt: "2026-09-11T00:00:00.000Z",
        updatedAt: "2026-09-11T00:00:00.000Z",
      },
    ],
  });
  await openIssues(page);
  const row = page.locator(`[data-issue-id="${id}"]`);
  await row.click();
  const panel = page.locator(".af-detail");
  const actions = panel.getByRole("region", { name: `Actions on ${id}` });
  const status = panel.locator(".af-detail-row", { hasText: "Status" });

  await actions.getByRole("button", { name: "Claim", exact: true }).click();
  await expect(actions.getByRole("status")).toContainText(`Claimed ${id}`);
  await expect(status).toContainText("in progress");
  await expect(status).toContainText(
    "from your actions on this page; the snapshot says open",
  );

  await actions.getByLabel("Comment").fill("worklog: seen from the panel");
  await actions.getByRole("button", { name: "Add comment" }).click();
  await expect(actions.getByRole("status")).toContainText(
    `Comment added to ${id}`,
  );
  const added = panel.locator(".af-bead-added-comment");
  await expect(added).toContainText("worklog: seen from the panel");
  await expect(added).toContainText("from your actions on this page");

  // Collapsed and reopened, the panel still shows what was done here.
  await panel.getByRole("button", { name: "Close expanded issue" }).click();
  await expect(panel).toHaveCount(0);
  await row.click();
  await expect(status).toContainText("in progress");
  await expect(panel.locator(".af-bead-added-comment")).toContainText(
    "worklog: seen from the panel",
  );

  // A close asks for its reason: without one it is not offered.
  const close = actions.getByRole("button", { name: "Close issue" });
  await expect(close).toBeDisabled();
  await actions
    .getByLabel("Reason for closing")
    .fill("Verified in the browser suite");
  await expect(close).toBeEnabled();
  await close.click();
  await expect(actions.getByRole("status")).toContainText(`Closed ${id}`);
  await expect(status).toContainText("closed");
  await expect(close).toBeDisabled();
  await expect(panel).toContainText("This bead is already closed.");

  // After a reload too.
  await reloadSettled(page);
  await page.locator(`[data-issue-id="${id}"]`).click();
  const reloaded = page.locator(".af-detail");
  await expect(
    reloaded.locator(".af-detail-row", { hasText: "Status" }),
  ).toContainText("closed");
  await expect(reloaded.locator(".af-bead-added-comment")).toContainText(
    "worklog: seen from the panel",
  );
  // The row above the panel is the snapshot's, and the panel says so.
  await expect(reloaded.locator(".af-bead-snapshot-note")).toContainText(
    "snapshot",
  );

  expect(
    standInCalls()
      .slice(callsBefore)
      .filter((call) => !isList(call)),
  ).toEqual([
    ["update", "--claim", "--json", "--", id],
    ["comments", "add", "--json", "--", id, "worklog: seen from the panel"],
    ["close", "--reason=Verified in the browser suite", "--json", "--", id],
  ]);
});

test("with no control plane the actions are disabled and say why, and copying the command still works", async ({
  page,
}) => {
  // What a static copy of the dashboard gets: no answer from the control plane.
  await page.route("**/__agent-forge/beads/options", (route) =>
    route.fulfill({ status: 404, body: "Not Found" }),
  );
  const callsBefore = standInCalls().length;
  await openSettled(page, "/index.html#/bead-builder");

  await expect(createButton(page)).toBeDisabled();
  await expect(page.locator("#bb-create-reason")).toContainText(
    "Needs the local control plane",
  );
  await page.fill("#bb-title", "Static copy");
  await page.fill("#bb-parent", "demo-epic");
  await page.click("button[type=submit]");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(page.locator("#bb-modal-textarea")).toHaveValue(
    /bd create .*--parent "demo-epic" --title "Static copy"/,
  );
  await closeDialog(page);

  await stubSnapshot(page);
  await openIssues(page);
  await page.locator('[data-issue-id="demo-migrate"]').click();
  const actions = page.getByRole("region", { name: "Actions on demo-migrate" });
  await expect(actions).toContainText("Needs the local control plane");
  for (const name of ["Claim", "Add comment", "Close issue"])
    await expect(
      actions.getByRole("button", { name, exact: true }),
    ).toBeDisabled();
  await expect(actions.getByLabel("Comment")).toBeDisabled();

  expect(
    standInCalls()
      .slice(callsBefore)
      .filter((call) => !isList(call)),
  ).toEqual([]);
});

test("Create is not offered while Labels or another Repo is set, and is again once they are cleared", async ({
  page,
}) => {
  await openSettled(page, "/index.html#/bead-builder");
  await page.fill("#bb-title", "Labelled");
  await expect(createButton(page)).toBeEnabled();

  await page.fill("#bb-labels", "dashboard,ui");
  await expect(createButton(page)).toBeDisabled();
  await expect(page.locator("#bb-create-reason")).toContainText("Labels");
  // The copied command keeps them.
  await page.click("button[type=submit]");
  await expect(page.locator("#bb-modal-textarea")).toHaveValue(
    /--labels "dashboard,ui"/,
  );
  await closeDialog(page);

  await page.fill("#bb-labels", "");
  await expect(createButton(page)).toBeEnabled();
  await page.fill("#bb-repo", "./repos/elsewhere");
  await expect(createButton(page)).toBeDisabled();
  await expect(page.locator("#bb-create-reason")).toContainText("Repo");

  // Clear form resets the form without firing an input event: the rule follows.
  await page.getByRole("button", { name: "Clear form" }).click();
  await page.fill("#bb-title", "Cleared");
  await expect(createButton(page)).toBeEnabled();
  await expect(page.locator("#bb-create-reason")).toHaveCount(0);

  await page.fill("#bb-parent", "not an id");
  await expect(createButton(page)).toBeDisabled();
  await expect(page.locator("#bb-create-reason")).toContainText("Parent");
});

test("a refusal by bd is shown as the error, and nothing says a bead was created", async ({
  page,
}) => {
  await openSettled(page, "/index.html#/bead-builder");
  await requireStandIn(page);
  await page.fill("#bb-title", "Orphan");
  await page.fill("#bb-parent", "e2e-no-such-parent");
  await createButton(page).click();

  const result = page.locator("#bb-create-result");
  await expect(result).toContainText(
    "bd create failed: parent issue e2e-no-such-parent not found",
  );
  await expect(result).toHaveAttribute("data-outcome", "failed");
  await expect(result).not.toContainText("Created");
  await expect(page.locator("#bead-created-card")).toHaveCount(0);
  // Seen where it was sent, the refusal is not also listed as one to check.
  await expect(writesToCheck(page)).toHaveCount(0);
});

/** A snapshot that holds `id` as an open task: what a rebuild from the tracker would give. */
function snapshotWith(id: string, title: string): typeof BEADS {
  return {
    ...BEADS,
    issues: [
      ...BEADS.issues,
      {
        id,
        type: "task",
        title,
        status: "open",
        createdAt: "2026-09-11T00:00:00.000Z",
        updatedAt: "2026-09-11T00:00:00.000Z",
      },
    ],
  };
}

/**
 * Hold every POST to `url` until `release()` is called, counting them as they
 * arrive. A request the page gave up on (it was reloaded) is let go quietly.
 */
async function holdPosts(
  page: Page,
  url: string,
): Promise<{ count: () => number; release: (answer?: Answer) => void }> {
  let seen = 0;
  let open: () => void = () => undefined;
  let reply: Answer | undefined;
  const released = new Promise<void>((resolve) => {
    open = resolve;
  });
  await page.route(url, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    seen++;
    await released;
    // With an answer the request is answered here and never reaches the hearth.
    if (reply !== undefined)
      await route
        .fulfill({
          status: reply.status,
          contentType: "application/json",
          body: JSON.stringify(reply.body),
        })
        .catch(() => undefined);
    else await route.continue().catch(() => undefined);
  });
  return {
    count: () => seen,
    release: (answer) => {
      reply = answer;
      open();
    },
  };
}

/** An answer `holdPosts` can give in place of the hearth's. */
interface Answer {
  status: number;
  body: unknown;
}

/** What the control plane answers when bd did not finish: the outcome is not known. */
function notFinished(id: string, command: string): Answer {
  return {
    status: 504,
    body: {
      ok: false,
      data: null,
      error: `bd ${command} did not finish within its time limit; the change may still have been made. Check with \`bd show ${id}\` before trying again.`,
    },
  };
}

/** Answer every POST to `url` with `answer`, before it reaches the hearth. */
async function answerPosts(page: Page, url: string, answer: Answer) {
  await page.route(url, (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: answer.status,
          contentType: "application/json",
          body: JSON.stringify(answer.body),
        })
      : route.continue(),
  );
}

/** The page's one list of writes to check, on every route. */
const writesToCheck = (page: Page) =>
  page.getByRole("region", { name: "Writes to check" });

/** Press a button twice in one turn of the event loop: before the page can draw it disabled. */
async function pressTwiceAtOnce(button: Locator): Promise<void> {
  await button.evaluate((element: HTMLButtonElement) => {
    element.click();
    element.click();
  });
}

test("an outcome nobody knows is said as not known, is still said after the view is left and the page reloaded, and goes when it is dismissed", async ({
  page,
}) => {
  await openSettled(page, "/index.html#/bead-builder");
  await requireStandIn(page);
  const id = await createFromBuilder(page, "Unknown outcome bead");
  const callsBefore = standInCalls().length;

  // What the control plane answers when bd did not finish.
  await page.route(`**${API}/beads/${id}/comment`, (route) =>
    route.fulfill({
      status: 504,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        data: null,
        error: `bd comments add did not finish within its time limit; the change may still have been made. Check with \`bd show ${id}\` before trying again.`,
      }),
    }),
  );
  const card = page.locator("#bead-created-card");
  const actions = card.getByRole("region", { name: `Actions on ${id}` });
  await actions.getByLabel("Comment").fill("worklog: was this added?");
  await actions.getByRole("button", { name: "Add comment" }).click();
  const notice = writesToCheck(page).locator('[data-outcome="unknown"]', {
    hasText: `comment on ${id}`,
  });
  await expect(notice).toContainText(`Outcome not known (comment on ${id}).`);
  await expect(actions).toContainText(
    "Outcome not known: see Writes to check at the top of the page.",
  );
  await expect(notice).toContainText("did not finish within its time limit");
  await expect(notice).toContainText(`bd show ${id}`);
  await expect(notice).toHaveClass(/is-error/);
  // Not as done, and not as a failure that invites another try.
  await expect(actions.locator('[data-outcome="done"]')).toHaveCount(0);
  await expect(actions.locator('[data-outcome="failed"]')).toHaveCount(0);
  await expect(card.locator(".af-detail-comments")).toHaveCount(0);
  // What was typed is kept: nothing confirmed that it was taken.
  await expect(actions.getByLabel("Comment", { exact: true })).toHaveValue(
    "worklog: was this added?",
  );

  // Seen from another view, after a reload: the page has not forgotten.
  await stubSnapshot(page, snapshotWith(id, "Unknown outcome bead"));
  await openIssues(page);
  await page.locator(`[data-issue-id="${id}"]`).click();
  const panel = page
    .locator(".af-detail")
    .getByRole("region", { name: `Actions on ${id}` });
  const kept = writesToCheck(page).locator('[data-outcome="unknown"]', {
    hasText: `comment on ${id}`,
  });
  await expect(kept).toContainText(`Outcome not known (comment on ${id}).`);
  await expect(kept).toContainText(`bd show ${id}`);

  // The operator has checked: dismissed, it is gone, and a reload does not bring it back.
  await writesToCheck(page)
    .getByRole("button", { name: `Dismiss the comment notice for ${id}` })
    .click();
  await expect(kept).toHaveCount(0);
  await reloadSettled(page);
  await page.locator(`[data-issue-id="${id}"]`).click();
  await expect(panel).toBeVisible();
  await expect(kept).toHaveCount(0);

  // A create whose request never completed: no id came back to look up.
  await openSettled(page, "/index.html#/bead-builder");
  await page.route(`**${API}/beads`, (route) =>
    route.request().method() === "POST"
      ? route.abort("connectionreset")
      : route.continue(),
  );
  await page.fill("#bb-title", "Was this one made?");
  await createButton(page).click();
  const lost = writesToCheck(page).locator('[data-outcome="unknown"]', {
    hasText: 'create "Was this one made?"',
  });
  await expect(lost).toContainText(
    'Outcome not known (create "Was this one made?").',
  );
  await expect(lost).toContainText("The request did not complete.");
  await expect(lost).toContainText("bd list");
  await expect(page.locator("#bb-create-result")).toHaveCount(0);
  await expect(page.getByText("Created ")).toHaveCount(0);

  // Clearing the form does not hide it; dismissing it does.
  await page.getByRole("button", { name: "Clear form" }).click();
  await expect(lost).toHaveCount(1);
  await page
    .getByRole("button", {
      name: 'Dismiss the create notice for "Was this one made?"',
    })
    .click();
  await expect(lost).toHaveCount(0);

  // Neither request was let through to the control plane: nothing reached bd.
  expect(
    standInCalls()
      .slice(callsBefore)
      .filter((call) => !isList(call)),
  ).toEqual([]);
});

test("a claim answered 504 after another bead was created is listed under Writes to check naming its bead; a notice already listed stays when another bead is created; each Dismiss removes its own", async ({
  page,
}) => {
  await openSettled(page, "/index.html#/bead-builder");
  await requireStandIn(page);
  const first = await createFromBuilder(page, "Notice bead A");
  const card = page.locator("#bead-created-card");
  const claim = await holdPosts(page, `**${API}/beads/${first}/claim`);
  await card
    .getByRole("region", { name: `Actions on ${first}` })
    .getByRole("button", { name: "Claim", exact: true })
    .click();
  await expect.poll(claim.count).toBe(1);

  // The card moves on to another bead before the answer arrives.
  const second = await createFromBuilder(page, "Notice bead B");
  claim.release(notFinished(first, "update --claim"));
  const list = writesToCheck(page);
  const forFirst = list.locator('[data-outcome="unknown"]', {
    hasText: `claim on ${first}`,
  });
  await expect(forFirst).toContainText(
    `Outcome not known (claim on ${first}).`,
  );
  await expect(forFirst).toContainText(`bd show ${first}`);

  // A notice for the second bead, then a third bead: both notices stay.
  await answerPosts(
    page,
    `**${API}/beads/${second}/comment`,
    notFinished(second, "comments add"),
  );
  const onSecond = card.getByRole("region", { name: `Actions on ${second}` });
  await onSecond.getByLabel("Comment").fill("worklog: was this added?");
  await onSecond.getByRole("button", { name: "Add comment" }).click();
  const forSecond = list.locator('[data-outcome="unknown"]', {
    hasText: `comment on ${second}`,
  });
  await expect(forSecond).toBeVisible();
  await createFromBuilder(page, "Notice bead C");
  await expect(forFirst).toBeVisible();
  await expect(forSecond).toBeVisible();

  await list
    .getByRole("button", { name: `Dismiss the claim notice for ${first}` })
    .click();
  await expect(forFirst).toHaveCount(0);
  await expect(forSecond).toBeVisible();
  await list
    .getByRole("button", { name: `Dismiss the comment notice for ${second}` })
    .click();
  await expect(list).toHaveCount(0);
});

test("an actions block mounted again while its bead's comment is out says so and offers nothing; once answered it offers again", async ({
  page,
}) => {
  await openSettled(page, "/index.html#/bead-builder");
  await requireStandIn(page);
  const id = await createFromBuilder(page, "Remounted while out");
  const actions = page
    .locator("#bead-created-card")
    .getByRole("region", { name: `Actions on ${id}` });
  const comment = await holdPosts(page, `**${API}/beads/${id}/comment`);
  await actions.getByLabel("Comment").fill("worklog: sent before leaving");
  await actions.getByRole("button", { name: "Add comment" }).click();
  await expect.poll(comment.count).toBe(1);

  // Leave the builder and come back, without a reload: the block is new.
  await openSettled(page, "/index.html#/issues");
  await openSettled(page, "/index.html#/bead-builder");
  await expect(actions.locator(".af-bead-out")).toContainText(
    "A comment sent from this page is still out",
  );
  await expect(actions.getByLabel("Comment", { exact: true })).toBeDisabled();
  await expect(actions.getByLabel("Reason for closing")).toBeDisabled();
  await expect(
    actions.getByRole("button", { name: "Claim", exact: true }),
  ).toBeDisabled();

  comment.release();
  await expect(actions.locator(".af-bead-out")).toHaveCount(0);
  await expect(
    actions.getByRole("button", { name: "Claim", exact: true }),
  ).toBeEnabled();
  await actions.getByLabel("Comment").fill("worklog: a second one");
  await expect(
    actions.getByRole("button", { name: "Add comment" }),
  ).toBeEnabled();
});

test("a builder opened again while a create is out does not offer Create, and says so; the create's answer still lands", async ({
  page,
}) => {
  await openSettled(page, "/index.html#/bead-builder");
  await requireStandIn(page);
  const create = await holdPosts(page, `**${API}/beads`);
  await page.fill("#bb-title", "Held create");
  await createButton(page).click();
  await expect.poll(create.count).toBe(1);

  await openSettled(page, "/index.html#/issues");
  await openSettled(page, "/index.html#/bead-builder");
  await page.fill("#bb-title", "Another one");
  await expect(createButton(page)).toBeDisabled();
  await expect(page.locator("#bead-form-card .af-bead-out")).toContainText(
    "A create sent from this page is still out",
  );

  create.release();
  await expect(page.locator("#bead-created-card")).toContainText("Held create");
  await expect(createButton(page)).toBeEnabled();
});

test("a create refused after the builder was left is listed as refused, naming its title", async ({
  page,
}) => {
  await openSettled(page, "/index.html#/bead-builder");
  await requireStandIn(page);
  const create = await holdPosts(page, `**${API}/beads`);
  await page.fill("#bb-title", "Refused while away");
  await page.fill("#bb-parent", "e2e-no-such-parent");
  await createButton(page).click();
  await expect.poll(create.count).toBe(1);

  await openSettled(page, "/index.html#/issues");
  create.release();
  const refused = writesToCheck(page).locator('[data-outcome="refused"]', {
    hasText: 'create "Refused while away"',
  });
  await expect(refused).toContainText('Refused (create "Refused while away"):');
  await expect(refused).toContainText(
    "parent issue e2e-no-such-parent not found",
  );
});

test("a close refused after its panel was closed is listed as refused, is still listed after a reload, and goes on Dismiss", async ({
  page,
}) => {
  await openSettled(page, "/index.html#/bead-builder");
  await requireStandIn(page);
  // An id the stand-in has never created: bd refuses to close it.
  const ghost = "e2e-999999";
  await stubSnapshot(page, snapshotWith(ghost, "A bead bd does not know"));
  await openIssues(page);
  await page.locator(`[data-issue-id="${ghost}"]`).click();
  const actions = page
    .locator(".af-detail")
    .getByRole("region", { name: `Actions on ${ghost}` });
  const callsBefore = standInCalls().length;
  const close = await holdPosts(page, `**${API}/beads/${ghost}/close`);
  await actions.getByLabel("Reason for closing").fill("Closed, then left");
  await actions.getByRole("button", { name: "Close issue" }).click();
  await expect.poll(close.count).toBe(1);

  // The panel is closed before the answer comes back from the hearth.
  await page.getByRole("button", { name: "Close expanded issue" }).click();
  await expect(page.locator(".af-detail")).toHaveCount(0);
  close.release();

  const refused = writesToCheck(page).locator('[data-outcome="refused"]', {
    hasText: `close on ${ghost}`,
  });
  await expect(refused).toContainText(`Refused (close on ${ghost}):`);
  await expect(refused).toContainText("no issue found");
  expect(
    standInCalls()
      .slice(callsBefore)
      .filter((call) => call[0] === "close" && call.includes(ghost)),
  ).toHaveLength(1);
  await reloadSettled(page);
  await expect(refused).toContainText(`Refused (close on ${ghost}):`);
  await writesToCheck(page)
    .getByRole("button", { name: `Dismiss the close notice for ${ghost}` })
    .click();
  await expect(refused).toHaveCount(0);
});

test("while a write is out its controls are disabled, and a second press in the same instant sends nothing", async ({
  page,
}) => {
  await openSettled(page, "/index.html#/bead-builder");
  await requireStandIn(page);
  const callsBefore = standInCalls().length;

  const create = await holdPosts(page, `**${API}/beads`);
  await page.fill("#bb-title", "Pressed twice");
  await expect(createButton(page)).toBeEnabled();
  await pressTwiceAtOnce(createButton(page));
  await expect(page.getByRole("button", { name: "Creating…" })).toBeDisabled();
  await expect(page.locator("button[type=submit]")).toBeDisabled();
  await expect.poll(create.count).toBe(1);
  create.release();
  await expect(page.locator("#bb-create-result")).toContainText("Created ");
  const id = await createdId(page);

  const actions = page
    .locator("#bead-created-card")
    .getByRole("region", { name: `Actions on ${id}` });
  const comment = await holdPosts(page, `**${API}/beads/${id}/comment`);
  await actions.getByLabel("Comment").fill("worklog: pressed twice");
  // With a reason typed, Close is offered: it is the write being out that disables it.
  await actions.getByLabel("Reason for closing").fill("Not sent");
  await expect(
    actions.getByRole("button", { name: "Close issue" }),
  ).toBeEnabled();
  await pressTwiceAtOnce(actions.getByRole("button", { name: "Add comment" }));
  await expect(actions.getByRole("button", { name: "Adding…" })).toBeDisabled();
  for (const name of ["Claim", "Close issue"])
    await expect(
      actions.getByRole("button", { name, exact: true }),
    ).toBeDisabled();
  await expect(actions.getByLabel("Comment")).toBeDisabled();
  await expect(actions.getByLabel("Reason for closing")).toBeDisabled();
  await expect.poll(comment.count).toBe(1);
  comment.release();
  await expect(actions.locator('[data-outcome="done"]')).toContainText(
    `Comment added to ${id}`,
  );
  await expect(
    actions.getByRole("button", { name: "Close issue" }),
  ).toBeEnabled();

  // One create and one comment reached bd, whatever was pressed.
  expect(create.count()).toBe(1);
  expect(comment.count()).toBe(1);
  expect(
    standInCalls()
      .slice(callsBefore)
      .filter((call) => !isList(call)),
  ).toEqual([
    [
      "create",
      "--title=Pressed twice",
      "--type=task",
      "--priority=2",
      "--json",
    ],
    ["comments", "add", "--json", "--", id, "worklog: pressed twice"],
  ]);
});

test("a page reloaded while a write is out says afterwards that its outcome is not known", async ({
  page,
}) => {
  await openSettled(page, "/index.html#/bead-builder");
  await requireStandIn(page);
  const id = await createFromBuilder(page, "Reloaded mid-write");
  const callsBefore = standInCalls().length;
  const actions = page
    .locator("#bead-created-card")
    .getByRole("region", { name: `Actions on ${id}` });

  const close = await holdPosts(page, `**${API}/beads/${id}/close`);
  await actions
    .getByLabel("Reason for closing")
    .fill("Closed just before a reload");
  await actions.getByRole("button", { name: "Close issue" }).click();
  await expect(
    actions.getByRole("button", { name: "Closing…" }),
  ).toBeDisabled();
  await expect.poll(close.count).toBe(1);
  // While the answer is awaited nothing is said about its outcome.
  await expect(actions.locator("[data-outcome]")).toHaveCount(0);

  await reloadSettled(page);
  close.release();
  const notice = writesToCheck(page).locator('[data-outcome="unknown"]', {
    hasText: `close on ${id}`,
  });
  await expect(notice).toContainText(`Outcome not known (close on ${id}).`);
  await expect(notice).toContainText("reloaded before the answer arrived");
  await expect(notice).toContainText(`bd show ${id}`);
  await expect(actions.locator('[data-outcome="done"]')).toHaveCount(0);

  // A create that was out when the page went: there is no id to show, only its title.
  const create = await holdPosts(page, `**${API}/beads`);
  await page.fill("#bb-title", "Created just before a reload");
  await createButton(page).click();
  await expect.poll(create.count).toBe(1);
  await reloadSettled(page);
  create.release();
  const lost = writesToCheck(page).locator('[data-outcome="unknown"]', {
    hasText: 'create "Created just before a reload"',
  });
  await expect(lost).toContainText(
    'Outcome not known (create "Created just before a reload").',
  );
  await expect(lost).toContainText("reloaded before the answer arrived");
  await expect(lost).toContainText("bd list");
  // The close is still said too.
  await expect(notice).toContainText(`Outcome not known (close on ${id}).`);

  // Here both requests were held before the control plane: nothing reached bd.
  // On a real page either may have: that is why the page will not say.
  expect(
    standInCalls()
      .slice(callsBefore)
      .filter((call) => !isList(call)),
  ).toEqual([]);
});

/** What a view says when the page already holds twenty writes out or to check. */
const NO_ROOM =
  "Not sent: 20 writes from this page are still out or listed under Writes to check. Dismiss the ones you have checked, then try again.";

test("with twenty writes to check, a twenty-first comment and a create are not sent and say so, the twenty stay listed, and after a Dismiss a create is sent", async ({
  page,
}) => {
  await openSettled(page, "/index.html#/bead-builder");
  await requireStandIn(page);
  const id = await createFromBuilder(page, "Twenty to check");
  const callsBefore = standInCalls().length;
  let comments = 0;
  await page.route(`**${API}/beads/${id}/comment`, (route) => {
    if (route.request().method() !== "POST") return route.continue();
    comments++;
    const answer = notFinished(id, "comments add");
    return route.fulfill({
      status: answer.status,
      contentType: "application/json",
      body: JSON.stringify(answer.body),
    });
  });
  const actions = page
    .locator("#bead-created-card")
    .getByRole("region", { name: `Actions on ${id}` });
  const listed = writesToCheck(page).locator('[data-outcome="unknown"]', {
    hasText: `comment on ${id}`,
  });
  for (let n = 1; n <= 20; n++) {
    await actions.getByLabel("Comment").fill(`worklog: comment ${n}`);
    await actions.getByRole("button", { name: "Add comment" }).click();
    await expect(listed).toHaveCount(n);
  }

  await actions.getByLabel("Comment").fill("worklog: the twenty-first");
  await actions.getByRole("button", { name: "Add comment" }).click();
  await expect(actions.locator('[data-outcome="failed"]')).toHaveText(NO_ROOM);
  await expect(listed).toHaveCount(20);
  expect(comments).toBe(20);
  await expect(actions.getByLabel("Comment", { exact: true })).toHaveValue(
    "worklog: the twenty-first",
  );

  await page.fill("#bb-title", "One write too many");
  await createButton(page).click();
  const result = page.locator("#bb-create-result");
  await expect(result).toHaveText(NO_ROOM);
  await expect(result).toHaveAttribute("data-outcome", "failed");
  await expect(listed).toHaveCount(20);

  // One checked and dismissed: there is room, and the create goes out.
  await writesToCheck(page)
    .getByRole("button", { name: `Dismiss the comment notice for ${id}` })
    .first()
    .click();
  await expect(listed).toHaveCount(19);
  await createButton(page).click();
  await expect(page.locator("#bead-created-card")).toContainText(
    "One write too many",
  );
  expect(
    standInCalls()
      .slice(callsBefore)
      .filter((call) => !isList(call)),
  ).toEqual([
    [
      "create",
      "--title=One write too many",
      "--type=task",
      "--priority=2",
      "--json",
    ],
  ]);
});

test("a create whose operator token cannot be had is said as not sent, is not listed under Writes to check, and reaches no bd", async ({
  page,
}) => {
  await openSettled(page, "/index.html#/bead-builder");
  await requireStandIn(page);
  const callsBefore = standInCalls().length;
  // A fresh page has no token yet: the create's own request for it is refused.
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
  await page.fill("#bb-title", "Never sent");
  await createButton(page).click();

  const result = page.locator("#bb-create-result");
  await expect(result).toHaveText(
    "Not sent: the page could not get an operator token from the control plane (the control plane is starting). Nothing was changed.",
  );
  await expect(result).toHaveAttribute("data-outcome", "failed");
  await expect(writesToCheck(page)).toHaveCount(0);
  await expect(page.locator("#bead-created-card")).toHaveCount(0);
  expect(
    standInCalls()
      .slice(callsBefore)
      .filter((call) => !isList(call)),
  ).toEqual([]);
});
