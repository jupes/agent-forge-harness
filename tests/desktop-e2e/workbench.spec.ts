import { expect, test } from "@playwright/test";
import { QUEUE_STATES } from "../../types/hearth";
import { readState, withStateLock, writeState } from "../e2e/bd-stand-in-state";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import { BD_STAND_IN_STATE } from "../e2e/servers";
import { standInCalls } from "../e2e/stand-in";
import { alpha, seedProjects } from "./project-fixtures";

test.beforeEach(() => {
  seedProjects();
  withStateLock(BD_STAND_IN_STATE, () => {
    const state = readState(BD_STAND_IN_STATE);
    for (const queue of QUEUE_STATES) {
      const id = `alpha-${queue}`;
      state[id] = {
        id,
        title: `Light ${queue}`,
        issue_type: "task",
        status: "open",
        priority: queue === "running" ? 0 : 4,
        labels: ["project:alpha", `queue:${queue}`, "complexity:low"],
        metadata: {
          queue_state: queue,
          ...(queue === "paused" ? { queue_resume: "running" } : {}),
        },
        description: `## Files\napps/${queue}/**`,
        created_at: alpha.createdAt,
        updated_at: alpha.updatedAt,
        dependencies: [
          { issue_id: id, depends_on_id: "alpha-epic", type: "parent-child" },
        ],
      };
    }
    state["beta-private"] = {
      id: "beta-private",
      title: "FOREIGN-PRIVATE-TITLE",
      issue_type: "task",
      status: "open",
      priority: 2,
      created_at: alpha.createdAt,
      updated_at: alpha.updatedAt,
      labels: ["project:beta", "queue:approved"],
      metadata: { queue_state: "approved" },
      dependencies: [
        {
          issue_id: "beta-private",
          depends_on_id: "beta-epic",
          type: "parent-child",
        },
      ],
    };
    const base = state["alpha-approved"];
    if (!base) throw Error("Missing approved fixture");
    state["alpha-inherited"] = {
      ...base,
      id: "alpha-inherited",
      title: "Inherited label",
      metadata: {},
      dependencies: [
        {
          issue_id: "alpha-inherited",
          depends_on_id: "alpha-epic",
          type: "parent-child",
        },
      ],
    };
    state["alpha-unknown-label"] = {
      ...base,
      id: "alpha-unknown-label",
      title: "Conflicting label",
      labels: ["project:alpha", "queue:approved", "queue:teleported"],
      dependencies: [
        {
          issue_id: "alpha-unknown-label",
          depends_on_id: "alpha-epic",
          type: "parent-child",
        },
      ],
    };
    writeState(BD_STAND_IN_STATE, state);
  });
});

