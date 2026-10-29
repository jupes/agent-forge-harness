import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { OPERATOR_HEADER } from "../../scripts/hearth/paths";
import { openSettled, reloadSettled } from "../e2e/fixtures";
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
  await page.unroute("**/keeper/stop");
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

test("the session list stops only its selected owned Keeper turn and keeps observed sessions ineligible", async ({
  page,
}) => {
  seedSessions();
  const before = starts();
  writeFileSync(
    join(HEARTH_HOME, "keeper-fixture-mode.json"),
    JSON.stringify("hang"),
  );
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/keeper`);
  await page
    .getByRole("textbox", { name: "Message the Keeper" })
    .fill("Session-list owned Stop fixture");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByRole("article", { name: "Keeper reply", exact: true }),
  ).toContainText("Scoped reply");
  await page
    .getByRole("link", { name: "Sessions", exact: true })
    .first()
    .click();
  const owned = page.getByRole("region", {
    name: "Owned Keeper session",
    exact: true,
  });
  await expect(owned).toContainText("claude");
  await expect(owned).toContainText("running");
  await page
    .getByRole("checkbox", { name: "Select e2e-alpha-parent", exact: true })
    .check();
  await owned.getByRole("checkbox").check();
  await expect(owned).toContainText("1 eligible");
  await expect(owned).toContainText("read-only");
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const stop = owned.getByRole("button", {
    name: "Stop selected",
    exact: true,
  });
  await owned.getByRole("checkbox").focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(stop).toBeFocused();
  expect(
    await stop.evaluate((node) => getComputedStyle(node).outlineWidth),
  ).toBe("2px");
  await page.screenshot({
    path: "apps/desktop/docs/screenshots/keeper-session-controls.png",
  });
  await page.keyboard.press("Enter");
  await expect(owned).toContainText("Stop confirmed");
  await expect
    .poll(() => rawState(alpha.id).turns?.[0]?.phase)
    .toBe("cancelled");
  await expect(
    page.getByRole("checkbox", {
      name: "Select e2e-alpha-parent",
      exact: true,
    }),
  ).toBeChecked();
  await expect(
    page.getByRole("link", { name: "Open e2e-alpha-parent", exact: true }),
  ).toBeVisible();
  expect(starts()).toBe(before + 1);
});

test("a lost session-list Stop is held and retried against its original turn even when the independent overview source is unavailable", async ({
  page,
}) => {
  const before = starts();
  writeFileSync(
    join(HEARTH_HOME, "keeper-fixture-mode.json"),
    JSON.stringify("hang"),
  );
  const stops: string[] = [];
  // The app-root observation cache now has its own protected source. Fail it
  // before the first read while keeping the independent Keeper controls live.
  await page.route(`**/projects/${alpha.id}/session-observations`, (route) =>
    route.fulfill({
      status: 503,
      json: {
        ok: false,
        data: null,
        error: "Synthetic session observations unavailable",
      },
    }),
  );
  await page.route("**/keeper/stop", (route) => {
    stops.push(route.request().postData() ?? "");
    return stops.length === 1 ? route.abort("failed") : route.continue();
  });
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/keeper`);
  await page
    .getByRole("textbox", { name: "Message the Keeper" })
    .fill("Owned Stop while observational metadata is unavailable");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByRole("article", { name: "Keeper reply", exact: true }),
  ).toContainText("Scoped reply");
  await page.route("**/overview", (route) =>
    route.fulfill({
      status: 503,
      json: { ok: false, data: null, error: "Synthetic overview unavailable" },
    }),
  );
  await page
    .getByRole("link", { name: "Sessions", exact: true })
    .first()
    .click();
  const owned = page.getByRole("region", {
    name: "Owned Keeper session",
    exact: true,
  });
  await expect(
    page
      .locator(".af-project-sessions")
      .getByText("Sessions unavailable", { exact: true }),
  ).toBeVisible();
  await owned.getByRole("checkbox").check();
  const stop = owned.getByRole("button", {
    name: "Stop selected",
    exact: true,
  });
  await stop.click();
  await expect(stop).toBeDisabled();
  await expect(
    owned.getByRole("button", { name: "Retry original Stop", exact: true }),
  ).toBeVisible();
  await owned
    .getByRole("button", { name: "Check selected Stop", exact: true })
    .click();
  await owned
    .getByRole("button", { name: "Retry original Stop", exact: true })
    .click();
  await expect(owned).toContainText("Stop confirmed");
  expect(stops).toHaveLength(2);
  expect(stops[1]).toBe(stops[0]);
  expect(starts()).toBe(before + 1);
});

