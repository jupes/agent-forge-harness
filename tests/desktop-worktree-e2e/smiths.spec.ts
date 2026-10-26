import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { canonicalSmithConfigCreateRequest } from "../../scripts/config/smith-create-protocol";
import { APPRENTICE_VERIFICATION } from "../../scripts/smith-verification";
import type { LedgerEventInput } from "../../types/hearth";
import { seedObservationEvents } from "../desktop-e2e/observed-session-fixtures";
import {
  readState,
  type StandInIssue,
  withStateLock,
  writeState,
} from "../e2e/bd-stand-in-state";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import { BD_STAND_IN_STATE, HEARTH_HOME, isRunHome } from "../e2e/servers";
import {
  checkedFixtureRoot,
  checkedOsHome,
  fixturePlan,
  OS_HOME,
  REPOSITORY,
} from "./environment";

let fixtureSmith = "";
let savedFiles: { file: string; before: Buffer | null; fixture: Buffer }[] = [];
const screenshotPath = (name: string) =>
  join(
    process.env["AGENT_FORGE_WORKTREE_SCREENSHOT_DIR"] ??
      "apps/desktop/docs/screenshots",
    name,
  );
const providerStarts = () =>
  ["keeper-fixture-starts.jsonl", "coding-fixture-starts.jsonl"].map((name) => {
    const file = join(HEARTH_HOME, name);
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  });
test.beforeEach(() => {
  checkedFixtureRoot();
  if (
    !isRunHome(HEARTH_HOME) ||
    !realpathSync
      .native(REPOSITORY)
      .startsWith(
        `${checkedFixtureRoot()}${process.platform === "win32" ? "\\" : "/"}`,
      )
  )
    throw Error(
      "Smiths fixtures require only the owned temporary repository and run home.",
    );
  fixtureSmith = `inspection-${randomUUID().slice(0, 8)}`;
  const machine = `[smiths.${fixtureSmith}]\nprovider="claude"\nmodel="saved-machine-model"\neffort="medium"\ntags=["rank:apprentice", "inspection"]\n`;
  const workspace = `\uFEFF# Preserved inspection fixture\r\n[workflow]\r\ndefault_crew="${fixtureSmith}"\r\n[smiths.${fixtureSmith}]\r\neffort="low"\r\nenabled=false\r\n[benches]\r\nlow=["${fixtureSmith}:2", "codex-journeyman:1"]\r\n`;
  savedFiles = [
    { file: join(HEARTH_HOME, "config.toml"), content: machine },
    { file: join(REPOSITORY, "agent-forge.toml"), content: workspace },
  ].map(({ file, content }) => ({
    file,
    before: existsSync(file) ? readFileSync(file) : null,
    fixture: Buffer.from(content),
  }));
  for (const saved of savedFiles) writeFileSync(saved.file, saved.fixture);
});
test.afterEach(() => {
  for (const saved of savedFiles) {
    if (saved.before !== null) writeFileSync(saved.file, saved.before);
    else if (existsSync(saved.file)) unlinkSync(saved.file);
  }
  savedFiles = [];
});
function unchangedConfig() {
  for (const saved of savedFiles)
    expect(readFileSync(saved.file)).toEqual(saved.fixture);
}
function seedVerification(title = "Owner verification remains pending") {
  const task: StandInIssue & { notes: string } = {
    id: APPRENTICE_VERIFICATION,
    title,
    issue_type: "task",
    priority: 0,
    status: "open",
    labels: ["verification"],
    description:
      "Visible task <script>stays inert</script>\nNo automatic provider verification.",
    acceptance_criteria: "The owner records the actual native result.",
    notes: "[No mutation](javascript:close())",
    created_at: "2026-10-23T00:00:00Z",
    updated_at: "2026-10-23T00:00:00Z",
  };
  const previous = withStateLock(BD_STAND_IN_STATE, () => {
    const rows = readState(BD_STAND_IN_STATE),
      old = rows[APPRENTICE_VERIFICATION];
    writeState(BD_STAND_IN_STATE, { ...rows, [APPRENTICE_VERIFICATION]: task });
    return old;
  });
  return {
    task,
    restore() {
      withStateLock(BD_STAND_IN_STATE, () => {
        const rows = readState(BD_STAND_IN_STATE);
        if (previous) rows[APPRENTICE_VERIFICATION] = previous;
        else delete rows[APPRENTICE_VERIFICATION];
        writeState(BD_STAND_IN_STATE, rows);
      });
    },
  };
}
function seedRecordedWork() {
  const workspace = fixturePlan()
    .root.replaceAll("\\", "/")
    .replace(/^([A-Z]):/, (_, drive: string) => `${drive.toLowerCase()}:`);
  const event = (
    model: string,
    ago: number,
    foreign = false,
  ): LedgerEventInput => ({
    kind: "session.ended",
    workspace: foreign ? `${workspace}/foreign-workspace` : workspace,
    ts: new Date(Date.now() - ago).toISOString(),
    sessionId: `${fixtureSmith}-${model}`,
    executor: { provider: "claude", model, smith: fixtureSmith },
    payload: {
      reason: "completed",
      ...(model === "recorded-current"
        ? { usage: { outputTokens: 0, cacheReadInputTokens: 17, costUsd: 0 } }
        : {}),
    },
  });
  seedObservationEvents([
    event("recorded-current", 60_000),
    event("recorded-old", 3 * 86_400_000),
    event("FOREIGN-RECORDED-MODEL", 60_000, true),
  ]);
}

