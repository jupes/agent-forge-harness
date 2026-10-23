import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { OPERATOR_HEADER } from "../../scripts/hearth/paths";
import { ownedCodingStateSchema } from "../../scripts/sessions/codex-owned-journal";
import { ownedCodingSessionSchema } from "../../scripts/sessions/codex-owned-wire-protocol";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import { pageToken } from "../e2e/launch-link";
import { HEARTH_HOME } from "../e2e/servers";
import { alpha, seedProjects } from "./project-fixtures";

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
function calls(): Array<{
  kind: string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  pid?: number;
  childPid?: number;
}> {
  const path = join(HEARTH_HOME, "codex-chat-fixture-calls.jsonl");
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    throw Error("Invalid complete native Chat fixture log");
  }
}
function mode(value: string) {
  writeFileSync(
    join(HEARTH_HOME, "codex-chat-fixture-mode.json"),
    JSON.stringify(value),
  );
}
let previous = new Set<string>();
test.beforeEach(() => {
  seedProjects();
  previous = new Set(records().map((record) => record.id));
  mode("approval-command");
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
async function composer(page: Page) {
  await page.getByRole("button", { name: "New session", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "New session · Alpha",
    exact: true,
  });
  await dialog.getByRole("button", { name: /Cx · Codex/ }).click();
  await dialog
    .getByRole("combobox", { name: "Session mode", exact: true })
    .selectOption("chat");
  await expect(
    dialog.getByRole("combobox", { name: "Session smith", exact: true }),
  ).toHaveValue("codex-journeyman");
  await dialog
    .getByRole("combobox", { name: "Session effort", exact: true })
    .selectOption("");
  await dialog
    .getByRole("textbox", { name: "Session prompt", exact: true })
    .fill("PRIVATE native Chat first question");
  await dialog
    .getByRole("button", { name: "Check supported options", exact: true })
    .click();
  await expect(
    dialog.getByRole("region", {
      name: "Equivalent session command",
      exact: true,
    }),
  ).toContainText("app-server");
  await expect(
    dialog.getByRole("region", {
      name: "Equivalent session command",
      exact: true,
    }),
  ).not.toContainText("PRIVATE");
  await expect(
    dialog.getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
  return dialog;
}

test("Codex Chat reviews native options, allows one actual command and resumes its exact saved thread after reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 750 });
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/sessions`);
  const before = calls().filter((row) => row.kind === "answer").length,
    dialog = await composer(page);
  await dialog
    .getByRole("textbox", { name: "Session prompt", exact: true })
    .fill("PRIVATE edited native Chat question");
  await expect(
    dialog.getByRole("button", { name: "Start", exact: true }),
  ).toBeDisabled();
  await dialog
    .getByRole("button", { name: "Check supported options", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
  await dialog
    .getByRole("textbox", { name: "Session prompt", exact: true })
    .press("Control+Enter");
  const pane = page.getByRole("region", {
      name: "Session conversation",
      exact: true,
    }),
    approval = pane.getByRole("article", {
      name: "Native command approval",
      exact: true,
    });
  await expect(approval).toContainText("inert example");
  await expect(
    approval.getByRole("button", { name: "Allow once", exact: true }),
  ).toBeEnabled();
  await approval
    .getByRole("button", { name: "Allow once", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(() => calls().filter((row) => row.kind === "answer").length)
    .toBe(before + 1);
  await expect(pane.getByText("Hello world", { exact: true })).toBeVisible();
  const record = records().find((row) => !previous.has(row.id));
  if (!record) throw Error("No accepted Chat record");
  await expect.poll(() => saved(record.id).turns[0]?.phase).toBe("completed");
  const usage = pane.getByRole("region", {
    name: "Native Chat usage",
    exact: true,
  });
  await expect(usage).toContainText("Latest native response");
  await expect(usage).toContainText("Native thread total");
  await expect(
    usage.getByRole("row", { name: "Input 9 19", exact: true }),
  ).toBeVisible();
  expect(saved(record.id).binding?.sessionId).toBe(
    "0199a213-81c0-7800-8aa1-bbab2a035a53",
  );
  mode("normal");
  await reloadSettled(page);
  await expect(pane.getByText("Hello world", { exact: true })).toBeVisible();
  const message = pane.getByRole("textbox", {
    name: "Session reply prompt",
    exact: true,
  });
  await message.fill("PRIVATE second explicit Chat turn");
  await pane
    .getByRole("button", { name: "Send session message", exact: true })
    .click();
  await expect
    .poll(() => saved(record.id).turns.map((turn) => turn.phase))
    .toEqual(["completed", "completed"]);
  expect(
    calls()
      .filter((row) => row.kind === "rpc" && row.method === "thread/resume")
      .at(-1)?.params,
  ).toMatchObject({
    threadId: saved(record.id).binding?.sessionId,
    excludeTurns: true,
  });
  expect(
    saved(record.id).frames.filter((frame) => frame.event.kind === "model"),
  ).toEqual([]);
});
