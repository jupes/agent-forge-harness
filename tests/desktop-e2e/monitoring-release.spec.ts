import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { expect, test } from "@playwright/test";
import { artifactPath } from "../../scripts/forge/phases";
import type { ForgeState } from "../../scripts/forge/phases";
import type { ProjectCatalog } from "../../types/projects";
import { seedObservationEvents } from "./observed-session-fixtures";
import { openSettled } from "../e2e/fixtures";
import {
  alpha,
  catalog,
  catalogFile,
  seedProjects,
  seedSessions,
  workspace,
} from "./project-fixtures";
import { HEARTH_HOME } from "../e2e/servers";

const providerDispatchFiles = [
  "codex-fixture-calls.jsonl",
  "gemini-fixture-calls.jsonl",
  "codex-chat-fixture-calls.jsonl",
  "gemini-chat-fixture-calls.json",
  "keeper-fixture-starts.jsonl",
  "coding-fixture-starts.jsonl",
] as const;
const protectedPosts: string[] = [];
const ownedFiles: { root: string; path: string; bytes: Buffer }[] = [];
let dispatchesBefore: string[] = [];

function dispatchSnapshot(): string[] {
  return providerDispatchFiles.map((name) => {
    const path = join(HEARTH_HOME, name);
    return existsSync(path)
      ? `${name}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`
      : `${name}:absent`;
  });
}

function inside(root: string, path: string): void {
  const pathFromRoot = relative(root, path);
  if (
    !pathFromRoot ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  )
    throw Error("Monitoring fixture path escaped the owned checkout.");
}

function createOwnedFile(root: string, path: string, content: string): void {
  inside(root, path);
  mkdirSync(dirname(path), { recursive: true });
  inside(root, realpathSync.native(dirname(path)));
  const bytes = Buffer.from(content, "utf8");
  writeFileSync(path, bytes, { flag: "wx" });
  ownedFiles.push({ root, path, bytes });
}

function cleanupOwnedFiles(): void {
  for (const file of ownedFiles.splice(0).reverse()) {
    inside(file.root, file.path);
    inside(file.root, realpathSync.native(dirname(file.path)));
    const stat = lstatSync(file.path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw Error("Monitoring fixture is no longer an owned regular file.");
    if (!readFileSync(file.path).equals(file.bytes))
      throw Error("Monitoring fixture changed after this test created it.");
    unlinkSync(file.path);
    expect(existsSync(file.path)).toBe(false);
  }
}

function seedAlphaRun(): string {
  const root = realpathSync.native(process.cwd());
  const slug = `monitoring-rc-alpha-${randomUUID().slice(0, 8)}`;
  const research = artifactPath("research", slug);
  if (!research) throw Error("Research artifact path is unavailable.");
  const run: ForgeState = {
    schemaVersion: 2,
    slug,
    feature: "Alpha foreground monitoring record",
    epic: "alpha-epic",
    phase: "plan",
    completed: ["research"],
    artifacts: { research },
    mode: "gated",
    checkout: root,
    updatedAt: new Date().toISOString(),
  };
  createOwnedFile(
    root,
    join(root, ".tmp", "work", "forge-runs", `${slug}.json`),
    JSON.stringify(run),
  );
  createOwnedFile(
    root,
    join(root, research),
    "# Verified monitoring research\n\nRecorded fixture artifact.\n",
  );
  return slug;
}

function seedBetaRun(): void {
  const root = realpathSync.native(process.cwd());
  const slug = `monitoring-rc-beta-${randomUUID().slice(0, 8)}`;
  const run: ForgeState = {
    schemaVersion: 2,
    slug,
    feature: "Beta foreground monitoring record",
    epic: "beta-epic",
    phase: "research",
    completed: [],
    artifacts: {},
    mode: "gated",
    checkout: root,
    updatedAt: new Date().toISOString(),
  };
  createOwnedFile(
    root,
    join(root, ".tmp", "work", "forge-runs", `${slug}.json`),
    JSON.stringify(run),
  );
}

function addPartialOverviewScope(): void {
  const partial: ProjectCatalog = {
    ...catalog,
    projects: catalog.projects.map((project) =>
      project.id === alpha.id
        ? {
            ...project,
            workspaces: [
              ...project.workspaces,
              {
                root: `${workspace}-unserved-monitoring-scope`,
                repositories: [],
                epicIds: [],
              },
            ],
          }
        : project,
    ),
  };
  writeFileSync(catalogFile, JSON.stringify(partial));
}

test.beforeEach(({ page }) => {
  seedProjects();
  protectedPosts.length = 0;
  dispatchesBefore = dispatchSnapshot();
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname.startsWith("/__agent-forge/")
    )
      protectedPosts.push(new URL(request.url()).pathname);
  });
});

