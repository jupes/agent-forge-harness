import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  expect,
  type Request,
  type Response,
  type Route,
  test,
} from "@playwright/test";
import { projectCouncilMetadataSchema } from "../../types/project-council";
import type { ProjectCouncilRunRead } from "../../types/project-council-run-read";
import type { ProjectRecord } from "../../types/projects";
import {
  readComments,
  readState,
  withStateLock,
  writeComments,
  writeState,
} from "../e2e/bd-stand-in-state";
import { openSettled } from "../e2e/fixtures";
import { BD_STAND_IN_STATE } from "../e2e/servers";
import { seedCouncilProject } from "./council-fixtures";
import {
  observeRunReads,
  responseData,
  verifiedRunReads,
} from "./council-run-read-observer";
import { alpha as fixtureAlpha, seedSessions } from "./project-fixtures";

let alpha: ProjectRecord = fixtureAlpha;

test.beforeEach(() => {
  alpha = seedCouncilProject();
  withStateLock(BD_STAND_IN_STATE, () => {
    writeComments(BD_STAND_IN_STATE, {});
    const state = readState(BD_STAND_IN_STATE);
    for (const id of [
      "alpha-council-first",
      "alpha-council-second",
      "alpha-council-third",
    ]) {
      state[id] = {
        id,
        title: `Title ${id}`,
        issue_type: "task",
        status: "open",
        priority: 2,
        labels: [`project:${alpha.slug}`],
        created_at: alpha.createdAt,
        updated_at: alpha.updatedAt,
        dependencies: [
          { issue_id: id, depends_on_id: "alpha-epic", type: "parent-child" },
        ],
      };
    }
    writeState(BD_STAND_IN_STATE, state);
  });
});

