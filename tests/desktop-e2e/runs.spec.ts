import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { runsHref } from "../../apps/desktop/src/project-runs-model";
import type { ForgeState } from "../../scripts/forge/phases";
import { OPERATOR_HEADER } from "../../scripts/hearth/paths";
import {
  projectRunDetailSchema,
  projectRunsPageSchema,
} from "../../scripts/projects/run-protocol";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import { pageToken } from "../e2e/launch-link";
import { HEARTH_HOME } from "../e2e/servers";
import { alpha, beta, seedProjects } from "./project-fixtures";

const owned = new Map<string, string>();
const posts: string[] = [];
const releases: Array<() => void> = [];
let beforeDispatches: number[] = [];
let streams = 0;
let fixture: ReturnType<typeof seedRuns>;
function dispatches() {
  return (
    [
      ["codex-fixture-calls.jsonl", "task"],
      ["gemini-fixture-calls.jsonl", "task"],
      ["codex-chat-fixture-calls.jsonl", "process"],
      ["gemini-chat-fixture-calls.json", "start"],
      ["keeper-fixture-starts.jsonl", "started"],
    ] as const
  ).map(([name, kind]) => {
    const path = join(HEARTH_HOME, name);
    if (!existsSync(path)) return 0;
    const text = readFileSync(path, "utf8");
    let values: unknown;
    try {
      values = name?.endsWith(".json")
        ? JSON.parse(text)
        : text
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line));
    } catch {
      throw Error("Invalid inert provider dispatch recording");
    }
    if (!Array.isArray(values))
      throw Error("Incomplete inert provider dispatch recording");
    return values.filter(
      (entry: unknown) =>
        entry &&
        typeof entry === "object" &&
        (kind === "started"
          ? "started" in entry && entry.started === true
          : "kind" in entry && entry.kind === kind),
    ).length;
  });
}
function publish(path: string, data: unknown) {
  const bytes = JSON.stringify(data);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes, { flag: "wx" });
  owned.set(path, bytes);
}
function remove(path: string) {
  const expected = owned.get(path);
  if (expected === undefined)
    throw Error("This is not an owned run fixture path");
  if (existsSync(path)) {
    expect(readFileSync(path, "utf8")).toBe(expected);
    unlinkSync(path);
  }
  owned.delete(path);
  expect(existsSync(path)).toBe(false);
}
function seedRuns() {
  const prefix = `e2e-inspect-${process.pid}-${randomUUID().slice(0, 8)}`;
  const checkout = realpathSync.native(process.cwd());
  const path = (slug: string) =>
    join(checkout, ".tmp", "work", "forge-runs", `${slug}.json`);
  const primary = `${prefix}-main`,
    shipped = `${prefix}-shipped`,
    legacy = `${prefix}-legacy`,
    foreign = `${prefix}-beta`;
  const base: ForgeState = {
    schemaVersion: 2,
    slug: primary,
    feature: "Scoped forge delivery",
    epic: "alpha-epic",
    phase: "plan",
    completed: ["research", "plan"],
    artifacts: {},
    mode: "gated",
    checkout,
    updatedAt: "2026-10-23T13:00:00.000Z",
    reviews: [
      {
        phase: "plan",
        round: 1,
        verdict: "FAIL",
        findings: { blocker: 0, high: 1, medium: 2, low: 0 },
        summary: "Recorded review <script>must remain text</script>",
        at: "2026-10-23T12:15:00.000Z",
      },
    ],
  };
  publish(path(primary), base);
  publish(path(shipped), {
    ...base,
    slug: shipped,
    feature: "Shipped forge delivery",
    phase: "ship",
    completed: ["research", "plan", "implement", "ship"],
    reviews: [],
  });
  publish(path(legacy), {
    ...base,
    slug: legacy,
    feature: "Historical unattended run",
    mode: "auto",
    reviews: [],
  });
  publish(path(foreign), {
    ...base,
    slug: foreign,
    feature: "FOREIGN BETA RUN",
    epic: "beta-epic",
    reviews: [],
  });
  const gate = {
    schemaVersion: 2,
    event: "TaskCompleted",
    timestamp: "2026-10-23T13:00:00.000Z",
    checkout,
    branch: "fixture/run-inspection",
    beadsIssueId: "alpha-epic",
    executionRunId: primary,
    passed: false,
    checks: [
      { name: "typecheck", passed: true },
      {
        name: "lint",
        passed: false,
        output: "Recorded lint failure\nPRIVATE GATE OUTPUT",
      },
      {
        name: "tests",
        passed: true,
        skipped: true,
        skipReason: "Not requested",
      },
    ],
  };
  const logs = [
    {
      event: "TaskCompleted",
      timestamp: "2026-10-23T12:00:00.000Z",
      checkout,
      forgeSlug: primary,
      passed: true,
      checks: [],
    },
    gate,
    {
      ...gate,
      timestamp: "2026-10-23T14:00:00.000Z",
      beadsIssueId: "beta-epic",
      passed: true,
    },
    {
      ...gate,
      timestamp: "2026-10-23T14:01:00.000Z",
      checkout: join(checkout, "foreign"),
      passed: true,
    },
    {
      ...gate,
      timestamp: "2026-10-23T14:02:00.000Z",
      executionRunId: null,
      beadsIssueId: null,
      passed: true,
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  const logPath = join(
    HEARTH_HOME,
    "run-gate-logs",
    "2026-10-23",
    "quality-gate.jsonl",
  );
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, logs, { flag: "wx" });
  owned.set(logPath, logs);
  return { primary, shipped, legacy, foreign, path };
}
function held() {
  let release!: () => void;
  const wait = {
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
    release: () => release(),
  };
  releases.push(wait.release);
  return wait;
}
async function protectedRead(page: Page, path: string) {
  const token = await pageToken(page);
  return page.evaluate(
    async ({ path, token, header }) => {
      const response = await fetch(`/__agent-forge${path}`, {
        headers: { [header]: token },
      });
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw Error("Incomplete protected read fixture");
      }
      return { status: response.status, body };
    },
    { path, token, header: OPERATOR_HEADER },
  );
}
const href = (project = alpha.id, slug: string | null = null) =>
  `/index.html${runsHref(project, slug)}`;