test("Smiths inspects actual temporary config provenance and workspace scoreboard without writes or provider starts", async ({
  page,
}) => {
  seedRecordedWork();
  const starts = providerStarts(),
    posts: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().includes("/__agent-forge/")
    )
      posts.push(new URL(request.url()).pathname);
  });
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSettled(page, "/index.html#/desktop/smiths");
  const config = page.getByRole("region", {
    name: "Saved smith configuration",
  });
  const table = config.getByRole("table", { name: "Configured smiths" });
  const row = table
    .getByRole("row")
    .filter({ has: page.getByText(fixtureSmith, { exact: true }) });
  await expect(row).toContainText("saved-machine-model");
  await expect(row).toContainText("Disabled");
  await row.locator("summary").click();
  await expect(row).toContainText(join(HEARTH_HOME, "config.toml"));
  await expect(row).toContainText(join(REPOSITORY, "agent-forge.toml"));
  await expect(
    config.getByRole("article", { name: "low bench", exact: true }),
  ).toContainText("66.7% · weight 2 · Disabled");
  await expect(
    page.getByRole("button", { name: "New smith", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Open verification task", exact: true }),
  ).toBeEnabled();
  await expect(config).toContainText("agent-forge-harness-cla5.6.6.1");
  const search = page.getByRole("searchbox", {
    name: "Filter smiths and scoreboard",
  });
  await search.fill(fixtureSmith);
  await search.focus();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("combobox", { name: "Configured smith status" }),
  ).toBeFocused();
  await expect(
    page.getByRole("combobox", { name: "Configured smith status" }),
  ).toHaveCSS("outline-width", "2px");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await row.locator("summary").click();
  await config
    .getByRole("heading", { name: "Saved smiths", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: screenshotPath("smiths-inspection.png"),
    mask: [page.locator(".af-smith-path"), page.locator("time")],
    maskColor: "#3f424d",
  });
  const board = page.getByRole("region", {
    name: "Recorded workspace scoreboard",
  });
  const rows = board.getByRole("table", { name: "Recorded scoreboard rows" });
  await expect(rows.getByRole("row")).toHaveCount(3);
  await expect(rows).toContainText("recorded-current");
  await expect(rows).toContainText("recorded-old");
  await expect(board).not.toContainText("FOREIGN-RECORDED-MODEL");
  const current = rows.getByRole("row").filter({ hasText: "recorded-current" });
  const old = rows.getByRole("row").filter({ hasText: "recorded-old" });
  await expect(current).toContainText("$0.00");
  await expect(
    old.locator("td").nth(4).getByText("—", { exact: true }),
  ).toHaveCount(1);
  await expect(
    old.locator("td").nth(5).getByText("—", { exact: true }),
  ).toHaveCount(1);
  await current.locator("summary").click();
  await expect(current).toContainText("cacheReadInputTokens");
  await expect(current).toContainText("17");
  await current.locator("summary").click();
  await page
    .getByRole("combobox", { name: "Recorded range" })
    .selectOption("24h");
  await expect(rows.getByRole("row")).toHaveCount(2);
  await expect(rows).not.toContainText("recorded-old");
  expect(posts).toEqual([]);
  await board
    .getByRole("heading", { name: "Recorded scoreboard", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: screenshotPath("smiths-scoreboard.png"),
    mask: [page.locator(".af-smith-path"), page.locator("time")],
    maskColor: "#3f424d",
  });
  await reloadSettled(page);
  await expect(
    config.getByRole("table", { name: "Configured smiths" }),
  ).toContainText(fixtureSmith);
  await search.fill("nothing-matches-this-filter");
  await expect(
    config.getByText("No smiths match these filters", { exact: true }),
  ).toBeVisible();
  await expect(
    board.getByText("No recorded rows match this filter", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  unchangedConfig();
  expect(providerStarts()).toEqual(starts);
  expect(posts).toEqual([]);
});

test("creates a reviewed Smith in the temporary workspace config and recovers its receipt after reload", async ({
  page,
}) => {
  const starts = providerStarts(),
    posts: string[] = [],
    createdName = `browser-create-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().includes("/__agent-forge/")
    )
      posts.push(new URL(request.url()).pathname);
  });
  const fixtureRoot = checkedFixtureRoot();
  checkedOsHome();
  if (
    !isRunHome(HEARTH_HOME) ||
    !realpathSync
      .native(REPOSITORY)
      .startsWith(`${fixtureRoot}${process.platform === "win32" ? "\\" : "/"}`)
  )
    throw Error("Smith creation requires only the owned temporary homes.");

  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSettled(page, "/index.html#/desktop/smiths");
  await page.getByRole("button", { name: "New smith", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create a Smith" });
  await dialog.getByLabel("Smith name").fill(createdName);
  await dialog.getByLabel("Provider").fill("codex");
  await dialog.getByLabel("Model").fill("browser-fixture-model");
  await dialog.getByLabel("Effort").fill("high");
  await dialog.getByLabel("Tags").fill("browser-fixture\nreviewed");
  await dialog.getByRole("button", { name: "Review candidate" }).click();
  await expect(
    dialog.getByRole("region", { name: "Candidate review" }),
  ).toContainText(join(REPOSITORY, "agent-forge.toml"));
  await expect(
    dialog.getByRole("region", { name: "Candidate review" }),
  ).toContainText(createdName);
  const candidateReview = dialog.getByRole("region", {
    name: "Candidate review",
  });
  const proofDirectory = process.env["AGENT_FORGE_WORKTREE_SCREENSHOT_DIR"];
  if (proofDirectory)
    await page.screenshot({
      path: join(proofDirectory, "smith-create-candidate.png"),
      mask: [
        candidateReview.locator("dd").filter({ hasText: REPOSITORY }),
        candidateReview.locator("dd").filter({ hasText: HEARTH_HOME }),
      ],
      maskColor: "#3f424d",
    });
  expect(posts).toEqual(["/__agent-forge/config/smiths/preview"]);
  unchangedConfig();

  const createResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname ===
        "/__agent-forge/config/smiths/creates",
  );
  await dialog.getByRole("button", { name: "Create Smith" }).click();
  expect((await createResponse).status()).toBe(200);
  await expect(
    page.getByRole("region", { name: "Original Smith create receipts" }),
  ).toContainText(createdName);
  const written = readFileSync(join(REPOSITORY, "agent-forge.toml"), "utf8");
  expect(written).toContain(`[smiths.${createdName}]`);
  expect(written).toContain('model = "browser-fixture-model"');
  expect(
    existsSync(
      join(OS_HOME, ".agent-forge-config-transactions", "write.lock.db"),
    ),
  ).toBe(true);
  expect(posts).toEqual([
    "/__agent-forge/config/smiths/preview",
    "/__agent-forge/config/smiths/creates",
  ]);

  const originalRead = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname.startsWith(
        "/__agent-forge/smiths/creates/",
      ),
  );
  await reloadSettled(page);
  expect((await originalRead).status()).toBe(200);
  await expect(
    page.getByRole("region", { name: "Original Smith create receipts" }),
  ).toContainText(createdName);
  expect(posts).toEqual([
    "/__agent-forge/config/smiths/preview",
    "/__agent-forge/config/smiths/creates",
  ]);
  expect(providerStarts()).toEqual(starts);
});

test("a source-proven NotSent retires across reload, while a lost response stays held on 404", async ({
  page,
}) => {
  const starts = providerStarts(),
    posts: string[] = [],
    originalReads: number[] = [],
    notSentName = `browser-not-sent-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path.startsWith("/__agent-forge/"))
      posts.push(path);
  });
  page.on("response", (response) => {
    if (
      response.request().method() === "GET" &&
      new URL(response.url()).pathname.startsWith(
        "/__agent-forge/smiths/creates/",
      )
    )
      originalReads.push(response.status());
  });
  checkedOsHome();
  if (!isRunHome(HEARTH_HOME) || !checkedFixtureRoot())
    throw Error("Smith identity recovery requires the owned temporary homes.");

  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSettled(page, "/index.html#/desktop/smiths");
  await page.getByRole("button", { name: "New smith", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create a Smith" });
  await dialog.getByLabel("Smith name").fill(notSentName);
  await dialog.getByLabel("Provider").fill("codex");
  await dialog.getByLabel("Model").fill("browser-not-sent-model");
  await dialog.getByLabel("Effort").fill("high");
  await dialog.getByRole("button", { name: "Review candidate" }).click();
  await expect(
    dialog.getByRole("region", { name: "Candidate review" }),
  ).toBeVisible();

  await page.route("**/config/smiths/creates", (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        data: null,
        error: "Operator access refused before any effect.",
      }),
    }),
  );
  const refused = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname ===
        "/__agent-forge/config/smiths/creates",
  );
  await dialog.getByRole("button", { name: "Create Smith" }).click();
  expect((await refused).status()).toBe(403);
  await expect(
    page.getByRole("region", { name: "Original Smith create receipts" }),
  ).toContainText("Not sent");
  expect(
    readFileSync(join(REPOSITORY, "agent-forge.toml"), "utf8"),
  ).not.toContain(`[smiths.${notSentName}]`);
  await page.unroute("**/config/smiths/creates");

  await reloadSettled(page);
  await expect(
    page.getByRole("region", { name: "Original Smith create receipts" }),
  ).toContainText("Not sent");
  expect(originalReads).toEqual([]);
  await page.getByRole("button", { name: "New smith", exact: true }).click();
  const afterReloadDialog = page.getByRole("dialog", {
    name: "Create a Smith",
  });
  const afterReload = `browser-after-not-sent-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await afterReloadDialog
    .getByRole("textbox", { name: "Smith name", exact: true })
    .fill(afterReload);
  await afterReloadDialog
    .getByRole("textbox", { name: "Provider", exact: true })
    .fill("codex");
  await afterReloadDialog
    .getByRole("textbox", { name: "Model", exact: true })
    .fill("browser-after-not-sent-model");
  await afterReloadDialog
    .getByRole("textbox", { name: "Effort", exact: true })
    .fill("high");
  await afterReloadDialog
    .getByRole("button", { name: "Review candidate", exact: true })
    .click();
  await expect(
    afterReloadDialog.getByRole("region", { name: "Candidate review" }),
  ).toContainText(afterReload);
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname ===
        "/__agent-forge/config/smiths/creates",
  );
  await afterReloadDialog
    .getByRole("button", { name: "Create Smith", exact: true })
    .click();
  expect((await created).status()).toBe(200);
  expect(readFileSync(join(REPOSITORY, "agent-forge.toml"), "utf8")).toContain(
    `[smiths.${afterReload}]`,
  );
  expect(providerStarts()).toEqual(starts);
});

test("a correlated stale-revision refusal reads back its exact original after reload", async ({
  page,
}) => {
  const starts = providerStarts(),
    posts: string[] = [],
    originalReads: number[] = [],
    name = `browser-refused-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path.startsWith("/__agent-forge/"))
      posts.push(path);
  });
  page.on("response", (response) => {
    if (
      response.request().method() === "GET" &&
      new URL(response.url()).pathname.startsWith(
        "/__agent-forge/smiths/creates/",
      )
    )
      originalReads.push(response.status());
  });
  checkedOsHome();
  if (!isRunHome(HEARTH_HOME) || !checkedFixtureRoot())
    throw Error("Smith refusal recovery requires the owned temporary homes.");

  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSettled(page, "/index.html#/desktop/smiths");
  await page.getByRole("button", { name: "New smith", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create a Smith" });
  await dialog.getByLabel("Smith name").fill(name);
  await dialog.getByLabel("Provider").fill("codex");
  await dialog.getByLabel("Model").fill("browser-stale-revision-model");
  await dialog.getByLabel("Effort").fill("high");
  await dialog.getByRole("button", { name: "Review candidate" }).click();
  await expect(
    dialog.getByRole("region", { name: "Candidate review" }),
  ).toBeVisible();

  writeFileSync(
    join(REPOSITORY, "agent-forge.toml"),
    `${readFileSync(join(REPOSITORY, "agent-forge.toml"), "utf8")}\n# stale paired revision fixture\n`,
  );
  const refused = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname ===
        "/__agent-forge/config/smiths/creates",
  );
  await dialog.getByRole("button", { name: "Create Smith" }).click();
  expect((await refused).status()).toBe(409);
  await expect(
    page.getByRole("region", { name: "Original Smith create receipts" }),
  ).toContainText("Refused before publication");
  expect(
    readFileSync(join(REPOSITORY, "agent-forge.toml"), "utf8"),
  ).not.toContain(`[smiths.${name}]`);

  const originalRead = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname.startsWith(
        "/__agent-forge/smiths/creates/",
      ),
  );
  await reloadSettled(page);
  const recovered = await originalRead;
  expect(recovered.status()).toBe(200);
  const receipt = (await recovered.json()) as {
    data: {
      inputHash: string;
      original: { smith: { name: string; model: string } };
      result: { phase: string; reason?: string };
    };
  };
  expect(receipt.data.original.smith).toEqual({
    name,
    provider: "codex",
    model: "browser-stale-revision-model",
    effort: "high",
    enabled: true,
    tags: [],
  });
  expect(receipt.data.result).toMatchObject({
    phase: "refused",
    reason: "stale-revision",
  });
  expect(receipt.data.inputHash).toMatch(/^[a-f0-9]{64}$/);
  await expect(
    page.getByRole("region", { name: "Original Smith create receipts" }),
  ).toContainText(name);
  await expect(
    page.getByRole("region", { name: "Original Smith create receipts" }),
  ).toContainText("stale-revision");
  expect(originalReads).toEqual([200]);
  expect(posts).toEqual([
    "/__agent-forge/config/smiths/preview",
    "/__agent-forge/config/smiths/creates",
  ]);
  expect(providerStarts()).toEqual(starts);
});

