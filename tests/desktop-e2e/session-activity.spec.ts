import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { OPERATOR_HEADER } from "../../scripts/hearth/paths";
import { ownedCodingStateSchema } from "../../scripts/sessions/codex-owned-journal";
import { ownedCodingSessionSchema } from "../../scripts/sessions/codex-owned-wire-protocol";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import { pageToken } from "../e2e/launch-link";
import { HEARTH_HOME } from "../e2e/servers";
import { alpha, seedProjects, workspace } from "./project-fixtures";
import { observePreviewIdentityRefresh } from "./session-start-refresh-barrier";

function records() {
  try {
    const value = JSON.parse(
      readFileSync(join(HEARTH_HOME, "sessions", "registry.json"), "utf8"),
    );
    return ownedCodingSessionSchema.array().parse(value.records);
  } catch {
    return [];
  }
}
function journal(id: string) {
  try {
    return ownedCodingStateSchema.parse(
      JSON.parse(
        readFileSync(join(HEARTH_HOME, "conversations", `${id}.json`), "utf8"),
      ),
    );
  } catch {
    throw Error("The isolated activity journal is unavailable.");
  }
}
function mode(provider: "claude" | "codex", value: string) {
  writeFileSync(
    join(
      HEARTH_HOME,
      provider === "claude"
        ? "coding-fixture-mode.json"
        : "codex-fixture-mode.json",
    ),
    JSON.stringify(value),
  );
}
let previous = new Set<string>();
test.beforeEach(() => {
  seedProjects();
  previous = new Set(records().map((record) => record.id));
  mode("claude", "normal");
  mode("codex", "normal");
});
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  for (const record of records().filter((record) => !previous.has(record.id))) {
    const turn = journal(record.id).turns.find((item) =>
      ["accepted", "running", "cancelling"].includes(item.phase),
    );
    if (!turn) continue;
    const token = await pageToken(page);
    await page.evaluate(
      async ({ projectId, sessionId, requestId, token, header }) => {
        await fetch(
          `/__agent-forge/projects/${projectId}/sessions/${sessionId}/stop`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", [header]: token },
            body: JSON.stringify({ requestId }),
          },
        );
      },
      {
        projectId: record.projectId,
        sessionId: record.id,
        requestId: turn.requestId,
        token,
        header: OPERATOR_HEADER,
      },
    );
    await expect
      .poll(() =>
        journal(record.id).turns.some((item) =>
          ["accepted", "running", "cancelling"].includes(item.phase),
        ),
      )
      .toBe(false);
  }
});

