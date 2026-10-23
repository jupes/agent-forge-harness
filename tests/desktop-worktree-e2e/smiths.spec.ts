import { randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { LedgerEventInput } from "../../types/hearth";
import { seedObservationEvents } from "../desktop-e2e/observed-session-fixtures";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import { HEARTH_HOME, isRunHome } from "../e2e/servers";
import { checkedFixtureRoot, fixturePlan, REPOSITORY } from "./environment";

let fixtureSmith = "";
let savedFiles: { file: string; before: Buffer | null; fixture: Buffer }[] = [];
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
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Open verification task", exact: true }),
  ).toBeDisabled();
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
    path: "apps/desktop/docs/screenshots/smiths-inspection.png",
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
  await board
    .getByRole("heading", { name: "Recorded scoreboard", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "apps/desktop/docs/screenshots/smiths-scoreboard.png",
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
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/__agent-forge/config", async (route) => {
    await waiting;
    await route.fulfill({
      status: 200,
      json: { ok: true, data: { malformed: true }, error: null },
    });
  });
  await page.goto("/index.html#/desktop/smiths", {
    waitUntil: "domcontentloaded",
  });
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
  await expect(
    config.getByText("Saved smiths unavailable", { exact: true }),
  ).toBeVisible();
  await expect(config.getByRole("table")).toHaveCount(0);
  await page.unroute("**/__agent-forge/config");
  await config
    .getByRole("button", { name: "Retry configuration", exact: true })
    .click();
  await expect(config.getByRole("table")).toContainText("saved-machine-model");
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
});