test("an unavailable create response remains held when the protected original returns 404", async ({
  page,
}) => {
  const posts: string[] = [],
    originalReads: number[] = [],
    name = `browser-uncertain-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path.startsWith("/__agent-forge/"))
      posts.push(path);
  });
  page.on("response", (response) => {
    if (
      response.request().method() === "GET" &&
      new URL(response.url()).pathname.startsWith(
        "/__agent-forge/smiths/creates/",
      )
    )
      originalReads.push(response.status());
  });
  checkedOsHome();
  if (!isRunHome(HEARTH_HOME) || !checkedFixtureRoot())
    throw Error("Smith identity recovery requires the owned temporary homes.");

  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSettled(page, "/index.html#/desktop/smiths");
  await page.getByRole("button", { name: "New smith", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create a Smith" });
  await dialog.getByLabel("Smith name").fill(name);
  await dialog.getByLabel("Provider").fill("codex");
  await dialog.getByLabel("Model").fill("browser-lost-reply-model");
  await dialog.getByLabel("Effort").fill("high");
  await dialog.getByRole("button", { name: "Review candidate" }).click();
  await expect(
    dialog.getByRole("region", { name: "Candidate review" }),
  ).toBeVisible();
  await page.route("**/config/smiths/creates", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, data: null, error: "unavailable" }),
    }),
  );
  const unavailable = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname ===
        "/__agent-forge/config/smiths/creates",
  );
  await dialog.getByRole("button", { name: "Create Smith" }).click();
  expect((await unavailable).status()).toBe(503);
  await expect(
    page.getByRole("region", { name: "Original Smith create receipts" }),
  ).toContainText("Outcome held");
  await page.unroute("**/config/smiths/creates");

  const missingOriginal = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname.startsWith(
        "/__agent-forge/smiths/creates/",
      ),
  );
  await reloadSettled(page);
  expect((await missingOriginal).status()).toBe(404);
  await expect(
    page.getByRole("region", { name: "Original Smith create receipts" }),
  ).toContainText("Outcome held");
  await page.getByRole("button", { name: "New smith", exact: true }).click();
  const recovered = page.getByRole("dialog", { name: "Create a Smith" });
  await expect(
    recovered.getByRole("button", { name: "Review candidate" }),
  ).toBeDisabled();
  await expect(
    recovered.getByRole("button", { name: "Create Smith" }),
  ).toBeDisabled();
  expect(originalReads).toEqual([404]);
  expect(posts).toEqual([
    "/__agent-forge/config/smiths/preview",
    "/__agent-forge/config/smiths/creates",
  ]);
  expect(
    readFileSync(join(REPOSITORY, "agent-forge.toml"), "utf8"),
  ).not.toContain(`[smiths.${name}]`);
});

test("a reply lost after actual temporary publication recovers the exact original without a second write", async ({
  page,
}) => {
  const starts = providerStarts(),
    posts: string[] = [],
    name = `browser-lost-after-write-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let original: Record<string, unknown> | null = null,
    savedServerStatus: number | null = null;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path.startsWith("/__agent-forge/")) {
      posts.push(path);
      if (path === "/__agent-forge/config/smiths/creates")
        original = request.postDataJSON() as Record<string, unknown>;
    }
  });
  checkedOsHome();
  if (!isRunHome(HEARTH_HOME) || !checkedFixtureRoot())
    throw Error("Smith recovery requires the owned temporary homes.");

  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSettled(page, "/index.html#/desktop/smiths");
  await page.getByRole("button", { name: "New smith", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create a Smith" });
  await dialog.getByLabel("Smith name").fill(name);
  await dialog.getByLabel("Provider").fill("codex");
  await dialog.getByLabel("Model").fill("browser-lost-after-write-model");
  await dialog.getByLabel("Effort").fill("high");
  await dialog.getByLabel("Tags").fill("real-write\nrecover-original");
  await dialog.getByRole("button", { name: "Review candidate" }).click();
  await expect(
    dialog.getByRole("region", { name: "Candidate review" }),
  ).toContainText(join(REPOSITORY, "agent-forge.toml"));

  await page.route("**/config/smiths/creates", async (route) => {
    const response = await route.fetch({
      headers: {
        ...route.request().headers(),
        Origin: new URL(route.request().url()).origin,
      },
    });
    savedServerStatus = response.status();
    expect(savedServerStatus).toBe(200);
    await route.abort();
  });
  const failedReply = page.waitForEvent("requestfailed", (request) =>
    new URL(request.url()).pathname.endsWith("/config/smiths/creates"),
  );
  await dialog.getByRole("button", { name: "Create Smith" }).click();
  await failedReply;
  expect(savedServerStatus).toBe(200);
  await expect(
    page.getByRole("region", { name: "Original Smith create receipts" }),
  ).toContainText("Outcome held");
  expect(original).not.toBeNull();
  const posted = original!;
  expect(posted).toMatchObject({
    target: "workspace",
    smith: { name, provider: "codex", model: "browser-lost-after-write-model" },
  });
  const written = readFileSync(join(REPOSITORY, "agent-forge.toml"), "utf8");
  expect(written).toContain(`[smiths.${name}]`);
  expect([
    ...written.matchAll(new RegExp(`\\[smiths\\.${name}\\]`, "g")),
  ]).toHaveLength(1);
  expect(posts).toEqual([
    "/__agent-forge/config/smiths/preview",
    "/__agent-forge/config/smiths/creates",
  ]);
  await page.unroute("**/config/smiths/creates");

  const originalRead = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname ===
        `/__agent-forge/smiths/creates/${String(posted["requestId"])}`,
  );
  await reloadSettled(page);
  const recoveredResponse = await originalRead;
  expect(recoveredResponse.status()).toBe(200);
  const receipt = (await recoveredResponse.json()) as {
    data: { inputHash: string; original: Record<string, unknown> };
  };
  expect(receipt.data.original).toEqual(posted);
  expect(receipt.data.inputHash).toBe(
    createHash("sha256")
      .update(canonicalSmithConfigCreateRequest(posted))
      .digest("hex"),
  );
  await expect(
    page.getByRole("region", { name: "Original Smith create receipts" }),
  ).toContainText("Confirmed");
  await expect(
    page.getByRole("region", { name: "Original Smith create receipts" }),
  ).toContainText(name);
  expect(readFileSync(join(REPOSITORY, "agent-forge.toml"), "utf8")).toBe(
    written,
  );
  expect(posts).toEqual([
    "/__agent-forge/config/smiths/preview",
    "/__agent-forge/config/smiths/creates",
  ]);
  expect(providerStarts()).toEqual(starts);
});

