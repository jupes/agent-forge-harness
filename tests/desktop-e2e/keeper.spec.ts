import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { OPERATOR_HEADER } from "../../scripts/hearth/paths";
import { openSettled } from "../e2e/fixtures";
import { HEARTH_HOME } from "../e2e/servers";
import {
  alpha,
  beta,
  seedKeeper,
  seedProjects,
  seedSessions,
} from "./project-fixtures";

const path = (id: string) =>
  join(HEARTH_HOME, "conversations", `keeper-${id}.json`);
function rawState(id: string): {
  turns?: Array<{ requestId: string; phase: string }>;
  frames?: unknown[];
} {
  try {
    return JSON.parse(readFileSync(path(id), "utf8"));
  } catch {
    return {};
  }
}
const starts = () =>
  existsSync(join(HEARTH_HOME, "keeper-fixture-starts.jsonl"))
    ? readFileSync(join(HEARTH_HOME, "keeper-fixture-starts.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean).length
    : 0;
test.beforeEach(() => {
  seedProjects();
  writeFileSync(
    join(HEARTH_HOME, "keeper-fixture-mode.json"),
    JSON.stringify("normal"),
  );
  for (const project of [alpha, beta]) {
    if (
      rawState(project.id).turns?.some((turn) =>
        ["accepted", "running", "cancelling"].includes(turn.phase),
      )
    )
      throw new Error(
        "A previous fake Keeper turn is still active; preserve its transcript.",
      );
    rmSync(path(project.id), { force: true });
  }
});
test.afterEach(async ({ page }) => {
  if (!page.url().startsWith("http://127.0.0.1:")) return;
  for (const project of [alpha, beta]) {
    const turn = rawState(project.id).turns?.find((turn) =>
      ["accepted", "running", "cancelling"].includes(turn.phase),
    );
    if (!turn) continue;
    await page.evaluate(
      async ({ id, requestId, operatorHeader }) => {
        const key = localStorage.getItem("agent-forge-session-key");
        const token = await fetch("/__agent-forge/token", {
          headers: { "x-agent-forge-session-key": key ?? "" },
        }).then((response) => response.json());
        if (!token.ok) throw new Error("No fixture operator token");
        await fetch(`/__agent-forge/projects/${id}/keeper/stop`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [operatorHeader]: token.data.token,
          },
          body: JSON.stringify({ requestId }),
        });
      },
      {
        id: project.id,
        requestId: turn.requestId,
        operatorHeader: OPERATOR_HEADER,
      },
    );
    await expect
      .poll(() =>
        rawState(project.id).turns?.some((turn) =>
          ["accepted", "running", "cancelling"].includes(turn.phase),
        ),
      )
      .toBe(false);
  }
});

test("Ctrl+J carries the selected bead through drawer/full view into one real fake-provider turn and returns focus", async ({
  page,
}) => {
  const before = starts();
  await openSettled(
    page,
    `/index.html#/desktop/project/${alpha.id}/overview?selectionKind=bead&selectionId=alpha-epic`,
  );
  const opener = page.getByRole("button", { name: "Ask Keeper", exact: true });
  await opener.focus();
  await page.keyboard.press("Control+j");
  const drawer = page.getByRole("dialog", {
    name: "Forge Keeper · Alpha",
    exact: true,
  });
  const input = drawer.getByRole("textbox", { name: "Message the Keeper" });
  await expect(input).toBeFocused();
  await expect(
    drawer
      .getByRole("group", { name: "About context for Alpha" })
      .getByRole("link", { name: "bead alpha-epic", exact: true }),
  ).toBeVisible();
  await input.fill("Explain this selected bead");
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.screenshot({
    path: "apps/desktop/docs/screenshots/keeper-selection-drawer.png",
  });
  await drawer
    .getByRole("link", { name: "Open full conversation", exact: true })
    .click();
  const fullInput = page.getByRole("textbox", { name: "Message the Keeper" });
  await expect(fullInput).toHaveValue("Explain this selected bead");
  await expect(
    page
      .getByRole("group", { name: "About context for Alpha" })
      .getByRole("link", { name: "bead alpha-epic", exact: true }),
  ).toBeVisible();
  await fullInput.focus();
  await page.keyboard.press("Control+j");
  await expect(input).toBeFocused();
  await input.press("Control+Enter");
  await expect(
    drawer.getByRole("article", { name: "Keeper reply", exact: true }),
  ).toContainText("Scoped reply 🌱");
  await expect(
    drawer
      .getByLabel("Message context")
      .getByRole("link", { name: "bead alpha-epic", exact: true }),
  ).toBeVisible();
  const state = rawState(alpha.id);
  expect(state.frames).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        event: {
          kind: "user",
          text: "Explain this selected bead",
          about: [{ kind: "bead", id: "alpha-epic" }],
        },
      }),
    ]),
  );
  expect(starts()).toBe(before + 1);
  await page.keyboard.press("Escape");
  await expect(drawer).not.toBeVisible();
  await expect(fullInput).toBeFocused();
});