test.beforeEach(({ page }) => {
  seedProjects();
  fixture = seedRuns();
  posts.length = 0;
  streams = 0;
  beforeDispatches = dispatches();
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/__agent-forge/stream") streams++;
    if (
      request.method() === "POST" &&
      request.url().includes("/__agent-forge/")
    )
      posts.push(request.url());
  });
});
test.afterEach(async ({ page }) => {
  for (const release of releases.splice(0)) release();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  for (const path of [...owned.keys()]) remove(path);
  expect(posts).toEqual([]);
  expect(dispatches()).toEqual(beforeDispatches);
});

test("scoped Runs keyboard inspection preserves real phase, review and gate truth through Activity, Back and reload without writes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSettled(page, href());
  const runs = page.getByRole("region", { name: "Project forge runs" });
  await expect(
    runs.getByRole("table", { name: "Recorded forge runs" }),
  ).toBeVisible();
  await expect(runs.getByText("FOREIGN BETA RUN", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    runs.getByRole("button", { name: "New forge run" }),
  ).toBeDisabled();
  const link = runs.getByRole("link", {
    name: "Scoped forge delivery",
    exact: true,
  });
  await link.focus();
  await expect(link).toHaveCSS("outline-width", "2px");
  await page.keyboard.press("Enter");
  const detail = page.getByRole("article", { name: "Selected forge run" });
  await expect(
    detail.getByRole("heading", { name: "Scoped forge delivery", exact: true }),
  ).toBeVisible();
  for (const [phase, state] of [
    ["research", "complete"],
    ["plan", "complete"],
    ["implement", "active"],
    ["ship", "locked"],
  ] as const)
    await expect(detail.locator(`[data-phase="${phase}"]`)).toHaveAttribute(
      "data-state",
      state,
    );
  await expect(detail.getByText("Gate failed", { exact: true })).toBeVisible();
  const checks = detail.getByRole("table", { name: "Gate checks" }).first();
  await expect(
    checks.getByRole("row", { name: "typecheck Pass No detail reported." }),
  ).toBeVisible();
  await expect(
    checks.getByRole("row", { name: "lint Fail Recorded lint failure" }),
  ).toBeVisible();
  await expect(
    checks.getByRole("row", { name: "tests Skipped Not requested" }),
  ).toBeVisible();
  await expect(
    checks.getByRole("row", {
      name: "clean-tree Not run No matching check was recorded.",
    }),
  ).toBeVisible();
  await expect(
    detail.getByText("Full or Mini is not recorded.", { exact: true }),
  ).toBeVisible();
  await expect(
    detail.getByText("Start time is not recorded.", { exact: true }),
  ).toBeVisible();
  await expect(
    detail.getByText("Recorded review <script>must remain text</script>", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(detail.locator("script")).toHaveCount(0);
  await expect(
    page.getByText("PRIVATE GATE OUTPUT", { exact: false }),
  ).toHaveCount(0);
  const earlier = detail.locator("summary");
  await earlier.focus();
  await page.keyboard.press("Enter");
  await expect(earlier).toHaveCSS("outline-width", "2px");
  expect(streams).toBe(1);
  await expect(
    detail.getByRole("table", { name: "Gate checks" }).nth(1),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "apps/desktop/docs/screenshots/runs-inspection.png",
    fullPage: true,
    mask: [
      page.locator(".af-runs-source code"),
      page.locator(".af-run-artifact code"),
    ],
    maskColor: "#3f424d",
    style: ".af-project-runs time { visibility: hidden !important; }",
  });
  await detail.getByRole("link", { name: "Open run Activity" }).click();
  await expect(page.getByLabel("Run filter", { exact: true })).toHaveValue(
    fixture.primary,
  );
  await page.goBack();
  await expect(
    detail.getByRole("heading", { name: "Scoped forge delivery", exact: true }),
  ).toBeVisible();
  await reloadSettled(page);
  await expect(
    detail.getByRole("heading", { name: "Scoped forge delivery", exact: true }),
  ).toBeVisible();
  const answer = await protectedRead(
    page,
    `/projects/${alpha.id}/runs/${fixture.primary}`,
  );
  expect(answer.status).toBe(200);
  const envelope = answer.body;
  if (
    !envelope ||
    typeof envelope !== "object" ||
    !("ok" in envelope) ||
    envelope.ok !== true ||
    !("data" in envelope)
  )
    throw Error("Protected run was not verified");
  const actual = projectRunDetailSchema.parse(envelope.data);
  expect(actual.run.gatePassed).toBe(false);
  expect(actual.gateHistory.map((gate) => gate.link)).toEqual([
    "linked",
    "legacy",
  ]);
});

test("Runs filters and verified empty/loading/error states never claim unavailable sources are empty", async ({
  page,
}) => {
  const entered = held(),
    release = held();
  let fail = false;
  await page.route(
    `**/__agent-forge/projects/${alpha.id}/runs`,
    async (route) => {
      if (fail) {
        await route.fulfill({
          status: 503,
          json: {
            ok: false,
            data: null,
            error: "Fixture current membership unavailable",
          },
        });
        return;
      }
      const response = await route.fetch();
      entered.release();
      await release.promise;
      await route.fulfill({ response });
    },
  );
  const opening = page.goto(href());
  await entered.promise;
  await expect(
    page.getByText("Loading project runs…", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("No forge runs in this served checkout", { exact: true }),
  ).toHaveCount(0);
  release.release();
  await opening;
  const table = page.getByRole("table", { name: "Recorded forge runs" });
  await expect(table).toBeVisible();
  await page.getByLabel("Find runs", { exact: true }).fill("no matching title");
  await page.getByRole("button", { name: "Apply run filters" }).click();
  await expect(
    page.getByRole("heading", { name: "No runs match these filters" }),
  ).toBeVisible();
  await reloadSettled(page);
  await expect(page.getByLabel("Find runs", { exact: true })).toHaveValue(
    "no matching title",
  );
  await page.getByRole("button", { name: "Clear run filters" }).click();
  await expect(table).toBeVisible();
  await page
    .getByRole("combobox", { name: "Run mode", exact: true })
    .selectOption("auto");
  await page.getByRole("button", { name: "Apply run filters" }).click();
  await expect(
    table.getByRole("link", { name: "Historical unattended run", exact: true }),
  ).toBeVisible();
  await expect(
    table.getByRole("link", { name: "Scoped forge delivery", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Clear run filters" }).click();
  fail = true;
  await page.getByRole("button", { name: "Refresh runs", exact: true }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Fixture current membership unavailable" }),
  ).toBeVisible();
  await expect(
    table.getByRole("link", { name: "Scoped forge delivery", exact: true }),
  ).toBeVisible();
  fail = false;
  for (const slug of [fixture.primary, fixture.shipped, fixture.legacy])
    remove(fixture.path(slug));
  await page.getByRole("button", { name: "Refresh runs", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "No forge runs in this served checkout",
      exact: true,
    }),
  ).toBeVisible();
});

test("late run and project answers cannot replace a newer scoped selection and foreign detail stays unavailable", async ({
  page,
}) => {
  const entered = held(),
    release = held(),
    finished = held();
  await page.route(
    `**/__agent-forge/projects/${alpha.id}/runs/${fixture.primary}`,
    async (route) => {
      try {
        const response = await route.fetch();
        entered.release();
        await release.promise;
        await route.fulfill({ response });
      } finally {
        finished.release();
      }
    },
  );
  await openSettled(page, href());
  await page
    .getByRole("link", { name: "Scoped forge delivery", exact: true })
    .click();
  await entered.promise;
  await page.evaluate((hash) => {
    location.hash = hash;
  }, runsHref(alpha.id, fixture.shipped).slice(1));
  await expect(
    page
      .getByRole("article", { name: "Selected forge run" })
      .getByRole("heading", { name: "Shipped forge delivery", exact: true }),
  ).toBeVisible();
  release.release();
  await finished.promise;
  await expect(
    page
      .getByRole("article", { name: "Selected forge run" })
      .getByRole("heading", { name: "Scoped forge delivery", exact: true }),
  ).toHaveCount(0);
  await page.evaluate((hash) => {
    location.hash = hash;
  }, runsHref(beta.id, fixture.primary).slice(1));
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "not in this project's current run list" }),
  ).toBeVisible();
  await expect(
    page.getByRole("article", { name: "Selected forge run" }),
  ).toHaveCount(0);
  const answer = await protectedRead(
    page,
    `/projects/${beta.id}/runs/${fixture.primary}`,
  );
  expect(answer.status).toBe(404);
  expect(JSON.stringify(answer.body)).not.toContain("Scoped forge delivery");
  const list = await protectedRead(page, `/projects/${beta.id}/runs`);
  if (
    !list.body ||
    typeof list.body !== "object" ||
    !("ok" in list.body) ||
    list.body.ok !== true ||
    !("data" in list.body)
  )
    throw Error("Missing protected foreign project list");
  expect(
    projectRunsPageSchema.parse(list.body.data).runs.map((run) => run.slug),
  ).toEqual([fixture.foreign]);
});

test("a failed initial read stays unknown and a held old project list cannot populate the new project's Runs", async ({
  page,
}) => {
  const entered = held(),
    release = held(),
    finished = held();
  let initialFailure = true;
  await page.route(
    `**/__agent-forge/projects/${alpha.id}/runs`,
    async (route) => {
      if (initialFailure) {
        await route.fulfill({
          status: 503,
          json: {
            ok: false,
            data: null,
            error: "Fixture initial membership unavailable",
          },
        });
        return;
      }
      try {
        const response = await route.fetch();
        entered.release();
        await release.promise;
        await route.fulfill({ response });
      } finally {
        finished.release();
      }
    },
  );
  await openSettled(page, href());
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Fixture initial membership unavailable" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "No forge runs in this served checkout",
    }),
  ).toHaveCount(0);
  initialFailure = false;
  await page.getByRole("button", { name: "Refresh runs", exact: true }).click();
  await entered.promise;
  await page.evaluate((hash) => {
    location.hash = hash;
  }, runsHref(beta.id, null).slice(1));
  const table = page.getByRole("table", { name: "Recorded forge runs" });
  await expect(
    table.getByRole("link", { name: "FOREIGN BETA RUN", exact: true }),
  ).toBeVisible();
  release.release();
  await finished.promise;
  await expect(
    table.getByRole("link", { name: "Scoped forge delivery", exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Fixture initial membership unavailable" }),
  ).toHaveCount(0);
});
