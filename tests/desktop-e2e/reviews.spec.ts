import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { ProjectRecord } from "../../types/projects";
import {
  type ProjectCouncilRunRead,
  projectCouncilRunReadSchema,
} from "../../types/project-council-run-read";
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
  const runPath = `/__agent-forge/projects/${alpha.id}/council/reviews/`;
  let verifiedRun: ProjectCouncilRunRead | undefined;
  const resultRead = page.waitForResponse(async (response) => {
    const path = new URL(response.url()).pathname;
    if (response.request().method() !== "GET" || !path.startsWith(runPath) || !path.endsWith("/run")) return false;
    if (!response.ok()) throw Error(`Council result returned HTTP ${response.status()}.`);
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("ok" in body) || body.ok !== true || !("error" in body) || body.error !== null || !("data" in body)) throw Error("Invalid Council result envelope.");
    const read = projectCouncilRunReadSchema.parse(body.data);
    if (read.receipt.phase !== "completed" || read.verdictCommentPreview === null) return false;
    verifiedRun = read;
    return true;
  });
  void resultRead.catch(() => {});
  page.on("request", (request) => {
    if (request.method() === "POST")
      posts.push(new URL(request.url()).pathname);
  });
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
  await page
    .getByRole("button", { name: "Prepare original for review" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Exact saved original" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Convene this exact original" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Council result" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole("heading", { name: "Verified result facts" }),
  ).toBeVisible();
  await resultRead;
  if (!verifiedRun?.job?.run) throw Error("The completed Bead result was not read back.");
  const run = verifiedRun.job.run;
  expect(verifiedRun.provenance).toMatchObject({ projectId: alpha.id, runId: run.runId });
  expect(run.context.source).toMatchObject({ kind: "bead", locator: "alpha-council-first" });
  expect(run.chair?.verdict).toBe("needs_changes");
  const counts = (["blocker", "high", "medium", "low"] as const).map((severity) => run.aggregatedFindings.filter((finding) => finding.severity === severity).length);
  const expectedPreview = `review: COUNCIL ${run.runId} FAIL — findings ${counts.join("/")} (blocker/high/medium/low)`;
  expect(verifiedRun.verdictCommentPreview).toBe(expectedPreview);
  await expect(page.getByRole("region", { name: "Bead verdict comment preview" }).locator("pre")).toHaveText(expectedPreview);
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
  expect(readComments(BD_STAND_IN_STATE)["alpha-council-first"]?.[0]?.text).toBe(expectedPreview);
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

  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Saved reviews" }),
  ).toBeVisible();
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
