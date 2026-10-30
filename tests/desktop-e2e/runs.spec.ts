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
import { expect, type Page, type Route, test } from "@playwright/test";
import { runsHref } from "../../apps/desktop/src/project-runs-model";
import type { ForgeState } from "../../scripts/forge/phases";
import { OPERATOR_HEADER } from "../../scripts/hearth/paths";
import {
  projectRunArtifactSchema,
  projectRunDetailSchema,
  projectRunsPageSchema,
} from "../../scripts/projects/run-protocol";
import { readState, withStateLock, writeState } from "../e2e/bd-stand-in-state";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import { pageToken } from "../e2e/launch-link";
import { BD_STAND_IN_STATE, HEARTH_HOME } from "../e2e/servers";
import { seedObservationEvents } from "./observed-session-fixtures";
import { alpha, beta, seedProjects, workspace } from "./project-fixtures";

const owned = new Map<string, string>();
const posts: string[] = [];
const releases: Array<() => void> = [];
let beforeDispatches: number[] = [];
let streams = 0;
let artifactReads = 0;
let fixture: ReturnType<typeof seedRuns>;
type RunsFilterEffectGate = {
  arm(): void;
  status(): {
    timerHeld: boolean;
    frameHeld: boolean;
    captures: number;
  };
  release(): Promise<void>;
};
type RunsFilterEffectGateWindow = Window & {
  __runsFilterEffectGate?: RunsFilterEffectGate;
};
function dispatches() {
  return (
    [
      ["codex-fixture-calls.jsonl", "task"],
      ["gemini-fixture-calls.jsonl", "task"],
      ["codex-chat-fixture-calls.jsonl", "process"],
      ["gemini-chat-fixture-calls.json", "start"],
      ["keeper-fixture-starts.jsonl", "started"],
      ["coding-fixture-starts.jsonl", "line"],
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
    if (kind === "line") return values.length;
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
    artifacts: { research: `plans/research/${primary}.md` },
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
  const research = `# Verified research\n\n<script>must remain text</script>\n\n![inert image](https://example.com/image.png)\n\n[Safe link](https://example.com/research)\n`;
  const researchPath = join(checkout, `plans/research/${primary}.md`);
  mkdirSync(dirname(researchPath), { recursive: true });
  writeFileSync(researchPath, research, { flag: "wx" });
  owned.set(researchPath, research);
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
  return { primary, shipped, legacy, foreign, path, research };
}
function recordRunSessions(runId: string, count: number) {
  const worktree = realpathSync.native(process.cwd());
  const sessionIds: string[] = [];
  const events: import("../../types/hearth").LedgerEventInput[] = [];
  for (let index = 0; index < count; index++) {
    const sessionId = `run-session-${randomUUID()}`;
    events.push({
      kind: "session.started",
      workspace,
      beadId: "alpha-epic",
      runId,
      sessionId,
      payload: {
        source: "headless:claude",
        kind: "headless",
        worktree,
      },
    });
    sessionIds.push(sessionId);
  }
  seedObservationEvents(events);
  return sessionIds;
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
/** Playwright's server-side forward must retain the browser's declared same-origin boundary. */
async function forwardRun(route: Route) {
  const response = await route.fetch({
    headers: {
      ...route.request().headers(),
      Origin: new URL(route.request().url()).origin,
      "Sec-Fetch-Site": "same-origin",
    },
  });
  expect(response.status()).toBe(200);
  let envelope: unknown;
  try {
    envelope = await response.json();
  } catch {
    throw Error("Incomplete forwarded run read");
  }
  if (
    !envelope ||
    typeof envelope !== "object" ||
    !("ok" in envelope) ||
    envelope.ok !== true ||
    !("data" in envelope)
  )
    throw Error("The forwarded run read was not a verified protected answer");
  const pathname = new URL(route.request().url()).pathname;
  if (pathname.includes("/artifacts/"))
    projectRunArtifactSchema.parse(envelope.data);
  else if (pathname.endsWith("/runs"))
    projectRunsPageSchema.parse(envelope.data);
  else projectRunDetailSchema.parse(envelope.data);
  return response;
}
const href = (project = alpha.id, slug: string | null = null) =>
  `/index.html${runsHref(project, slug)}`;

test.beforeEach(({ page }) => {
  seedProjects();
  fixture = seedRuns();
  posts.length = 0;
  artifactReads = 0;
  streams = 0;
  beforeDispatches = dispatches();
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/__agent-forge/stream") streams++;
    if (new URL(request.url()).pathname.includes("/artifacts/"))
      artifactReads++;
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

function checkpoint(
  id: string,
  issueType: "feature" | "task",
  status: "open" | "in_progress",
  parent: string,
  blocker?: string,
) {
  return {
    id,
    title: id,
    issue_type: issueType,
    status,
    priority: 2,
    created_at: "2026-10-29T00:00:00.000Z",
    updated_at: "2026-10-29T00:00:00.000Z",
    labels: ["project:alpha"],
    dependencies: [
      { issue_id: id, depends_on_id: parent, type: "parent-child" },
      ...(blocker
        ? [{ issue_id: id, depends_on_id: blocker, type: "blocks" }]
        : []),
    ],
  };
}

test("selected run shows its scoped checkpoints and prefills only the current bead in Council", async ({
  page,
}) => {
  withStateLock(BD_STAND_IN_STATE, () => {
    const state = readState(BD_STAND_IN_STATE);
    Object.assign(state, {
      "alpha-feature": checkpoint(
        "alpha-feature",
        "feature",
        "open",
        "alpha-epic",
      ),
      "alpha-active": checkpoint(
        "alpha-active",
        "task",
        "in_progress",
        "alpha-feature",
      ),
      "alpha-second": checkpoint(
        "alpha-second",
        "task",
        "in_progress",
        "alpha-feature",
      ),
      "alpha-next": checkpoint(
        "alpha-next",
        "task",
        "open",
        "alpha-feature",
        "alpha-active",
      ),
    });
    writeState(BD_STAND_IN_STATE, state);
  });
  await openSettled(page, href(alpha.id, fixture.primary));
  const detail = page.getByRole("article", { name: "Selected forge run" });
  const checkpoints = detail.getByRole("region", { name: "Run checkpoints" });
  const active = checkpoints.locator('[data-checkpoint-id="alpha-active"]');
  const second = checkpoints.locator('[data-checkpoint-id="alpha-second"]');
  const waiting = checkpoints.locator('[data-checkpoint-id="alpha-next"]');
  await expect(active).toContainText("In progress");
  await expect(second).toContainText("In progress");
  await expect(waiting).toContainText("Open");
  await expect(waiting).toContainText("waiting on alpha-active");
  await expect(
    waiting.getByRole("button", { name: "Send alpha-next to Council" }),
  ).toHaveCount(0);
  await active
    .getByRole("button", { name: "Send alpha-active to Council" })
    .click();
  await expect(page).toHaveURL(/\/reviews$/);
  await expect(page.getByLabel("Source type")).toHaveValue("bead");
  await expect(page.getByLabel("Beads issue ID")).toHaveValue("alpha-active");
  await page.goBack();
  await expect(detail).toBeVisible();
  const secondAction = second.getByRole("button", {
    name: "Send alpha-second to Council",
  });
  await expect(secondAction).toBeEnabled();
  await secondAction.click();
  const replace = page.getByRole("dialog", {
    name: "Replace Council draft source?",
  });
  await expect(replace).toBeVisible();
  await replace.getByRole("button", { name: "Replace source" }).click();
  await expect(page).toHaveURL(/\/reviews$/);
  await expect(page.getByLabel("Beads issue ID")).toHaveValue("alpha-second");
  expect(posts).toEqual([]);
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
  ).toBeEnabled();
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
  expect(artifactReads).toBe(0);
  const readArtifact = detail.getByRole("button", {
    name: "Read research artifact",
  });
  await readArtifact.focus();
  await expect(readArtifact).toHaveCSS("outline-width", "2px");
  await page.keyboard.press("Enter");
  const artifact = page.getByRole("region", { name: "Verified run artifact" });
  await expect(
    artifact.getByText("Verified research", { exact: true }),
  ).toBeVisible();
  await expect(
    artifact.getByText("<script>must remain text</script>", { exact: true }),
  ).toBeVisible();
  await expect(artifact.locator("script, img")).toHaveCount(0);
  await expect(
    artifact.getByRole("link", { name: "Safe link" }),
  ).toHaveAttribute("href", "https://example.com/research");
  expect(artifactReads).toBe(1);
  const shotDir = process.env["SHOT_DIR"];
  if (shotDir) {
    mkdirSync(shotDir, { recursive: true });
    await artifact.screenshot({
      path: join(shotDir, "runs-artifact.png"),
      animations: "disabled",
    });
  }
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
    path: "apps/desktop/docs/screenshots/runs-gate-history.png",
    fullPage: true,
    mask: [
      page.locator(".af-runs-source code"),
      page.locator(".af-run-artifact code"),
    ],
    maskColor: "#3f424d",
    style: ".af-project-runs time { visibility: hidden !important; }",
  });
  // The shell scrolls its main pane, so fullPage alone cannot reveal the heading/phases.
  // Capture the overview separately after the functional compact-layout/focus checks.
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.locator("main").evaluate((element) => element.scrollTo(0, 0));
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
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
  await page.setViewportSize({ width: 1100, height: 700 });
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

test("recorded run sessions page in the served project and open only admitted metadata", async ({
  page,
}) => {
  const sessions = recordRunSessions(fixture.primary, 101);
  await openSettled(page, href(alpha.id, fixture.primary));
  const history = page.getByRole("region", {
    name: "Recorded sessions for this run",
  });
  await expect(history.getByText(sessions[0]!, { exact: true })).toBeVisible();
  await expect(history.getByText(sessions[100]!, { exact: true })).toHaveCount(
    0,
  );
  await history
    .getByRole("button", { name: "Load more recorded sessions" })
    .click();
  await expect(
    history.getByText(sessions[100]!, { exact: true }),
  ).toBeVisible();

  await history
    .getByRole("link", { name: "Open session metadata" })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "Session metadata", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(sessions[0]!, { exact: true })).toBeVisible();
  await expect(
    page.getByText("Session start recorded", { exact: true }),
  ).toBeVisible();

  await openSettled(page, href(beta.id, fixture.foreign));
  const betaHistory = page.getByRole("region", {
    name: "Recorded sessions for this run",
  });
  await expect(
    betaHistory.getByText(sessions[0]!, { exact: true }),
  ).toHaveCount(0);
  expect(posts).toEqual([]);
  expect(dispatches()).toEqual(beforeDispatches);
});

test("a changed run-session admission key keeps the old page stale and disables metadata links and paging", async ({
  page,
}) => {
  const sessions = recordRunSessions(fixture.primary, 101);
  await openSettled(page, href(alpha.id, fixture.primary));
  const history = page.getByRole("region", {
    name: "Recorded sessions for this run",
  });
  await expect(history.getByText(sessions[0]!, { exact: true })).toBeVisible();
  await expect(
    history.getByRole("link", { name: "Open session metadata" }).first(),
  ).toBeVisible();

  const newlyAdmitted = recordRunSessions(fixture.primary, 1)[0]!;
  await history
    .getByRole("button", { name: "Load more recorded sessions" })
    .click();

  await expect(history).toContainText(
    "Project or session membership changed while reading this run",
  );
  await expect(history.getByText(sessions[0]!, { exact: true })).toBeVisible();
  await expect(history.getByText(newlyAdmitted, { exact: true })).toHaveCount(
    0,
  );
  await expect(
    history.getByRole("link", { name: "Open session metadata" }),
  ).toHaveCount(0);
  await expect(
    history.getByRole("button", { name: "Load more recorded sessions" }),
  ).toBeDisabled();
  expect(posts).toEqual([]);
  expect(dispatches()).toEqual(beforeDispatches);
});

test("Runs filters and verified empty/loading/error states never claim unavailable sources are empty", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const originalSetTimeout = (
      window.setTimeout as unknown as (
        callback: TimerHandler,
        delay?: number,
        ...args: unknown[]
      ) => number
    ).bind(window);
    const originalClearTimeout = (
      window.clearTimeout as unknown as (id?: number) => void
    ).bind(window);
    const originalRequestAnimationFrame =
      window.requestAnimationFrame.bind(window);
    const originalCancelAnimationFrame =
      window.cancelAnimationFrame.bind(window);
    const heldTimerId = -1;
    const heldFrameId = -2;
    let armed = false;
    let heldTimer:
      | { callback: TimerHandler; delay: number; args: unknown[] }
      | undefined;
    let heldFrame: FrameRequestCallback | undefined;
    let captures = 0;

    window.setTimeout = ((
      callback: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (
        armed &&
        delay === 35 &&
        typeof callback === "function" &&
        !heldTimer
      ) {
        const candidate = { callback, delay, args };
        heldTimer = candidate;
        queueMicrotask(() => {
          if (armed && heldTimer === candidate && !heldFrame) {
            heldTimer = undefined;
            originalSetTimeout(callback, delay, ...args);
          }
        });
        return heldTimerId;
      }
      return originalSetTimeout(callback, delay, ...args);
    }) as unknown as typeof window.setTimeout;
    window.clearTimeout = ((id?: number) => {
      if (id !== heldTimerId) originalClearTimeout(id);
    }) as unknown as typeof window.clearTimeout;
    window.requestAnimationFrame = ((callback) => {
      if (armed && heldTimer && !heldFrame) {
        heldFrame = callback;
        captures += 1;
        return heldFrameId;
      }
      return originalRequestAnimationFrame(callback);
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = ((id) => {
      if (id !== heldFrameId) originalCancelAnimationFrame(id);
    }) as typeof window.cancelAnimationFrame;

    (window as RunsFilterEffectGateWindow).__runsFilterEffectGate = {
      arm() {
        heldTimer = undefined;
        heldFrame = undefined;
        captures = 0;
        armed = true;
      },
      status() {
        return {
          timerHeld: !!heldTimer,
          frameHeld: !!heldFrame,
          captures,
        };
      },
      async release() {
        armed = false;
        const timer = heldTimer;
        const frame = heldFrame;
        heldTimer = undefined;
        heldFrame = undefined;
        window.setTimeout =
          originalSetTimeout as unknown as typeof window.setTimeout;
        window.clearTimeout =
          originalClearTimeout as unknown as typeof window.clearTimeout;
        window.requestAnimationFrame = originalRequestAnimationFrame;
        window.cancelAnimationFrame = originalCancelAnimationFrame;
        if (frame) frame(performance.now());
        else if (timer)
          originalSetTimeout(timer.callback, timer.delay, ...timer.args);
        await new Promise<void>((resolve) => originalSetTimeout(resolve, 0));
      },
    };
  });
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
      const response = await forwardRun(route);
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
  const runMode = page.getByRole("combobox", { name: "Run mode", exact: true });
  await page.evaluate(() => {
    const gate = (window as RunsFilterEffectGateWindow).__runsFilterEffectGate;
    if (!gate) throw new Error("Runs filter effect gate was not installed");
    gate.arm();
  });
  try {
    await page.getByRole("button", { name: "Clear run filters" }).click();
    await expect(
      table.getByRole("link", { name: "Scoped forge delivery", exact: true }),
    ).toBeVisible();
    const heldEffect = await page.evaluate(() => {
      const gate = (window as RunsFilterEffectGateWindow)
        .__runsFilterEffectGate;
      if (!gate) throw new Error("Runs filter effect gate was not installed");
      return gate.status();
    });
    console.log(`Runs filter effect gate: ${JSON.stringify(heldEffect)}`);
    expect([
      { timerHeld: false, frameHeld: false, captures: 0 },
      { timerHeld: true, frameHeld: true, captures: 1 },
    ]).toContainEqual(heldEffect);
    await runMode.focus();
    await runMode.selectOption("auto");
    await page.evaluate(async () => {
      const gate = (window as RunsFilterEffectGateWindow)
        .__runsFilterEffectGate;
      if (!gate) throw new Error("Runs filter effect gate was not installed");
      await gate.release();
    });
  } finally {
    await page.evaluate(async () => {
      const gate = (window as RunsFilterEffectGateWindow)
        .__runsFilterEffectGate;
      if (!gate) throw new Error("Runs filter effect gate was not installed");
      await gate.release();
    });
  }
  await expect(runMode).toHaveValue("auto");
  await expect(runMode).toBeFocused();
  await page.getByRole("button", { name: "Apply run filters" }).click();
  await expect(page).toHaveURL(/runMode=auto/);
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
  let primaryDetailRequests = 0;
  await page.route(
    new RegExp(
      `^https?://[^/]+/__agent-forge/projects/${alpha.id}/runs/${fixture.primary}\\?after=0&limit=100$`,
    ),
    async (route) => {
      primaryDetailRequests++;
      try {
        const response = await forwardRun(route);
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
  expect(primaryDetailRequests).toBe(1);
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
        const response = await forwardRun(route);
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
