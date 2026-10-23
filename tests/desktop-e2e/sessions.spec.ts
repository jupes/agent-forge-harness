import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, type Route, test } from "@playwright/test";
import { OPERATOR_HEADER } from "../../scripts/hearth/paths";
import type { ConversationState } from "../../types/conversation";
import type { OwnedSessionRecord } from "../../types/owned-session";
import { openSettled } from "../e2e/fixtures";
import { pageToken } from "../e2e/launch-link";
import { HEARTH_HOME } from "../e2e/servers";
import { alpha, beta, seedProjects } from "./project-fixtures";

const starts = () =>
  existsSync(join(HEARTH_HOME, "coding-fixture-starts.jsonl"))
    ? readFileSync(join(HEARTH_HOME, "coding-fixture-starts.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean).length
    : 0;
function records(): OwnedSessionRecord[] {
  try {
    return JSON.parse(
      readFileSync(join(HEARTH_HOME, "sessions", "registry.json"), "utf8"),
    ).records;
  } catch {
    return [];
  }
}
function journal(id: string): ConversationState {
  try {
    return JSON.parse(
      readFileSync(join(HEARTH_HOME, "conversations", `${id}.json`), "utf8"),
    );
  } catch {
    throw new Error("The isolated session journal is unavailable");
  }
}
function recording(): { argv: string[]; stdin: string; id: string } {
  try {
    return JSON.parse(
      readFileSync(join(HEARTH_HOME, "coding-fixture-record.json"), "utf8"),
    );
  } catch {
    throw new Error("The fake provider input recording is unavailable");
  }
}
const forward = async (route: Route) =>
  route.fetch({
    headers: {
      ...(await route.request().allHeaders()),
      Origin: new URL(route.request().url()).origin,
      "Sec-Fetch-Site": "same-origin",
    },
  });
async function composer(page: Page) {
  await page.getByRole("button", { name: "New session", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New session · Alpha" });
  await expect(
    dialog.getByRole("combobox", { name: "Session smith" }),
  ).toHaveValue("claude-journeyman");
  await expect(
    dialog.getByRole("combobox", { name: "Session effort" }),
  ).toBeEnabled();
  return dialog;
}
async function checked(
  page: Page,
  prompt: string,
  mode: "task" | "chat" = "chat",
) {
  const dialog = await composer(page);
  await dialog.getByRole("textbox", { name: "Session prompt" }).fill(prompt);
  await dialog
    .getByRole("combobox", { name: "Session mode" })
    .selectOption(mode);
  await dialog
    .getByRole("combobox", { name: "Session effort" })
    .selectOption("");
  await dialog
    .getByRole("button", { name: "Check supported options", exact: true })
    .click();
  await expect(
    dialog.getByRole("region", { name: "Equivalent session command" }),
  ).toContainText("--model");
  await expect(
    dialog.getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
  return dialog;
}
let previousSessions = new Set<string>(),
  releaseHeldStop: (() => Promise<void>) | undefined;
test.beforeEach(() => {
  previousSessions = new Set(records().map((record) => record.id));
  releaseHeldStop = undefined;
  seedProjects();
  writeFileSync(
    join(HEARTH_HOME, "coding-fixture-mode.json"),
    JSON.stringify("normal"),
  );
  writeFileSync(
    join(HEARTH_HOME, "keeper-fixture-mode.json"),
    JSON.stringify("normal"),
  );
});
test.afterEach(async ({ page }) => {
  await releaseHeldStop?.();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  const owned = records().filter((record) => !previousSessions.has(record.id));
  for (const record of owned) {
    const turn = journal(record.id).turns.find((item) =>
      ["accepted", "running", "cancelling"].includes(item.phase),
    );
    if (!turn) continue;
    const token = await pageToken(page);
    await page.evaluate(
      async ({ record, requestId, token, header }) => {
        await fetch(
          `/__agent-forge/projects/${encodeURIComponent(record.projectId)}/sessions/${record.id}/stop`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", [header]: token },
            body: JSON.stringify({ requestId }),
          },
        );
      },
      { record, requestId: turn.requestId, token, header: OPERATOR_HEADER },
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

test("Cancel, templates and checked options start nothing; a lost Start reply creates one Chat with exact inline context and native resume", async ({
  page,
}) => {
  const beforeStarts = starts(),
    beforeRecords = records().length;
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1100, height: 700 });
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/sessions`);
  const cancelled = await composer(page);
  await cancelled
    .getByRole("textbox", { name: "Session prompt" })
    .fill("/review");
  await cancelled
    .getByRole("group", { name: "Harness commands" })
    .getByRole("button")
    .first()
    .click();
  await expect(
    cancelled.getByRole("textbox", { name: "Session prompt" }),
  ).toHaveValue(/\/review/);
  await cancelled
    .getByRole("combobox", { name: "Session template" })
    .selectOption("Research a question");
  await expect(
    cancelled.getByRole("textbox", { name: "Session prompt" }),
  ).toHaveValue(/Research this question/);
  await cancelled.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(starts()).toBe(beforeStarts);
  const dialog = await composer(page);
  await expect(
    dialog.getByRole("textbox", { name: "Session prompt" }),
  ).toHaveValue(/Research this question/);
  const firstPrompt = "  Exact session question 🌱\n";
  await dialog
    .getByRole("textbox", { name: "Session prompt" })
    .fill("@bead:alpha-epic");
  await dialog
    .getByRole("group", { name: "Mention suggestions" })
    .getByRole("button", { name: /bead alpha-epic/ })
    .click();
  await expect(
    dialog.getByText("About bead alpha-epic", { exact: false }),
  ).toBeVisible();
  await dialog
    .getByRole("textbox", { name: "Session prompt" })
    .fill(firstPrompt);
  await dialog
    .getByRole("button", { name: "Check supported options", exact: true })
    .click();
  await expect(
    dialog
      .getByRole("status")
      .filter({ hasText: "unavailable or unsupported" })
      .first(),
  ).toBeVisible();
  await expect(
    dialog.getByRole("combobox", { name: "Session effort" }),
  ).toHaveValue("medium");
  await dialog
    .getByRole("combobox", { name: "Session effort" })
    .selectOption("");
  await dialog
    .getByLabel("Session attachments", { exact: true })
    .setInputFiles([
      {
        name: "notes.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Keep this exact selected text"),
      },
      {
        name: "tiny.png",
        mimeType: "image/png",
        buffer: Buffer.from("iVBORw0KGgo=", "base64"),
      },
    ]);
  await expect(
    dialog.getByText("text · notes.txt", { exact: false }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Check supported options", exact: true })
    .click();
  await expect(
    dialog.getByRole("region", { name: "Equivalent session command" }),
  ).toContainText("stream-json");
  expect(starts()).toBe(beforeStarts);
  let posted = 0;
  await page.route(
    `**/__agent-forge/projects/${alpha.id}/sessions`,
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      posted++;
      await forward(route);
      await route.abort("failed");
    },
  );
  await dialog.getByRole("button", { name: "Start", exact: true }).focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByRole("button", { name: "Start", exact: true }),
  ).toBeFocused();
  expect(
    await dialog
      .getByRole("button", { name: "Start", exact: true })
      .evaluate((node) => getComputedStyle(node).outlineWidth),
  ).toBe("2px");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("region", { name: "Session conversation" }),
  ).toBeVisible();
  await expect(
    page.getByRole("article", { name: "Session reply", exact: true }),
  ).toContainText("Coding reply 🌱");
  expect(posted).toBe(1);
  expect(starts()).toBe(beforeStarts + 1);
  expect(records()).toHaveLength(beforeRecords + 1);
  const created = records().at(-1);
  if (!created) throw new Error("Missing tracked session");
  await expect
    .poll(() => journal(created.id).turns.at(-1)?.phase)
    .toBe("completed");
  expect(recording().argv).not.toContain("--resume");
  expect(recording().stdin).toContain(firstPrompt.replaceAll("\n", "\\n"));
  expect(recording().stdin).toContain("Keep this exact selected text");
  expect(recording().stdin).toContain("iVBORw0KGgo=");
  const native = journal(created.id).binding?.sessionId;
  await page
    .getByLabel("Session reply attachments", { exact: true })
    .setInputFiles({
      name: "follow-up.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Only this second-turn attachment"),
    });
  await expect(
    page.getByText("text · follow-up.txt", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Session reply prompt" })
    .fill("Second exact Chat turn");
  await page.getByRole("button", { name: "Send session message" }).click();
  await expect.poll(() => journal(created.id).turns.length).toBe(2);
  await expect
    .poll(() => journal(created.id).turns.at(-1)?.phase)
    .toBe("completed");
  expect(recording().argv).toContain("--resume");
  expect(recording().argv).toContain(native);
  expect(recording().stdin).toContain("Only this second-turn attachment");
  expect(starts()).toBe(beforeStarts + 2);
  const transcript = page.getByRole("region", {
    name: "Session transcript",
    exact: true,
  });
  expect((await transcript.boundingBox())?.height).toBeGreaterThanOrEqual(140);
  await page.screenshot({
    path: "apps/desktop/docs/screenshots/session-chat.png",
    mask: [page.getByText(created.worktree, { exact: true })],
  });
});

test("a provider failure retains its streamed partial reply and never restarts automatically", async ({
  page,
}) => {
  const beforeStarts = starts();
  writeFileSync(
    join(HEARTH_HOME, "coding-fixture-mode.json"),
    JSON.stringify("provider-error"),
  );
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/sessions`);
  const dialog = await checked(page, "Keep the partial failed reply");
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  await expect(
    page.getByRole("article", { name: "Session reply", exact: true }),
  ).toContainText("Coding reply 🌱");
  const created = records().at(-1);
  if (!created) throw new Error("Missing failed session");
  await expect
    .poll(() => journal(created.id).turns.at(-1)?.phase)
    .toBe("failed");
  await expect(
    page.getByText("The session could not finish.", { exact: false }),
  ).toBeVisible();
  expect(starts()).toBe(beforeStarts + 1);
});

test("closing the session observer leaves the fake provider running, and Stop remains pending until actual cancellation", async ({
  page,
}) => {
  const beforeStarts = starts();
  writeFileSync(
    join(HEARTH_HOME, "coding-fixture-mode.json"),
    JSON.stringify("hang"),
  );
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/sessions`);
  const dialog = await checked(page, "Wait for explicit Stop");
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  await expect(
    page.getByRole("article", { name: "Session reply", exact: true }),
  ).toContainText("Coding reply 🌱");
  const created = records().at(-1);
  if (!created) throw new Error("Missing tracked session");
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
  expect(journal(created.id).turns.at(-1)?.phase).toBe("running");
  expect(starts()).toBe(beforeStarts + 1);
  await page.goto(
    `/index.html#/desktop/project/${alpha.id}/sessions?selectionKind=session&selectionId=${created.id}`,
  );
  await expect(
    page.getByRole("button", { name: "Stop session", exact: true }),
  ).toBeEnabled();
  await page.route(`**/sessions/${created.id}/stop`, async (route) => {
    await new Promise<void>((resolve) => {
      releaseHeldStop = async () => {
        await route.continue();
        resolve();
        releaseHeldStop = undefined;
      };
    });
  });
  await page.getByRole("button", { name: "Stop session", exact: true }).click();
  await expect(
    page.getByText("Stopping… waiting for confirmation", { exact: true }),
  ).toBeVisible();
  expect(journal(created.id).turns.at(-1)?.phase).toBe("running");
  if (!releaseHeldStop) throw new Error("No held Stop request");
  await releaseHeldStop();
  await expect
    .poll(() => journal(created.id).turns.at(-1)?.phase)
    .toBe("cancelled");
  await expect(
    page.getByRole("textbox", { name: "Session reply prompt" }),
  ).toBeEnabled();
  expect(starts()).toBe(beforeStarts + 1);
});

test("a bead-prefilled Task exposes locked modes, and project drafts and session membership stay isolated", async ({
  page,
}) => {
  const beforeStarts = starts();
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSettled(
    page,
    `/index.html#/desktop/project/${alpha.id}/beads?selectionKind=bead&selectionId=alpha-epic`,
  );
  await page
    .getByRole("button", { name: "Show inspector", exact: true })
    .click();
  await page
    .getByRole("region", { name: "Bead alpha-epic", exact: true })
    .getByRole("button", {
      name: "Start session",
      exact: true,
    })
    .click();
  let dialog = page.getByRole("dialog", { name: "New session · Alpha" });
  await expect(
    dialog.getByRole("textbox", { name: "Session bead" }),
  ).toHaveValue("alpha-epic");
  await expect(
    dialog.getByRole("button", { name: "Codex", exact: false }),
  ).toBeDisabled();
  await expect(dialog.getByLabel("Raw session flags locked")).toBeDisabled();
  await dialog
    .getByRole("textbox", { name: "Session prompt" })
    .fill("Preserved Alpha draft");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await openSettled(page, `/index.html#/desktop/project/${beta.id}/sessions`);
  await page.getByRole("button", { name: "New session", exact: true }).click();
  const betaDialog = page.getByRole("dialog", { name: "New session · Beta" });
  await expect(
    betaDialog.getByRole("textbox", { name: "Session prompt" }),
  ).toHaveValue("");
  await betaDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/sessions`);
  dialog = await composer(page);
  await expect(
    dialog.getByRole("textbox", { name: "Session prompt" }),
  ).toHaveValue("Preserved Alpha draft");
  await dialog
    .getByRole("combobox", { name: "Session mode" })
    .selectOption("task");
  await dialog
    .getByRole("combobox", { name: "Session effort" })
    .selectOption("");
  await dialog
    .getByRole("spinbutton", { name: "Task maximum budget" })
    .fill("1.25");
  await dialog
    .getByRole("textbox", { name: "Task output schema" })
    .fill('{"type":"object"}');
  await dialog
    .getByRole("button", { name: "Check supported options", exact: true })
    .click();
  await expect(
    dialog.getByRole("region", { name: "Equivalent session command" }),
  ).toContainText("--max-budget-usd");
  await page.screenshot({
    path: "apps/desktop/docs/screenshots/session-composer.png",
    mask: [
      dialog.getByRole("combobox", { name: "Session repository", exact: true }),
    ],
  });
  await dialog.locator(".af-dialog-body").evaluate((node) => {
    node.scrollTop = 0;
  });
  await page.screenshot({
    path: "apps/desktop/docs/screenshots/session-composer-prompt.png",
    mask: [
      dialog.getByRole("combobox", { name: "Session repository", exact: true }),
    ],
  });
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  await expect(
    page.getByRole("article", { name: "Session reply", exact: true }),
  ).toContainText("Coding reply 🌱");
  const created = records().at(-1);
  if (!created) throw new Error("Missing tracked Task");
  await expect
    .poll(() => journal(created.id).turns.at(-1)?.phase)
    .toBe("completed");
  await expect(
    page.getByRole("textbox", { name: "Session reply prompt" }),
  ).toBeDisabled();
  expect(recording().argv).toContain("--json-schema");
  expect(recording().argv).toContain("1.25");
  await openSettled(page, `/index.html#/desktop/project/${beta.id}/sessions`);
  await expect(
    page.locator(`a[href*="selectionId=${created.id}"]`),
  ).toHaveCount(0);
  expect(starts()).toBe(beforeStarts + 1);
});
