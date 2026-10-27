import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Download,
  expect,
  type Page,
  type Route,
  test,
} from "@playwright/test";
import { desktopHref } from "../../apps/desktop/src/navigation";
import { OPERATOR_HEADER } from "../../scripts/hearth/paths";
import { ownedCodingStateSchema } from "../../scripts/sessions/codex-owned-journal";
import { ownedCodingSessionSchema } from "../../scripts/sessions/codex-owned-wire-protocol";
import { sessionTranscriptExportSchema } from "../../scripts/sessions/library-protocol";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import { pageToken } from "../e2e/launch-link";
import { HEARTH_HOME } from "../e2e/servers";
import { alpha, beta, seedProjects, workspace } from "./project-fixtures";
import { observePreviewIdentityRefresh } from "./session-start-refresh-barrier";

const registryFile = () => join(HEARTH_HOME, "sessions", "registry.json");
function records() {
  try {
    const raw: unknown = JSON.parse(readFileSync(registryFile(), "utf8"));
    if (!raw || typeof raw !== "object" || !("records" in raw))
      throw Error("Missing records");
    return ownedCodingSessionSchema.array().parse(raw.records);
  } catch {
    return [];
  }
}
function state(id: string) {
  try {
    return ownedCodingStateSchema.parse(
      JSON.parse(
        readFileSync(join(HEARTH_HOME, "conversations", `${id}.json`), "utf8"),
      ),
    );
  } catch {
    throw Error("The isolated private session is unavailable");
  }
}
const bytes = (id: string) =>
  readFileSync(join(HEARTH_HOME, "conversations", `${id}.json`));
