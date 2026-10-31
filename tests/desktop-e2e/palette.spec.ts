import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  buildContextPack,
  contextListing,
} from "../../scripts/council/context";
import {
  projectCouncilInputHash,
  projectCouncilIntentHash,
  projectCouncilProfileHash,
  projectCouncilRunId,
} from "../../scripts/council/project-original-store";
import { providerEndpointSnapshot } from "../../scripts/council/providers";
import { parseCouncilProfileJson } from "../../scripts/council/types";
import { projectBeadsPageSchema } from "../../scripts/projects/beads-protocol";
import {
  projectRunDetailSchema,
  projectRunsPageSchema,
} from "../../scripts/projects/run-protocol";
import { projectSessionObservationsSchema } from "../../scripts/projects/session-observations-protocol";
import {
  type ProjectCouncilOriginal,
  projectCouncilHistorySchema,
  projectCouncilMetadata,
  projectCouncilOriginalReadSchema,
} from "../../types/project-council";
import { projectCouncilRunReadSchema } from "../../types/project-council-run-read";
import { openSettled } from "../e2e/fixtures";
import { HEARTH_HOME } from "../e2e/servers";
import { alpha, seedKeeper, seedProjects, workspace } from "./project-fixtures";

test.beforeEach(() => seedProjects());

function savedCouncilReadFixtures(requestId: string) {
  const profilePath = join(process.cwd(), "councils/default.json");
  const parsedProfile = parseCouncilProfileJson(
    readFileSync(profilePath, "utf8"),
  );
  if (!parsedProfile.ok) throw Error("The inert Council fixture is invalid.");
  const source = "Palette saved review fixture.";
  const now = new Date().toISOString();
  const context = buildContextPack({
    kind: "stdin",
    text: source,
    maxBytes: 1024,
  });
  const binding = {
    projectId: alpha.id,
    workspace,
    catalogRevision: 1,
    scopeHash: "b".repeat(64),
    profileHash: projectCouncilProfileHash(parsedProfile.value),
  };
  const original: ProjectCouncilOriginal = {
    requestId,
    runId: projectCouncilRunId(requestId),
    inputHash: projectCouncilInputHash({ source }),
    intentHash: "0".repeat(64),
    binding,
    profileChoice: profilePath,
    profile: parsedProfile.value,
    providerEndpoints: providerEndpointSnapshot(parsedProfile.value, {}),
    context,
    listing: contextListing(context),
    options: {
      maxUsd: 1,
      maxBytes: 1024,
      redactSecrets: true,
      deepDiscussion: false,
    },
    state: "failed",
    createdAt: now,
    updatedAt: now,
    dispatchClaimedAt: now,
  };
  original.intentHash = projectCouncilIntentHash(original);
  const originalRead = projectCouncilOriginalReadSchema.parse({
    metadata: projectCouncilMetadata(original),
    original,
  });
  const runRead = projectCouncilRunReadSchema.parse({
    version: 1,
    provenance: {
      version: 1,
      requestId,
      intentHash: original.intentHash,
      runId: original.runId,
      projectId: alpha.id,
      workspace,
      catalogRevision: binding.catalogRevision,
      scopeHash: binding.scopeHash,
    },
    receipt: { metadata: originalRead.metadata, phase: "failed" },
    job: null,
    verdictCommentPreview: null,
  });
  return { originalRead, runRead };
}