test("Smiths opens its actual fixed global verification task with keyboard focus and retry, without project membership or writes", async ({
  page,
}) => {
  const seeded = seedVerification(),
    starts = providerStarts(),
    posts: string[] = [],
    reads: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/__agent-forge/")) {
      if (request.method() === "POST") posts.push(request.url());
      if (
        new URL(request.url()).pathname === "/__agent-forge/smiths/verification"
      )
        reads.push(request.url());
    }
  });
  try {
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openSettled(page, "/index.html#/desktop/smiths");
    const opener = page.getByRole("button", {
      name: "Open verification task",
      exact: true,
    });
    await expect(opener).toBeEnabled();
    expect(reads).toEqual([]);
    await opener.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(opener).toBeFocused();
    await expect(opener).toHaveCSS("outline-width", "2px");
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", {
      name: "Apprentice verification task",
      exact: true,
    });
    await expect(dialog).toContainText(seeded.task.title);
    await expect(dialog).toContainText("P0");
    await expect(dialog).toContainText(
      "Visible task <script>stays inert</script>",
    );
    await expect(dialog).toContainText(seeded.task.acceptance_criteria!);
    await expect(
      dialog.locator("script, img, a, input, textarea, select"),
    ).toHaveCount(0);
    await expect(dialog).toContainText(
      "Task status does not certify live model or effort support.",
    );
    await expect(
      dialog.getByRole("button", { name: "Close dialog", exact: true }),
    ).toBeFocused();
    await page.screenshot({
      path: screenshotPath("smiths-verification.png"),
      mask: [
        dialog.locator(".af-smith-verification-facts code"),
        dialog.locator("time"),
      ],
      maskColor: "#3f424d",
    });
    await page.keyboard.press("Escape");
    await expect(opener).toBeFocused();
    await reloadSettled(page);
    await expect(dialog).not.toBeVisible();
    let failed = false;
    await page.route("**/__agent-forge/smiths/verification", async (route) => {
      if (!failed) {
        failed = true;
        await route.fulfill({
          status: 503,
          json: {
            ok: false,
            data: null,
            error: "The verification record is temporarily unavailable.",
          },
        });
      } else await route.continue();
    });
    await opener.click();
    await expect(dialog.getByRole("alert")).toContainText(
      "temporarily unavailable",
    );
    await expect(dialog).not.toContainText(seeded.task.title);
    await dialog
      .getByRole("button", { name: "Retry verification read", exact: true })
      .click();
    await expect(dialog).toContainText(seeded.task.title);
    expect(readState(BD_STAND_IN_STATE)[APPRENTICE_VERIFICATION]).toEqual(
      seeded.task,
    );
    const calls = readFileSync(join(BD_STAND_IN_STATE, "calls.jsonl"), "utf8");
    expect(calls).toContain(
      JSON.stringify(["--readonly", "show", APPRENTICE_VERIFICATION, "--json"]),
    );
    unchangedConfig();
    expect(providerStarts()).toEqual(starts);
    expect(posts).toEqual([]);
  } finally {
    seeded.restore();
  }
});

