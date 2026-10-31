import { rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { projectBeadsPageSchema } from "../../scripts/projects/beads-protocol";
import {
  projectRunDetailSchema,
  projectRunsPageSchema,
} from "../../scripts/projects/run-protocol";
import { projectCouncilHistorySchema } from "../../types/project-council";
import { openSettled } from "../e2e/fixtures";
import { HEARTH_HOME } from "../e2e/servers";
import { alpha, seedKeeper, seedProjects, workspace } from "./project-fixtures";

test.beforeEach(() => seedProjects());

test("the visible Search entry opens the keyboard palette", async ({
  page,
}) => {
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/overview`);
  await page.getByRole("button", { name: "Open command palette" }).click();
  await expect(
    page.getByRole("dialog", { name: "Command palette" }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Search projects, work, and commands" }),
  ).toBeFocused();
});

test("palette opens by shortcut, navigates a scoped result, and restores it as a recent", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/overview`);
  await page.keyboard.press("Control+k");

  const dialog = page.getByRole("dialog", { name: "Command palette" });
  const search = dialog.getByRole("combobox", {
    name: "Search projects, work, and commands",
  });
  await expect(dialog).toBeVisible();
  await expect(search).toBeFocused();
  await expect(search).toHaveCSS("outline-width", "2px");
  await search.fill("alpha-epic");
  const bead = dialog.getByRole("option").filter({ hasText: "alpha-epic" });
  await expect(bead).toHaveCount(1);
  await expect(bead.getByRole("button")).toHaveCount(0);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(
    new RegExp(
      `/desktop/project/${alpha.id}/beads\\?selectionKind=bead&selectionId=alpha-epic`,
    ),
  );
  await expect(dialog).not.toBeVisible();

  await page.keyboard.press("Control+k");
  const reopened = page.getByRole("dialog", { name: "Command palette" });
  await expect(
    reopened.getByRole("option").filter({ hasText: "alpha-epic" }),
  ).toHaveCount(1);
  await reopened.getByRole("combobox").press("Escape");
  await expect(reopened).not.toBeVisible();
});

test("palette command selection displays generated argument guidance without a shortcut side effect", async ({
  page,
}) => {
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/overview`);
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST")
      writes.push(new URL(request.url()).pathname);
  });
  const before = page.url();
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  const search = dialog.getByRole("combobox");
  await search.fill("/forge-plan");
  const command = dialog.getByRole("option").filter({ hasText: "/forge-plan" });
  await expect(command).toContainText("<slug> [--smith <name>]");
  await expect(page).toHaveURL(before);
  await page.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Session prompt", exact: true }),
  ).toHaveValue("/forge-plan ");
  await expect(page).toHaveURL(before);
  expect(writes).toEqual([]);
});

test("expired palette selection stays open with a refresh path and performs no write action", async ({
  page,
}) => {
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/overview`);
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST")
      writes.push(new URL(request.url()).pathname);
  });
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  const search = dialog.getByRole("combobox");
  await search.fill("alpha-epic");
  const option = dialog.getByRole("option").first();
  await expect(option).toBeVisible();
  await page.route(`**/projects/${alpha.id}/beads*`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 900));
    await route.continue();
  });
  await page.evaluate(() => {
    const now = Date.now();
    Date.now = () => now + 31_000;
  });
  await option.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("alert")).toContainText("This result changed");
  await expect(
    dialog.getByRole("button", { name: "Refresh results" }),
  ).toBeVisible();
  expect(writes).toEqual([]);
});

