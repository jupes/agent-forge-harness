import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Route, test } from "@playwright/test";
import { ownedCodingSessionSchema } from "../../scripts/sessions/codex-owned-wire-protocol";
import { projectFixture } from "../../scripts/projects/testing";
import { openSettled } from "../e2e/fixtures";
import { readState, withStateLock, writeState } from "../e2e/bd-stand-in-state";
import { BD_STAND_IN_STATE, HEARTH_HOME } from "../e2e/servers";
import { seedObservationEvents } from "./observed-session-fixtures";
import {
  alpha,
  beta,
  catalog,
  catalogFile,
  seedProjects,
  workspace,
} from "./project-fixtures";

const url = (id: string, projectId = alpha.id) =>
  `/index.html#/desktop/project/${projectId}/sessions?selectionKind=session&selectionId=${encodeURIComponent(id)}`;
const forward = async (route: Route) =>
  route.fetch({
    headers: {
      ...(await route.request().allHeaders()),
      Origin: new URL(route.request().url()).origin,
      "Sec-Fetch-Site": "same-origin",
    },
  });
const starts = () =>
  existsSync(join(HEARTH_HOME, "coding-fixture-starts.jsonl"))
    ? readFileSync(join(HEARTH_HOME, "coding-fixture-starts.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean).length
    : 0;
function records() {
  try {
    const value: unknown = JSON.parse(
      readFileSync(join(HEARTH_HOME, "sessions", "registry.json"), "utf8"),
    );
    if (
      !value ||
      typeof value !== "object" ||
      !("records" in value) ||
      !Array.isArray(value.records)
    )
      throw Error("Invalid registry fixture");
    return value.records.map((record) =>
      ownedCodingSessionSchema.parse(record),
    );
  } catch {
    return [];
  }
}

test.beforeEach(seedProjects);

test("external child opens scoped read-only metadata with its verified parent and no invented tool input or transcript", async ({
  page,
}) => {
  const parent = `observed-parent-${randomUUID()}`,
    child = `observed-child-${randomUUID()}`;
  seedObservationEvents([
    {
      kind: "session.started",
      workspace,
      beadId: "alpha-epic",
      sessionId: parent,
      executor: {
        provider: "codex",
        model: "recorded-model",
        smith: "recorded-smith",
      },
      payload: { kind: "interactive" },
    },
    {
      kind: "session.started",
      workspace,
      beadId: "alpha-epic",
      sessionId: child,
      executor: {
        provider: "codex",
        model: "recorded-model",
        smith: "recorded-smith",
      },
      payload: { kind: "subagent", parentSessionId: parent },
    },
    {
      kind: "tool.called",
      workspace,
      beadId: "alpha-epic",
      sessionId: child,
      payload: {
        tool: "Read",
        argsHash: "private-hash-not-input",
        durationMs: 12,
      },
    },
    ...Array.from({ length: 102 }, (_, n) => ({ kind: "tool.called" as const, workspace, beadId: "alpha-epic", sessionId: child, payload: { tool: `Recorded fixture tool ${n}`, argsHash: "c".repeat(64) } })),
  ]);
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/sessions`);
  await page.getByRole("link", { name: `Open ${child}`, exact: true }).click();
  const detail = page.getByRole("region", {
    name: "Observed session details",
    exact: true,
  });
  await expect(detail).toBeVisible();
  await expect(detail).toContainText(child);
  await expect(
    detail.getByRole("link", { name: `Open parent ${parent}`, exact: true }),
  ).toBeVisible();
  await expect(detail).toContainText("Read");
  await expect(detail).toContainText("Exit code not reported");
  await expect(detail).toContainText("The conversation is not captured here");
  await expect(detail).not.toContainText("private-hash-not-input");
  const activity = detail.getByRole("region", { name: "Recorded activity metadata", exact: true });
  await expect(activity.getByRole("listitem")).toHaveCount(100);
  await detail.getByRole("button", { name: "Load more recorded activity", exact: true }).click();
  await expect(activity.getByRole("listitem")).toHaveCount(104);
  await expect(activity).toContainText("Recorded fixture tool 101");
  await expect(detail.getByRole("button", { name: "Load more recorded activity", exact: true })).toHaveCount(0);
  await expect(detail.getByRole("textbox")).toHaveCount(0);
  await expect(
    detail.getByRole("button", { name: /Stop|Resume|Send/ }),
  ).toHaveCount(0);
  const refresh = detail.getByRole("button", {
    name: "Refresh session metadata",
    exact: true,
  });
  await refresh.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(refresh).toBeFocused();
  await expect(refresh).toHaveCSS("outline-width", "2px");
  expect(
    await detail.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "apps/desktop/docs/screenshots/observed-session.png",
    style: ".af-observed-session time { visibility: hidden !important; }",
  });
});

test("an actual app-owned Task is deduplicated, stays owned after both index failures, and a foreign UUID never reaches its private read", async ({
  page,
}) => {
  const previous = new Set(records().map((record) => record.id)),
    before = starts();
  writeFileSync(
    join(HEARTH_HOME, "coding-fixture-mode.json"),
    JSON.stringify("normal"),
  );
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/sessions`);
  await page.route(`**/projects/${alpha.id}/session-observations`, (route) => route.fulfill({ status: 503, json: { ok: false, data: null, error: "Ownership index temporarily unavailable in this fixture" } }));
  await page.getByRole("button", { name: "New session", exact: true }).click();
  const composer = page.getByRole("dialog", {
    name: "New session · Alpha",
    exact: true,
  });
  await composer
    .getByRole("textbox", { name: "Session prompt", exact: true })
    .fill("Private owned observation fixture prompt");
  await composer
    .getByRole("combobox", { name: "Session mode", exact: true })
    .selectOption("task");
  await composer
    .getByRole("combobox", { name: "Session effort", exact: true })
    .selectOption("");
  await composer
    .getByRole("button", { name: "Check supported options", exact: true })
    .click();
  await expect(
    composer.getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
  await composer.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.locator("[data-session-state]")).toHaveAttribute(
    "data-session-state",
    "ended",
  );
  const record = records().find((item) => !previous.has(item.id));
  if (!record) throw Error("Missing actual fake-CLI owned session");
  expect(starts()).toBe(before + 1);
  await page.getByRole("link", { name: "All sessions", exact: true }).click();
  const sidebar = page.getByRole("complementary", {
    name: "Project",
    exact: true,
  });
  const row = sidebar.locator(`a[href*="${record.id}"]`);
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute("aria-label", /Status unavailable/);
  await expect(
    page.locator(".af-project-sessions").locator(`a[href*="${record.id}"]`),
  ).toHaveCount(0);
  await page.route(`**/projects/${alpha.id}/session-observations`, (route) =>
    route.fulfill({
      status: 503,
      json: {
        ok: false,
        data: null,
        error: "Ownership index temporarily unavailable in this fixture",
      },
    }),
  );
  await page.route(`**/projects/${alpha.id}/sessions`, (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          status: 503,
          json: {
            ok: false,
            data: null,
            error: "Session control index unavailable in this fixture",
          },
        })
      : route.continue(),
  );
  await page
    .getByRole("button", { name: "Refresh sessions", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Refresh app sessions", exact: true })
    .click();
  await expect(
    page.getByText(/Refresh failed: Ownership index temporarily unavailable/),
  ).toBeVisible();
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute("aria-label", /Status unavailable/);
  let foreignPrivateReads = 0;
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname.startsWith(
        `/__agent-forge/projects/${beta.id}/sessions/${record.id}`,
      )
    )
      foreignPrivateReads++;
  });
  await openSettled(page, url(record.id, beta.id));
  await expect(
    page.getByRole("region", { name: "Session metadata details", exact: true }),
  ).toContainText("not in this project's verified metadata");
  expect(foreignPrivateReads).toBe(0);
  await expect(
    page.getByRole("textbox", { name: "Session reply prompt", exact: true }),
  ).toHaveCount(0);
  expect(starts()).toBe(before + 1);
});

