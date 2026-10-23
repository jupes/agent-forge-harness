import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { OPERATOR_HEADER, SESSION_ROUTE } from "../../scripts/hearth/paths";
import { keeperSessionStartRequestSchema } from "../../scripts/keeper/session-start-protocol";
import type { KeeperSessionStartRequest } from "../../types/keeper-session-start";
import { pageToken } from "../e2e/launch-link";
import { HEARTH_HOME } from "../e2e/servers";
import { alpha, ROOT } from "./environment";

const lines = (file: string) =>
  existsSync(join(HEARTH_HOME, file))
    ? readFileSync(join(HEARTH_HOME, file), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean).length
    : 0;
async function pid(page: Page) {
  return page.evaluate(async () => {
    const reply = await fetch("/__agent-forge/health"),
      value: unknown = await reply.json();
    if (
      !reply.ok ||
      !value ||
      typeof value !== "object" ||
      !("data" in value) ||
      !value.data ||
      typeof value.data !== "object" ||
      !("pid" in value.data) ||
      typeof value.data.pid !== "number"
    )
      throw new Error("The isolated hearth identity was unavailable.");
    return value.data.pid;
  });
}

test("a lost reviewed Start recovers its full original after an actual owned hearth restart and explicitly retries one fake provider", async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/index.html#/desktop/project/${alpha.id}/keeper`);
  const card = page.getByRole("article", {
    name: "Review restart recovery",
    exact: true,
  });
  await card
    .getByRole("button", { name: "Review & start", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Review Keeper session · Alpha",
    exact: true,
  });
  const prompt = dialog.getByRole("textbox", {
    name: "Session prompt",
    exact: true,
  });
  await expect(prompt).toBeEditable();
  await expect(
    dialog.getByRole("combobox", { name: "Where the session runs" }),
  ).toHaveValue("main");
  const text = "  Exact reviewed restart prompt\nKeep private body 🌱\n";
  await prompt.fill(text);
  await dialog
    .getByRole("combobox", { name: "Session effort" })
    .selectOption("");
  await dialog
    .getByRole("checkbox", { name: "Custom options", exact: false })
    .check();
  await dialog
    .getByRole("textbox", { name: "Session model", exact: true })
    .fill("claude-fixture-reviewed");
  await dialog
    .getByRole("combobox", { name: "Session permission mode" })
    .selectOption("plan");
  await dialog
    .getByRole("textbox", { name: "Task output schema" })
    .fill('{"type":"object","properties":{"ok":{"type":"boolean"}}}');
  await dialog
    .getByRole("spinbutton", { name: "Task maximum budget" })
    .fill("1.25");
  await dialog
    .locator("summary", { hasText: "Tools and advanced options" })
    .click();
  await dialog
    .getByRole("textbox", { name: "Fallback session models" })
    .fill("haiku");
  await dialog
    .getByRole("textbox", { name: "Session extra directories" })
    .fill(join(ROOT, "docs"));
  await dialog
    .getByLabel("Session attachments", { exact: true })
    .setInputFiles([
      {
        name: "private.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("  Private attachment\n"),
      },
      {
        name: "pixel.png",
        mimeType: "image/png",
        buffer: Buffer.from("iVBORw0KGgo=", "base64"),
      },
    ]);
  await expect(
    dialog.getByRole("button", { name: "Remove attachment pixel.png" }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Check supported options", exact: true })
    .click();
  await expect(
    dialog.getByRole("region", { name: "Equivalent session command" }),
  ).toContainText("--json-schema");
  await expect(
    dialog.getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
  const originalPid = await pid(page),
    sent: KeeperSessionStartRequest[] = [];
  writeFileSync(
    join(HEARTH_HOME, "restart-capability-mode.json"),
    JSON.stringify("refuse-recorded-intent"),
  );
  await page.route("**/keeper/proposals/*/session-start", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    sent.push(
      keeperSessionStartRequestSchema.parse(route.request().postDataJSON()),
    );
    const response = await route.fetch({
      headers: {
        ...(await route.request().allHeaders()),
        Origin: new URL(route.request().url()).origin,
        "Sec-Fetch-Site": "same-origin",
      },
    });
    if (sent.length === 1) await route.abort("connectionfailed");
    else await route.fulfill({ response });
  });
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Retry original Start", exact: true }),
  ).toBeEnabled();
  expect(sent).toHaveLength(1);
  expect(lines("restart-capability-refusals.jsonl")).toBeGreaterThan(0);
  expect(lines("coding-fixture-starts.jsonl")).toBe(0);
  const original = sent[0];
  if (!original) throw new Error("Missing actual reviewed request.");
  expect(original.start.launch.prompt).toBe(text);
  expect(original.start.launch.attachments).toHaveLength(2);
  expect(original.start.launch).toMatchObject({
    mode: "task",
    model: "claude-fixture-reviewed",
    permissionMode: "plan",
    maxBudgetUsd: 1.25,
    fallbackModels: ["haiku"],
  });
  const token = await pageToken(page);
  const restart = await page.evaluate(
    async ({ token, header }) => {
      const reply = await fetch("/__agent-forge/desktop/restart", {
        method: "POST",
        headers: { "Content-Type": "application/json", [header]: token },
        body: "{}",
      });
      const value: unknown = await reply.json();
      if (
        !reply.ok ||
        !value ||
        typeof value !== "object" ||
        !("data" in value) ||
        !value.data ||
        typeof value.data !== "object" ||
        !("url" in value.data) ||
        typeof value.data.url !== "string"
      )
        throw new Error("The actual owned restart did not return a launch.");
      return value.data.url;
    },
    { token, header: OPERATOR_HEADER },
  );
  expect(await pid(page)).not.toBe(originalPid);
  expect(lines("coding-fixture-starts.jsonl")).toBe(0);
  writeFileSync(
    join(HEARTH_HOME, "restart-capability-mode.json"),
    JSON.stringify("normal"),
  );
  const exchanged = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === SESSION_ROUTE,
  );
  await page.goto(restart);
  expect((await exchanged).status()).toBe(200);
  await page.goto(`/index.html#/desktop/project/${alpha.id}/keeper`);
  await card
    .getByRole("button", { name: "Review original Start", exact: true })
    .click();
  await expect(prompt).toHaveValue(text);
  await expect(prompt).not.toBeEditable();
  await expect(
    dialog.getByRole("button", { name: "Retry original Start", exact: true }),
  ).toBeEnabled();
  expect(sent).toHaveLength(1);
  expect(lines("coding-fixture-starts.jsonl")).toBe(0);
  await dialog
    .getByRole("button", { name: "Retry original Start", exact: true })
    .click();
  await expect(page).toHaveURL(
    /\/sessions\?selectionKind=session&selectionId=session-/,
  );
  await expect(
    page.getByRole("region", { name: "Session conversation", exact: true }),
  ).toContainText("Coding reply 🌱");
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  expect(lines("coding-fixture-starts.jsonl")).toBe(1);
  const recording = JSON.parse(
    readFileSync(join(HEARTH_HOME, "coding-fixture-record.json"), "utf8"),
  );
  expect(recording.cwd.replaceAll("\\", "/").toLowerCase()).toBe(
    ROOT.replaceAll("\\", "/").toLowerCase(),
  );
  expect(recording.argv).toContain("--json-schema");
  expect(recording.argv).toContain("claude-fixture-reviewed");
  expect(recording.stdin).toContain("Private attachment");
  expect(recording.stdin).toContain("iVBORw0KGgo=");
  expect(recording.stdin).toContain(text.replaceAll("\n", "\\n"));
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Session conversation", exact: true }),
  ).toContainText("Coding reply 🌱");
  expect(lines("coding-fixture-starts.jsonl")).toBe(1);
});