test("a shortcut during the selection render uses the new selection before effects run", async ({
  page,
}) => {
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/overview`);
  await page.evaluate(
    (projectId) =>
      new Promise<void>((resolve) => {
        const frame = document.querySelector(".af-desktop-frame");
        if (!frame) throw new Error("No desktop frame");
        const observer = new MutationObserver(() => {
          if (frame.getAttribute("data-selection-id") !== "alpha-epic") return;
          observer.disconnect();
          window.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "j",
              ctrlKey: true,
              bubbles: true,
              cancelable: true,
            }),
          );
          resolve();
        });
        observer.observe(frame, {
          attributes: true,
          attributeFilter: ["data-selection-id"],
        });
        location.hash = `/desktop/project/${projectId}/overview?selectionKind=bead&selectionId=alpha-epic`;
      }),
    alpha.id,
  );
  const drawer = page.getByRole("dialog", {
    name: "Forge Keeper · Alpha",
    exact: true,
  });
  await expect(
    drawer
      .getByRole("group", { name: "About context for Alpha" })
      .getByRole("link", { name: "bead alpha-epic", exact: true }),
  ).toBeVisible();
});

test("a pending context read holds Send and mention source errors recover after an explicit edit", async ({
  page,
}) => {
  const before = starts();
  let release = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  await page.route("**/keeper/read?*", async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get("id") === "alpha-epic" && !held) {
      held = true;
      await waiting;
    }
    await route.continue();
  });
  await openSettled(
    page,
    `/index.html#/desktop/project/${alpha.id}/overview?selectionKind=bead&selectionId=alpha-epic`,
  );
  await page.keyboard.press("Meta+j");
  const drawer = page.getByRole("dialog", {
    name: "Forge Keeper · Alpha",
    exact: true,
  });
  const input = drawer.getByRole("textbox", { name: "Message the Keeper" });
  await input.fill("Explain this");
  await expect(
    drawer.getByRole("group", { name: "About context for Alpha" }),
  ).toContainText("Checking scope…");
  await expect(
    drawer.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled();
  release();
  await expect(
    drawer.getByRole("button", { name: "Send", exact: true }),
  ).toBeEnabled();
  await page.unroute("**/keeper/read?*");
  await page.route("**/keeper/read?*", (route) =>
    route.fulfill({
      status: 503,
      json: { ok: false, data: null, error: "Fixture source unavailable" },
    }),
  );
  await input.fill("@session:");
  const mentions = drawer.getByRole("group", { name: "Mention suggestions" });
  await expect(mentions).toContainText("Mentions could not be read.");
  await page.unroute("**/keeper/read?*");
  await input.fill("@bead:alpha");
  await expect(
    mentions.getByRole("button", {
      name: "bead alpha-epic Alpha epic",
      exact: true,
    }),
  ).toBeVisible();
  expect(starts()).toBe(before);
});