test("all eight scoped queue states offer canonical moves, Done expands, and filters preserve P4", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1100, height: 700 });
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/workbench`);
  const board = page.getByRole("region", {
    name: "Project Workbench",
    exact: true,
  });
  await expect(
    board.getByRole("heading", { name: "Workbench", exact: true }),
  ).toBeVisible();
  for (const queue of QUEUE_STATES)
    await expect(board.locator(`[data-column="${queue}"]`)).toHaveCount(1);
  await expect(
    board
      .locator('[data-bead="alpha-proposed"]')
      .getByRole("button", { name: "Approve alpha-proposed", exact: true }),
  ).toBeEnabled();
  await expect(
    board
      .locator('[data-bead="alpha-running"]')
      .getByRole("button", { name: "Pause alpha-running", exact: true }),
  ).toBeEnabled();
  await expect(
    board.getByRole("button", { name: /Queue alpha-proposed/ }),
  ).toHaveCount(0);
  await expect(board.locator('[data-bead="alpha-done"]')).toHaveCount(0);
  await board
    .getByRole("button", { name: "Show Done (1)", exact: true })
    .click();
  await expect(board.locator('[data-bead="alpha-done"]')).toBeVisible();
  await expect(board).not.toContainText("FOREIGN-PRIVATE");
  await expect(
    board
      .locator('[data-bead="alpha-inherited"]')
      .getByRole("button", { name: "Propose alpha-inherited", exact: true }),
  ).toBeEnabled();
  await expect(
    board
      .locator('[data-bead="alpha-inherited"]')
      .getByRole("button", { name: "Approve alpha-inherited", exact: true }),
  ).toHaveCount(0);
  await expect(
    board.locator('[data-bead="alpha-unknown-label"]'),
  ).toContainText("conflicting queue labels");
  await expect(
    board
      .locator('[data-bead="alpha-unknown-label"]')
      .getByRole("button", { name: /Approve |Pause |Reassign / }),
  ).toHaveCount(0);
  await board
    .getByLabel("Filter Workbench by priority", { exact: true })
    .selectOption("4");
  await expect(board.locator('[data-bead="alpha-running"]')).toHaveCount(0);
  await expect(board.locator('[data-bead="alpha-proposed"]')).toContainText(
    "P4",
  );
  await board
    .getByLabel("Search Workbench by id or title", { exact: true })
    .fill("NO-MATCH");
  await expect(
    board.getByText("No beads match these filters.", { exact: true }),
  ).toBeVisible();
  await board
    .getByRole("button", { name: "Clear Workbench filters", exact: true })
    .click();
  await expect(board.locator('[data-bead="alpha-running"]')).toHaveCount(1);
  const search = board.getByLabel("Search Workbench by id or title", {
    exact: true,
  });
  await search.focus();
  await page.keyboard.press("Tab");
  const focus = await page.locator(":focus").evaluate((node) => ({
    outline: getComputedStyle(node).outlineWidth,
    width: node.getBoundingClientRect().width,
    height: node.getBoundingClientRect().height,
  }));
  expect(focus.outline).toBe("2px");
  expect(focus.width).toBeGreaterThanOrEqual(24);
  expect(focus.height).toBeGreaterThanOrEqual(24);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "apps/desktop/docs/screenshots/workbench.png",
  });
});

test("approved moves and reassignment refresh live while selection and keyboard focus survive", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/workbench`);
  const board = page.getByRole("region", {
    name: "Project Workbench",
    exact: true,
  });
  const card = board.locator('[data-bead="alpha-proposed"]');
  const inspect = card.getByRole("button", {
    name: "Inspect alpha-proposed: Light proposed",
    exact: true,
  });
  await inspect.click();
  await expect(page).toHaveURL(/selectionId=alpha-proposed/);
  const before = standInCalls().filter(
    (args) => args[0] === "update" && args.at(-1) === "alpha-proposed",
  ).length;
  for (const [action, to] of [
    ["Approve", "approved"],
    ["Queue", "queued"],
    ["Pause", "paused"],
    ["Resume", "queued"],
  ]) {
    const button = card.getByRole("button", {
      name: `${action} alpha-proposed`,
      exact: true,
    });
    await expect(button).toBeEnabled();
    await button.focus();
    await page.keyboard.press("Enter");
    await expect
      .poll(
        () =>
          readState(BD_STAND_IN_STATE)["alpha-proposed"]?.metadata?.[
            "queue_state"
          ],
      )
      .toBe(to);
    await expect(
      board.locator(`[data-column="${to}"] [data-bead="alpha-proposed"]`),
    ).toHaveCount(1);
    await expect(inspect).toHaveAttribute("aria-pressed", "true");
    await expect(inspect).toBeFocused();
  }
  const choice = card.getByRole("combobox", {
    name: "Smith for alpha-proposed",
    exact: true,
  });
  await expect(choice).toBeEnabled();
  await choice.selectOption("claude-master");
  await card
    .getByRole("button", { name: "Reassign alpha-proposed", exact: true })
    .click();
  await expect
    .poll(
      () => readState(BD_STAND_IN_STATE)["alpha-proposed"]?.metadata?.["smith"],
    )
    .toBe("claude-master");
  await expect(card).toContainText("smith claude-master");
  expect(
    standInCalls().filter(
      (args) => args[0] === "update" && args.at(-1) === "alpha-proposed",
    ),
  ).toHaveLength(before + 5);
});