test("a missing then late ended parent keeps its child; failed metadata refresh keeps activity and a later valid read restores the link", async ({
  page,
}) => {
  const parent = `late-parent-${randomUUID()}`,
    child = `late-child-${randomUUID()}`;
  seedObservationEvents([
    {
      kind: "session.started",
      workspace,
      beadId: "alpha-epic",
      sessionId: child,
      payload: { kind: "subagent", parentSessionId: parent },
    },
  ]);
  await openSettled(page, url(child));
  const detail = page.getByRole("region", {
    name: "Observed session details",
    exact: true,
  });
  await expect(detail).toContainText("Parent unavailable in this project");
  await expect(
    detail.getByRole("link", { name: `Open parent ${parent}` }),
  ).toHaveCount(0);
  await page.route(`**/session-observations/${child}?*`, (route) =>
    route.fulfill({
      status: 503,
      json: {
        ok: false,
        data: null,
        error: "Recorded activity temporarily unavailable in this fixture",
      },
    }),
  );
  await detail
    .getByRole("button", { name: "Refresh session metadata", exact: true })
    .click();
  await expect(detail.getByRole("alert")).toContainText(
    "Recorded activity temporarily unavailable",
  );
  await expect(detail).toContainText("Session start recorded");
  seedObservationEvents([
    {
      kind: "session.started",
      workspace,
      beadId: "alpha-epic",
      sessionId: parent,
      payload: { kind: "interactive" },
    },
    {
      kind: "session.ended",
      workspace,
      beadId: "alpha-epic",
      sessionId: parent,
      payload: { reason: "actual fixture exit", durationMs: 14 },
    },
  ]);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await detail
    .getByRole("button", { name: "Refresh session metadata", exact: true })
    .click();
  const link = detail.getByRole("link", {
    name: `Open parent ${parent}`,
    exact: true,
  });
  await expect(link).toBeVisible();
  await expect(detail).toContainText(child);
  await link.click();
  await expect(detail).toContainText("End recorded");
  await expect(detail).toContainText("actual fixture exit");
});