const starts = () =>
  existsSync(join(HEARTH_HOME, "coding-fixture-starts.jsonl"))
    ? readFileSync(join(HEARTH_HOME, "coding-fixture-starts.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean).length
    : 0;
const mode = (value: string) =>
  writeFileSync(
    join(HEARTH_HOME, "coding-fixture-mode.json"),
    JSON.stringify(value),
  );
const sessionUrl = (id: string) =>
  `/index.html${desktopHref({
    projectId: alpha.id,
    destination: "sessions",
    selection: { kind: "session", id },
  })}`;
const forward = (route: Route) =>
  route.fetch({
    headers: {
      ...route.request().headers(),
      Origin: new URL(route.request().url()).origin,
      "Sec-Fetch-Site": "same-origin",
    },
  });
let previous = new Set<string>();
test.beforeEach(() => {
  seedProjects();
  previous = new Set(records().map((record) => record.id));
  mode("normal");
});
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  for (const record of records().filter((record) => !previous.has(record.id))) {
    const current = state(record.id).turns.find((turn) =>
      ["accepted", "running", "cancelling"].includes(turn.phase),
    );
    if (!current) continue;
    const token = await pageToken(page);
    await page.evaluate(
      async ({ project, session, requestId, token, header }) => {
        await fetch(
          `/__agent-forge/projects/${project}/sessions/${session}/stop`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", [header]: token },
            body: JSON.stringify({ requestId }),
          },
        );
      },
      {
        project: record.projectId,
        session: record.id,
        requestId: current.requestId,
        token,
        header: OPERATOR_HEADER,
      },
    );
    await expect
      .poll(() =>
        state(record.id).turns.some((turn) =>
          ["accepted", "running", "cancelling"].includes(turn.phase),
        ),
      )
      .toBe(false);
  }
});
async function start(
  page: Page,
  selectedMode: "task" | "chat" = "task",
  attach = false,
) {
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/sessions`);
  await page.getByRole("button", { name: "New session", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "New session · Alpha",
    exact: true,
  });
  await expect(
    dialog.getByRole("combobox", { name: "Session smith", exact: true }),
  ).toHaveValue("claude-journeyman");
  await dialog
    .getByRole("textbox", { name: "Session prompt", exact: true })
    .fill("Private library fixture request");
  await dialog
    .getByRole("combobox", { name: "Session mode", exact: true })
    .selectOption(selectedMode);
  await dialog
    .getByRole("combobox", { name: "Session effort", exact: true })
    .selectOption("");
  if (attach) {
    await dialog
      .getByLabel("Session attachments", { exact: true })
      .setInputFiles({
        name: "private-notes.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Private selected export attachment"),
      });
    await expect(
      dialog.getByText("text · private-notes.txt", { exact: false }),
    ).toBeVisible();
  }
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
  if (!record) throw Error("Missing isolated registered session");
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
    await dialog
      .getByRole("textbox", { name: "Session prompt", exact: true })
      .fill("Private library fixture request");
    await dialog
      .getByRole("combobox", { name: "Session mode", exact: true })
      .selectOption("task");
    await dialog
      .getByRole("combobox", { name: "Session effort", exact: true })
      .selectOption("");

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

async function actions(page: Page) {
  await page
    .getByRole("button", { name: "Session actions", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Session actions",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function exported(download: Download) {
  expect(await download.failure()).toBeNull();
  const file = await download.path();
  if (!file) throw Error("Missing isolated download file");
  try {
    return sessionTranscriptExportSchema.parse(
      JSON.parse(readFileSync(file, "utf8")),
    );
  } catch {
    throw Error("The downloaded file is not a complete verified transcript");
  }
}

test("actual >100-frame private export includes attachments and all reports; compact keyboard actions keep unsupported controls locked", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  mode("rich-many");
  const before = starts(),
    record = await start(page, "task", true);
  await expect(page.locator("[data-session-state]")).toHaveAttribute(
    "data-session-state",
    "ended",
  );
  const saved = state(record.id),
    history = bytes(record.id);
  expect(saved.frames.length).toBeGreaterThan(100);
  const button = page.getByRole("button", {
    name: "Session actions",
    exact: true,
  });
  await button.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(button).toBeFocused();
  await expect(button).toHaveCSS("outline-width", "2px");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", {
    name: "Session actions",
    exact: true,
  });
  await expect(
    dialog.getByRole("button", { name: "Close dialog", exact: true }),
  ).toBeFocused();
  await expect(
    dialog.getByRole("button", { name: "Fork session", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", {
      name: "Open session in terminal",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", {
      name: "Live permission controls",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "Continue this Chat", exact: true }),
  ).toBeDisabled();
  await expect(dialog).toContainText(
    "Historical permission denials remain read-only",
  );
  const downloading = page.waitForEvent("download");
  await dialog
    .getByRole("button", { name: "Export saved transcript", exact: true })
    .click();
  const file = await exported(await downloading);
  expect(file.lastSequence).toBe(saved.frames.length);
  expect(file.conversation.frames).toEqual(saved.frames);
  expect(file.conversation.turns).toEqual(
    saved.turns.map(({ owner: _owner, ...turn }) => turn),
  );
  expect(JSON.stringify(file)).toContain("Private selected export attachment");
  expect(JSON.stringify(file)).toContain("Private complete export line 120");
  expect(JSON.stringify(file)).toContain("Private command output");
  expect(bytes(record.id)).toEqual(history);
  expect(starts()).toBe(before + 1);
  await expect(dialog).toContainText(
    `download requested for saved revision ${saved.revision}`,
  );
  const box = await dialog.boundingBox();
  expect(
    box &&
      box.x >= 0 &&
      box.y >= 0 &&
      box.x + box.width <= 1100 &&
      box.y + box.height <= 700,
  ).toBe(true);
  await page
    .getByText(record.worktree, { exact: true })
    .evaluateAll((paths) => {
      for (const path of paths) path.setAttribute("data-private-path", "");
    });
  await page.screenshot({
    path: "apps/desktop/docs/screenshots/session-actions.png",
    style:
      ".af-owned-turn > time, [data-private-path] { visibility:hidden !important; }",
  });
  await page.keyboard.press("Escape");
  await expect(button).toBeFocused();
});

test("a lost pre-admission archive survives project navigation and reload404; exact retry archives and restore preserves an actual running provider", async ({
  page,
}) => {
  mode("rich-hang");
  const before = starts(),
    record = await start(page, "chat");
  await expect(page.locator("[data-session-state]")).toHaveAttribute(
    "data-session-state",
    "running",
  );
  await expect
    .poll(() =>
      state(record.id).frames.some(
        (frame) =>
          frame.event.kind === "coding-activity" &&
          frame.event.activity.kind === "tool" &&
          frame.event.id === "pending-native-tool",
      ),
    )
    .toBe(true);
  const history = bytes(record.id),
    registry = readFileSync(registryFile());
  const bodies: unknown[] = [];
  let first = true;
  await page.route(
    `**/projects/${alpha.id}/sessions/${record.id}/archive`,
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      bodies.push(route.request().postDataJSON());
      if (first) {
        first = false;
        await route.abort("failed");
      } else await route.fulfill({ response: await forward(route) });
    },
  );
  let dialog = await actions(page);
  await expect(
    dialog.getByRole("button", { name: "Archive session", exact: true }),
  ).toBeEnabled();
  await dialog
    .getByRole("button", { name: "Archive session", exact: true })
    .click();
  await expect(
    dialog.getByText("Archive change not confirmed", { exact: false }).first(),
  ).toBeVisible();
  expect(bodies).toHaveLength(1);
  await page.keyboard.press("Escape");
  await openSettled(page, `/index.html#/desktop/project/${beta.id}/sessions`);
  await expect(
    page.getByRole("region", {
      name: "Sessions started in the app",
      exact: true,
    }),
  ).not.toContainText(record.id);
  await openSettled(page, sessionUrl(record.id));
  await reloadSettled(page);
  dialog = await actions(page);
  await expect(
    dialog.getByRole("button", {
      name: "Retry original archive change",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole("button", { name: "Archive session", exact: true }),
  ).toBeDisabled();
  expect(bodies).toHaveLength(1);
  await dialog
    .getByRole("button", { name: "Retry original archive change", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Restore session", exact: true }),
  ).toBeEnabled();
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(starts()).toBe(before + 1);
  expect(bytes(record.id)).toEqual(history);
  expect(readFileSync(registryFile())).toEqual(registry);
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "All sessions", exact: true }).click();
  const list = page.getByRole("region", {
    name: "Sessions started in the app",
    exact: true,
  });
  await expect(list.locator(`a[href*="${record.id}"]`)).toHaveCount(0);
  await list.getByLabel("Show archived app sessions", { exact: true }).check();
  await list.locator(`a[href*="${record.id}"]`).click();
  await expect(
    page.getByRole("button", { name: "Stop session", exact: true }),
  ).toBeEnabled();
  dialog = await actions(page);
  await dialog
    .getByRole("button", { name: "Restore session", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Archive session", exact: true }),
  ).toBeEnabled();
  expect(starts()).toBe(before + 1);
  expect(bytes(record.id)).toEqual(history);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Stop session", exact: true }).click();
  await expect(page.locator("[data-session-state]")).toHaveAttribute(
    "data-session-state",
    "stopped",
  );
});

test("a lost applied archive response is confirmed after reload without another POST and a later restore has a new reviewed revision", async ({
  page,
}) => {
  const before = starts(),
    record = await start(page);
  await expect(page.locator("[data-session-state]")).toHaveAttribute(
    "data-session-state",
    "ended",
  );
  const history = bytes(record.id),
    bodies: unknown[] = [];
  await page.route(
    `**/projects/${alpha.id}/sessions/${record.id}/archive`,
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      bodies.push(route.request().postDataJSON());
      const response = await forward(route);
      expect(response.status()).toBe(200);
      await route.abort("failed");
    },
  );
  let dialog = await actions(page);
  await expect(
    dialog.getByRole("button", { name: "Archive session", exact: true }),
  ).toBeEnabled();
  await dialog
    .getByRole("button", { name: "Archive session", exact: true })
    .click();
  await expect(
    dialog.getByText("Archive change not confirmed", { exact: false }).first(),
  ).toBeVisible();
  await reloadSettled(page);
  dialog = await actions(page);
  await expect(
    dialog.getByRole("button", { name: "Restore session", exact: true }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole("button", {
      name: "Retry original archive change",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(bodies).toHaveLength(1);
  expect(starts()).toBe(before + 1);
  expect(bytes(record.id)).toEqual(history);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await dialog
    .getByRole("button", { name: "Restore session", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Archive session", exact: true }),
  ).toBeEnabled();
});

test("Continue Chat only focuses the composer; the explicit next send resumes the actual same native conversation", async ({
  page,
}) => {
  const before = starts(),
    record = await start(page, "chat");
  await expect(page.locator("[data-session-state]")).toHaveAttribute(
    "data-session-state",
    "idle",
  );
  const binding = state(record.id).binding;
  const dialog = await actions(page);
  await expect(
    dialog.getByRole("button", { name: "Continue this Chat", exact: true }),
  ).toBeEnabled();
  await dialog
    .getByRole("button", { name: "Continue this Chat", exact: true })
    .click();
  const reply = page.getByRole("textbox", {
    name: "Session reply prompt",
    exact: true,
  });
  await expect(reply).toBeFocused();
  expect(starts()).toBe(before + 1);
  await reply.fill("Private explicit follow-up");
  await page
    .getByRole("button", { name: "Send session message", exact: true })
    .click();
  await expect.poll(() => state(record.id).turns.length).toBe(2);
  // Acceptance can precede provider dispatch while the prior idle DOM remains.
  // Wait for the actual second turn, then retain the exact count/native checks.
  await expect
    .poll(() => state(record.id).turns.at(-1)?.phase)
    .toBe("completed");
  await expect(page.locator("[data-session-state]")).toHaveAttribute(
    "data-session-state",
    "idle",
  );
  expect(state(record.id).binding).toEqual(binding);
  expect(starts()).toBe(before + 2);
  let native: unknown;
  try {
    native = JSON.parse(
      readFileSync(join(HEARTH_HOME, "coding-fixture-record.json"), "utf8"),
    );
  } catch {
    throw Error("Missing native recording");
  }
  expect(native).toMatchObject({
    id: binding?.sessionId,
    argv: expect.arrayContaining(["--resume", binding?.sessionId]),
  });
});

test("failed complete-export and archive reads show specific errors without a partial download or hidden archive write", async ({
  page,
}) => {
  const record = await start(page);
  await expect(page.locator("[data-session-state]")).toHaveAttribute(
    "data-session-state",
    "ended",
  );
  let writes = 0,
    downloads = 0;
  page.on("download", () => {
    downloads++;
  });
  await page.route(
    `**/projects/${alpha.id}/sessions/${record.id}/export`,
    (route) =>
      route.fulfill({
        status: 503,
        json: {
          ok: false,
          data: null,
          error: "Complete saved export unavailable in this fixture",
        },
      }),
  );
  await page.route(
    `**/projects/${alpha.id}/sessions/${record.id}/archive*`,
    async (route) => {
      if (route.request().method() === "POST") {
        writes++;
        await route.continue();
      } else
        await route.fulfill({
          status: 503,
          json: {
            ok: false,
            data: null,
            error: "Saved archive status unavailable in this fixture",
          },
        });
    },
  );
  const dialog = await actions(page);
  await dialog
    .getByRole("button", { name: "Check archive status", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Saved archive status unavailable",
  );
  await expect(
    dialog.getByRole("button", { name: "Archive session", exact: true }),
  ).toBeDisabled();
  await dialog
    .getByRole("button", { name: "Export saved transcript", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Complete saved export unavailable",
  );
  expect(downloads).toBe(0);
  expect(writes).toBe(0);
});