test("partial source and filtered-empty state stay visible while reads load", async ({
  page,
}) => {
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/overview`);
  await page.route(`**/projects/${alpha.id}/beads*`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({
      json: { ok: false, data: null, error: "fixture source unavailable" },
    });
  });
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  await expect(
    dialog
      .getByRole("status")
      .filter({ hasText: `beads:${alpha.id}: loading` }),
  ).toBeVisible();
  const search = dialog.getByRole("combobox");
  await search.fill("palette-query-with-no-matching-row");
  await expect(
    dialog
      .getByRole("status")
      .filter({ hasText: "Some sources are unavailable" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("status").filter({ hasText: "No matching results" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Refresh results" }),
  ).toBeVisible();
});

test("Keeper palette target opens the current reviewed proposal without approving or starting it", async ({
  page,
}) => {
  rmSync(join(HEARTH_HOME, "conversations", `keeper-${alpha.id}.json`), {
    force: true,
  });
  seedKeeper([
    {
      kind: "text",
      text: JSON.stringify({
        kind: "keeper.proposals.v1",
        message: "Review this session first.",
        proposals: [
          {
            title: "Palette Keeper proposal",
            detail: "Exact current source request.",
            action: {
              kind: "start-session",
              provider: "claude",
              smith: "claude-journeyman",
              beadId: "alpha-epic",
              repository: workspace,
              worktree: "new",
              prompt: "Review through the existing owner",
            },
          },
        ],
      }),
    },
  ]);
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/overview`);
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST")
      writes.push(new URL(request.url()).pathname);
  });
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  await dialog.getByRole("combobox").fill("Palette Keeper proposal");
  await dialog
    .getByRole("option")
    .filter({ hasText: "Palette Keeper proposal" })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Review Keeper session · Alpha" }),
  ).toBeVisible();
  expect(
    writes.filter((path) =>
      /keeper\/proposals\/(approve|dismiss)|\/sessions(?:\/|$)/.test(path),
    ),
  ).toEqual([]);
});

test("failed Keeper read is explicit current-project coverage, not an empty proposal list", async ({
  page,
}) => {
  await page.route(
    `**/__agent-forge/projects/${alpha.id}/keeper/proposals**`,
    async (route) => {
      await route.fulfill({
        status: 503,
        json: { ok: false, data: null, error: "private server detail" },
      });
    },
  );
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/overview`);
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  await expect(
    dialog
      .getByRole("status")
      .filter({ hasText: "Keeper current project: unavailable" }),
  ).toBeVisible();
  await expect(
    dialog
      .getByRole("status")
      .filter({ hasText: "Keeper current project: unavailable" }),
  ).not.toContainText("private server detail");
  await dialog.getByRole("combobox").fill("proposal that does not exist");
  await expect(
    dialog.getByRole("option").filter({ hasText: "Keeper proposal review" }),
  ).toHaveCount(0);
  await expect(
    dialog
      .getByRole("status")
      .filter({ hasText: "Keeper current project: unavailable" }),
  ).toBeVisible();
});

test("Council history palette target opens the exact saved-result owner without a Council mutation", async ({
  page,
}) => {
  const requestId = "9f46f619-9750-4b30-9e86-bf43ebcabc01";
  const history = projectCouncilHistorySchema.parse({
    version: 1,
    projectId: alpha.id,
    workspace,
    activeRequestId: null,
    total: 1,
    omitted: 0,
    items: [
      {
        requestId,
        runId: "palette-run",
        intentHash: "a".repeat(64),
        state: "completed",
        phase: "completed",
        sourceType: "bead",
        sourceName: "Palette saved review",
        profileId: "reviewer",
        profileTitle: "Palette reviewer",
        depth: "quick",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
  });
  await page.route(
    `**/__agent-forge/projects/${alpha.id}/council/reviews`,
    async (route) => {
      await route.fulfill({ json: { ok: true, data: history, error: null } });
    },
  );
  const ownerReads: string[] = [];
  const writes: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path.endsWith(`/${requestId}/run`))
      ownerReads.push(path);
    if (request.method() === "POST" && path.includes("/council/"))
      writes.push(path);
  });
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/overview`);
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  await dialog.getByRole("combobox").fill("Palette saved review");
  await dialog
    .getByRole("option")
    .filter({ hasText: "Palette saved review" })
    .click();
  await expect(page).toHaveURL(
    new RegExp(
      `/desktop/project/${alpha.id}/reviews\\?selectionKind=event&selectionId=${requestId}`,
    ),
  );
  await expect.poll(() => ownerReads.length).toBeGreaterThan(0);
  expect(ownerReads.every((path) => path.endsWith(`/${requestId}/run`))).toBe(
    true,
  );
  expect(writes).toEqual([]);
});