test("reviewed brief uses the standing conversation, recovers its original, and supports earlier briefs and a quoted follow-up", async ({
  page,
}) => {
  const before = starts();
  seedSessions();
  writeFileSync(
    join(HEARTH_HOME, "keeper-fixture-mode.json"),
    JSON.stringify("brief"),
  );
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/overview`);
  const panel = page.getByRole("region", { name: "Keeper brief", exact: true });
  await expect(panel).toContainText("No confirmed brief yet");
  const review = panel.getByRole("button", {
    name: "Review a brief",
    exact: true,
  });
  await expect(review).toBeEnabled();
  const reserveResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith(
        "/keeper/brief-intents/reserve",
      ) && response.request().method() === "POST",
  );
  await review.focus();
  await page.keyboard.press("Enter");
  const reserved = await reserveResponse;
  expect(reserved.status()).toBe(202);
  await expect(
    panel.getByRole("region", { name: "Exact Keeper brief original" }),
  ).toBeVisible();
  const canonicalRequestId = await panel
    .locator(".af-brief-review dd")
    .first()
    .textContent();
  expect(canonicalRequestId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );
  await expect.poll(starts).toBe(before);
  await reloadSettled(page);
  const recoveredPanel = page.getByRole("region", {
    name: "Keeper brief",
    exact: true,
  });
  await expect(recoveredPanel).toContainText("No confirmed brief yet");
  await expect(
    recoveredPanel.getByRole("button", { name: "Review saved brief" }),
  ).toBeEnabled();
  await recoveredPanel
    .getByRole("button", { name: "Review saved brief" })
    .click();
  await expect(
    recoveredPanel.getByRole("region", {
      name: "Exact Keeper brief original",
    }),
  ).toBeVisible();
  await expect(
    recoveredPanel.locator(".af-brief-review dd").first(),
  ).toHaveText(canonicalRequestId ?? "");
  await expect.poll(starts).toBe(before);
  const firstCommitResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/keeper/briefs") &&
      response.request().method() === "POST",
  );
  await recoveredPanel
    .getByRole("button", { name: "Send reviewed brief" })
    .click();
  expect((await firstCommitResponse).status()).toBe(202);
  const card = panel.getByRole("article", {
    name: "Keeper brief card",
    exact: true,
  });
  await expect(card).toContainText("Alpha:");
  await expect(card).toContainText("Moving");
  await expect(card).toContainText("Waiting on you");
  await expect(card).toContainText("Stuck");
  await expect(card).toContainText("project:alpha");
  await expect(card).toContainText("session.started");
  await expect(card).not.toContainText("beta-epic");
  const first = await card.getAttribute("data-brief-id");
  const sourceTime = await card
    .locator("time")
    .first()
    .getAttribute("datetime");
  await expect.poll(starts).toBe(before + 1);
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.screenshot({
    path: "apps/desktop/docs/screenshots/keeper-brief-overview.png",
  });
  await recoveredPanel
    .getByRole("button", { name: "Review another brief" })
    .click();
  await expect(
    recoveredPanel.getByRole("region", {
      name: "Exact Keeper brief original",
    }),
  ).toBeVisible();
  await recoveredPanel
    .getByRole("button", { name: "Send reviewed brief" })
    .click();
  await expect(card).not.toHaveAttribute("data-brief-id", first ?? "");
  await expect(panel.getByLabel("Earlier briefs")).toBeVisible();
  await panel.getByLabel("Earlier briefs").selectOption(first ?? "");
  await expect(card).toHaveAttribute("data-brief-id", first ?? "");
  await expect(card.locator("time").first()).toHaveAttribute(
    "datetime",
    sourceTime ?? "",
  );
  await panel.getByLabel("Earlier briefs").selectOption("");
  const latest = await card.getAttribute("data-brief-id");
  writeFileSync(
    join(HEARTH_HOME, "keeper-fixture-mode.json"),
    JSON.stringify("brief-failed"),
  );
  await recoveredPanel
    .getByRole("button", { name: "Review another brief" })
    .click();
  await recoveredPanel
    .getByRole("button", { name: "Send reviewed brief" })
    .click();
  await expect(panel).toContainText("previous brief has been kept");
  await expect(card).toHaveAttribute("data-brief-id", latest ?? "");
  writeFileSync(
    join(HEARTH_HOME, "keeper-fixture-mode.json"),
    JSON.stringify("brief"),
  );
  await page.route("**/keeper/briefs", (route) =>
    route.request().method() === "GET"
      ? route.abort("failed")
      : route.continue(),
  );
  await recoveredPanel
    .getByRole("button", { name: "Review another brief" })
    .click();
  await recoveredPanel
    .getByRole("button", { name: "Send reviewed brief" })
    .click();
  await expect(panel).toContainText("brief read could not be verified");
  await expect(card).toHaveAttribute("data-brief-id", latest ?? "");
  await expect
    .poll(() => rawState(alpha.id).turns?.at(-1)?.phase)
    .toBe("completed");
  // Keep the synthetic failure through the terminal stream update and its
  // coalesced read; otherwise that queued read can heal before the retry click.
  await expect(recoveredPanel).toHaveAttribute("aria-busy", "false");
  await expect(
    panel.getByRole("button", { name: "Retry brief read", exact: true }),
  ).toBeVisible();
  await page.unroute("**/keeper/briefs");
  await recoveredPanel
    .getByRole("button", { name: "Retry brief read", exact: true })
    .click();
  await expect(card).not.toHaveAttribute("data-brief-id", latest ?? "");
  await card
    .getByRole("link", { name: "Ask a follow-up", exact: true })
    .click();
  const input = page.getByRole("textbox", {
    name: "Message the Keeper",
    exact: true,
  });
  await expect(input).toHaveValue(/Brief as of .*Alpha:/s);
  await expect(
    page
      .getByRole("region", { name: "Conversation history" })
      .getByRole("article", { name: "Keeper brief card" })
      .first(),
  ).toBeVisible();
  await expect.poll(starts).toBe(before + 4);
  await page
    .getByRole("link", { name: "Projects", exact: true })
    .first()
    .click();
  await expect(
    page
      .getByRole("article", { name: "Alpha", exact: true })
      .locator(".af-project-keeper"),
  ).toContainText("Alpha:");
  await expect(
    page
      .getByRole("article", { name: "Beta", exact: true })
      .locator(".af-project-keeper"),
  ).not.toContainText("Alpha:");
  expect(starts()).toBe(before + 4);
});

test("a refused and lost reviewed commit stays tied to its exact saved original", async ({
  page,
}) => {
  const before = starts();
  writeFileSync(
    join(HEARTH_HOME, "keeper-fixture-mode.json"),
    JSON.stringify("brief"),
  );
  const bodies: string[] = [];
  let mode: "refused" | "lost" | "success" = "refused";
  await page.route("**/keeper/briefs", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    bodies.push(route.request().postData() ?? "");
    if (mode === "refused")
      return route.fulfill({
        status: 409,
        json: {
          ok: false,
          data: null,
          error: "Synthetic provider unavailable; no turn accepted.",
        },
      });
    if (mode === "lost") return route.abort("failed");
    return route.continue();
  });
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/overview`);
  const panel = page.getByRole("region", { name: "Keeper brief", exact: true });
  const review = panel.getByRole("button", {
    name: "Review a brief",
    exact: true,
  });
  await expect(review).toBeEnabled();
  await review.click();
  await expect(
    panel.getByRole("region", { name: "Exact Keeper brief original" }),
  ).toBeVisible();
  const send = panel.getByRole("button", { name: "Send reviewed brief" });
  await send.click();
  await expect(panel).toContainText("Synthetic provider unavailable");
  expect(starts()).toBe(before);
  mode = "lost";
  await send.click();
  await expect(
    panel.getByRole("button", { name: "Check saved original", exact: true }),
  ).toBeVisible();
  await expect(send).toBeHidden();
  await panel.getByRole("button", { name: "Check saved original" }).click();
  await expect(
    panel.getByRole("button", { name: "Review saved brief" }),
  ).toBeEnabled();
  await panel.getByRole("button", { name: "Review saved brief" }).click();
  await expect(
    panel.getByRole("region", { name: "Exact Keeper brief original" }),
  ).toBeVisible();
  mode = "success";
  await panel.getByRole("button", { name: "Send reviewed brief" }).click();
  await expect(
    panel.getByRole("article", { name: "Keeper brief card", exact: true }),
  ).toContainText("Alpha:");
  expect(bodies).toHaveLength(3);
  expect(bodies[2]).toBe(bodies[1]);
  expect(starts()).toBe(before + 1);
  expect(rawState(alpha.id).turns).toHaveLength(1);
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

test("returning to the full view synchronizes the native dialog before another shortcut", async ({
  page,
}) => {
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/overview`);
  await page.getByRole("button", { name: "Ask Keeper", exact: true }).click();
  const drawer = page.getByRole("dialog", {
    name: "Forge Keeper · Alpha",
    exact: true,
  });
  await expect(
    drawer.getByRole("textbox", { name: "Message the Keeper" }),
  ).toBeFocused();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const frame = document.querySelector(".af-desktop-frame");
        const link = document.querySelector<HTMLAnchorElement>(
          ".af-keeper-drawer-link a",
        );
        if (!frame || !link) throw new Error("No full-view handoff");
        const observer = new MutationObserver(() => {
          if (frame.getAttribute("data-destination") !== "keeper") return;
          observer.disconnect();
          document
            .querySelector<HTMLTextAreaElement>(".af-desktop-main textarea")
            ?.focus();
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
          attributeFilter: ["data-destination"],
        });
        link.click();
      }),
  );
  await expect(
    drawer.getByRole("textbox", { name: "Message the Keeper" }),
  ).toBeFocused();
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