test("held metadata reads show loading, retain refresh keyboard focus and cannot paint another project", async ({
  page,
}) => {
  const child = `held-child-${randomUUID()}`;
  seedObservationEvents([
    {
      kind: "session.started",
      workspace,
      beadId: "alpha-epic",
      sessionId: child,
      payload: { kind: "interactive" },
    },
  ]);
  let release: (() => Promise<void>) | undefined;
  const releaseHeld = async () => {
    if (!release) throw Error("Missing held metadata read");
    await release();
  };
  await page.route(
    `**/projects/${alpha.id}/session-observations`,
    async (route) => {
      const response = await forward(route);
      await new Promise<void>((resolve) => {
        release = async () => {
          await route.fulfill({ response });
          resolve();
        };
      });
    },
  );
  await page.goto(`/index.html#/desktop/project/${alpha.id}/sessions`, {
    waitUntil: "domcontentloaded",
  });
  await expect(
    page.getByText("Loading sessions…", { exact: true }),
  ).toBeVisible();
  await expect.poll(() => Boolean(release)).toBe(true);
  await releaseHeld();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  const find = page.getByRole("searchbox", {
    name: "Find sessions",
    exact: true,
  });
  await find.fill("no-such-observed-fixture");
  await expect(
    page.getByText("No matching sessions", { exact: true }),
  ).toBeVisible();
  await find.fill(child);
  await page.getByRole("link", { name: `Open ${child}`, exact: true }).click();
  const detail = page.getByRole("region", {
    name: "Observed session details",
    exact: true,
  });
  await expect(detail).toContainText("Session start recorded");
  release = undefined;
  await page.route(`**/session-observations/${child}?*`, async (route) => {
    const response = await forward(route);
    await new Promise<void>((resolve) => {
      release = async () => {
        await route.fulfill({ response });
        resolve();
      };
    });
  });
  const refresh = detail.getByRole("button", {
    name: "Refresh session metadata",
    exact: true,
  });
  await refresh.focus();
  await page.keyboard.press("Enter");
  await expect(refresh).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(refresh).toBeFocused();
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, url("not-in-beta", beta.id).split("#")[1] ?? "");
  await expect(
    page.getByRole("region", { name: "Session metadata details", exact: true }),
  ).toContainText("not in this project's verified metadata");
  await releaseHeld();
  await expect(
    page.getByRole("region", { name: "Session metadata details", exact: true }),
  ).not.toContainText(child);
});

test("an unavailable initial source is not shown as empty; a later complete empty project read recovers without a write", async ({
  page,
}) => {
  const empty = projectFixture(workspace, {
    id: `project-${randomUUID()}`,
    slug: "empty-observation",
    name: "Empty observation",
    workspaces: [
      {
        root: workspace,
        repositories: [workspace],
        epicIds: ["empty-observation-epic"],
      },
    ],
  });
  withStateLock(BD_STAND_IN_STATE, () =>
    writeState(BD_STAND_IN_STATE, {
      ...readState(BD_STAND_IN_STATE),
      "empty-observation-epic": {
        id: "empty-observation-epic",
        title: "Empty observation epic",
        issue_type: "epic",
        status: "open",
        priority: 2,
        created_at: empty.createdAt,
        updated_at: empty.updatedAt,
        labels: ["project:empty-observation"],
      },
    }),
  );
  writeFileSync(
    catalogFile,
    JSON.stringify({ ...catalog, projects: [...catalog.projects, empty] }),
  );
  let posts = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      !request.url().endsWith("/__agent-forge/session")
    )
      posts++;
  });
  await page.route(`**/projects/${empty.id}/session-observations`, (route) =>
    route.fulfill({
      status: 503,
      json: {
        ok: false,
        data: null,
        error: "Scoped metadata could not be read in this fixture",
      },
    }),
  );
  await openSettled(page, `/index.html#/desktop/project/${empty.id}/sessions`);
  await expect(
    page.getByRole("main").getByText("Sessions unavailable", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Scoped metadata could not be read in this fixture", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("No scoped sessions observed", { exact: true }),
  ).toHaveCount(0);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page
    .getByRole("button", { name: "Refresh sessions", exact: true })
    .click();
  await expect(
    page.getByText("No scoped sessions observed", { exact: true }),
  ).toBeVisible();
  expect(posts).toBe(0);
});