test("source entry, Keep draft, and Replace source preserve options without preparing anything", async ({
  page,
}) => {
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST")
      posts.push(new URL(request.url()).pathname);
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/beads`);
  await page
    .getByRole("button", {
      name: "Inspect alpha-council-first: Title alpha-council-first",
    })
    .click();
  await page.getByRole("button", { name: "Review bead in Council" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/desktop/project/${alpha.id}/reviews$`),
  );

  const sourceType = page.getByLabel("Source type");
  const source = page.getByLabel("Beads issue ID");
  await expect(sourceType).toHaveValue("bead");
  await expect(source).toHaveValue("alpha-council-first");
  const profile = page.getByLabel("Council profile");
  await expect(profile).toHaveValue(/.+/);
  const profileBefore = await profile.inputValue();
  await page.getByLabel("Maximum estimated cost (USD)").fill("12.50");
  await page.getByLabel("Maximum prepared bytes").fill("123456");
  await page
    .getByLabel(
      "Redact detected secrets; otherwise source preparation rejects them",
    )
    .uncheck();
  await page
    .getByLabel("Allow deep discussion when supported by this profile")
    .check();
  await sourceType.selectOption("text");
  await page
    .getByLabel("Document or question")
    .fill("Keep this explicit draft body.");

  await page.getByRole("link", { name: "Beads", exact: true }).click();
  await expect(page).toHaveURL(
    new RegExp(`/desktop/project/${alpha.id}/beads$`),
  );
  await page
    .getByRole("button", {
      name: "Inspect alpha-council-second: Title alpha-council-second",
    })
    .click();
  await page.getByRole("button", { name: "Review bead in Council" }).click();
  const replacementDialog = page.getByRole("dialog", {
    name: "Replace Council draft source?",
  });
  const keep = replacementDialog.getByRole("button", { name: "Keep draft" });
  const replace = replacementDialog.getByRole("button", {
    name: "Replace source",
  });
  await keep.focus();
  await page.keyboard.press("Tab");
  await expect(replace).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(
    new RegExp(`/desktop/project/${alpha.id}/reviews$`),
  );
  await expect(page.getByLabel("Source type")).toHaveValue("text");
  await expect(page.getByLabel("Document or question")).toHaveValue(
    "Keep this explicit draft body.",
  );

  await page.getByRole("link", { name: "Beads", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Inspect alpha-council-third: Title alpha-council-third",
    })
    .click();
  await page.getByRole("button", { name: "Review bead in Council" }).click();
  await page.getByRole("button", { name: "Replace source" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/desktop/project/${alpha.id}/reviews$`),
  );
  await expect(page.getByLabel("Source type")).toHaveValue("bead");
  await expect(page.getByLabel("Beads issue ID")).toHaveValue(
    "alpha-council-third",
  );
  await expect(profile).toHaveValue(profileBefore);
  await expect(page.getByLabel("Maximum estimated cost (USD)")).toHaveValue(
    "12.50",
  );
  await expect(page.getByLabel("Maximum prepared bytes")).toHaveValue("123456");
  await expect(
    page.getByLabel(
      "Redact detected secrets; otherwise source preparation rejects them",
    ),
  ).not.toBeChecked();
  await expect(
    page.getByLabel("Allow deep discussion when supported by this profile"),
  ).toBeChecked();
  expect(posts).toEqual([]);
  expect(new URL(page.url()).search).toBe("");
  expect(new URL(page.url()).hash).not.toContain("alpha-council-third");
  const persistedText = await page.evaluate(() =>
    [
      window.location.href,
      ...Object.values(localStorage),
      ...Object.values(sessionStorage),
    ].join("\n"),
  );
  expect(persistedText).not.toContain("Keep this explicit draft body.");
});

test("session and Keeper summary entries keep the draft blank and focused", async ({
  page,
}) => {
  seedSessions();
  const posts: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname.startsWith(
        `/__agent-forge/projects/${alpha.id}/council/reviews`,
      )
    )
      posts.push(request.url());
  });
  await openSettled(
    page,
    `/index.html#/desktop/project/${alpha.id}/sessions?selectionKind=session&selectionId=e2e-alpha-parent`,
  );
  const inspector = page.getByRole("region", { name: "Selected session" });
  await expect(inspector.getByText("e2e-alpha-parent")).toBeVisible();
  await inspector
    .getByRole("button", { name: "Write a Council summary" })
    .click();
  const source = page.getByLabel("Document or question");
  await expect(source).toHaveValue("");
  await expect(source).toBeFocused();
  await source.fill("Handwritten review instructions stay mine.");
  await page.goBack();
  await expect(page).toHaveURL(/\/sessions\?selectionKind=session/);

  await page
    .getByRole("button", { name: "Ask Keeper about this session" })
    .click();
  const drawer = page.getByRole("dialog", {
    name: `Forge Keeper · ${alpha.name}`,
  });
  await expect(drawer).toBeVisible();
  await drawer
    .getByRole("textbox", { name: "Message the Keeper" })
    .fill("Private Keeper draft must not enter Council.");
  await drawer.getByRole("button", { name: "Write a Council summary" }).click();
  await expect(drawer).not.toBeVisible();
  const confirmation = page.getByRole("dialog", {
    name: "Replace Council draft source?",
  });
  await expect(
    confirmation.getByRole("button", { name: "Keep draft" }),
  ).toBeVisible();
  await confirmation.getByRole("button", { name: "Replace source" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/desktop/project/${alpha.id}/reviews$`),
  );
  await expect(source).toHaveValue("");
  await expect(source).toBeFocused();
  expect(posts).toEqual([]);
  const visible = await page.locator("body").innerText();
  expect(visible).not.toContain("Private Keeper draft must not enter Council.");
});

test("a completed bead-source review links to its bead and reports the one recorded comment outcome", async ({
  page,
}) => {
  const posts: string[] = [];
  const reviewsPath = `/__agent-forge/projects/${alpha.id}/council/reviews`;
  let historyGets = 0;
  let historyResponseCount = 0;
  let lastHistoryResponse: Response | undefined;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "POST")
      posts.push(new URL(request.url()).pathname);
    if (
      request.method() === "GET" &&
      url.origin === new URL(page.url()).origin &&
      url.pathname === reviewsPath
    )
      historyGets++;
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (
      response.request().method() === "GET" &&
      url.origin === new URL(page.url()).origin &&
      url.pathname === reviewsPath
    ) {
      historyResponseCount++;
      lastHistoryResponse = response;
    }
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/beads`);
  await page
    .getByRole("button", {
      name: "Inspect alpha-council-first: Title alpha-council-first",
    })
    .click();
  await page.getByRole("button", { name: "Review bead in Council" }).click();
  await expect(page.getByLabel("Beads issue ID")).toHaveValue(
    "alpha-council-first",
  );
  const reservationOrigin = new URL(page.url()).origin;
  type ReservationCapture =
    | { original: ReturnType<typeof projectCouncilMetadataSchema.parse> }
    | { error: unknown };
  let reservationClaimed = false;
  let captureError: Error | undefined;
  let resolveReservation!: (value: ReservationCapture) => void;
  const reservationCapture = new Promise<ReservationCapture>((resolve) => {
    resolveReservation = resolve;
  });
  const reservationUrl = `${reservationOrigin}${reviewsPath}`;
  let captureTimer: ReturnType<typeof setTimeout> | undefined;
  let captureTimedOut = false;
  const captureDeadline = new Promise<{ timedOut: true }>((resolve) => {
    captureTimer = setTimeout(() => {
      captureTimedOut = true;
      resolve({ timedOut: true });
    }, 10_000);
  });
  const validateReservation = (status: number, body: Uint8Array) => {
    expect(status).toBe(202);
    const reservationText = new TextDecoder("utf-8", { fatal: true }).decode(
      body,
    );
    let reservationEnvelope: unknown;
    try {
      reservationEnvelope = JSON.parse(reservationText);
    } catch {
      throw Error("The actual Council reservation body was not valid JSON.");
    }
    const reservedData = responseData(reservationEnvelope);
    if (
      typeof reservedData !== "object" ||
      reservedData === null ||
      !("metadata" in reservedData)
    )
      throw Error("The actual Council reservation omitted metadata.");
    const original = projectCouncilMetadataSchema.parse(reservedData.metadata);
    if (original.projectId !== alpha.id)
      throw Error("The reserved Council original belonged to another project.");
    return original;
  };
  const captureReservation = async (route: Route) => {
    const request = route.request();
    let url: URL;
    try {
      url = new URL(request.url());
    } catch {
      await route.continue();
      return;
    }
    if (
      request.method() !== "POST" ||
      request.frame() !== page.mainFrame() ||
      url.origin !== reservationOrigin ||
      url.pathname !== reviewsPath ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      await route.continue();
      return;
    }
    if (reservationClaimed) {
      captureError = new Error(
        "Multiple Council reservation responses were observed.",
      );
      await route.abort().catch(() => undefined);
      return;
    }
    reservationClaimed = true;
    try {
      const response = await route.fetch({
        maxRedirects: 0,
        maxRetries: 0,
        timeout: 10_000,
      });
      const bodyResult = await Promise.race([response.body(), captureDeadline]);
      if ("timedOut" in bodyResult)
        throw new Error(
          "The Council reservation body exceeded its time bound.",
        );
      if (bodyResult.byteLength > 512 * 1024)
        throw new Error(
          "The Council reservation body exceeded its bounded size.",
        );
      const original = validateReservation(response.status(), bodyResult);
      await route.fulfill({ response, body: bodyResult });
      resolveReservation({ original });
    } catch (error) {
      captureError = error instanceof Error ? error : new Error(String(error));
      resolveReservation({ error });
      await route.abort().catch(() => undefined);
    }
  };
  await page.route(reservationUrl, captureReservation);
  let original: ReturnType<typeof projectCouncilMetadataSchema.parse>;
  try {
    await page
      .getByRole("button", { name: "Prepare original for review" })
      .click();
    if (captureTimedOut)
      throw new Error(
        "The Council reservation response was not captured in time.",
      );
    const captured = await Promise.race([reservationCapture, captureDeadline]);
    if ("timedOut" in captured)
      throw new Error(
        "The Council reservation response was not captured in time.",
      );
    if ("error" in captured)
      throw new Error(
        `The Council reservation body was unavailable: ${String(captured.error)}`,
      );
    if (captureError) throw captureError;
    original = captured.original;
  } finally {
    await page.unroute(reservationUrl, captureReservation);
    if (captureTimer !== undefined) clearTimeout(captureTimer);
  }
  if (captureError) throw captureError;
  const exactOriginal = page.getByRole("heading", {
      name: "Exact saved original",
    }),
    readSaved = page.getByRole("button", { name: "Read saved original" }),
    convene = page.getByRole("button", {
      name: "Convene this exact original",
    });
  await expect
    .poll(
      async () =>
        ((await exactOriginal.isVisible()) && (await convene.isVisible())) ||
        (await readSaved.isVisible()),
      { timeout: 10_000 },
    )
    .toBe(true);
  if (!(await convene.isVisible())) {
    const originalRead = page.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === "GET" &&
          url.origin === reservationOrigin &&
          url.pathname === `${reviewsPath}/${original.requestId}`
        );
      },
      { timeout: 10_000 },
    );
    await readSaved.click();
    expect((await originalRead).status()).toBe(200);
  }
  await expect(exactOriginal).toBeVisible();
  await expect(convene).toBeVisible();
  const runReads = await observeRunReads(
    page,
    `${reviewsPath}/${original.requestId}/run`,
    original,
  );
  let verifiedRun: ProjectCouncilRunRead | undefined;
  const matchesOriginal = (read: ProjectCouncilRunRead) =>
    read.provenance.projectId === alpha.id &&
    read.provenance.requestId === original.requestId &&
    read.provenance.intentHash === original.intentHash &&
    read.provenance.runId === original.runId;
  try {
    await page
      .getByRole("button", { name: "Convene this exact original" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Council result" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("heading", { name: "Verified result facts" }),
    ).toBeVisible();
    await expect
      .poll(() => runReads.length, {
        message: "The exact Council result read was not observed.",
        timeout: 15_000,
      })
      .toBeGreaterThan(0);
    const firstReads = await Promise.all([...runReads]);
    const verifiedReads = await verifiedRunReads(runReads);
    if (verifiedReads.some((read) => !matchesOriginal(read)))
      throw Error("A Council result read did not match its saved original.");
    verifiedRun = verifiedReads.find(
      (read) =>
        read.receipt.phase === "completed" &&
        read.verdictCommentPreview !== null,
    );
    if (
      !verifiedRun &&
      firstReads.some((read) => read.kind === "interrupted")
    ) {
      const beforeCheck = runReads.length;
      await page.getByRole("button", { name: "Check saved result" }).click();
      await expect
        .poll(() => runReads.length > beforeCheck, {
          message: "The explicit saved-result read was not observed.",
          timeout: 15_000,
        })
        .toBe(true);
      const freshObservation = runReads[beforeCheck];
      if (!freshObservation)
        throw Error("The explicit saved-result read had no observation.");
      const fresh = await freshObservation;
      const allVerifiedReads = await verifiedRunReads(runReads);
      if (allVerifiedReads.some((read) => !matchesOriginal(read)))
        throw Error("A Council result read did not match its saved original.");
      if (
        fresh.kind !== "verified" ||
        !matchesOriginal(fresh.read) ||
        fresh.read.receipt.phase !== "completed" ||
        fresh.read.verdictCommentPreview === null
      )
        throw Error(
          "The explicit saved-result read did not verify this result.",
        );
      verifiedRun = fresh.read;
    }
    if (
      !verifiedRun ||
      verifiedRun.provenance.projectId !== alpha.id ||
      verifiedRun.provenance.requestId !== original.requestId ||
      verifiedRun.provenance.intentHash !== original.intentHash ||
      verifiedRun.provenance.runId !== original.runId
    )
      throw Error(
        "The completed Council result did not match its saved original.",
      );
  } finally {
    await runReads.dispose();
  }
  if (!verifiedRun?.job?.run)
    throw Error("The completed Bead result was not read back.");
  const run = verifiedRun.job.run;
  expect(verifiedRun.provenance).toMatchObject({
    projectId: alpha.id,
    runId: run.runId,
  });
  expect(run.context.source).toMatchObject({
    kind: "bead",
    locator: "alpha-council-first",
  });
  expect(run.chair?.verdict).toBe("needs_changes");
  const counts = (["blocker", "high", "medium", "low"] as const).map(
    (severity) =>
      run.aggregatedFindings.filter((finding) => finding.severity === severity)
        .length,
  );
  const expectedPreview = `review: COUNCIL ${run.runId} FAIL — findings ${counts.join("/")} (blocker/high/medium/low)`;
  expect(verifiedRun.verdictCommentPreview).toBe(expectedPreview);
  await expect(
    page
      .getByRole("region", { name: "Bead verdict comment preview" })
      .locator("pre"),
  ).toHaveText(expectedPreview);
  const beadLink = page.getByRole("link", {
    name: "Open reviewed bead alpha-council-first",
  });
  const beadHref = await beadLink.getAttribute("href");
  if (beadHref === null) throw Error("The verified bead link has no href.");
  const beadHash = new URL(beadHref, page.url()).hash.slice(1);
  const queryIndex = beadHash.indexOf("?");
  const beadRoute = queryIndex < 0 ? beadHash : beadHash.slice(0, queryIndex);
  const beadQuery = new URLSearchParams(
    queryIndex < 0 ? "" : beadHash.slice(queryIndex + 1),
  );
  expect(beadRoute).toBe(`/desktop/project/${alpha.id}/beads`);
  expect([...beadQuery.keys()].sort()).toEqual([
    "selectionId",
    "selectionKind",
    "view",
  ]);
  expect(beadQuery.get("selectionKind")).toBe("bead");
  expect(beadQuery.get("selectionId")).toBe("alpha-council-first");
  expect(beadQuery.get("view")).toBe("full");
  await expect
    .poll(
      () => readComments(BD_STAND_IN_STATE)["alpha-council-first"]?.length,
      {
        message: "The completed Council verdict comment was not recorded.",
        timeout: 15_000,
      },
    )
    .toBe(1);
  expect(
    readComments(BD_STAND_IN_STATE)["alpha-council-first"]?.[0]?.text,
  ).toBe(expectedPreview);
  await expect(page.getByTestId("council-verdict-status")).toHaveText(
    "Verdict comment posted to the bead.",
    { timeout: 15_000 },
  );
  expect(posts).toHaveLength(2);
  expect(posts[0]).toMatch(/\/projects\/.*\/council\/reviews$/);
  expect(posts[1]).toMatch(/\/projects\/.*\/council\/reviews\/[^/]+\/commit$/);
  await page.getByRole("button", { name: "Back to saved reviews" }).click();
  const savedRow = page
    .getByRole("listitem")
    .filter({ hasText: "alpha-council-first" });
  await expect(
    savedRow.getByRole("heading", { name: /Verified result facts/ }),
  ).toBeVisible();
  await expect(savedRow).toContainText("Actual cost");
  await expect(savedRow).toContainText("Findings by severity");
  await expect(savedRow).not.toContainText(
    "Verdict comment posted to the bead.",
  );

  const historyGetCountBeforeFilter = historyGets;
  const postCountBeforeFilter = posts.length;
  const historyFilter = page.getByLabel("Filter saved reviews");
  await historyFilter.fill("completed");
  await expect(savedRow).toBeVisible();
  await historyFilter.fill("no-such-saved-review");
  await expect(
    page.getByText("No saved reviews match this filter."),
  ).toBeVisible();
  await expect(savedRow).toHaveCount(0);
  const clearFilters = page.getByRole("button", { name: "Clear filters" });
  await historyFilter.press("Tab");
  await expect(clearFilters).toBeFocused();
  await expect(clearFilters).toHaveCSS("outline-width", "2px");
  await page.keyboard.press("Enter");
  await expect(savedRow).toBeVisible();
  await expect(
    savedRow.getByRole("heading", { name: /Verified result facts/ }),
  ).toBeVisible();
  expect(historyGets).toBe(historyGetCountBeforeFilter);
  expect(posts).toHaveLength(postCountBeforeFilter);

  const appOrigin = new URL(page.url()).origin;
  const historyMatcher = `**${reviewsPath}`;
  let routeFailure: string | undefined;
  let historyRouteCalls = 0;
  let failedHistoryRequests = 0;
  let releaseHold!: () => void;
  let resolveHandlerDone!: () => void;
  const heldResponse = new Promise<void>((resolve) => (releaseHold = resolve));
  const handlerDone = new Promise<void>(
    (resolve) => (resolveHandlerDone = resolve),
  );
  let holdReleased = false;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  const failureListener = (request: Request) => {
    const url = new URL(request.url());
    if (
      request.method() === "GET" &&
      url.origin === appOrigin &&
      url.pathname === reviewsPath
    )
      failedHistoryRequests++;
  };
  const historyHandler = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      request.method() !== "GET" ||
      request.frame() !== page.mainFrame() ||
      url.origin !== appOrigin ||
      url.pathname !== reviewsPath ||
      url.search !== ""
    ) {
      try {
        await route.continue();
      } catch {
        routeFailure = "A nonmatching request could not continue.";
        await route.abort("failed").catch(() => undefined);
      }
      return;
    }
    historyRouteCalls++;
    if (historyRouteCalls !== 1) {
      routeFailure = "An unexpected extra saved-history GET was attempted.";
      await route.abort("failed").catch(() => undefined);
      return;
    }
    holdTimer = setTimeout(() => {
      if (!holdReleased) routeFailure = "The bounded history hold expired.";
      releaseHold();
    }, 5000);
    try {
      await heldResponse;
      await route.abort("failed");
    } catch {
      routeFailure =
        routeFailure ?? "The held browser history GET could not be aborted.";
      await route.abort("failed").catch(() => undefined);
    } finally {
      if (holdTimer !== undefined) clearTimeout(holdTimer);
      resolveHandlerDone();
    }
  };
  const releaseHistory = () => {
    holdReleased = true;
    releaseHold();
  };
  page.on("requestfailed", failureListener);
  let routeInstalled = false;
  try {
    await page.route(historyMatcher, historyHandler);
    routeInstalled = true;
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(() => historyRouteCalls, { timeout: 6000 }).toBe(1);
    await expect(
      page
        .getByRole("status")
        .getByText("Loading saved Council reviews…", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Check saved reviews" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("heading", { name: "No council reviews yet" }),
    ).toHaveCount(0);
    releaseHistory();
    await expect.poll(() => failedHistoryRequests).toBe(1);
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "Saved review status is unknown" }),
    ).toContainText("Keep it held");
    await expect(page.getByRole("button", { name: "New review" })).toHaveCount(
      0,
    );
  } finally {
    releaseHistory();
    try {
      if (routeInstalled) {
        try {
          await page.unroute(historyMatcher, historyHandler);
        } catch {
          routeFailure =
            routeFailure ?? "The history route could not be removed.";
        }
        if (historyRouteCalls > 0) {
          let drainTimer: ReturnType<typeof setTimeout> | undefined;
          const drained = await Promise.race([
            handlerDone.then(() => true),
            new Promise<boolean>((resolve) => {
              drainTimer = setTimeout(() => resolve(false), 6000);
            }),
          ]);
          if (drainTimer !== undefined) clearTimeout(drainTimer);
          if (!drained)
            routeFailure =
              routeFailure ?? "The held history route did not drain.";
        }
      }
    } finally {
      page.off("requestfailed", failureListener);
    }
  }
  if (routeFailure) throw new Error(routeFailure);
  expect(historyRouteCalls).toBe(1);
  expect(historyGets).toBe(historyGetCountBeforeFilter + 1);
  const beforeExplicitCheck = historyGets;
  const beforeExplicitResponse = historyResponseCount;
  await page
    .getByRole("alert")
    .filter({ hasText: "Saved review status is unknown" })
    .getByRole("button", { name: "Check saved reviews" })
    .click();
  await expect
    .poll(() => historyResponseCount > beforeExplicitResponse)
    .toBe(true);
  expect(historyGets).toBe(beforeExplicitCheck + 1);
  expect(lastHistoryResponse?.status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: "Saved reviews" }),
  ).toBeVisible();
  await expect(savedRow).toBeVisible();
  await expect(
    page.getByText(
      "Open this result to read verified facts and Bead comment status.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open result" }).click();
  await expect(
    page.getByRole("heading", { name: "Verified result facts" }),
  ).toBeVisible();
  await expect(page.getByTestId("council-verdict-status")).toHaveText(
    "Verdict comment posted to the bead.",
    { timeout: 15_000 },
  );
  expect(posts).toHaveLength(2);
  await expect
    .poll(() => readComments(BD_STAND_IN_STATE)["alpha-council-first"]?.length)
    .toBe(1);
});