test("the visible Search entry opens the keyboard palette", async ({
  page,
}) => {
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/overview`);
  await page.getByRole("button", { name: "Open command palette" }).click();
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  await expect(dialog).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Search projects, work, and commands" }),
  ).toBeFocused();
  const screenshotDirectory = process.env["SHOT_DIR"];
  if (screenshotDirectory) {
    const coverage = dialog
      .getByRole("status")
      .filter({ hasText: "Source coverage:" });
    await expect(coverage).toContainText("Alpha · Beads:");
    await expect(coverage).not.toContainText("loading");
    await expect(coverage).not.toContainText(alpha.id);
    await dialog.getByRole("combobox").fill("Alpha");
    await expect(
      dialog.getByRole("option", { name: /^Alpha epic\b/ }),
    ).toBeVisible();
    mkdirSync(screenshotDirectory, { recursive: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await dialog.screenshot({
      path: join(screenshotDirectory, "command-palette.png"),
      animations: "disabled",
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await dialog.screenshot({
      path: join(screenshotDirectory, "command-palette-narrow.png"),
      animations: "disabled",
    });
  }
});

test("palette opens by shortcut, navigates a scoped result, and restores it as a recent", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/overview`);
  const sessionPath = `**/__agent-forge/projects/${alpha.id}/session-observations`;
  let releaseSessions!: () => void;
  let signalSessionsStarted!: () => void;
  let signalSessionsFinished!: () => void;
  let sessionReadStarted = false;
  const sessionsHeld = new Promise<void>(
    (resolve) => (releaseSessions = resolve),
  );
  const sessionsStarted = new Promise<void>(
    (resolve) => (signalSessionsStarted = resolve),
  );
  const sessionsFinished = new Promise<void>(
    (resolve) => (signalSessionsFinished = resolve),
  );
  const asOf = new Date().toISOString();
  const sessions = projectSessionObservationsSchema.parse({
    projectId: alpha.id,
    workspace,
    asOf,
    observations: Array.from({ length: 16 }, (_, index) => ({
      sessionId: `palette-session-${String(index).padStart(2, "0")}`,
      workspace,
      beadId: "alpha-epic",
      lastEventAt: asOf,
    })),
    observationsComplete: true,
    ownership: { available: true, records: [], reason: null },
    problems: [],
  });
  await page.route(sessionPath, async (route) => {
    sessionReadStarted = true;
    signalSessionsStarted();
    try {
      await sessionsHeld;
      await route.fulfill({ json: { ok: true, data: sessions, error: null } });
    } finally {
      signalSessionsFinished();
    }
  });
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST")
      writes.push(new URL(request.url()).pathname);
  });
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  const search = dialog.getByRole("combobox", {
    name: "Search projects, work, and commands",
  });
  try {
    await page.keyboard.press("Control+k");
    await expect(dialog).toBeVisible();
    await expect(search).toBeFocused();
    await expect(search).toHaveCSS("outline-width", "2px");
    await search.fill("alpha-epic");
    await sessionsStarted;
    const coverage = dialog
      .getByRole("status")
      .filter({ hasText: "Source coverage:" });
    await expect(coverage).toContainText("Beads: available");
    await expect(coverage).toContainText("Sessions: loading");
    const bead = dialog.getByRole("option", { name: /^Alpha epic\b/ });
    const review = dialog.getByRole("option", { name: /^Review Alpha epic\b/ });
    await expect(bead).toHaveCount(1);
    await expect(bead.getByRole("button")).toHaveCount(0);
    await page.keyboard.press("ArrowDown");
    await expect(review).toHaveAttribute("aria-selected", "true");
    const reviewIdBefore = await review.getAttribute("id");
    await expect(search).toHaveAttribute(
      "aria-activedescendant",
      reviewIdBefore!,
    );

    releaseSessions();
    await expect(coverage).toContainText("Sessions: available");
    await expect(search).toHaveValue("alpha-epic");
    await expect(
      dialog.getByRole("option", { name: /^alpha-epic\b/ }),
    ).toHaveCount(16);
    const reviewIdAfter = await review.getAttribute("id");
    expect(reviewIdAfter).not.toBe(reviewIdBefore);
    expect(Number(reviewIdAfter?.replace("af-palette-", ""))).toBe(
      Number(reviewIdBefore?.replace("af-palette-", "")) + 16,
    );
    await expect(review).toHaveAttribute("aria-selected", "true");
    await expect(dialog.getByRole("option", { selected: true })).toHaveCount(1);
    await expect(search).toHaveAttribute(
      "aria-activedescendant",
      reviewIdAfter!,
    );
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
      reopened.getByRole("option", { name: /^Review Alpha epic\b/ }),
    ).toHaveCount(1);
    await reopened.getByRole("combobox").press("Escape");
    await expect(reopened).not.toBeVisible();
    expect(writes).toEqual([]);
  } finally {
    releaseSessions();
    if (sessionReadStarted) await sessionsFinished;
    await page.unroute(sessionPath);
  }
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
  const option = dialog.getByRole("option", { name: /^Alpha epic\b/ });
  await expect(option).toBeVisible();
  await expect(search).toBeFocused();
  await expect(option).toHaveAttribute("aria-selected", "true");
  const coverage = dialog
    .getByRole("status")
    .filter({ hasText: "Source coverage:" });
  const initialCoverage = await coverage.innerText();
  expect(initialCoverage).toContain("Beads: available");

  let releaseBeads!: () => void;
  let releaseSessions!: () => void;
  let releaseSummary!: () => void;
  const started = { beads: false, sessions: false, summary: false };
  let activeRouteHandlers = 0;
  let routeContinuationFailures = 0;
  let signalRoutesIdle: (() => void) | undefined;
  const beadsGate = new Promise<void>((resolve) => {
    releaseBeads = resolve;
  });
  const sessionsGate = new Promise<void>((resolve) => {
    releaseSessions = resolve;
  });
  const summaryGate = new Promise<void>((resolve) => {
    releaseSummary = resolve;
  });
  const beadsPattern = `**/projects/${alpha.id}/beads*`;
  const sessionsPattern =
    `**/__agent-forge/projects/${alpha.id}/session-observations*`;
  const summaryPattern = "**/projects/summary";
  const hold = (
    source: keyof typeof started,
    gate: Promise<void>,
  ) =>
    async (route: import("@playwright/test").Route) => {
      started[source] = true;
      activeRouteHandlers++;
      try {
        await gate;
        await route.continue();
      } catch {
        routeContinuationFailures++;
      } finally {
        activeRouteHandlers--;
        if (activeRouteHandlers === 0) signalRoutesIdle?.();
      }
    };
  const holdBeads = hold("beads", beadsGate);
  const holdSessions = hold("sessions", sessionsGate);
  const holdSummary = hold("summary", summaryGate);
  const waitForRoutesIdle = () =>
    activeRouteHandlers === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          signalRoutesIdle = resolve;
        });
  const settleRoutes = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        waitForRoutesIdle(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Error("Palette route continuations exceeded 10 seconds.")),
            10_000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (routeContinuationFailures)
      throw Error("A held palette route continuation rejected.");
  };
  try {
    await page.route(beadsPattern, holdBeads);
    await page.route(sessionsPattern, holdSessions);
    await page.route(summaryPattern, holdSummary);
    await page.evaluate(() => {
      type ClockProbe = {
        original: typeof Date.now;
        shifted: typeof Date.now;
      };
      const host = window as Window & { __ci94PaletteClock?: ClockProbe };
      const original = Date.now;
      const now = original();
      const shifted = () => now + 31_000;
      host.__ci94PaletteClock = { original, shifted };
      Date.now = shifted;
    });
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("alert")).toContainText(
      "This result changed",
    );
    expect(writes).toEqual([]);
    await expect.poll(() => started.summary).toBe(true);

    // Keep the summary refresh from publishing its initial loading snapshot
    // until the rejected-selection warning has been observed above.
    releaseSummary();
    await expect.poll(() => started.beads).toBe(true);
    await expect.poll(() => started.sessions).toBe(true);
    const fastSourceResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/__agent-forge/projects/${alpha.id}/session-observations` &&
        response.request().method() === "GET",
      { timeout: 10_000 },
    );
    releaseSessions();
    const response = await fastSourceResponse;
    expect(response.status()).toBe(200);
    await expect(coverage).toContainText("Sessions: available");
    await expect(coverage).toContainText("Beads: loading");
    expect(await coverage.innerText()).not.toBe(initialCoverage);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => resolve()),
          ),
        ),
    );
    await expect(dialog.getByRole("alert")).toContainText(
      "This result changed",
    );
    await expect(
      dialog.getByRole("button", { name: "Refresh results" }),
    ).toBeVisible();
    expect(writes).toEqual([]);
  } finally {
    releaseSummary();
    releaseSessions();
    releaseBeads();
    const cleanupResults = await Promise.allSettled([
      page.unroute(beadsPattern, holdBeads),
      page.unroute(sessionsPattern, holdSessions),
      page.unroute(summaryPattern, holdSummary),
      page.evaluate(() => {
        type ClockProbe = {
          original: typeof Date.now;
          shifted: typeof Date.now;
        };
        const host = window as Window & { __ci94PaletteClock?: ClockProbe };
        const probe = host.__ci94PaletteClock;
        if (probe && Date.now === probe.shifted) Date.now = probe.original;
        delete host.__ci94PaletteClock;
      }),
    ]);
    await settleRoutes();
    if (cleanupResults.some((result) => result.status === "rejected"))
      throw Error("A CI94 palette route or clock cleanup failed.");
  }
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
  const coverage = dialog
    .getByRole("status")
    .filter({ hasText: "Source coverage:" });
  const unavailable = dialog
    .getByRole("status")
    .filter({ hasText: "Some sources are unavailable" });
  await expect(
    coverage.filter({ hasText: "Alpha · Beads: loading" }),
  ).toBeVisible();
  await expect(coverage).not.toContainText(alpha.id);
  const search = dialog.getByRole("combobox");
  await search.fill("palette-query-with-no-matching-row");
  await expect(unavailable).toBeVisible();
  await expect(coverage).toContainText("Alpha · Beads: unavailable");
  await expect(unavailable).toContainText(
    "Alpha · Beads: Current Beads metadata could not be verified.",
  );
  await expect(unavailable).not.toContainText(alpha.id);
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
  const keeperCoverage = dialog
    .getByRole("status")
    .filter({ hasText: "Source coverage:" })
    .filter({ hasText: "Keeper current project: unavailable" });
  await expect(keeperCoverage).toBeVisible();
  await expect(keeperCoverage).not.toContainText("private server detail");
  await dialog.getByRole("combobox").fill("proposal that does not exist");
  await expect(
    dialog.getByRole("option").filter({ hasText: "Keeper proposal review" }),
  ).toHaveCount(0);
  await expect(keeperCoverage).toBeVisible();
});

test("Council history palette target opens the exact saved-result owner without a Council mutation", async ({
  page,
}) => {
  const requestId = "9f46f619-9750-4b30-9e86-bf43ebcabc01";
  const { originalRead, runRead } = savedCouncilReadFixtures(requestId);
  const profileTitle = originalRead.metadata.profileTitle;
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
        state: "failed",
        phase: "failed",
        sourceType: "text",
        sourceName: "Palette saved review",
        profileId: "reviewer",
        profileTitle,
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
  const originalReads: string[] = [];
  const ownerReads: string[] = [];
  const writes: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() === "GET" &&
      path.endsWith(`/council/reviews/${requestId}`)
    )
      originalReads.push(path);
    if (request.method() === "GET" && path.endsWith(`/${requestId}/run`))
      ownerReads.push(path);
    if (request.method() === "POST" && path.includes("/council/"))
      writes.push(path);
  });
  await page.route(
    `**/__agent-forge/projects/${alpha.id}/council/reviews/${requestId}`,
    async (route) =>
      route.fulfill({
        json: { ok: true, data: originalRead, error: null },
      }),
  );
  await page.route(
    `**/__agent-forge/projects/${alpha.id}/council/reviews/${requestId}/run`,
    async (route) =>
      route.fulfill({ json: { ok: true, data: runRead, error: null } }),
  );
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
  await expect.poll(() => originalReads.length).toBeGreaterThan(0);
  await expect.poll(() => ownerReads.length).toBeGreaterThan(0);
  expect(
    originalReads.every((path) =>
      path.endsWith(`/council/reviews/${requestId}`),
    ),
  ).toBe(true);
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