test.afterEach(() => {
  cleanupOwnedFiles();
  expect(protectedPosts).toEqual([]);
  expect(dispatchSnapshot()).toEqual(dispatchesBefore);
});

test("foreground monitoring keeps Alpha and Beta scope, source limits and recorded run truth", async ({
  page,
}) => {
  seedSessions();
  addPartialOverviewScope();
  const runSlug = seedAlphaRun();
  seedBetaRun();
  seedObservationEvents([
    {
      kind: "tool.called",
      workspace,
      beadId: "alpha-epic",
      sessionId: "e2e-alpha-parent",
      executor: { provider: "codex", model: "recorded-model" },
      payload: {
        tool: "Alpha monitoring event",
        argsHash: "a".repeat(64),
        durationMs: 4,
      },
    },
    {
      kind: "tool.called",
      workspace,
      beadId: "beta-epic",
      sessionId: "e2e-beta-own",
      executor: { provider: "codex", model: "recorded-model" },
      payload: {
        tool: "Beta monitoring event",
        argsHash: "b".repeat(64),
        durationMs: 5,
      },
    },
  ]);
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/overview`);

  const alphaNeeds = page.getByRole("region", { name: "Needs you", exact: true });
  await expect(alphaNeeds.getByRole("heading")).toHaveText("Needs you · partial");
  const alphaAsOf = page.locator(".af-overview-toolbar time");
  await expect(alphaAsOf).toHaveAttribute("datetime", /T/);
  await expect(
    page.getByRole("region", { name: "Session observations", exact: true }),
  ).toContainText("partial or unavailable");
  await page.screenshot({ path: test.info().outputPath("alpha-overview.png") });

  await page.getByRole("link", { name: "Projects", exact: true }).click();
  await page.getByRole("link", { name: "Open Beta", exact: true }).click();
  const betaEpics = page.getByRole("region", { name: "Epics", exact: true });
  await expect(betaEpics).toContainText("Beta epic");
  await expect(betaEpics).not.toContainText("Alpha epic");
  await page.screenshot({ path: test.info().outputPath("beta-overview.png") });
  const betaProjectNav = page.getByRole("complementary", {
    name: "Project",
    exact: true,
  });
  await betaProjectNav.getByRole("link", { name: "Runs", exact: true }).click();
  const betaRuns = page.getByRole("region", { name: "Project forge runs" });
  await expect(betaRuns).toContainText("Beta foreground monitoring record");
  await expect(betaRuns).not.toContainText("Alpha foreground monitoring record");
  await page.getByRole("link", { name: "Projects", exact: true }).click();
  await page.getByRole("link", { name: "Open Alpha", exact: true }).click();

  const projectNav = page.getByRole("complementary", {
    name: "Project",
    exact: true,
  });
  await projectNav.getByRole("link", { name: "Sessions", exact: true }).click();
  const observed = page.getByRole("region", { name: "Observed", exact: true });
  await expect(observed).toContainText("e2e-alpha-child");
  await expect(observed).not.toContainText("e2e-beta-own");
  await observed
    .getByRole("link", { name: "Open e2e-alpha-child", exact: true })
    .click();
  const session = page.getByRole("region", {
    name: "Observed session details",
    exact: true,
  });
  await expect(session).toContainText("The conversation is not captured here");
  await expect(session.getByRole("textbox")).toHaveCount(0);
  await expect(session.getByRole("button", { name: /Stop|Resume|Send/ })).toHaveCount(0);
  await page.getByRole("link", { name: "All sessions", exact: true }).click();

  await projectNav.getByRole("link", { name: "Runs", exact: true }).click();
  const runs = page.getByRole("region", { name: "Project forge runs" });
  await expect(runs.getByRole("table", { name: "Recorded forge runs" })).toBeVisible();
  await expect(runs).toContainText("Alpha foreground monitoring record");
  await expect(runs).not.toContainText("Beta foreground monitoring record");
  await runs
    .getByRole("link", { name: "Alpha foreground monitoring record", exact: true })
    .click();
  const detail = page.getByRole("article", { name: "Selected forge run" });
  await expect(detail).toContainText(runSlug);
  await expect(detail.locator('[data-phase="research"]')).toHaveAttribute(
    "data-state",
    "complete",
  );
  await expect(detail.locator('[data-phase="plan"]')).toHaveAttribute(
    "data-state",
    "active",
  );
  await expect(detail).toContainText("Full or Mini is not recorded");
  await expect(detail).toContainText("Start time is not recorded");
  const gateHistory = detail.getByRole("region", { name: "Run gate history" });
  await expect(gateHistory).toContainText("No matching gate was recorded");
  await expect(runs).toContainText("correlated sessions are not available here");
  await detail.getByRole("button", { name: "Read research artifact" }).click();
  await expect(
    page.getByRole("region", { name: "Verified run artifact" }),
  ).toContainText("Recorded fixture artifact.");

  await projectNav.getByRole("link", { name: "Activity", exact: true }).click();
  const activity = page.getByRole("listbox", { name: "Project activity" });
  await expect(activity).toContainText("Alpha monitoring event");
  await expect(activity).not.toContainText("Beta monitoring event");
  expect(protectedPosts).toEqual([]);
});

test("a failed Overview refresh keeps its last verified status and a later protected read recovers", async ({
  page,
}) => {
  let failNext = false,
    overviewReads = 0;
  await page.route(
    `**/__agent-forge/projects/${alpha.id}/overview`,
    async (route) => {
    overviewReads++;
    if (failNext) {
      failNext = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          data: null,
          error: "Scoped Overview fixture read unavailable",
        }),
      });
      return;
    }
    await route.continue();
    },
  );
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/overview`);
  const epics = page.getByRole("region", { name: "Epics", exact: true });
  await expect(epics).toContainText("Alpha epic");
  const asOf = await page
    .locator(".af-overview-toolbar time")
    .getAttribute("datetime");
  expect(asOf).toBeTruthy();
  const refresh = page.getByRole("button", {
    name: "Refresh overview",
    exact: true,
  });
  const beforeFailure = overviewReads;
  const failedRead = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/__agent-forge/projects/${alpha.id}/overview` &&
      response.status() === 503,
  );
  failNext = true;
  await refresh.click();
  await failedRead;
  await expect(
    page.getByRole("status").filter({ hasText: "Scoped Overview fixture read unavailable" }),
  ).toContainText("Showing last-known overview");
  await expect(epics).toContainText("Alpha epic");
  await expect(page.locator(".af-overview-toolbar time")).toHaveAttribute(
    "datetime",
    asOf ?? "",
  );
  expect(overviewReads).toBeGreaterThan(beforeFailure);

  const beforeRecovery = overviewReads;
  const recovered = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/__agent-forge/projects/${alpha.id}/overview` &&
      response.status() === 200,
  );
  await refresh.click();
  await recovered;
  await expect(
    page.getByRole("status").filter({ hasText: "Refresh failed:" }),
  ).toHaveCount(0);
  await expect(epics).toContainText("Alpha epic");
  await expect.poll(() => overviewReads).toBeGreaterThan(beforeRecovery);
  expect(protectedPosts).toEqual([]);
});