test("a lost actual approval reply remains held after reload and appears in Inbox without another move", async ({
  page,
}) => {
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/workbench`);
  const before = standInCalls().filter(
    (args) => args[0] === "update" && args.at(-1) === "alpha-proposed",
  ).length;
  await page.route(
    `**/__agent-forge/projects/${alpha.id}/beads/alpha-proposed/approve`,
    async (route) => {
      const response = await route.fetch({
        headers: {
          ...(await route.request().allHeaders()),
          Origin: new URL(route.request().url()).origin,
          "Sec-Fetch-Site": "same-origin",
        },
      });
      expect(response.status()).toBe(200);
      await route.abort("connectionreset");
    },
  );
  const board = page.getByRole("region", {
    name: "Project Workbench",
    exact: true,
  });
  const approve = board.getByRole("button", {
    name: "Approve alpha-proposed",
    exact: true,
  });
  await expect(approve).toBeEnabled();
  await approve.evaluate((button) => {
    if (!(button instanceof HTMLButtonElement))
      throw Error("Expected approval button");
    button.click();
    button.click();
  });
  await expect(
    board.getByRole("region", { name: "Current bead write" }),
  ).toContainText("Outcome unknown");
  await expect
    .poll(
      () =>
        readState(BD_STAND_IN_STATE)["alpha-proposed"]?.metadata?.[
          "queue_state"
        ],
    )
    .toBe("approved");
  await reloadSettled(page);
  await expect(
    board.getByRole("region", { name: "Current bead write" }),
  ).toContainText("Outcome unknown");
  await expect(
    board.getByRole("button", { name: "Queue alpha-proposed", exact: true }),
  ).toBeDisabled();
  expect(
    standInCalls().filter(
      (args) => args[0] === "update" && args.at(-1) === "alpha-proposed",
    ),
  ).toHaveLength(before + 1);
  await page
    .getByRole("navigation", { name: "Global", exact: true })
    .getByRole("link", { name: "Inbox", exact: true })
    .click();
  const inbox = page.getByRole("region", {
    name: "Bead write outcomes",
    exact: true,
  });
  await expect(inbox).toContainText("Outcome unknown");
  await expect(
    inbox.getByRole("link", { name: "Check alpha-proposed", exact: true }),
  ).toBeVisible();
});

test("loading and failed reads never become a false empty board or positive eligibility", async ({
  page,
}) => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fail = true;
  const path = `**/__agent-forge/projects/${alpha.id}/workbench`;
  await page.route(path, async (route) => {
    await held;
    if (fail)
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          data: null,
          error: "Isolated tracker read unavailable",
        }),
      });
    return route.continue();
  });
  await page.goto(`/index.html#/desktop/project/${alpha.id}/workbench`, {
    waitUntil: "domcontentloaded",
  });
  const board = page.getByRole("region", {
    name: "Project Workbench",
    exact: true,
  });
  await expect(
    board.getByText("Loading project Workbench…", { exact: true }),
  ).toBeVisible();
  release();
  await expect(board.getByRole("alert")).toBeVisible();
  await expect(
    board.getByText("No beads in the approval queue.", { exact: true }),
  ).toHaveCount(0);
  fail = false;
  await expect(
    board.getByRole("button", { name: "Refresh Workbench", exact: true }),
  ).toBeEnabled();
  await board
    .getByRole("button", { name: "Refresh Workbench", exact: true })
    .click();
  await expect(
    board.getByRole("button", { name: "Approve alpha-proposed", exact: true }),
  ).toBeEnabled();
  fail = true;
  await board
    .getByRole("button", { name: "Refresh Workbench", exact: true })
    .click();
  await expect(board.getByRole("alert")).toBeVisible();
  await expect(board.locator('[data-bead="alpha-queued"]')).toContainText(
    "Eligibility unavailable",
  );
  await expect(
    board.getByRole("button", { name: "Approve alpha-proposed", exact: true }),
  ).toBeDisabled();
  await expect(board.getByText("May start", { exact: true })).toHaveCount(0);
});

test("a held background read preserves queue control focus and blocks an early action", async ({
  page,
}) => {
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/workbench`);
  const board = page.getByRole("region", {
    name: "Project Workbench",
    exact: true,
  });
  const approve = board.getByRole("button", {
    name: "Approve alpha-proposed",
    exact: true,
  });
  await expect(approve).toBeEnabled();
  await approve.focus();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    `**/__agent-forge/projects/${alpha.id}/workbench`,
    async (route) => {
      await gate;
      await route.continue();
    },
  );
  const requested = page.waitForRequest((request) =>
    request.url().endsWith(`/projects/${alpha.id}/workbench`),
  );
  await board
    .getByRole("button", { name: "Refresh Workbench", exact: true })
    .evaluate((button) => {
      if (!(button instanceof HTMLButtonElement))
        throw Error("Expected refresh button");
      button.click();
    });
  await requested;
  await expect(approve).toHaveAttribute("aria-disabled", "true");
  await expect(approve).toBeFocused();
  const before = standInCalls().filter(
    (args) => args[0] === "update" && args.at(-1) === "alpha-proposed",
  ).length;
  await page.keyboard.press("Enter");
  release();
  await expect(approve).toHaveAttribute("aria-disabled", "false");
  await expect(approve).toBeFocused();
  expect(
    standInCalls().filter(
      (args) => args[0] === "update" && args.at(-1) === "alpha-proposed",
    ),
  ).toHaveLength(before);
});

test("an actually empty scoped queue offers the bead entry point", async ({
  page,
}) => {
  seedProjects();
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/workbench`);
  const board = page.getByRole("region", {
    name: "Project Workbench",
    exact: true,
  });
  await expect(
    board.getByText("No beads in the approval queue.", { exact: true }),
  ).toBeVisible();
  await expect(
    board.getByRole("link", { name: "Open project beads", exact: true }),
  ).toHaveAttribute("href", `#/desktop/project/${alpha.id}/beads`);
});
