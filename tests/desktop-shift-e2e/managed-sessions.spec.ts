import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  managedShiftHref,
  managedShiftSelection,
} from "../../apps/desktop/src/managed-shift-navigation";
import { conversationFile } from "../../scripts/conversations/paths";
import { FIXTURE_PROJECT_ID } from "../../scripts/projects/testing";
import { seedObservationEvents } from "../desktop-e2e/observed-session-fixtures";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import {
  checkedFixtureRoot,
  fixtureCalls,
  fixtureMode,
  HOME,
  REPOSITORY,
  resetTracker,
  STATE,
} from "./environment";

test.use({ viewport: { width: 1100, height: 700 } });
const workbench = `/index.html#/desktop/project/${FIXTURE_PROJECT_ID}/workbench`;
const shifts = (page: Page) =>
  page.getByRole("region", { name: "Bounded project shifts", exact: true });
const managed = (page: Page) =>
  page.getByRole("region", { name: "Managed Shift session", exact: true });
const activity = (page: Page) =>
  page.getByRole("region", { name: "Private shift activity", exact: true });
async function start(page: Page) {
  await openSettled(page, workbench);
  await shifts(page)
    .getByRole("button", { name: "Start shift", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Review bounded project shift",
  });
  await expect(dialog.getByLabel("Duration", { exact: true })).toHaveValue(
    "1m",
  );
  await dialog.getByLabel("Base branch", { exact: true }).fill("main");
  await dialog
    .getByLabel("Smith override", { exact: true })
    .selectOption("claude-journeyman");
  await dialog
    .getByLabel("Epic filter", { exact: true })
    .selectOption("alpha-epic");
  await dialog
    .getByRole("button", { name: "Start reviewed shift", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  return shifts(page).locator("[data-shift]").last();
}
function mutationCalls() {
  return fixtureCalls().filter(
    (row) =>
      row !== null &&
      typeof row === "object" &&
      "tool" in row &&
      row.tool === "bd" &&
      "args" in row &&
      Array.isArray(row.args) &&
      ["create", "update", "comments", "close", "reopen", "delete"].includes(
        String(row.args[0]),
      ),
  );
}
function watchInspectionPosts(page: Page) {
  const paths: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() === "POST" &&
      /\/projects\/[^/]+\/(?:sessions|shifts)/.test(path)
    )
      paths.push(path);
  });
  return paths;
}
async function attemptLink(page: Page) {
  await expect(activity(page)).toContainText("Verified saved turn:");
  const href = await activity(page)
    .getByRole("link", { name: "Open this attempt in Sessions", exact: true })
    .getAttribute("href");
  if (!href) throw Error("No exact private attempt link was rendered.");
  const selected = managedShiftSelection(href).selection;
  if (!selected?.sessionId)
    throw Error("The actual attempt link is not strict.");
  return { href, selected: { ...selected, sessionId: selected.sessionId } };
}

test.beforeEach(() => {
  checkedFixtureRoot();
  resetTracker();
  fixtureMode("rich");
});

test("an actual managed attempt survives direct reload and Back with its exact original, keyboard focus and no inspection effects", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const row = await start(page);
  await expect(row).toHaveAttribute("data-phase", "stopped", {
    timeout: 20000,
  });
  await row.getByRole("button", { name: "Attend shift", exact: true }).click();
  await expect(activity(page)).toContainText("Verified saved turn: completed");
  const { href, selected } = await attemptLink(page),
    provider = readFileSync(join(STATE, "claude.json"), "utf8"),
    journalPath = conversationFile(HOME, FIXTURE_PROJECT_ID, {
      kind: "session",
      projectId: FIXTURE_PROJECT_ID,
      sessionId: selected.sessionId,
    }),
    journal = readFileSync(journalPath, "utf8"),
    configuration = readFileSync(join(REPOSITORY, "agent-forge.toml"), "utf8"),
    writes = mutationCalls(),
    posts = watchInspectionPosts(page);
  await activity(page)
    .getByRole("link", { name: "Open this attempt in Sessions", exact: true })
    .click();
  await expect(managed(page)).toBeVisible();
  await expect(managed(page)).toContainText("Coding reply 🌱!");
  await expect(
    managed(page).getByRole("button", { name: /^(Send|Stop|Start|Continue)/ }),
  ).toHaveCount(0);
  await expect(managed(page).getByRole("textbox")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(selected.sessionId));
  const owning = managed(page).getByRole("link", {
    name: /^Open owning Shift /,
  });
  await owning.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(owning).toBeFocused();
  expect(
    await owning.evaluate((element) => getComputedStyle(element).outlineWidth),
  ).toBe("2px");
  const owningElement = await owning.elementHandle(),
    checkedBefore = await managed(page)
      .locator("time[data-managed-metadata]")
      .getAttribute("datetime");
  if (!owningElement || !checkedBefore)
    throw Error("The managed source/focus witness is missing.");
  seedObservationEvents([
    {
      kind: "tool.called",
      workspace: REPOSITORY,
      beadId: "alpha-work",
      sessionId: selected.sessionId,
      payload: {
        tool: "Read",
        argsHash: "a".repeat(64),
        durationMs: 3,
        exitCode: 0,
      },
    },
  ]);
  await expect(
    managed(page).locator("time[data-managed-metadata]"),
  ).not.toHaveAttribute("datetime", checkedBefore);
  expect(await owningElement.evaluate((element) => element.isConnected)).toBe(
    true,
  );
  await expect(owning).toBeFocused();
  await expect(managed(page)).toContainText("Coding reply 🌱!");
  expect(
    await managed(page).evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= innerWidth;
    }),
  ).toBe(true);
  await page.screenshot({
    path: "apps/desktop/docs/screenshots/managed-shift-session.png",
  });
  await page.keyboard.press("Enter");
  await expect(shifts(page)).toBeVisible();
  await expect(activity(page)).toContainText("Verified saved turn: completed");
  expect(managedShiftSelection(new URL(page.url()).hash).selection).toEqual({
    ...selected,
    sessionId: null,
  });
  await page.goBack();
  await expect(managed(page)).toContainText("Coding reply 🌱!");
  expect(new URL(page.url()).hash).toBe(href);
  await reloadSettled(page);
  await expect(managed(page)).toContainText("Verified saved turn: completed");
  expect(new URL(page.url()).hash).toBe(href);
  expect(posts).toEqual([]);
  expect(readFileSync(join(STATE, "claude.json"), "utf8")).toBe(provider);
  expect(readFileSync(journalPath, "utf8")).toBe(journal);
  expect(readFileSync(join(REPOSITORY, "agent-forge.toml"), "utf8")).toBe(
    configuration,
  );
  expect(mutationCalls()).toEqual(writes);
});