test("checkpoint palette target focuses the existing current review owner without submitting", async ({
  page,
}) => {
  const beadPage = projectBeadsPageSchema.parse({
    projectId: alpha.id,
    workspace,
    asOf: new Date().toISOString(),
    complete: true,
    problems: [],
    dependencies: [],
    beads: [
      {
        id: "alpha-epic",
        title: "Alpha epic",
        type: "epic",
        status: "open",
        priority: 2,
        parent: null,
        assignee: null,
        owner: null,
        labels: [],
        createdAt: alpha.createdAt,
        updatedAt: alpha.updatedAt,
        due: null,
        description: "",
        acceptanceCriteria: "",
        estimate: null,
        spent: null,
        ready: false,
        blocked: false,
        blockers: [],
        unavailableBlockers: 0,
        queue: null,
        smith: null,
        comments: [],
        commentsComplete: true,
        detailsLoaded: true,
      },
      {
        id: "alpha-checkpoint",
        title: "Alpha checkpoint",
        type: "task",
        status: "in_progress",
        priority: 2,
        parent: "alpha-epic",
        assignee: null,
        owner: null,
        labels: [],
        createdAt: alpha.createdAt,
        updatedAt: alpha.updatedAt,
        due: null,
        description: "",
        acceptanceCriteria: "",
        estimate: null,
        spent: null,
        ready: false,
        blocked: false,
        blockers: [],
        unavailableBlockers: 0,
        queue: null,
        smith: null,
        comments: [],
        commentsComplete: true,
        detailsLoaded: true,
      },
    ],
  });
  const run = {
    slug: "palette-run",
    feature: "Palette run",
    epic: "alpha-epic",
    mode: "gated",
    health: "running",
    phases: [
      {
        id: "research",
        state: "active",
        artifact: "plans/research/palette-run.md",
        artifactMissing: false,
      },
      {
        id: "plan",
        state: "locked",
        artifact: "plans/drafts/palette-run.md",
        artifactMissing: false,
      },
      {
        id: "implement",
        state: "locked",
        artifact: null,
        artifactMissing: false,
      },
      {
        id: "ship",
        state: "locked",
        artifact: "reports/palette-run-ship.md",
        artifactMissing: false,
      },
    ],
    status: { kind: "phase", phase: "research" },
    completedCount: 0,
    totalPhases: 4,
    gatePassed: null,
    reviewRounds: 0,
    latestVerdict: null,
    updatedAt: new Date().toISOString(),
    complete: true,
  };
  const runSource = {
    version: 1,
    projectId: alpha.id,
    workspace,
    checkout: workspace,
    asOf: new Date().toISOString(),
    coverage: "served-checkout-only",
    problems: [],
  };
  const runsPage = projectRunsPageSchema.parse({ ...runSource, runs: [run] });
  const detail = projectRunDetailSchema.parse({
    ...runSource,
    run,
    reviews: [],
    gateHistory: [],
    gateHistoryDays: 30,
    earlierGateLimit: 10,
  });
  await page.route(`**/projects/${alpha.id}/beads*`, async (route) =>
    route.fulfill({ json: { ok: true, data: beadPage, error: null } }),
  );
  await page.route(
    `**/__agent-forge/projects/${alpha.id}/runs`,
    async (route) =>
      route.fulfill({ json: { ok: true, data: runsPage, error: null } }),
  );
  await page.route(
    `**/__agent-forge/projects/${alpha.id}/runs/palette-run*`,
    async (route) =>
      route.fulfill({ json: { ok: true, data: detail, error: null } }),
  );
  const writes: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /checkpoint|review/.test(new URL(request.url()).pathname)
    )
      writes.push(request.url());
  });
  await openSettled(
    page,
    `/index.html#/desktop/project/${alpha.id}/runs?selectionKind=run&selectionId=palette-run`,
  );
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  await dialog.getByRole("combobox").fill("alpha-checkpoint");
  await dialog
    .getByRole("option")
    .filter({ hasText: "Review checkpoint alpha-checkpoint" })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Review note" }),
  ).toBeFocused();
  expect(writes).toEqual([]);
});