async function start(page: Page, provider: "claude" | "codex" = "claude") {
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/sessions`);
  await page.getByRole("button", { name: "New session", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "New session · Alpha",
    exact: true,
  });
  if (provider === "codex")
    await dialog.getByRole("button", { name: /Cx · Codex/ }).click();
  await expect(
    dialog.getByRole("combobox", { name: "Session smith", exact: true }),
  ).toHaveValue(`${provider}-journeyman`);
  await dialog
    .getByRole("textbox", { name: "Session prompt", exact: true })
    .fill("Inspect private session activity");
  if (provider === "claude")
    await dialog
      .getByRole("combobox", { name: "Session mode", exact: true })
      .selectOption("task");
  await dialog
    .getByRole("combobox", { name: "Session effort", exact: true })
    .selectOption("");
  const identityRefresh = await observePreviewIdentityRefresh(
    page,
    alpha.id,
    workspace,
    { holdResponse: false },
  );
  await dialog
    .getByRole("button", { name: "Check supported options", exact: true })
    .click();
  await expect.poll(() => identityRefresh.isObserved).toBe(true);
  await identityRefresh.settledRead;
  const identityRegion = dialog.getByRole("region", {
    name: "Original Start requests",
    exact: true,
  });
  await expect(
    identityRegion
      .getByRole("status")
      .filter({ hasText: "Checking the server-owned identity page" }),
  ).not.toBeVisible();
  await expect(
    identityRegion.getByRole("button", { name: "Check server", exact: true }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Session conversation", exact: true }),
  ).toBeVisible();
  const record = records().find((item) => !previous.has(item.id));
  if (!record) throw Error("No isolated owned session was admitted.");
  return record;
}

test("Start waits for the protected identity refresh emitted by preview", async ({
  page,
}) => {
  const before = records().length;
  let identityPosts = 0;
  let startPosts = 0;
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const path = new URL(request.url()).pathname;
    if (path === `/__agent-forge/projects/${alpha.id}/session-start-identities`)
      identityPosts++;
    if (path === `/__agent-forge/projects/${alpha.id}/sessions`) startPosts++;
  });
  mode("codex", "rich");
  const identityRefresh = await observePreviewIdentityRefresh(
    page,
    alpha.id,
    workspace,
    { holdResponse: true },
  );
  try {
    await openSettled(
      page,
      `/index.html#/desktop/project/${alpha.id}/sessions`,
    );
    await page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "New session · Alpha",
      exact: true,
    });
    await dialog.getByRole("button", { name: /Cx · Codex/ }).click();
    await expect(
      dialog.getByRole("combobox", { name: "Session smith", exact: true }),
    ).toHaveValue("codex-journeyman");
    await expect(
      dialog.getByRole("textbox", { name: "Session model", exact: true }),
    ).toHaveValue("gpt-5-codex");
    await dialog
      .getByRole("textbox", { name: "Session prompt", exact: true })
      .fill("Inspect private session activity");
    await dialog
      .getByRole("combobox", { name: "Session effort", exact: true })
      .selectOption("");
    await expect(
      dialog.getByRole("combobox", { name: "Session effort", exact: true }),
    ).toHaveValue("");

    await dialog
      .getByRole("button", { name: "Check supported options", exact: true })
      .click();
    await expect(
      dialog.getByRole("region", {
        name: "Equivalent session command",
        exact: true,
      }),
    ).toBeVisible();
    await expect.poll(() => identityRefresh.isHeld).toBe(true);

    const identityRegion = dialog.getByRole("region", {
      name: "Original Start requests",
      exact: true,
    });
    await expect(
      identityRegion
        .getByRole("status")
        .filter({ hasText: "Checking the server-owned identity page" }),
    ).toBeVisible();
    const startButton = dialog.getByRole("button", {
      name: "Start",
      exact: true,
    });
    await expect(startButton).toBeDisabled();
    await dialog
      .getByRole("textbox", { name: "Session prompt", exact: true })
      .focus();
    await page.keyboard.press("Control+Enter");
    expect(identityRefresh.isHeld).toBe(true);
    expect(identityPosts).toBe(0);
    expect(startPosts).toBe(0);
    expect(records()).toHaveLength(before);
  } finally {
    identityRefresh.release();
  }

  const dialog = page.getByRole("dialog", {
    name: "New session · Alpha",
    exact: true,
  });
  await expect(
    dialog
      .getByRole("region", {
        name: "Original Start requests",
        exact: true,
      })
      .getByRole("status")
      .filter({ hasText: "Checking the server-owned identity page" }),
  ).not.toBeVisible();
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Session conversation", exact: true }),
  ).toBeVisible();
  expect(identityPosts).toBe(1);
  expect(startPosts).toBe(1);
  expect(records()).toHaveLength(before + 1);
});