test("closing and navigating away from a held actual verification read fences its late private body", async ({
  page,
}) => {
  const seeded = seedVerification("Old held verification record");
  let release: (() => void) | undefined, arrived: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  let first = true;
  await page.route("**/__agent-forge/smiths/verification", async (route) => {
    if (!first) {
      await route.continue();
      return;
    }
    first = false;
    const response = await route.fetch({
      headers: {
        ...route.request().headers(),
        Origin: new URL(route.request().url()).origin,
      },
    });
    expect(response.status()).toBe(200);
    arrived?.();
    await held;
    await route.fulfill({ response });
  });
  try {
    await openSettled(page, "/index.html#/desktop/smiths");
    const opener = page.getByRole("button", {
      name: "Open verification task",
      exact: true,
    });
    await opener.click();
    await started;
    const dialog = page.getByRole("dialog", {
      name: "Apprentice verification task",
      exact: true,
    });
    await expect(dialog.getByRole("status")).toContainText(
      "Reading the verification task",
    );
    await expect(
      dialog.getByRole("button", {
        name: "Refresh verification task",
        exact: true,
      }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(opener).toBeFocused();
    await page.getByRole("link", { name: "Projects", exact: true }).click();
    release?.();
    await expect(page.locator("main")).not.toContainText(seeded.task.title);
    await page.getByRole("link", { name: "Smiths", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await opener.click();
    await expect(dialog).toContainText(seeded.task.title);
    unchangedConfig();
  } finally {
    release?.();
    seeded.restore();
  }
});

test("failed configuration and scoreboard refreshes independently retain actual verified reads and Retry recovers", async ({
  page,
}) => {
  seedRecordedWork();
  const starts = providerStarts();
  await openSettled(page, "/index.html#/desktop/smiths");
  const config = page.getByRole("region", {
    name: "Saved smith configuration",
  });
  const board = page.getByRole("region", {
    name: "Recorded workspace scoreboard",
  });
  await page
    .getByRole("searchbox", { name: "Filter smiths and scoreboard" })
    .fill(fixtureSmith);
  await expect(board.getByRole("table")).toContainText("recorded-current");
  await page.route("**/__agent-forge/scoreboard*", (route) =>
    route.fulfill({
      status: 503,
      json: {
        ok: false,
        data: null,
        error: "Fixture scoreboard temporarily unavailable",
      },
    }),
  );
  await board
    .getByRole("button", { name: "Refresh scoreboard", exact: true })
    .click();
  await expect(board.getByRole("alert")).toContainText(
    "Last-verified results remain visible",
  );
  await expect(board.getByRole("table")).toContainText("recorded-current");
  await expect(config.getByRole("alert")).toHaveCount(0);
  await page.route("**/__agent-forge/config", (route) =>
    route.fulfill({
      status: 503,
      json: {
        ok: false,
        data: null,
        error: "Fixture configuration temporarily unavailable",
      },
    }),
  );
  await config
    .getByRole("button", { name: "Refresh configuration", exact: true })
    .click();
  await expect(config.getByRole("alert")).toContainText(
    "Last-verified values remain visible",
  );
  await expect(config.getByRole("table")).toContainText("saved-machine-model");
  await page.unroute("**/__agent-forge/scoreboard*");
  await board
    .getByRole("button", { name: "Refresh scoreboard", exact: true })
    .click();
  await expect(board.getByRole("alert")).toHaveCount(0);
  await expect(config.getByRole("alert")).toBeVisible();
  await page.unroute("**/__agent-forge/config");
  await config
    .getByRole("button", { name: "Refresh configuration", exact: true })
    .click();
  await expect(config.getByRole("alert")).toHaveCount(0);
  unchangedConfig();
  expect(providerStarts()).toEqual(starts);
});

test("a held initial configuration can fail while a genuine scoreboard succeeds, and malformed answers never become saved values", async ({
  page,
}) => {
  seedRecordedWork();
  const starts = providerStarts(),
    posts: string[] = [];
  let configurationReads = 0;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/__agent-forge/config")
      configurationReads++;
    if (request.method() === "POST" && path.startsWith("/__agent-forge/"))
      posts.push(path);
  });
  let release: (() => void) | undefined,
    releaseResync: (() => void) | undefined,
    resyncEntered: (() => void) | undefined,
    genuine = false;
  const waiting = new Promise<void>((resolve) => {
      release = resolve;
    }),
    heldResync = new Promise<void>((resolve) => {
      releaseResync = resolve;
    }),
    readingResync = new Promise<void>((resolve) => {
      resyncEntered = resolve;
    });
  await page.route("**/__agent-forge/config", async (route) => {
    const answerGenuinely = genuine;
    await waiting;
    if (answerGenuinely) {
      const actual = await route.fetch({
        headers: {
          ...(await route.request().allHeaders()),
          origin: new URL(route.request().url()).origin,
        },
      });
      expect(actual.status()).toBe(200);
      resyncEntered?.();
      await heldResync;
      await route.fulfill({ response: actual });
      return;
    }
    await route.fulfill({
      status: 200,
      json: { ok: true, data: { malformed: true }, error: null },
    });
  });
  const navigation = openSettled(page, "/index.html#/desktop/smiths");
  void navigation.catch(() => {});
  try {
    const config = page.getByRole("region", {
      name: "Saved smith configuration",
    });
    const board = page.getByRole("region", {
      name: "Recorded workspace scoreboard",
    });
    await expect(
      config.getByText("Reading saved smiths…", { exact: true }),
    ).toBeVisible();
    await expect(board.getByRole("table")).toContainText("recorded-current");
    release?.();
    await navigation;
    await expect(
      config.getByText("Saved smiths unavailable", { exact: true }),
    ).toBeVisible();
    await expect(config.getByRole("table")).toHaveCount(0);
    // Retry is covered while data is still absent. An older error alone does not
    // prove this read is settled: resyncs retain that error while loading.
    await expect(config).toHaveAttribute("aria-busy", "false");
    const retryBefore = configurationReads;
    const retryRead = page.waitForRequest(
      (request) =>
        request.method() === "GET" &&
        new URL(request.url()).pathname === "/__agent-forge/config",
    );
    await config
      .getByRole("button", { name: "Retry configuration", exact: true })
      .click();
    await retryRead;
    await expect(config).toHaveAttribute("aria-busy", "false");
    expect(configurationReads).toBe(retryBefore + 1);
    await expect(config.getByRole("table")).toHaveCount(0);
    const temporary = await config
      .getByRole("button", { name: "Retry configuration", exact: true })
      .elementHandle();
    if (!temporary)
      throw Error("The unavailable configuration lost its Retry control.");

    // A real scoped ledger event starts an independent protected read. Its
    // successful result legitimately replaces the temporary Retry branch.
    genuine = true;
    seedObservationEvents([
      {
        kind: "session.ended",
        workspace: fixturePlan()
          .root.replaceAll("\\", "/")
          .replace(
            /^([A-Z]):/,
            (_, drive: string) => `${drive.toLowerCase()}:`,
          ),
        sessionId: `${fixtureSmith}-resync`,
        executor: {
          provider: "claude",
          model: "recorded-resync",
          smith: fixtureSmith,
        },
        payload: { reason: "completed" },
      },
    ]);
    await readingResync;
    await expect(config).toHaveAttribute("aria-busy", "true");
    await expect(config.getByRole("alert")).toContainText(
      "No saved values are available",
    );
    await expect(config.getByRole("table")).toHaveCount(0);
    await expect(
      config.getByRole("button", { name: "Retry configuration", exact: true }),
    ).toHaveAttribute("aria-disabled", "true");
    releaseResync?.();
    await expect(config).toHaveAttribute("aria-busy", "false");
    await expect(config.getByRole("table")).toContainText(
      "saved-machine-model",
    );
    await expect(
      config.getByRole("button", { name: "Retry configuration", exact: true }),
    ).toHaveCount(0);
    expect(await temporary.evaluate((element) => element.isConnected)).toBe(
      false,
    );
    await page.unroute("**/__agent-forge/config");

    // The stable header control must cause its own new GET; a background success
    // is never accepted as evidence that this explicit gesture happened.
    const explicitBefore = configurationReads;
    const explicitRead = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === "/__agent-forge/config",
    );
    await config
      .getByRole("button", { name: "Refresh configuration", exact: true })
      .click();
    expect((await explicitRead).status()).toBe(200);
    await expect(config).toHaveAttribute("aria-busy", "false");
    expect(configurationReads).toBe(explicitBefore + 1);
    await expect(config.getByRole("table")).toContainText(
      "saved-machine-model",
    );
    // Explicit empty response fixture covers the empty renderer state independently of other specs' records.
    await page.route("**/__agent-forge/scoreboard*", (route) =>
      route.fulfill({
        status: 200,
        json: {
          ok: true,
          data: { rows: [], events: 0, from: null, to: null },
          error: null,
        },
      }),
    );
    await board
      .getByRole("button", { name: "Refresh scoreboard", exact: true })
      .click();
    await expect(
      board.getByText("No recorded work in this range", { exact: true }),
    ).toBeVisible();
    unchangedConfig();
    expect(providerStarts()).toEqual(starts);
    expect(posts).toEqual([]);
  } finally {
    release?.();
    releaseResync?.();
    await navigation.catch(() => {});
  }
});
