import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  readComments,
  readState,
  withStateLock,
  writeComments,
  writeState,
} from "../e2e/bd-stand-in-state";
import { openSettled } from "../e2e/fixtures";
import { createPostFencedGesture } from "../e2e/post-fenced-gesture";
import { BD_STAND_IN_STATE, HEARTH_HOME } from "../e2e/servers";
import { standInCalls } from "../e2e/stand-in";
import { alpha, beta, seedProjects } from "./project-fixtures";

const conversation = (id: string) =>
  join(HEARTH_HOME, "conversations", `keeper-${id}.json`);
const cards = (page: Page) =>
  page.getByRole("region", { name: "Keeper action cards", exact: true });
test.beforeEach(() => {
  seedProjects();
  for (const project of [alpha, beta])
    rmSync(conversation(project.id), { force: true });
  writeFileSync(
    join(HEARTH_HOME, "keeper-fixture-mode.json"),
    JSON.stringify("proposals"),
  );
  withStateLock(BD_STAND_IN_STATE, () => {
    const state = readState(BD_STAND_IN_STATE),
      epic = state["alpha-epic"];
    if (!epic) throw new Error("Missing scoped fixture epic");
    state[epic.id] = {
      ...epic,
      labels: [...(epic.labels ?? []), "queue:proposed"],
      metadata: { queue_state: "proposed" },
    };
    state["alpha-epic.1"] = {
      ...epic,
      id: "alpha-epic.1",
      title: "Scoped child",
      issue_type: "task",
      labels: ["project:alpha", "queue:proposed"],
      metadata: { queue_state: "proposed" },
      dependencies: [
        {
          issue_id: "alpha-epic.1",
          depends_on_id: "alpha-epic",
          type: "parent-child",
        },
      ],
    };
    writeState(BD_STAND_IN_STATE, state);
    writeComments(BD_STAND_IN_STATE, {});
  });
});
test.afterEach(async () => {
  await expect
    .poll(
      () => {
        try {
          const state = JSON.parse(
            readFileSync(conversation(alpha.id), "utf8"),
          );
          return state.turns.some((turn: { phase: string }) =>
            ["accepted", "running", "cancelling"].includes(turn.phase),
          );
        } catch {
          return false;
        }
      },
      { timeout: 15_000 },
    )
    .toBe(false);
});
async function propose(page: Page) {
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/keeper`);
  await page
    .getByRole("textbox", { name: "Message the Keeper" })
    .fill("Show seven reviewable fixture proposals");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(cards(page).getByRole("article")).toHaveCount(7);
  await expect(cards(page)).toHaveAttribute("aria-busy", "false");
}
test("all seven cards are inert until review, edits survive drawer navigation, and a lost decision answer confirms one actual write and Activity", async ({
  page,
}) => {
  await propose(page);
  expect(readComments(BD_STAND_IN_STATE)).toEqual({});
  for (const [title, reason] of [
    ["Review a session", "session review composer"],
    ["Review a shift", "attended project shift review"],
    ["Review council input", "project council review composer"],
  ] as const) {
    const card = cards(page).getByRole("article", { name: title, exact: true });
    await expect(card).toContainText(reason!);
    await expect(
      card.getByRole("button", { name: "Approve", exact: true }),
    ).toBeDisabled();
    await card.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(card.getByRole("textbox").first()).toBeEditable();
    await card
      .getByRole("button", { name: "Finish editing", exact: true })
      .click();
  }
  const decision = cards(page).getByRole("article", {
    name: "Record a scoped decision",
    exact: true,
  });
  await decision.getByRole("button", { name: "Edit", exact: true }).click();
  await decision
    .getByRole("textbox", { name: "Decision", exact: true })
    .fill("Reviewed wording <script> stays plain text.");
  await page
    .getByRole("link", { name: "Overview", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "Ask Keeper", exact: true }).click();
  const drawer = page.getByRole("dialog", {
    name: "Forge Keeper · Alpha",
    exact: true,
  });
  const drawerDecision = drawer.getByRole("article", {
    name: "Record a scoped decision",
    exact: true,
  });
  await drawerDecision
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await expect(
    drawerDecision.getByRole("textbox", { name: "Decision", exact: true }),
  ).toHaveValue("Reviewed wording <script> stays plain text.");
  expect(readComments(BD_STAND_IN_STATE)).toEqual({});
  await drawer
    .getByRole("link", { name: "Open full conversation", exact: true })
    .click();
  let writes = 0;
  await page.route("**/keeper/proposals/approve", async (route) => {
    writes++;
    await route.fetch();
    await route.abort("connectionfailed");
  });
  await decision.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(decision).toContainText("Done");
  await expect
    .poll(() => readComments(BD_STAND_IN_STATE)["alpha-epic"]?.length)
    .toBe(1);
  expect(readComments(BD_STAND_IN_STATE)["alpha-epic"]?.[0]?.text).toBe(
    "design: Reviewed wording <script> stays plain text.",
  );
  expect(writes).toBe(1);
  await expect(decision.locator("script")).toHaveCount(0);
  const activity = decision.getByRole("button", { name: /View Activity/ });
  await activity.focus();
  await page.keyboard.press("Enter");
  const audit = page.getByRole("dialog", {
    name: "Approval Activity",
    exact: true,
  });
  await expect(audit).toContainText("keeper.proposal.approve");
  await expect(audit).toContainText("proposal-");
  await page.keyboard.press("Escape");
  await expect(activity).toBeFocused();
  const dismiss = cards(page).getByRole("article", {
    name: "Review council input",
    exact: true,
  });
  await dismiss.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(dismiss).toContainText("Dismissed");
  expect(readComments(BD_STAND_IN_STATE)["alpha-epic"]).toHaveLength(1);
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(cards(page)).toHaveAttribute("aria-busy", "false");
  await expect(
    cards(page).getByRole("button", {
      name: "Refresh action cards",
      exact: true,
    }),
  ).toBeEnabled();
  await cards(page)
    .getByRole("button", { name: "Refresh action cards", exact: true })
    .focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(
    cards(page).getByRole("button", {
      name: "Refresh action cards",
      exact: true,
    }),
  ).toBeFocused();
  expect(
    await cards(page)
      .getByRole("button", { name: "Refresh action cards", exact: true })
      .evaluate((node) => getComputedStyle(node).outlineWidth),
  ).toBe("2px");
  await page.setViewportSize({ width: 1440, height: 900 });
  await decision.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "apps/desktop/docs/screenshots/keeper-action-cards.png",
  });
});
test("checked approvals, reviewed child creation and pause use the actual scoped operator destinations", async ({
  page,
}) => {
  await propose(page);
  let approvalPosts = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname ===
        `/__agent-forge/projects/${alpha.id}/keeper/proposals/approve`
    )
      approvalPosts++;
  });
  const epicWrites = () =>
    standInCalls().filter(
      (args) => args[0] === "update" && args.at(-1) === "alpha-epic",
    ).length;
  const writesBefore = epicWrites();
  const approveReviewed = async (card: Locator, applied: () => boolean) => {
    const button = card.getByRole("button", {
      name: "Approve",
      exact: true,
    });
    const fence = createPostFencedGesture({
      posts: () => approvalPosts,
      applied,
      ready: () => expect(button).toBeEnabled({ timeout: 250 }),
      gesture: () => button.click({ timeout: 250 }),
    });
    // A background read can disable the button between the enabled check and
    // the click. Repeat only that unsent gesture: any POST or applied effect
    // permanently closes the retry boundary for this reviewed action.
    await expect(async () => {
      await fence.attempt();
      expect(applied()).toBe(true);
    }).toPass({ timeout: 10_000, intervals: [100, 250, 500] });
    await expect(card).toContainText("Done");
    expect(approvalPosts).toBe(fence.postsBefore + 1);
  };
  const approval = cards(page).getByRole("article", {
    name: "Approve scoped beads",
    exact: true,
  });
  await approval.getByRole("button", { name: "Edit", exact: true }).click();
  await approval
    .getByRole("checkbox", { name: "alpha-epic.1", exact: true })
    .uncheck();
  await approveReviewed(
    approval,
    () =>
      readState(BD_STAND_IN_STATE)["alpha-epic"]?.metadata?.queue_state ===
      "approved",
  );
  expect(
    readState(BD_STAND_IN_STATE)["alpha-epic"]?.metadata?.queue_state,
  ).toBe("approved");
  expect(
    readState(BD_STAND_IN_STATE)["alpha-epic.1"]?.metadata?.queue_state,
  ).toBe("proposed");
  const create = cards(page).getByRole("article", {
    name: "Create a scoped follow-up",
    exact: true,
  });
  await expect(
    create.getByRole("button", { name: "Approve", exact: true }),
  ).toBeEnabled();
  await create.getByRole("button", { name: "Edit", exact: true }).click();
  await create
    .getByRole("textbox", { name: "Title", exact: true })
    .fill("Reviewed fixture child");
  const childrenBefore = new Set(Object.keys(readState(BD_STAND_IN_STATE)));
  const reviewedChildren = () =>
    Object.values(readState(BD_STAND_IN_STATE)).filter(
      (item) =>
        !childrenBefore.has(item.id) && item.title === "Reviewed fixture child",
    );
  await approveReviewed(create, () => reviewedChildren().length === 1);
  expect(reviewedChildren()).toHaveLength(1);
  const child = reviewedChildren()[0];
  expect(child?.metadata?.queue_state).toBe("proposed");
  expect(child?.labels).toContain("project:alpha");
  const manage = cards(page).getByRole("article", {
    name: "Manage scoped work",
    exact: true,
  });
  await approveReviewed(
    manage,
    () =>
      readState(BD_STAND_IN_STATE)["alpha-epic"]?.metadata?.queue_state ===
      "paused",
  );
  expect(
    readState(BD_STAND_IN_STATE)["alpha-epic"]?.metadata?.queue_state,
  ).toBe("paused");
  expect(
    readState(BD_STAND_IN_STATE)["beta-epic"]?.metadata?.queue_state,
  ).toBeUndefined();
  for (const [operation, expected] of [
    ["resume", "approved"],
    ["reassign", "approved"],
  ] as const) {
    const count = await cards(page).getByRole("article").count();
    await page
      .getByRole("textbox", { name: "Message the Keeper" })
      .fill(`Review ${operation} fixture`);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(cards(page).getByRole("article")).toHaveCount(count + 7);
    const next = cards(page)
      .getByRole("article", { name: "Manage scoped work", exact: true })
      .last();
    await next.getByRole("button", { name: "Edit", exact: true }).click();
    await next
      .getByRole("combobox", { name: "Operation", exact: true })
      .selectOption(operation);
    if (operation === "reassign")
      await next
        .getByRole("textbox", { name: "Smith", exact: true })
        .fill("claude-journeyman");
    await approveReviewed(next, () => {
      const metadata = readState(BD_STAND_IN_STATE)["alpha-epic"]?.metadata;
      return operation === "reassign"
        ? metadata?.smith === "claude-journeyman"
        : metadata?.queue_state === expected;
    });
    expect(
      readState(BD_STAND_IN_STATE)["alpha-epic"]?.metadata?.queue_state,
    ).toBe(expected);
    if (operation === "reassign")
      expect(readState(BD_STAND_IN_STATE)["alpha-epic"]?.metadata?.smith).toBe(
        "claude-journeyman",
      );
  }
  expect(approvalPosts).toBe(5);
  expect(epicWrites()).toBe(writesBefore + 4);
});

test("a pending action-card refresh stays in keyboard order and cannot queue duplicate reads", async ({
  page,
}) => {
  await propose(page);
  const refresh = cards(page).getByRole("button", {
    name: "Refresh action cards",
    exact: true,
  });
  let release = () => {},
    entered = () => {},
    reads = 0;
  const held = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pattern = `**/__agent-forge/projects/${alpha.id}/keeper/proposals*`;
  await page.route(pattern, async (route) => {
    reads++;
    entered();
    await released;
    await route.continue();
  });
  try {
    await refresh.click();
    await held;
    await expect(cards(page)).toHaveAttribute("aria-busy", "true");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(refresh).toBeFocused();
    await expect(refresh).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    expect(reads).toBe(1);
  } finally {
    release();
  }
  await expect(cards(page)).toHaveAttribute("aria-busy", "false");
  await page.unroute(pattern);
});