test("a late mention index cannot replace a newer object kind's suggestions", async ({
  page,
}) => {
  seedSessions();
  let release = () => {};
  let started = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/keeper/read?*", async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get("kind") === "beads" && !query.has("id")) {
      const response = await route.fetch();
      started();
      await waiting;
      await route.fulfill({ response });
    } else await route.continue();
  });
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/keeper`);
  const input = page.getByRole("textbox", { name: "Message the Keeper" });
  await input.fill("@bead:alpha");
  await reading;
  await input.fill("@session:e2e-alpha");
  const mentions = page.getByRole("group", { name: "Mention suggestions" });
  await expect(
    mentions.getByRole("button", { name: /session e2e-alpha-parent/ }),
  ).toBeVisible();
  const delayed = page.waitForResponse(
    (response) =>
      response.url().includes("/keeper/read?") &&
      new URL(response.url()).searchParams.get("kind") === "beads",
  );
  release();
  await delayed;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  await expect(
    mentions.getByRole("button", { name: /session e2e-alpha-parent/ }),
  ).toBeVisible();
  await expect(
    mentions.getByRole("button", { name: /bead alpha-epic/ }),
  ).toHaveCount(0);
});

test("mentions and harness commands edit the shared draft with keyboard suggestions, empty results and no automatic starts", async ({
  page,
}) => {
  const before = starts();
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/overview`);
  await page.getByRole("button", { name: "Ask Keeper", exact: true }).click();
  const drawer = page.getByRole("dialog", {
    name: "Forge Keeper · Alpha",
    exact: true,
  });
  const input = drawer.getByRole("textbox", { name: "Message the Keeper" });
  await expect(
    drawer.getByRole("group", { name: "About context for Alpha" }),
  ).toHaveCount(0);
  await input.fill("Explain @bead:alpha");
  const mentions = drawer.getByRole("group", { name: "Mention suggestions" });
  await expect(
    mentions.getByRole("button", {
      name: "bead alpha-epic Alpha epic",
      exact: true,
    }),
  ).toBeVisible();
  await input.press("ArrowDown");
  await page.screenshot({
    path: "apps/desktop/docs/screenshots/keeper-mentions.png",
  });
  await page.keyboard.press("Enter");
  await expect(input).toHaveValue("Explain @bead:alpha-epic ");
  await expect(
    drawer
      .getByRole("group", { name: "About context for Alpha" })
      .getByRole("link", { name: "bead alpha-epic", exact: true }),
  ).toBeVisible();
  await input.fill("/forge");
  const commands = drawer.getByRole("group", { name: "Harness commands" });
  await commands
    .getByRole("button", { name: "/forge-plan", exact: false })
    .click();
  await expect(input).toHaveValue("/forge-plan ");
  expect(starts()).toBe(before);
  await input.fill("@bead:no-such-id");
  await expect(mentions).toContainText(
    "No matching objects in the available project read.",
  );
  await input.press("Escape");
  await expect(mentions).not.toBeVisible();
  await expect(drawer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).not.toBeVisible();
  expect(starts()).toBe(before);
});

