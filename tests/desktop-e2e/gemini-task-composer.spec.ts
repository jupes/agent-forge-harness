import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { OPERATOR_HEADER } from "../../scripts/hearth/paths";
import { ownedCodingStateSchema } from "../../scripts/sessions/codex-owned-journal";
import { ownedCodingSessionSchema } from "../../scripts/sessions/codex-owned-wire-protocol";
import { geminiTaskPreviewReceiptSchema } from "../../scripts/sessions/gemini-task-preview-protocol";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import { pageToken } from "../e2e/launch-link";
import { HEARTH_HOME } from "../e2e/servers";
import { alpha, seedProjects, workspace } from "./project-fixtures";

const log = join(HEARTH_HOME, "gemini-fixture-calls.jsonl");
function calls(): Array<{
  kind: string;
  argv?: string[];
  stdin?: string;
  pid?: number;
  childPid?: number;
}> {
  if (!existsSync(log)) return [];
  try {
    return readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    throw Error("Invalid complete inert Gemini recording");
  }
}
function records() {
  try {
    return ownedCodingSessionSchema
      .array()
      .parse(
        JSON.parse(
          readFileSync(join(HEARTH_HOME, "sessions", "registry.json"), "utf8"),
        ).records,
      );
  } catch {
    return [];
  }
}
function saved(id: string) {
  return ownedCodingStateSchema.parse(
    JSON.parse(
      readFileSync(join(HEARTH_HOME, "conversations", `${id}.json`), "utf8"),
    ),
  );
}
let previous = new Set<string>();
test.beforeEach(async ({ page }) => {
  seedProjects();
  previous = new Set(records().map((record) => record.id));
  writeFileSync(`${log}.control`, JSON.stringify({ mode: "normal" }));
  // The actual native producer has this isolated configured smith. Expose that
  // same choice to the browser without changing the suite's shared config home.
  await page.route("**/__agent-forge/smiths", async (route) => {
    const response = await route.fetch({
      headers: {
        ...(await route.request().allHeaders()),
        Origin: new URL(route.request().url()).origin,
        "Sec-Fetch-Site": "same-origin",
      },
    });
    const body = await response.json();
    if (!body.ok || !Array.isArray(body.data?.smiths))
      throw Error(
        `The real smith index did not answer (${response.status()}; ${JSON.stringify(body).slice(0, 200)})`,
      );
    await route.fulfill({
      response,
      json: {
        ...body,
        data: {
          ...body.data,
          smiths: [
            ...body.data.smiths,
            {
              name: "gemini-example",
              provider: "gemini",
              model: "configured-example",
              effort: "default",
              enabled: true,
              tags: [],
            },
            {
              name: "gemini-disabled",
              provider: "gemini",
              model: "disabled-example",
              effort: "default",
              enabled: false,
              tags: [],
            },
          ],
        },
      },
    });
  });
});
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  for (const record of records().filter((item) => !previous.has(item.id))) {
    const active = saved(record.id).turns.find((turn) =>
      ["accepted", "running", "cancelling"].includes(turn.phase),
    );
    if (!active) continue;
    const token = await pageToken(page);
    await page.evaluate(
      async ({ project, id, requestId, token, header }) => {
        await fetch(`/__agent-forge/projects/${project}/sessions/${id}/stop`, {
          method: "POST",
          headers: { "Content-Type": "application/json", [header]: token },
          body: JSON.stringify({ requestId }),
        });
      },
      {
        project: record.projectId,
        id: record.id,
        requestId: active.requestId,
        token,
        header: OPERATOR_HEADER,
      },
    );
    await expect
      .poll(() =>
        saved(record.id).turns.some((turn) =>
          ["accepted", "running", "cancelling"].includes(turn.phase),
        ),
      )
      .toBe(false);
  }
});
async function openComposer(page: Page, bead = false) {
  await openSettled(
    page,
    `/index.html#/desktop/project/${alpha.id}/${bead ? "beads?selectionKind=bead&selectionId=alpha-epic" : "sessions"}`,
  );
  if (bead) {
    const show = page.getByRole("button", {
      name: "Show inspector",
      exact: true,
    });
    if (await show.isVisible()) await show.click();
    await page
      .getByRole("region", { name: "Bead alpha-epic", exact: true })
      .getByRole("button", { name: "Start session", exact: true })
      .click();
  } else {
    await page
      .getByRole("button", { name: "New session", exact: true })
      .click();
  }
  const dialog = page.getByRole("dialog", {
    name: "New session · Alpha",
    exact: true,
  });
  await dialog.getByRole("button", { name: /Gm · Gemini/ }).click();
  await expect(
    dialog.getByRole("combobox", { name: "Session smith" }),
  ).toHaveValue("gemini-example");
  await dialog
    .getByRole("combobox", { name: "Where the session runs", exact: true })
    .selectOption("main");
  await dialog
    .getByRole("textbox", { name: "Session prompt", exact: true })
    .fill("PRIVATE GEMINI COMPOSER QUESTION");
  return dialog;
}
async function check(dialog: Locator) {
  await dialog
    .getByRole("button", { name: "Check supported options", exact: true })
    .click();
  await expect(
    dialog.getByRole("region", {
      name: "Equivalent session command",
      exact: true,
    }),
  ).toContainText("--output-format");
  await expect(
    dialog.getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
}
function taskCount() {
  return calls().filter((row) => row.kind === "task").length;
}
function running(pid: number) {
  try {
    if (
      process.platform === "linux" &&
      /\) Z(?: |$)/.test(readFileSync(`/proc/${pid}/stat`, "utf8"))
    )
      return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("Gemini bead composer keeps native defaults omitted, reviews private text and keyboard starts exactly one Task through reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const before = taskCount();
  let startBody: Record<string, unknown> | undefined;
  const posts: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith(`/projects/${alpha.id}/sessions`)
    ) {
      posts.push(request.postData() ?? "");
      startBody = request.postDataJSON();
    }
  });
  const dialog = await openComposer(page, true);
  await expect(
    dialog.getByRole("textbox", { name: "Session bead" }),
  ).toHaveValue("alpha-epic");
  await expect(
    dialog.getByRole("textbox", { name: "Session model", exact: true }),
  ).toHaveValue("");
  await expect(
    dialog.getByRole("combobox", { name: "Session approvals" }),
  ).toHaveValue("");
  await expect(
    dialog.getByRole("combobox", { name: "Session sandbox" }),
  ).toHaveValue("");
  await expect(
    dialog.getByRole("combobox", { name: "Session effort" }),
  ).toHaveCount(0);
  await expect(dialog.locator('option[value="yolo"]')).toHaveJSProperty(
    "disabled",
    true,
  );
  await expect(dialog.locator('option[value="disabled"]')).toHaveJSProperty(
    "disabled",
    true,
  );
  const sessionMode = dialog.getByRole("combobox", {
    name: "Session mode",
    exact: true,
  });
  await expect(sessionMode).toHaveValue("task");
  await expect(
    sessionMode.getByRole("option", {
      name: "Chat · native session and once permissions",
      exact: true,
    }),
  ).toHaveJSProperty("disabled", false);
  await expect(
    dialog
      .getByRole("combobox", { name: "Session provider route" })
      .getByRole("option", { name: /ADK/ }),
  ).toHaveJSProperty("disabled", true);
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "private-context.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("PRIVATE INLINE COMPOSER CONTEXT"),
  });
  await expect(
    dialog.getByRole("button", {
      name: "Remove attachment private-context.txt",
    }),
  ).toBeVisible();
  const checkedReply = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/projects/${alpha.id}/sessions/preview`),
  );
  await check(dialog);
  const checkedEnvelope = await (await checkedReply).json();
  expect(checkedEnvelope.ok).toBe(true);
  const checked = geminiTaskPreviewReceiptSchema.parse(checkedEnvelope.data);
  const command = dialog.getByRole("region", {
    name: "Equivalent session command",
  });
  await expect(command).not.toContainText("PRIVATE");
  await expect(command).not.toContainText("--model");
  await expect(command).not.toContainText("--approval-mode");
  await expect(command).not.toContainText("--sandbox");
  expect(taskCount()).toBe(before);
  if (process.env["GEMINI_TASK_SHOTS"]) {
    mkdirSync(process.env["GEMINI_TASK_SHOTS"], { recursive: true });
    await page.setViewportSize({ width: 1280, height: 1000 });
    await dialog
      .getByRole("textbox", { name: "Session prompt", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(
        process.env["GEMINI_TASK_SHOTS"],
        "gemini-task-composer-prompt.png",
      ),
      style:
        '[aria-label="Session prompt"], [aria-label="Session repository"], [aria-label="Registered session worktree"] { visibility:hidden!important; }',
    });
    await command.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(process.env["GEMINI_TASK_SHOTS"], "gemini-task-composer.png"),
      style:
        '[aria-label="Session prompt"], [aria-label="Session repository"], [aria-label="Registered session worktree"] { visibility:hidden!important; }',
    });
    await page.setViewportSize({ width: 1100, height: 700 });
  }
  const prompt = dialog.getByRole("textbox", {
    name: "Session prompt",
    exact: true,
  });
  await prompt.focus();
  await page.keyboard.press("Control+Enter");
  const pane = page.getByRole("region", {
    name: "Session conversation",
    exact: true,
  });
  await expect(
    pane.getByText("Native Task outcome: completed", { exact: true }),
  ).toBeVisible();
  expect(posts).toHaveLength(1);
  expect(startBody).toMatchObject({
    provider: "gemini",
    smith: "gemini-example",
    beadId: "alpha-epic",
    repository: workspace,
    worktree: checked.snapshot.launch.cwd,
  });
  const launch = startBody?.launch;
  expect(launch).toEqual({
    route: "gemini-cli",
    mode: "task",
    prompt: "PRIVATE GEMINI COMPOSER QUESTION",
    attachments: [
      {
        kind: "text",
        name: "private-context.txt",
        text: "PRIVATE INLINE COMPOSER CONTEXT",
      },
    ],
  });
  expect(taskCount()).toBe(before + 1);
  const actual = calls()
    .filter((row) => row.kind === "task")
    .at(-1);
  expect(actual?.argv).toEqual(["--output-format", "stream-json"]);
  expect(actual?.stdin).toContain("PRIVATE GEMINI COMPOSER QUESTION");
  expect(actual?.stdin).toContain("PRIVATE INLINE COMPOSER CONTEXT");
  await reloadSettled(page);
  await expect(
    page.getByText("Native Task outcome: completed", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Private reply 🌱", { exact: true }),
  ).toBeVisible();
  expect(taskCount()).toBe(before + 1);
});

test("an edit after Gemini review and before paint cannot dispatch an unreviewed original", async ({
  page,
}) => {
  const dialog = await openComposer(page);
  await check(dialog);
  const before = taskCount();
  let posts = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith(`/projects/${alpha.id}/sessions`)
    )
      posts++;
  });
  await dialog.evaluate((element) => {
    const input = element.querySelector<HTMLTextAreaElement>(
      '[aria-label="Session prompt"]',
    );
    const start = [
      ...element.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.trim() === "Start");
    if (!input || !start) throw Error("Missing reviewed composer controls");
    input.value = "PRIVATE changed synchronously before dispatch";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    start.click();
  });
  await expect(
    dialog.getByText(
      "The Task selection changed. Check supported options again before Start.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(posts).toBe(0);
  expect(taskCount()).toBe(before);
  await expect(
    dialog.getByRole("button", { name: "Start", exact: true }),
  ).toBeDisabled();
  await check(dialog);
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  await expect(
    page.getByText("Native Task outcome: completed", { exact: true }),
  ).toBeVisible();
  expect(posts).toBe(1);
  expect(
    calls()
      .filter((row) => row.kind === "task")
      .at(-1)?.stdin,
  ).toContain("PRIVATE changed synchronously before dispatch");
});

test("Gemini optional overrides are explicit and provider switching preserves common input and independent drafts", async ({
  page,
}) => {
  const dialog = await openComposer(page, true);
  await expect(
    dialog
      .getByRole("combobox", { name: "Session smith" })
      .locator('option[value="gemini-disabled"]'),
  ).toHaveJSProperty("disabled", true);
  await dialog
    .getByRole("combobox", { name: "Session smith" })
    .selectOption("gemini-example");
  await expect(
    dialog.getByRole("textbox", { name: "Session model", exact: true }),
  ).toHaveValue("configured-example");
  await dialog
    .getByRole("textbox", { name: "Session model", exact: true })
    .fill("requested-example");
  await dialog
    .getByRole("combobox", { name: "Session approvals" })
    .selectOption("plan");
  await dialog
    .getByRole("combobox", { name: "Session sandbox" })
    .selectOption("enabled");
  await dialog.getByRole("button", { name: /Cl · Claude/ }).click();
  await expect(
    dialog.getByRole("textbox", { name: "Session model", exact: true }),
  ).toHaveJSProperty("readOnly", true);
  await dialog.getByRole("checkbox", { name: /Custom options/ }).check();
  await dialog
    .getByRole("textbox", { name: "Session model", exact: true })
    .fill("claude-preserved");
  await dialog.getByRole("button", { name: /Cx · Codex/ }).click();
  await dialog
    .getByRole("combobox", { name: "Session mode" })
    .selectOption("chat");
  await dialog
    .getByRole("textbox", { name: "Session model", exact: true })
    .fill("codex-chat-preserved");
  await dialog.getByRole("button", { name: /Gm · Gemini/ }).click();
  await expect(
    dialog.getByRole("textbox", { name: "Session prompt", exact: true }),
  ).toHaveValue("PRIVATE GEMINI COMPOSER QUESTION");
  await expect(
    dialog.getByRole("textbox", { name: "Session bead" }),
  ).toHaveValue("alpha-epic");
  await expect(
    dialog.getByRole("textbox", { name: "Session model", exact: true }),
  ).toHaveValue("requested-example");
  await expect(
    dialog.getByRole("combobox", { name: "Session approvals" }),
  ).toHaveValue("plan");
  await check(dialog);
  const command = dialog.getByRole("region", {
    name: "Equivalent session command",
  });
  await expect(command).toContainText("requested-example");
  await expect(command).toContainText("--approval-mode");
  await expect(command).toContainText("--sandbox");
  await dialog.getByRole("button", { name: /Cx · Codex/ }).click();
  await expect(
    dialog.getByRole("combobox", { name: "Session mode" }),
  ).toHaveValue("chat");
  await expect(
    dialog.getByRole("textbox", { name: "Session model", exact: true }),
  ).toHaveValue("codex-chat-preserved");
  await dialog.getByRole("button", { name: /Cl · Claude/ }).click();
  await expect(
    dialog.getByRole("textbox", { name: "Session model", exact: true }),
  ).toHaveValue("claude-preserved");
});

test("native help with missing overrides keeps Gemini defaults usable and locks unsupported controls", async ({
  page,
}) => {
  writeFileSync(
    `${log}.control`,
    JSON.stringify({ mode: "normal", help: "--output-format" }),
  );
  const before = taskCount();
  const dialog = await openComposer(page);
  await check(dialog);
  await expect(
    dialog.getByRole("textbox", { name: "Session model", exact: true }),
  ).toBeDisabled();
  await expect(dialog.locator('option[value="plan"]')).toHaveJSProperty(
    "disabled",
    true,
  );
  await expect(dialog.locator('option[value="enabled"]')).toHaveJSProperty(
    "disabled",
    true,
  );
  await expect(
    dialog.getByText(/This native help report does not support/),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  await expect(
    page.getByText("Native Task outcome: completed", { exact: true }),
  ).toBeVisible();
  expect(taskCount()).toBe(before + 1);
  expect(
    calls()
      .filter((row) => row.kind === "task")
      .at(-1)?.argv,
  ).toEqual(["--output-format", "stream-json"]);
});

test("keyboard Stop from the Gemini composer ends the actual provider and helper and survives reload", async ({
  page,
}) => {
  writeFileSync(`${log}.control`, JSON.stringify({ mode: "hang-tree" }));
  const before = taskCount(),
    dialog = await openComposer(page);
  await check(dialog);
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  const pane = page.getByRole("region", {
    name: "Session conversation",
    exact: true,
  });
  await expect(
    pane.getByText("Private reply 🌱", { exact: true }),
  ).toBeVisible();
  const actual = calls()
    .filter((row) => row.kind === "task")
    .at(-1);
  if (typeof actual?.pid !== "number" || typeof actual.childPid !== "number")
    throw Error("No actual inert process tree identities");
  expect(running(actual.pid) && running(actual.childPid)).toBe(true);
  await pane.getByRole("button", { name: "Stop session", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    pane
      .locator(".af-owned-turn")
      .getByRole("status")
      .filter({ hasText: /^Stop confirmed\./ }),
  ).toBeVisible();
  for (const pid of [actual.pid, actual.childPid])
    await expect.poll(() => running(pid)).toBe(false);
  await reloadSettled(page);
  await expect(
    page
      .locator(".af-owned-turn")
      .getByRole("status")
      .filter({ hasText: /^Stop confirmed\./ }),
  ).toBeVisible();
  expect(taskCount()).toBe(before + 1);
});

test("Gemini choices and capability failures disable dispatch until a fresh verified check", async ({
  page,
}) => {
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/sessions`);
  const before = taskCount();
  let releaseChoices!: () => void;
  const choicesGate = new Promise<void>((resolve) => {
    releaseChoices = resolve;
  });
  const hold = async (route: import("@playwright/test").Route) => {
    await choicesGate;
    await route.fallback();
  };
  await page.route("**/__agent-forge/smiths", hold);
  await page.getByRole("button", { name: "New session", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "New session · Alpha",
    exact: true,
  });
  await dialog.getByRole("button", { name: /Gm · Gemini/ }).click();
  try {
    await expect(
      dialog.getByText("Loading scoped Gemini launch choices…", {
        exact: true,
      }),
    ).toBeVisible();
    for (const name of [
      "Session model",
      "Session smith",
      "Session approvals",
      "Session sandbox",
    ]) {
      await expect(dialog.getByLabel(name, { exact: true })).toBeDisabled();
    }
    await expect(
      dialog.getByRole("button", { name: "Start", exact: true }),
    ).toBeDisabled();
  } finally {
    releaseChoices();
  }
  await expect(
    dialog.getByRole("combobox", { name: "Session smith" }),
  ).toHaveValue("gemini-example");
  await page.unroute("**/__agent-forge/smiths", hold);
  await dialog
    .getByRole("combobox", { name: "Where the session runs", exact: true })
    .selectOption("main");
  await dialog
    .getByRole("textbox", { name: "Session prompt", exact: true })
    .fill("PRIVATE eventual checked Task");
  const path = `**/__agent-forge/projects/${alpha.id}/sessions/preview`;
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(path, async (route) => {
    entered();
    await gate;
    await route.fulfill({
      status: 503,
      json: {
        ok: false,
        data: null,
        error:
          "Native options are temporarily unavailable. No Task was started.",
      },
    });
  });
  await dialog
    .getByRole("button", { name: "Check supported options", exact: true })
    .click();
  await held;
  try {
    await expect(
      dialog.getByRole("button", {
        name: "Checking supported options…",
        exact: true,
      }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Start", exact: true }),
    ).toBeDisabled();
    expect(taskCount()).toBe(before);
  } finally {
    release();
  }
  await expect(
    dialog.getByText(
      "Native options are temporarily unavailable. No Task was started.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.unroute(path);
  await check(dialog);
  expect(taskCount()).toBe(before);
});

test("a foreign bead is refused by the actual Gemini preview and never becomes Start authority", async ({
  page,
}) => {
  const before = taskCount(),
    dialog = await openComposer(page);
  await dialog
    .getByRole("textbox", { name: "Session bead", exact: true })
    .fill("beta-epic");
  const answer = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/projects/${alpha.id}/sessions/preview`),
  );
  await dialog
    .getByRole("button", { name: "Check supported options", exact: true })
    .click();
  const response = await answer;
  expect(response.status()).toBe(409);
  const body = await response.json();
  expect(body.ok).toBe(false);
  expect(body.error).toMatch(/project|scope|bead/i);
  await expect(
    dialog.getByRole("button", { name: "Start", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("region", { name: "Equivalent session command" }),
  ).toHaveCount(0);
  expect(taskCount()).toBe(before);
});

test("a Gemini Start held before admission retains its original metadata through reload and cannot be replaced", async ({
  page,
}) => {
  const dialog = await openComposer(page);
  await check(dialog);
  const before = taskCount(),
    posts: string[] = [];
  let identityWrites = 0,
    startPosts = 0,
    protectedOriginalReads = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      request.method() === "POST" &&
      url.pathname.endsWith("/session-start-identities")
    )
      identityWrites++;
    if (
      request.method() === "POST" &&
      url.pathname === `/__agent-forge/projects/${alpha.id}/sessions`
    )
      startPosts++;
    if (
      request.method() === "GET" &&
      url.searchParams.has("requestId") &&
      url.pathname.includes(`/projects/${alpha.id}/sessions/`)
    )
      protectedOriginalReads++;
  });
  let entered!: () => void, release!: () => void, finished!: () => void;
  const held = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const delivery = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delivered = new Promise<void>((resolve) => {
    finished = resolve;
  });
  await page.route(
    `**/__agent-forge/projects/${alpha.id}/sessions`,
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      posts.push(route.request().postData() ?? "");
      entered();
      await delivery;
      try {
        await route.fetch({
          headers: {
            ...(await route.request().allHeaders()),
            Origin: new URL(route.request().url()).origin,
            "Sec-Fetch-Site": "same-origin",
          },
        });
        await route.abort("failed").catch(() => {});
      } finally {
        finished();
      }
    },
  );
  try {
    await dialog.getByRole("button", { name: "Start", exact: true }).click();
    await held;
    expect(taskCount()).toBe(before);
    await reloadSettled(page);
    await page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    const reopened = page.getByRole("dialog", {
      name: "New session · Alpha",
      exact: true,
    });
    await reopened.getByRole("button", { name: /Gm · Gemini/ }).click();
    await reopened
      .getByRole("combobox", { name: "Where the session runs", exact: true })
      .selectOption("main");
    const identityRegion = reopened.getByRole("region", {
      name: "Original Start requests",
      exact: true,
    });
    await expect(identityRegion).toBeVisible();
    const checkServer = identityRegion.getByRole("button", {
      name: "Check server",
      exact: true,
    });
    await checkServer.click();
    const heldOriginal = JSON.parse(posts[0] ?? "null") as {
      requestId?: string;
    } | null;
    if (!heldOriginal?.requestId)
      throw Error("Missing held original Gemini Task request identity.");
    const identityRow = identityRegion
      .locator(".af-start-identities-list li")
      .filter({ hasText: heldOriginal.requestId });
    await expect(identityRow).toContainText("gemini task · reserved");
    const listedRequestId = await identityRow
      .locator("code")
      .nth(0)
      .textContent();
    const listedRequestHash = await identityRow
      .locator("code")
      .nth(1)
      .textContent();
    expect(listedRequestId).toBe(heldOriginal.requestId);
    expect(listedRequestHash).toMatch(/^[0-9a-f]{64}$/);
    const continueOriginal = identityRow.getByRole("button", {
      name: "Continue exact original",
      exact: true,
    });
    await expect(continueOriginal).toBeDisabled();
    await reopened
      .getByRole("textbox", { name: "Session prompt", exact: true })
      .fill("PRIVATE GEMINI COMPOSER QUESTION");
    await expect(continueOriginal).toBeEnabled();
    await expect(
      reopened.getByRole("button", { name: "Start", exact: true }),
    ).toBeDisabled();
    await reopened.getByRole("button", { name: /Cl · Claude/ }).click();
    await expect(
      reopened.getByRole("button", { name: "Start", exact: true }),
    ).toBeDisabled();
    await reopened.getByRole("button", { name: /Gm · Gemini/ }).click();
    await expect(identityRegion).toContainText(heldOriginal.requestId);
    await expect(continueOriginal).toBeEnabled();
    await expect(
      reopened.getByRole("button", { name: "Start", exact: true }),
    ).toBeDisabled();
    expect(
      await page.evaluate(() =>
        JSON.stringify({
          local: Object.entries(localStorage),
          session: Object.entries(sessionStorage),
        }),
      ),
    ).not.toContain("PRIVATE GEMINI COMPOSER QUESTION");
    expect(identityWrites).toBe(1);
    expect(startPosts).toBe(1);
    expect(posts).toHaveLength(1);
    release();
    await delivered;
    await expect.poll(taskCount).toBe(before + 1);
    await expect(reopened).toBeVisible();
    await checkServer.click();
    await expect(identityRow).toContainText("gemini task · admitted");
    expect(await identityRow.locator("code").nth(0).textContent()).toBe(
      listedRequestId,
    );
    expect(await identityRow.locator("code").nth(1).textContent()).toBe(
      listedRequestHash,
    );
    await identityRow
      .getByRole("button", { name: "Inspect original", exact: true })
      .click();
    await expect(
      identityRow.getByRole("link", { name: "Open original session" }),
    ).toBeVisible();
    await expect.poll(() => protectedOriginalReads).toBeGreaterThan(0);
    await identityRow
      .getByRole("link", { name: "Open original session" })
      .click();
    await expect(reopened).toBeHidden();
    await expect(
      page.getByText("Native Task outcome: completed", { exact: true }),
    ).toBeVisible();
    expect(identityWrites).toBe(1);
    expect(startPosts).toBe(1);
    expect(posts).toHaveLength(1);
  } finally {
    release();
    await delivered;
  }
});
