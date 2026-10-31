import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { projectFixture } from "../../scripts/projects/testing";
import type { LedgerEventInput } from "../../types/hearth";
import { readState, withStateLock, writeState } from "../e2e/bd-stand-in-state";
import { openSettled } from "../e2e/fixtures";
import { BD_STAND_IN_STATE } from "../e2e/servers";
import {
  activityFixtureSessionCount,
  clearActivityMembershipFixtures,
} from "./activity-fixtures";
import { seedObservationEvents } from "./observed-session-fixtures";
import {
  alpha,
  beta,
  catalog,
  catalogFile,
  seedProjects,
  workspace,
} from "./project-fixtures";

test.beforeEach(seedProjects);
test("observed session exposes the shared project Activity feed in its Activity tab", async ({
  page,
}) => {
  const sessionId = `activity-observed-tab-${randomUUID()}`;
  seedObservationEvents([
    {
      kind: "session.started",
      workspace,
      beadId: "alpha-epic",
      sessionId,
      executor: { provider: "codex", model: "recorded-model" },
      payload: { kind: "interactive" },
    },
    {
      kind: "tool.called",
      workspace,
      beadId: "alpha-epic",
      sessionId,
      executor: { provider: "codex", model: "recorded-model" },
      payload: {
        tool: "Observed shared Activity marker",
        argsHash: "a".repeat(64),
      },
    },
  ]);
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/sessions`);
  await page
    .getByRole("link", { name: `Open ${sessionId}`, exact: true })
    .click();

  const detail = page.getByRole("region", {
    name: "Observed session details",
    exact: true,
  });
  await expect(detail).toBeVisible();
  await expect(
    detail.getByRole("region", {
      name: "Recorded activity metadata",
      exact: true,
    }),
  ).toContainText("Observed shared Activity marker");
  const activityTab = detail.getByRole("tab", {
    name: "Activity",
    exact: true,
  });
  await expect(activityTab).toBeVisible();
  await activityTab.click();

  const feed = detail.getByRole("listbox", { name: "Project activity" });
  await expect(feed).toBeVisible();
  await expect(feed).toContainText("Observed shared Activity marker");
  await expect(detail.getByLabel("Session filter")).toHaveValue(sessionId);
  await expect(detail.getByLabel("Session filter")).toHaveAttribute(
    "readonly",
    "",
  );
});

test("project Activity virtualizes scoped metadata and keyboard selection opens its protected inspector", async ({
  page,
}) => {
  const sessionId = `activity-${randomUUID()}`;
  const events: LedgerEventInput[] = [
    {
      kind: "session.started",
      workspace,
      beadId: "alpha-epic",
      sessionId,
      executor: { provider: "codex", model: "recorded-model" },
      payload: { kind: "interactive" },
    },
  ];
  for (let i = 1; i <= 1200; i++)
    events.push({
      kind: "tool.called",
      workspace,
      sessionId,
      executor: { provider: "codex", model: "recorded-model" },
      payload: {
        tool: `Activity tool ${i}`,
        argsHash: "a".repeat(64),
        durationMs: i,
      },
    });
  events.push({
    kind: "tool.called",
    workspace,
    beadId: "beta-epic",
    sessionId,
    payload: { tool: "FOREIGN ACTIVITY", argsHash: "b".repeat(64) },
  });
  seedObservationEvents(events);
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSettled(
    page,
    `/index.html#/desktop/project/${alpha.id}/activity?session=${encodeURIComponent(sessionId)}`,
  );
  await expect(
    page.getByRole("heading", { name: "Activity", exact: true, level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("1201 events", { exact: false })).toBeVisible();
  const feed = page.getByRole("listbox", { name: "Project activity" });
  await expect(feed).toBeVisible();
  expect(await page.locator(".af-activity-row").count()).toBeLessThan(80);
  await feed.focus();
  await page.keyboard.press("End");
  await expect(feed).toHaveCSS("outline-width", "2px");
  await expect(
    feed.getByRole("option", { name: /Activity tool 1200/ }),
  ).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await page.screenshot({
    path: "apps/desktop/docs/screenshots/activity-feed.png",
    mask: [page.getByLabel("Session filter")],
    maskColor: "#3f424d",
  });
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Event metadata", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Activity tool 1200", { exact: true }).last(),
  ).toBeVisible();
  await expect(
    page.getByText("Recorded provider", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("FOREIGN ACTIVITY", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Refresh event metadata" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const scroll = await feed.evaluate((element) => element.scrollTop),
    selected = await page
      .locator(".af-desktop-frame")
      .getAttribute("data-selection-id");
  seedObservationEvents([
    {
      kind: "tool.called",
      workspace,
      beadId: "alpha-epic",
      sessionId,
      executor: { provider: "claude", model: "recorded-model" },
      payload: { tool: "Appended Activity", argsHash: "a".repeat(64) },
    },
  ]);
  await expect(page.getByText("1202 events", { exact: false })).toBeVisible();
  expect(await feed.evaluate((element) => element.scrollTop)).toBe(scroll);
  await expect(page.locator(".af-desktop-frame")).toHaveAttribute(
    "data-selection-id",
    selected ?? "",
  );
  const inspector = page.getByRole("region", { name: "Activity inspector" });
  await expect(
    inspector.getByRole("heading", { name: "Activity tool 1200", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "apps/desktop/docs/screenshots/activity-inspector.png",
    mask: [
      page.getByLabel("Session filter"),
      inspector.locator("dd").first(),
      inspector.getByRole("navigation"),
    ],
    maskColor: "#3f424d",
    style:
      ".af-project-activity time, .af-activity-inspector time { visibility: hidden !important; }",
  });
});

test("historical assignment, provider/kind/time filters and bead reuse preserve project boundaries", async ({
  page,
}) => {
  const sessionId = `activity-shared-${randomUUID()}`;
  seedObservationEvents([
    {
      kind: "session.started",
      workspace,
      beadId: "alpha-epic",
      sessionId,
      executor: { provider: "claude", model: "recorded-model" },
      payload: { kind: "interactive" },
    },
    {
      kind: "tool.called",
      workspace,
      sessionId,
      executor: { provider: "codex", model: "recorded-model" },
      payload: { tool: "Shared A earlier", argsHash: "a".repeat(64) },
    },
    {
      kind: "tool.called",
      workspace,
      beadId: "beta-epic",
      sessionId,
      executor: { provider: "codex", model: "recorded-model" },
      payload: { tool: "Shared B explicit", argsHash: "b".repeat(64) },
    },
    {
      kind: "tool.called",
      workspace,
      sessionId,
      executor: { provider: "codex", model: "recorded-model" },
      payload: { tool: "Shared B later untagged", argsHash: "b".repeat(64) },
    },
  ]);
  await page.setViewportSize({ width: 1100, height: 700 });
  await openSettled(
    page,
    `/index.html#/desktop/project/${alpha.id}/activity?session=${sessionId}`,
  );
  const activity = page.getByRole("region", { name: "Project Activity" });
  await expect(activity.getByText("2 events", { exact: false })).toBeVisible();
  await expect(activity).toContainText("Shared A earlier");
  await expect(activity).not.toContainText("Shared B");
  await activity.getByLabel("Activity kind").selectOption("tools");
  await activity.getByLabel("Recorded provider filter").fill("codex");
  await activity
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  await expect(activity.getByText("1 event", { exact: false })).toBeVisible();
  await activity.getByLabel("From time").fill("2099-01-01T00:00");
  await activity
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  await expect(
    activity.getByRole("heading", { name: "No events match these filters" }),
  ).toBeVisible();
  await activity.getByLabel("From time").fill("");
  await activity.getByLabel("Recorded provider filter").fill("claude");
  await activity
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  await expect(
    activity.getByRole("heading", { name: "No events match these filters" }),
  ).toBeVisible();
  await page.goto(
    `/index.html#/desktop/project/${alpha.id}/activity?session=${sessionId}`,
  );
  await expect(activity.getByText("2 events", { exact: false })).toBeVisible();
  const feed = activity.getByRole("listbox");
  await feed.focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  const inspector = page.getByRole("region", { name: "Activity inspector" });
  await inspector
    .getByRole("link", { name: "Bead alpha-epic", exact: true })
    .click();
  const bead = page.getByRole("region", {
    name: "Bead alpha-epic",
    exact: true,
  });
  await bead.getByRole("tab", { name: "Activity", exact: true }).click();
  const embedded = bead.getByRole("region", { name: "Project Activity" });
  await expect(embedded.getByLabel("Bead filter")).toHaveValue("alpha-epic");
  await expect(embedded.getByLabel("Bead filter")).toHaveAttribute(
    "readonly",
    "",
  );
  await expect(
    bead.getByRole("link", { name: "Open in Activity", exact: true }),
  ).toHaveAttribute("href", /bead=alpha-epic/);
  await page.goto(
    `/index.html#/desktop/project/${beta.id}/activity?session=${sessionId}`,
  );
  await expect(activity.getByText("2 events", { exact: false })).toBeVisible();
  await expect(activity).toContainText("Shared B later untagged");
  await expect(activity).not.toContainText("Shared A earlier");
});

test("held and failed reads retain verified feed and selected metadata with explicit rechecks", async ({
  page,
}) => {
  const sessionId = `activity-fault-${randomUUID()}`;
  seedObservationEvents([
    {
      kind: "session.started",
      workspace,
      beadId: "alpha-epic",
      sessionId,
      payload: { kind: "interactive" },
    },
  ]);
  let mode: "held" | "okay" | "failed" = "held",
    release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/projects/${alpha.id}/activity?**`, async (route) => {
    if (mode === "held") await held;
    if (mode === "failed")
      await route.fulfill({
        status: 503,
        json: {
          ok: false,
          data: null,
          error: "Activity fixture source unavailable",
        },
      });
    else await route.continue();
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(
    `/index.html#/desktop/project/${alpha.id}/activity?session=${sessionId}`,
    { waitUntil: "domcontentloaded" },
  );
  const activity = page.getByRole("region", { name: "Project Activity" });
  await expect(
    activity.getByRole("status", { name: "Loading Activity" }),
  ).toBeVisible();
  await expect(activity.locator(".af-activity-skeleton i").first()).toHaveCSS(
    "animation-name",
    "none",
  );
  mode = "failed";
  release();
  await expect(activity.getByRole("alert")).toContainText(
    "Activity fixture source unavailable",
  );
  const refresh = activity.getByRole("button", {
    name: "Refresh Activity",
    exact: true,
  });
  await expect(refresh).toHaveAttribute("aria-disabled", "false");
  mode = "okay";
  await refresh.click();
  await expect(activity.getByText("1 event", { exact: false })).toBeVisible();
  const feed = activity.getByRole("listbox", { name: "Project activity" });
  await feed.getByRole("option").first().click();
  const inspector = page.getByRole("region", { name: "Activity inspector" });
  await expect(
    inspector.getByRole("heading", { name: "Session started", exact: true }),
  ).toBeVisible();
  mode = "failed";
  await refresh.click();
  await expect(activity.getByRole("alert")).toContainText(
    "The last verified events remain visible",
  );
  await expect(feed.getByRole("option")).toHaveCount(1);
  await expect(inspector).toContainText(
    "Activity was refreshed after this metadata was checked",
  );
  await page.route(`**/projects/${alpha.id}/activity/*`, (route) =>
    route.fulfill({
      status: 503,
      json: {
        ok: false,
        data: null,
        error: "Selected Activity fixture unavailable",
      },
    }),
  );
  await inspector
    .getByRole("button", { name: "Refresh event metadata" })
    .click();
  await expect(inspector.getByRole("alert")).toContainText(
    "Previously verified metadata is kept",
  );
  await expect(
    inspector.getByRole("heading", { name: "Session started", exact: true }),
  ).toBeVisible();
});

test("invalid filters refuse before the Activity read and clear restores the protected feed", async ({
  page,
}) => {
  const reads: string[] = [];
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname.endsWith(`/projects/${alpha.id}/activity`)
    )
      reads.push(request.url());
  });
  await openSettled(
    page,
    `/index.html#/desktop/project/${alpha.id}/activity?workspace=%2Fforeign`,
  );
  const activity = page.getByRole("region", { name: "Project Activity" });
  await expect(activity.getByRole("alert")).toContainText(
    "filters or their time range are invalid",
  );
  expect(reads).toEqual([]);
  await activity
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await expect.poll(() => reads.length).toBeGreaterThan(0);
  await expect(activity.getByRole("alert")).toHaveCount(0);
  await expect(activity.locator(".af-activity-source")).toBeVisible();
});