test("a running managed attempt remains read-only and only its owning original offers whole-Shift Stop", async ({
  page,
}) => {
  fixtureMode("hang-tree");
  const row = await start(page);
  await expect(row).toHaveAttribute("data-phase", "running", {
    timeout: 20000,
  });
  const shiftId = await row.getAttribute("data-shift");
  if (!shiftId) throw Error("No actual running Shift identity.");
  await row.getByRole("button", { name: "Attend shift", exact: true }).click();
  const { selected } = await attemptLink(page),
    posts = watchInspectionPosts(page);
  try {
    await activity(page)
      .getByRole("link", { name: "Open this attempt in Sessions", exact: true })
      .click();
    await expect(managed(page)).toContainText("Verified saved turn: running");
    await expect(
      managed(page).getByRole("button", { name: /Send|Stop|Continue|Resume/ }),
    ).toHaveCount(0);
    await expect(managed(page).getByRole("textbox")).toHaveCount(0);
    await reloadSettled(page);
    await expect(managed(page)).toContainText("Verified saved turn: running");
    expect(posts).toEqual([]);
    await managed(page)
      .getByRole("link", { name: /^Open owning Shift / })
      .click();
    const original = shifts(page).locator(`[data-shift="${shiftId}"]`);
    await expect(
      original.getByRole("button", { name: "Stop shift", exact: true }),
    ).toBeVisible();
  } finally {
    await openSettled(
      page,
      `/index.html${managedShiftHref({ ...selected, sessionId: null })}`,
    );
    const original = shifts(page).locator(`[data-shift="${shiftId}"]`);
    const stop = original.getByRole("button", {
      name: "Stop shift",
      exact: true,
    });
    if (await stop.count()) await stop.click();
    await expect(original).toHaveAttribute("data-phase", "stopped", {
      timeout: 20000,
    });
  }
  expect(posts.filter((path) => path.endsWith("/stop"))).toHaveLength(1);
});

test("a held original cannot open a private feed after navigation, and a mismatched original link remains unavailable", async ({
  page,
}) => {
  const row = await start(page);
  await expect(row).toHaveAttribute("data-phase", "stopped", {
    timeout: 20000,
  });
  await row.getByRole("button", { name: "Attend shift", exact: true }).click();
  await expect(activity(page)).toContainText("Verified saved turn: completed");
  const { href, selected } = await attemptLink(page),
    provider = readFileSync(join(STATE, "claude.json"), "utf8"),
    writes = mutationCalls(),
    posts = watchInspectionPosts(page),
    originalPath = `/__agent-forge/projects/${FIXTURE_PROJECT_ID}/shifts/requests/${selected.requestId}`;
  let release = () => {},
    entered = () => {},
    feeds = 0;
  const held = new Promise<void>((resolve) => {
      release = resolve;
    }),
    received = new Promise<void>((resolve) => {
      entered = resolve;
    });
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname.endsWith(
        `/attempts/${selected.sessionId}/events`,
      )
    )
      feeds++;
  });
  await page.route(`**${originalPath}`, async (intercept) => {
    const response = await intercept.fetch({
      headers: {
        ...(await intercept.request().allHeaders()),
        Origin: new URL(page.url()).origin,
      },
    });
    expect(response.status()).toBe(200);
    entered();
    await held;
    await intercept.fulfill({ response });
  });
  const navigation = openSettled(page, `/index.html${href}`);
  void navigation.catch(() => {});
  try {
    await received;
    await expect(
      managed(page).getByRole("status", { exact: true }),
    ).toContainText("Verifying the original Shift");
    await expect(activity(page)).toHaveCount(0);
    await page.evaluate((hash) => {
      window.location.hash = hash;
    }, `#/desktop/project/${FIXTURE_PROJECT_ID}/sessions`);
    await expect(managed(page)).toHaveCount(0);
    release();
    await navigation;
    expect(feeds).toBe(0);
    await page.unroute(`**${originalPath}`);
    const wrong = href.replace(
      selected.requestId,
      "42509d94-d509-4653-af8b-f4792fc04899",
    );
    await openSettled(page, `/index.html${wrong}`);
    await expect(managed(page).getByRole("alert")).toContainText(
      "managed Shift source could not be verified",
    );
    await expect(activity(page)).toHaveCount(0);
    expect(feeds).toBe(0);
    await openSettled(page, `/index.html${href}`);
    await expect(managed(page)).toContainText("Verified saved turn: completed");
    expect(feeds).toBeGreaterThan(0);
    expect(posts).toEqual([]);
    expect(readFileSync(join(STATE, "claude.json"), "utf8")).toBe(provider);
    expect(mutationCalls()).toEqual(writes);
  } finally {
    release();
    await navigation.catch(() => {});
    await page.unroute(`**${originalPath}`);
  }
});