test("private Claude activity reloads with collapsed reasoning, inert tool/diff/JSON, exact per-turn usage and keyboard focus at 1100", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  mode("claude", "rich");
  const record = await start(page);
  await expect(page.locator("[data-session-state]")).toHaveAttribute(
    "data-session-state",
    "ended",
  );
  const region = page.getByRole("region", {
    name: "Reported session activity",
    exact: true,
  });
  await expect(region).toBeVisible();
  const reasoning = region.locator("details").filter({
    has: page.locator("summary", { hasText: /^Reported reasoning$/ }),
  });
  await expect(reasoning).not.toHaveAttribute("open", "");
  await reasoning.locator("summary").focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(reasoning.locator("summary")).toBeFocused();
  await expect(reasoning.locator("summary")).toHaveCSS("outline-width", "2px");
  await reasoning.locator("summary").press("Enter");
  await expect(reasoning).toContainText("Private reported reasoning");
  const command = region
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: /^Command/ }) });
  await command.locator("summary").click();
  await expect(command).toContainText("Private command output");
  await expect(command).toContainText("Exit code not reported");
  const files = region
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: /^Files changed/ }) });
  await files.locator("summary").click();
  await expect(files).toContainText("-Private old");
  await expect(files).toContainText("+1 · −1");
  await region.locator("summary").filter({ hasText: /^Plan/ }).click();
  await expect(region).toContainText("Private plan");
  const structured = region.locator("details").filter({
    has: page.locator("summary", { hasText: /^Structured output/ }),
  });
  await structured.locator("summary").click();
  await expect(structured).toContainText("<script>inert</script>");
  await expect(structured.locator("script")).toHaveCount(0);
  const denials = region.locator("details").filter({
    has: page.locator("summary", { hasText: /^Reported permission denials/ }),
  });
  await denials.locator("summary").click();
  await expect(denials).toContainText("denied-one");
  await expect(denials).toContainText("denied-two");
  await expect(denials).toContainText("not live requests");
  await expect(denials.getByRole("button")).toHaveCount(0);
  const usage = page.locator(".af-session-turn-usage");
  await usage.locator("summary").click();
  await expect(usage).toContainText("fixture-served-model");
  await expect(usage).toContainText("0.0001");
  await expect(usage).toContainText("Cache read tokens3");
  const saved = journal(record.id);
  await reloadSettled(page);
  await expect(page.locator("[data-session-state]")).toHaveAttribute(
    "data-session-state",
    "ended",
  );
  await expect(region).toBeVisible();
  expect(journal(record.id).binding).toEqual(saved.binding);
  expect(journal(record.id).turns).toHaveLength(1);
  await region.evaluate((node) =>
    node.closest(".af-owned-transcript")?.scrollTo({ top: 0 }),
  );
  await page.screenshot({
    path: "apps/desktop/docs/screenshots/session-activity.png",
    mask: [page.getByText(record.worktree, { exact: true })],
    style: ".af-owned-turn > time { visibility: hidden !important; }",
    maskColor: "#3f424d",
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await files.locator("summary").click();
  await files.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "apps/desktop/docs/screenshots/session-activity-diff.png",
    mask: [page.getByText(record.worktree, { exact: true })],
    style: ".af-owned-turn > time { visibility: hidden !important; }",
    maskColor: "#3f424d",
  });
});

test("native Codex exec activity keeps actual token fields while model, cost, diff counts and permission controls remain unavailable", async ({
  page,
}) => {
  mode("codex", "rich");
  const record = await start(page, "codex");
  await expect(page.locator("[data-session-state]")).toHaveAttribute(
    "data-session-state",
    "ended",
  );
  const region = page.getByRole("region", {
    name: "Reported session activity",
    exact: true,
  });
  const command = region
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: /^Command/ }) });
  await command.locator("summary").click();
  await expect(command).toContainText("Private command output");
  await expect(command).toContainText("Reported exit code: 0");
  const files = region
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: /^Files changed/ }) });
  await files.locator("summary").click();
  await expect(files).toContainText("Line counts not reported");
  await expect(files).toContainText("Diff not reported");
  const usage = page.locator(".af-session-turn-usage");
  await usage.locator("summary").click();
  await expect(usage).toContainText("Turn input tokens9");
  await expect(usage).toContainText("Turn output tokens6");
  await expect(usage).toContainText("Observed modelNot reported");
  await expect(usage).not.toContainText("cost estimate");
  await page.getByText("Session details", { exact: true }).click();
  await page.getByText("State support for this route", { exact: true }).click();
  await expect(
    page.getByText(
      "These non-interactive transports do not expose live permission requests.",
      { exact: false },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: /Allow once|Allow for this session|Deny/,
      exact: true,
    }),
  ).toHaveCount(0);
  await reloadSettled(page);
  await expect(region).toBeVisible();
  expect(
    journal(record.id).frames.some(
      (frame) => frame.event.kind === "coding-activity",
    ),
  ).toBe(true);
});