test("complete empty history and bounded incomplete membership have different states", async ({
  page,
}) => {
  const empty = projectFixture(workspace, {
    id: `project-${randomUUID()}`,
    slug: "activity-empty",
    name: "Activity empty",
    workspaces: [
      {
        root: workspace,
        repositories: [workspace],
        epicIds: ["activity-empty-epic"],
      },
    ],
  });
  writeFileSync(
    catalogFile,
    JSON.stringify({
      ...catalog,
      revision: 2,
      projects: [...catalog.projects, empty],
    }),
  );
  withStateLock(BD_STAND_IN_STATE, () => {
    const state = readState(BD_STAND_IN_STATE);
    state["activity-empty-epic"] = {
      id: "activity-empty-epic",
      title: "Activity empty epic",
      issue_type: "epic",
      status: "open",
      priority: 2,
      labels: ["project:activity-empty"],
      created_at: empty.createdAt,
      updated_at: empty.updatedAt,
    };
    writeState(BD_STAND_IN_STATE, state);
  });
  await openSettled(page, `/index.html#/desktop/project/${empty.id}/activity`);
  const activity = page.getByRole("region", { name: "Project Activity" });
  await expect(
    activity.getByRole("heading", {
      name: "No activity in this project yet",
      exact: true,
    }),
  ).toBeVisible();
  const before = activityFixtureSessionCount();
  try {
    seedObservationEvents(
      Array.from(
        { length: 1001 },
        (_, i): LedgerEventInput => ({
          kind: "session.started",
          workspace,
          beadId: "activity-empty-epic",
          sessionId: `bounded-${empty.id}-${i}`,
          payload: { kind: "interactive" },
        }),
      ),
    );
    await page.goto(
      `/index.html#/desktop/project/${empty.id}/activity?provider=not-reported-in-fixture`,
    );
    await expect(
      activity.getByRole("heading", {
        name: "Activity is incomplete",
        exact: true,
      }),
    ).toBeVisible();
    await expect(activity).toContainText(
      "this read cannot prove an empty history",
    );
    await expect(activity).toContainText("Some project sources are incomplete");
  } finally {
    await page.close();
    clearActivityMembershipFixtures(empty.id, before);
    expect(activityFixtureSessionCount()).toBe(before);
  }
});