test("a foreign selected bead holds Send until removed, while the session inspector attaches its actual scoped session", async ({
  page,
}) => {
  const before = starts();
  seedSessions();
  await openSettled(
    page,
    `/index.html#/desktop/project/${alpha.id}/overview?selectionKind=bead&selectionId=beta-epic`,
  );
  await page.keyboard.press("Control+j");
  const drawer = page.getByRole("dialog", {
    name: "Forge Keeper · Alpha",
    exact: true,
  });
  await drawer
    .getByRole("textbox", { name: "Message the Keeper" })
    .fill("Explain this");
  await expect(
    drawer.getByRole("group", { name: "About context for Alpha" }),
  ).toContainText("Unavailable");
  await expect(
    drawer.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled();
  await drawer
    .getByRole("button", { name: "Remove bead beta-epic context", exact: true })
    .click();
  await expect(
    drawer.getByRole("button", { name: "Send", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await openSettled(
    page,
    `/index.html#/desktop/project/${alpha.id}/sessions?selectionKind=session&selectionId=e2e-alpha-parent`,
  );
  const ask = page.getByRole("button", {
    name: "Ask Keeper about this session",
    exact: true,
  });
  await ask.click();
  await expect(
    drawer
      .getByRole("group", { name: "About context for Alpha" })
      .getByRole("link", { name: "session e2e-alpha-parent", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(ask).toBeFocused();
  expect(starts()).toBe(before);
});

test("a question streams through the fake CLI and scoped reader, persists on reload, and shares its draft with the drawer", async ({
  page,
}) => {
  const before = starts();
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/keeper`);
  await expect(
    page.getByText("Your Keeper for Alpha", { exact: true }),
  ).toBeVisible();
  expect(starts()).toBe(before);
  const input = page.getByRole("textbox", { name: "Message the Keeper" });
  await input.fill('What is scoped?\nKeep "quotes" and 🌱');
  await input.press("Control+Enter");
  await expect(
    page.getByRole("article", { name: "Keeper reply", exact: true }),
  ).toContainText("Scoped reply 🌱");
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled();
  await page.getByText(/What the Keeper looked at/).click();
  await expect(page.locator(".af-keeper-object-links")).toContainText(
    "alpha-epic",
  );
  await expect(page.locator(".af-keeper-object-links")).not.toContainText(
    "beta-epic",
  );
  await expect.poll(starts).toBe(before + 1);
  await input.fill("Draft survives the drawer");
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: "Ask Keeper", exact: true }).click();
  const drawer = page.getByRole("dialog", {
    name: "Forge Keeper · Alpha",
    exact: true,
  });
  await expect(
    drawer.getByRole("textbox", { name: "Message the Keeper" }),
  ).toHaveValue("Draft survives the drawer");
  await drawer
    .getByRole("textbox", { name: "Message the Keeper" })
    .fill("Updated shared draft");
  await page.keyboard.press("Escape");
  await expect(drawer).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Ask Keeper", exact: true }),
  ).toBeFocused();
  await page.getByRole("link", { name: "Forge Keeper", exact: true }).click();
  await expect(input).toHaveValue("Updated shared draft");
  await page.reload({ waitUntil: "load" });
  await expect(
    page.getByRole("article", { name: "Keeper reply", exact: true }),
  ).toContainText("Scoped reply 🌱");
  expect(starts()).toBe(before + 1);
  await page.screenshot({
    path: "apps/desktop/docs/screenshots/keeper-conversation.png",
  });
});

test("switching project rejects late conversation frames and keeps project drafts separate", async ({
  page,
}) => {
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/keeper`);
  const input = page.getByRole("textbox", { name: "Message the Keeper" });
  await input.fill("Alpha draft");
  await page.goto(`/index.html#/desktop/project/${beta.id}/keeper`, {
    waitUntil: "load",
  });
  await expect(
    page.getByRole("region", { name: "Keeper conversation for Beta" }),
  ).toBeVisible();
  await expect(input).toHaveValue("");
  await input.fill("Beta draft");
  await page.goBack();
  await expect(
    page.getByRole("region", { name: "Keeper conversation for Alpha" }),
  ).toBeVisible();
  await expect(input).toHaveValue("Alpha draft");
  expect(rawState(beta.id).turns ?? []).toEqual([]);
});

test("losing the send response reconciles the original request and cannot double-start a provider", async ({
  page,
}) => {
  const before = starts();
  await page.route("**/keeper/turns", async (route) => {
    await route.fetch();
    await route.abort("failed");
  });
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/keeper`);
  const input = page.getByRole("textbox", { name: "Message the Keeper" });
  await input.fill("Only one actual start");
  await page.getByRole("button", { name: "Send", exact: true }).dblclick();
  await expect(
    page.getByRole("article", { name: "Keeper reply", exact: true }),
  ).toContainText("Scoped reply 🌱");
  await expect.poll(() => rawState(alpha.id).turns?.length).toBe(1);
  expect(starts()).toBe(before + 1);
  await expect(
    page.getByText("The original request is recorded in this conversation.", {
      exact: true,
    }),
  ).toBeVisible();
});

test("closing the drawer leaves generation running until explicit Stop confirms cancellation", async ({
  page,
}) => {
  writeFileSync(
    join(HEARTH_HOME, "keeper-fixture-mode.json"),
    JSON.stringify("hang"),
  );
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/overview`);
  await page.getByRole("button", { name: "Ask Keeper", exact: true }).click();
  const drawer = page.getByRole("dialog", {
    name: "Forge Keeper · Alpha",
    exact: true,
  });
  await drawer
    .getByRole("textbox", { name: "Message the Keeper" })
    .fill("Keep answering until I stop");
  await drawer.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    drawer.getByRole("article", { name: "Keeper reply", exact: true }),
  ).toContainText("Scoped reply 🌱");
  await page.keyboard.press("Escape");
  expect(rawState(alpha.id).turns?.[0]?.phase).toBe("running");
  await page.getByRole("button", { name: "Ask Keeper", exact: true }).click();
  await drawer.getByRole("button", { name: "Stop", exact: true }).click();
  await expect
    .poll(() => rawState(alpha.id).turns?.[0]?.phase)
    .toBe("cancelled");
  await expect(drawer.getByText(/Stopped\./)).toBeVisible();
  await page.screenshot({
    path: "apps/desktop/docs/screenshots/keeper-drawer.png",
  });
});

test("recorded incomplete reads and near-full context stay explicit; Markdown and keyboard controls work at 1100 by 700", async ({
  page,
}) => {
  const before = starts();
  const at = "2026-10-22T00:00:00.000Z";
  seedKeeper([
    {
      kind: "text",
      text: '# Recorded fixture\n\n| Bead | Status |\n| --- | --- |\n| `alpha-epic` | Open |\n\n```html\n<script>window.__keeperLeak = true</script>\n```\n<img src=x onerror="window.__keeperLeak=true">\n[bad](javascript:alert)',
    },
    {
      kind: "read",
      query: "queue",
      source: "Synthetic unavailable queue",
      asOf: at,
      complete: false,
      reason:
        "The Keeper could not read the queue. The answer may be incomplete.",
      ids: [],
      nextCursor: null,
    },
    {
      kind: "context",
      used: 90,
      capacity: 100,
      basis: "reported",
      source: "Synthetic recorded context measurement",
      asOf: at,
    },
  ]);
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/keeper`);
  const conversation = page.getByRole("region", {
    name: "Keeper conversation for Alpha",
  });
  await expect(
    conversation.getByText("Context 90%", { exact: true }),
  ).toBeVisible();
  await expect(
    conversation.getByText(/Conversation context is nearly full/),
  ).toBeVisible();
  await conversation.getByText(/What the Keeper looked at/).click();
  await expect(
    conversation.getByText(
      "The Keeper could not read the queue. The answer may be incomplete.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(conversation.locator("table")).toContainText("alpha-epic");
  await expect(conversation.locator("script, img")).toHaveCount(0);
  expect(await page.evaluate(() => Object.hasOwn(window, "__keeperLeak"))).toBe(
    false,
  );
  const input = conversation.getByRole("textbox", {
    name: "Message the Keeper",
  });
  await input.fill("A keyboard-accessible draft");
  await input.press("Tab");
  const send = conversation.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeFocused();
  expect(
    await send.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      return (
        rect.top >= 0 && rect.bottom <= innerHeight && rect.right <= innerWidth
      );
    }),
  ).toBe(true);
  expect(
    await send.evaluate((button) => getComputedStyle(button).outlineWidth),
  ).toBe("2px");
  expect(
    await conversation.evaluate(
      (node) => getComputedStyle(node).scrollBehavior,
    ),
  ).toBe("auto");
  expect(starts()).toBe(before);
  await page.screenshot({
    path: "apps/desktop/docs/screenshots/keeper-1100.png",
  });
});

test("an unanswered Stop can be retried explicitly against its original turn", async ({
  page,
}) => {
  writeFileSync(
    join(HEARTH_HOME, "keeper-fixture-mode.json"),
    JSON.stringify("hang"),
  );
  const before = starts();
  let stops = 0;
  await page.route("**/keeper/stop", (route) =>
    ++stops === 1 ? route.abort("failed") : route.continue(),
  );
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/keeper`);
  await page
    .getByRole("textbox", { name: "Message the Keeper" })
    .fill("Keep answering until an explicit stop");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByRole("article", { name: "Keeper reply", exact: true }),
  ).toContainText("Scoped reply 🌱");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry stop", exact: true }),
  ).toBeVisible();
  expect(rawState(alpha.id).turns?.[0]?.phase).toBe("running");
  await page.getByRole("button", { name: "Retry stop", exact: true }).click();
  await expect
    .poll(() => rawState(alpha.id).turns?.[0]?.phase)
    .toBe("cancelled");
  await expect(
    page.getByText("Stop confirmed.", { exact: true }),
  ).toBeVisible();
  expect(starts()).toBe(before + 1);
  expect(rawState(alpha.id).turns).toHaveLength(1);
});

test("an unavailable private feed ends loading and explicit reload recovers without starting a provider", async ({
  page,
}) => {
  const before = starts();
  await page.route("**/keeper/events", (route) =>
    route.fulfill({
      status: 503,
      json: {
        ok: false,
        data: null,
        error: "Synthetic unavailable private feed",
      },
    }),
  );
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/keeper`);
  await expect(
    page.getByText(
      "Conversation live updates are unavailable. Reload the conversation to check again.",
      { exact: true },
    ),
  ).toBeVisible({ timeout: 25_000 });
  await expect(
    page.getByText("Loading the saved conversation…", { exact: true }),
  ).not.toBeVisible();
  await page.unroute("**/keeper/events");
  await page
    .getByRole("button", { name: "Reload conversation", exact: true })
    .click();
  await expect(
    page.getByText("Your Keeper for Alpha", { exact: true }),
  ).toBeVisible();
  expect(starts()).toBe(before);
});
