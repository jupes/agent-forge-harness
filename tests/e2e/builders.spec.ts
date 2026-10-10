import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  OPERATOR_HEADER,
  SURFACE_HEADER,
  TOKEN_ROUTE,
} from "../../scripts/hearth/paths";
import { BEADS, stubSnapshot } from "./fixtures";
import { BD_STAND_IN_STATE } from "./servers";

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
  await page.goto("/index.html#/bead-builder", { waitUntil: "networkidle" });
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
  await page.goto("/index.html#/skill-builder", { waitUntil: "networkidle" });
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
  await page.goto("/index.html#/bead-builder", { waitUntil: "networkidle" });
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
    await page.goto(`/index.html#/${route}`, { waitUntil: "networkidle" });
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

/** Every argument array the stand-in has been called with in this run, oldest first. */
function standInCalls(): string[][] {
  const file = join(BD_STAND_IN_STATE, "calls.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as string[]);
}

const isList = (call: string[]): boolean => call[0] === "list";

/**
 * Stop unless the hearth's `bd` is the stand-in: a read of the queue makes the
 * hearth run `bd list`, and that call must appear in the stand-in's own record.
 * Called before a test's first write, so a hearth that would run anything else
 * is found before it is asked to change something.
 */
async function requireStandIn(page: Page): Promise<void> {
  const before = standInCalls().filter(isList).length;
  const status = await page.evaluate(
    async (url) => (await fetch(url)).status,
    `${API}/queue`,
  );
  expect(status, "the queue read answers").toBe(200);
  expect(
    standInCalls().filter(isList).length,
    "the hearth's bd is the suite's stand-in",
  ).toBeGreaterThan(before);
}

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
  await page.goto("/index.html#/issues", { waitUntil: "networkidle" });
  await page.reload({ waitUntil: "networkidle" });
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

const createButton = (page: Page) =>
  page.getByRole("button", { name: "Create bead" });

/** The id shown on the card of the bead most recently created from this page. */
async function createdId(page: Page): Promise<string> {
  return (
    await page
      .locator("#bead-created-card .issue-id-copy code")
      .first()
      .innerText()
  ).trim();
}

/** Create a bead from the builder and return the id the page shows for it. */
async function createFromBuilder(page: Page, title: string): Promise<string> {
  await page.fill("#bb-title", title);
  await expect(createButton(page)).toBeEnabled();
  await createButton(page).click();
  await expect(page.locator("#bb-create-result")).toContainText("Created ");
  await expect(page.locator("#bead-created-card")).toContainText(title);
  return createdId(page);
}

test("create, claim and comment from the bead builder go through the control plane to bd, and are recorded", async ({
  page,
}) => {
  await page.goto("/index.html#/bead-builder", { waitUntil: "networkidle" });
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
  await page.reload({ waitUntil: "networkidle" });
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
  await page.goto("/index.html#/bead-builder", { waitUntil: "networkidle" });
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
  await page.reload({ waitUntil: "networkidle" });
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
  await page.goto("/index.html#/bead-builder", { waitUntil: "networkidle" });

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
  await page.goto("/index.html#/bead-builder", { waitUntil: "networkidle" });
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
  await page.goto("/index.html#/bead-builder", { waitUntil: "networkidle" });
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
});