test("project Reviews reserves, convenes, completes, and reloads the verified original and result", async ({
  page,
}) => {
  const councilPosts: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname.includes("/council/"))
      councilPosts.push(url.pathname);
  });

  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/overview`);
  await page.getByRole("link", { name: "Reviews", exact: true }).click();
  await expect(page).toHaveURL(
    new RegExp(`/desktop/project/${alpha.id}/reviews$`),
  );
  await expect(
    page.getByText("No council reviews yet", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New review", exact: true }).click();
  await expect(page.getByLabel("Source type")).toHaveValue("text");
  await expect(page.getByLabel("Document or question")).toBeVisible();
  const prepare = page.getByRole("button", {
    name: "Prepare original for review",
  });
  await expect(prepare).toBeDisabled();
  expect(councilPosts).toEqual([]);

  const source = page.getByLabel("Document or question");
  await source.fill(
    "Exact review body: preserve this sentence and its identity.",
  );
  await expect(prepare).toBeEnabled();
  await page
    .getByLabel(
      "Redact detected secrets; otherwise source preparation rejects them",
    )
    .uncheck();
  await expect(source).toHaveValue(
    "Exact review body: preserve this sentence and its identity.",
  );
  await expect(prepare).toBeEnabled();
  await page
    .getByLabel(
      "Redact detected secrets; otherwise source preparation rejects them",
    )
    .check();
  await prepare.click();
  await expect(
    page.getByRole("heading", { name: "Exact saved original" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Exact review body: preserve this sentence and its identity.",
    ),
  ).toBeVisible();
  const identitySummary = page.getByText("Request identity and scope", {
    exact: true,
  });
  await identitySummary.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Intent hash/)).toBeVisible();
  const shotDir = process.env["SHOT_DIR"];
  if (shotDir) {
    mkdirSync(shotDir, { recursive: true });
    const originalHeading = page.getByRole("heading", {
      name: "Exact saved original",
    });
    await originalHeading.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(shotDir, "council-exact-original.png"),
      animations: "disabled",
    });
  }
  expect(councilPosts).toHaveLength(1);
  expect(councilPosts[0]).toMatch(/\/projects\/.*\/council\/reviews$/);
  expect(councilPosts.some((path) => path.endsWith("/commit"))).toBe(false);
  expect(councilPosts.some((path) => path.includes("/council-api/runs"))).toBe(
    false,
  );

  await page
    .getByRole("button", { name: "Convene this exact original" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Council result" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Verified state: completed")).toBeVisible();
  if (shotDir) {
    const resultHeading = page.getByRole("heading", {
      name: "Council result",
    });
    await resultHeading.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(shotDir, "council-completed-result.png"),
      animations: "disabled",
    });
  }
  expect(councilPosts).toHaveLength(2);
  expect(councilPosts[1]).toMatch(
    /\/projects\/.*\/council\/reviews\/[^/]+\/commit$/,
  );

  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Saved reviews" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open result" }).click();
  await expect(
    page.getByRole("heading", { name: "Council result" }),
  ).toBeVisible();
  await expect(page.getByText("Verified state: completed")).toBeVisible();
  await page.getByText("Show exact saved original", { exact: true }).click();
  await page.getByText("Request identity and scope", { exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Exact saved original" }),
  ).toBeVisible();
  await expect(page.getByText(/Intent hash/)).toBeVisible();
  await expect(
    page.getByText(
      "Exact review body: preserve this sentence and its identity.",
    ),
  ).toBeVisible();
  await page
    .getByText("Inspect complete public Council result", { exact: true })
    .click();
  await expect(page.locator(".af-council-transcript")).toHaveValue(
    /Exact review body: preserve this sentence and its identity\./,
  );
  expect(councilPosts).toHaveLength(2);
});