for (const [fixtureMode, outcome, title] of [
  [
    "rich-auth-error",
    "auth-error",
    "Provider reported an authentication error",
  ],
  ["rich-rate-limit", "rate-limited", "Provider reported a usage limit"],
  ["rich-crash", "cli-exit", "Provider process exited with an error"],
] as const) {
  test(`${fixtureMode} retains actual private partials and the specific reported failure after reload`, async ({
    page,
  }) => {
    mode("claude", fixtureMode);
    const record = await start(page);
    await expect
      .poll(
        () =>
          journal(record.id)
            .frames.filter((frame) => frame.event.kind === "coding-outcome")
            .at(-1)?.event,
      )
      .toMatchObject({
        code: outcome,
        ...(outcome === "cli-exit" ? { exitCode: 7 } : {}),
      });
    const result = page.locator(".af-session-outcome");
    await result.locator("summary").click();
    await expect(result).toContainText(title);
    await expect(result).not.toContainText("Stop confirmed");
    if (outcome === "cli-exit")
      await expect(result).toContainText("Private fixture crash tail");
    if (outcome === "rate-limited")
      await expect(result).toContainText(
        "Not reported. Check Providers for current allowance.",
      );
    await expect(
      page.getByRole("article", { name: "Session reply", exact: true }),
    ).toContainText("Coding reply");
    await reloadSettled(page);
    await expect(result.locator("summary")).toHaveText(title);
    expect(journal(record.id).turns).toHaveLength(1);
  });
}

for (const [fixtureMode, expectedCode, expectedState] of [
  ["rich-hang", "stopped", "stopped"],
  ["rich-timeout", "timed-out", "timed-out"],
] as const) {
  test(`${fixtureMode} preserves reported activity until actual supervised ${expectedCode} is confirmed`, async ({
    page,
  }) => {
    mode("claude", fixtureMode);
    const record = await start(page);
    const pending = page
      .getByRole("region", { name: "Reported session activity", exact: true })
      .locator("summary")
      .filter({ hasText: "Tool · Bash · Reported running" });
    await expect(pending).toBeVisible();
    if (fixtureMode === "rich-hang")
      await page
        .getByRole("button", { name: "Stop session", exact: true })
        .click();
    await expect(page.locator("[data-session-state]")).toHaveAttribute(
      "data-session-state",
      expectedState,
    );
    await expect
      .poll(
        () =>
          journal(record.id)
            .frames.filter((frame) => frame.event.kind === "coding-outcome")
            .at(-1)?.event,
      )
      .toMatchObject({
        code: expectedCode,
        stopped: expectedCode === "stopped",
        timedOut: expectedCode === "timed-out",
      });
    await reloadSettled(page);
    await expect(page.locator("[data-session-state]")).toHaveAttribute(
      "data-session-state",
      expectedState,
    );
    await expect(pending).toBeVisible();
    expect(journal(record.id).turns).toHaveLength(1);
  });
}

test("an interrupted private live feed keeps saved activity and labels it stale without guessing process death", async ({
  page,
}) => {
  mode("claude", "rich-hang");
  await page.route("**/sessions/*/events*", (route) =>
    route.abort("connectionreset"),
  );
  const record = await start(page);
  await expect
    .poll(() =>
      journal(record.id).frames.some(
        (frame) => frame.event.kind === "coding-activity",
      ),
    )
    .toBe(true);
  await reloadSettled(page);
  await expect(page.locator("[data-session-state]")).toHaveAttribute(
    "data-session-state",
    "stale",
  );
  await expect(
    page.getByText("process failure is not confirmed", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", {
      name: "Reported session activity",
      exact: true,
    }),
  ).toBeVisible();
  expect(journal(record.id).turns.at(-1)?.phase).toBe("running");
  expect(
    journal(record.id).frames.some(
      (frame) => frame.event.kind === "coding-outcome",
    ),
  ).toBe(false);
});

test("a failed protected saved read leaves an actionable read error without claiming the provider ended", async ({
  page,
}) => {
  mode("claude", "rich-hang");
  await page.route("**/sessions/*/events*", (route) =>
    route.abort("connectionreset"),
  );
  await page.route("**/sessions/session-*?*", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        data: null,
        error: "The isolated saved read is unavailable",
      }),
    }),
  );
  const record = await start(page);
  await expect(page.locator("[data-session-state]")).toContainText(
    "Saved conversation unavailable",
  );
  await expect(page.getByRole("alert")).toContainText(
    "Earlier private activity was kept",
  );
  await expect(
    page.getByRole("button", {
      name: "Reload session conversation",
      exact: true,
    }),
  ).toBeVisible();
  await expect
    .poll(() => journal(record.id).turns.at(-1)?.phase)
    .toBe("running");
  expect(
    journal(record.id).frames.some(
      (frame) => frame.event.kind === "coding-outcome",
    ),
  ).toBe(false);
});
