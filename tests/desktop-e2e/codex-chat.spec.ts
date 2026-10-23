import {
  existsSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import { OPERATOR_HEADER } from "../../scripts/hearth/paths";
import { serializeCodexChat } from "../../scripts/sessions/codex-app-server-protocol";
import { codexChatApprovalPageSchema } from "../../scripts/sessions/codex-chat-owned-protocol";
import { ownedCodingStateSchema } from "../../scripts/sessions/codex-owned-journal";
import { ownedCodingSessionSchema } from "../../scripts/sessions/codex-owned-wire-protocol";
import { sessionTranscriptExportSchema } from "../../scripts/sessions/library-protocol";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import { pageToken } from "../e2e/launch-link";
import { HEARTH_HOME } from "../e2e/servers";
import {
  alpha,
  beta,
  catalog,
  catalogFile,
  seedProjects,
  workspace,
} from "./project-fixtures";

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
async function startedChat(page: Page) {
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/sessions`);
  const dialog = await composer(page);
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  const pane = page.getByRole("region", {
    name: "Session conversation",
    exact: true,
  });
  await expect(pane).toBeVisible();
  await expect
    .poll(() => records().filter((row) => !previous.has(row.id)).length)
    .toBe(1);
  const record = records().find((row) => !previous.has(row.id));
  if (!record) throw Error("No accepted Chat record");
  return { pane, record };
}
let previous = new Set<string>();
test.beforeEach(() => {
  seedProjects();
  for (const name of [
    "codex-chat-outcome-held.json",
    "codex-chat-outcome-release",
  ]) {
    const file = join(HEARTH_HOME, name);
    if (existsSync(file)) unlinkSync(file);
  }
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
async function composer(page: Page, capture = false, alreadyOpen = false) {
  if (!alreadyOpen)
    await page
      .getByRole("button", { name: "New session", exact: true })
      .click();
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
  if (capture && process.env.CODEX_CHAT_SHOTS) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({
      path: join(process.env.CODEX_CHAT_SHOTS, "codex-chat-composer.png"),
      fullPage: true,
      maskColor: "#1c1d24",
      mask: [
        dialog.getByRole("combobox", {
          name: "Session repository",
          exact: true,
        }),
        dialog.getByRole("textbox", { name: "Session prompt", exact: true }),
      ],
    });
    await page.setViewportSize({ width: 1100, height: 700 });
  }
  return dialog;
}

test("native Chat command reports show inert streamed and aggregate output with exact completion after saved reload", async ({
  page,
}) => {
  mode("command-activity");
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const starts = calls().filter(
    (row) => row.kind === "rpc" && row.method === "turn/start",
  ).length;
  const answers = calls().filter((row) => row.kind === "answer").length;
  const { pane, record } = await startedChat(page);
  await expect.poll(() => saved(record.id).turns[0]?.phase).toBe("completed");
  const activity = pane.getByRole("region", {
    name: "Reported session activity",
    exact: true,
  });
  const summary = activity.locator("summary", {
    hasText: "Command · Reported completed",
  });
  await expect(summary).toBeVisible();
  await summary.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(summary).toBeFocused();
  await expect(summary).toHaveCSS("outline-width", "2px");
  await page.keyboard.press("Enter");
  await expect(
    activity.getByRole("region", { name: "Command report", exact: true }),
  ).toHaveText("inert command <script> stays text");
  await expect(
    activity.getByRole("region", {
      name: "Streamed output report",
      exact: true,
    }),
  ).toHaveText("Reported line one\n");
  await expect(
    activity.getByRole("region", {
      name: "Reported aggregate output report",
      exact: true,
    }),
  ).toHaveText("Reported line one\nReported line two\n");
  await expect(activity).toContainText("Reported exit code: 0");
  await expect(activity).toContainText("Reported duration: 12 ms");
  await expect(activity).toContainText("app-server item/completed");
  await expect(activity.locator("script, iframe, img, a, button")).toHaveCount(
    0,
  );
  await expect(
    pane.getByRole("article", { name: "Native command approval", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(
    activity.getByRole("region", { name: "Command report", exact: true }),
  ).toBeFocused();
  await expect(
    activity.getByRole("region", { name: "Command report", exact: true }),
  ).toHaveCSS("outline-width", "2px");
  if (process.env.CODEX_CHAT_COMMAND_SHOTS) {
    // The live1100px assertions above remain the behavior check. Capture the
    // entire inert report in a taller review viewport, outside the reply bar.
    await page.setViewportSize({ width: 1280, height: 1100 });
    await activity.evaluate((node) => node.scrollIntoView({ block: "center" }));
    await expect
      .poll(() =>
        activity.evaluate((node) => {
          const outer = node
            .closest(".af-owned-transcript")
            ?.getBoundingClientRect();
          const inner = node.getBoundingClientRect();
          return Boolean(
            outer && inner.top >= outer.top && inner.bottom <= outer.bottom,
          );
        }),
      )
      .toBe(true);
    await activity.screenshot({
      path: join(
        process.env.CODEX_CHAT_COMMAND_SHOTS,
        "native-chat-command.png",
      ),
      maskColor: "#1c1d24",
      mask: [
        activity.locator(".af-session-note", {
          hasText: "Reported working directory:",
        }),
      ],
    });
    await page.setViewportSize({ width: 1100, height: 700 });
  }
  const beforeReload = saved(record.id).frames;
  await reloadSettled(page);
  await activity
    .locator("summary", { hasText: "Command · Reported completed" })
    .click();
  await expect(activity).toContainText("Reported exit code: 0");
  await expect(
    activity.getByRole("region", {
      name: "Streamed output report",
      exact: true,
    }),
  ).toHaveText("Reported line one\n");
  expect(saved(record.id).frames).toEqual(beforeReload);
  expect(
    calls().filter((row) => row.kind === "rpc" && row.method === "turn/start"),
  ).toHaveLength(starts + 1);
  expect(calls().filter((row) => row.kind === "answer")).toHaveLength(answers);
  await openSettled(
    page,
    `/index.html#/desktop/project/${beta.id}/sessions?selectionKind=session&selectionId=${record.id}`,
  );
  await expect(
    page.getByRole("region", {
      name: "Reported session activity",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByText("inert command <script> stays text", { exact: true }),
  ).toHaveCount(0);
});

test("actual Stop retains a partial native command stream without inventing completion or permission authority", async ({
  page,
}) => {
  mode("command-activity-held");
  const starts = calls().filter(
    (row) => row.kind === "rpc" && row.method === "turn/start",
  ).length;
  const answers = calls().filter((row) => row.kind === "answer").length;
  const { pane, record } = await startedChat(page);
  const activity = pane.getByRole("region", {
    name: "Reported session activity",
    exact: true,
  });
  await activity
    .locator("summary", {
      hasText: "Command · Reported in progress · Partial report",
    })
    .click();
  await expect(
    activity.getByRole("region", {
      name: "Streamed output report",
      exact: true,
    }),
  ).toHaveText("Reported line one\n");
  await expect(activity).toContainText("Exit code not reported");
  await expect(activity).toContainText("Final aggregate output not reported");
  await expect(
    pane.getByRole("button", { name: "Allow once", exact: true }),
  ).toHaveCount(0);
  await pane.getByRole("button", { name: "Stop session", exact: true }).click();
  await expect.poll(() => saved(record.id).turns[0]?.phase).toBe("cancelled");
  await expect(pane.locator("[data-session-state]")).toHaveAttribute(
    "data-session-state",
    "stopped",
  );
  await expect(activity.locator("summary")).toContainText("Partial report");
  const commands = saved(record.id).frames.filter(
    (frame) =>
      frame.event.kind === "coding-chat" &&
      frame.event.event.kind === "command",
  );
  expect(commands).toHaveLength(2);
  expect(commands.at(-1)?.event).toMatchObject({
    event: {
      source: "item/commandExecution/outputDelta",
      status: "inProgress",
      partial: true,
      exitCode: null,
    },
  });
  await reloadSettled(page);
  await activity
    .locator("summary", {
      hasText: "Command · Reported in progress · Partial report",
    })
    .click();
  await expect(
    activity.getByRole("region", {
      name: "Streamed output report",
      exact: true,
    }),
  ).toHaveText("Reported line one\n");
  await expect(activity).toContainText("Exit code not reported");
  await expect(pane.locator("[data-session-state]")).toHaveAttribute(
    "data-session-state",
    "stopped",
  );
  expect(
    calls().filter((row) => row.kind === "rpc" && row.method === "turn/start"),
  ).toHaveLength(starts + 1);
  expect(calls().filter((row) => row.kind === "answer")).toHaveLength(answers);
});

test("Codex Chat reviews native options, allows one actual command and resumes its exact saved thread after reload", async ({
  page,
}) => {
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
    .getByRole("button", { name: "Start session", exact: true })
    .click();
  const before = calls().filter((row) => row.kind === "answer").length,
    dialog = await composer(page, true, true);
  await expect(
    dialog.getByRole("textbox", { name: "Session bead", exact: true }),
  ).toHaveValue("alpha-epic");
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
  await expect(pane.locator("[data-session-state]")).toHaveAttribute(
    "data-session-state",
    "needs-permission",
  );
  await expect
    .poll(() =>
      pane.locator("header").evaluate((header) => {
        const heading = header.querySelector("h2");
        if (!heading) return false;
        const outer = header.getBoundingClientRect(),
          inner = heading.getBoundingClientRect();
        return inner.top >= outer.top && inner.bottom <= outer.bottom;
      }),
    )
    .toBe(true);
  const actions = pane.getByRole("button", {
    name: "Session actions",
    exact: true,
  });
  await actions.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(actions).toBeFocused();
  await expect(actions).toHaveCSS("outline-width", "2px");
  await page.keyboard.press("Enter");
  const support = page.getByRole("dialog", {
    name: "Session actions",
    exact: true,
  });
  await expect(support).toContainText(
    "Review the inline native permission cards",
  );
  await expect(
    support.getByRole("button", { name: "Continue this Chat", exact: true }),
  ).toBeDisabled();
  await expect(
    support.getByRole("button", { name: "Fork session", exact: true }),
  ).toBeDisabled();
  await expect(
    support.getByRole("button", {
      name: "Open session in terminal",
      exact: true,
    }),
  ).toBeDisabled();
  const review = support.getByRole("button", {
    name: "Review native permissions",
    exact: true,
  });
  await expect(review).toBeEnabled();
  await review.focus();
  if (process.env.CODEX_CHAT_SHOTS)
    await support.screenshot({
      path: join(process.env.CODEX_CHAT_SHOTS, "native-chat-actions.png"),
    });
  await page.keyboard.press("Enter");
  const refresh = pane.getByRole("button", {
    name: "Refresh native approvals",
    exact: true,
  });
  await expect(refresh).toBeFocused();
  await expect(refresh).toHaveCSS("outline-width", "2px");
  expect(calls().filter((row) => row.kind === "answer")).toHaveLength(before);
  if (process.env.CODEX_CHAT_SHOTS) {
    await page
      .getByRole("button", { name: "Hide inspector", exact: true })
      .click();
    await page.setViewportSize({ width: 1280, height: 1000 });
    await approval.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(process.env.CODEX_CHAT_SHOTS, "codex-chat-approval.png"),
      fullPage: true,
      maskColor: "#1c1d24",
      style:
        '.af-owned-session code, .af-owned-session-header details, [aria-label="Your session message"] { visibility: hidden !important; }',
      mask: [
        page.getByRole("complementary", { name: "Inspector", exact: true }),
        pane
          .locator(".af-session-note")
          .filter({ hasText: /[A-Z]:[\\/]|\/Users\/|\/home\// }),
      ],
    });
    await page.setViewportSize({ width: 1100, height: 700 });
  }
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
  expect(record.beadId).toBe("alpha-epic");
  expect(realpathSync.native(record.worktree)).toBe(
    realpathSync.native(workspace),
  );
  expect(
    saved(record.id).frames.find((frame) => frame.event.kind === "user")?.event,
  ).toMatchObject({
    kind: "user",
    codexChat: {
      launch: {
        context: { beadId: "alpha-epic", worktree: record.worktree },
      },
    },
  });
  await expect.poll(() => saved(record.id).turns[0]?.phase).toBe("completed");
  await expect(pane.locator("[data-session-state]")).toHaveAttribute(
    "data-session-state",
    "idle",
  );
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
  await pane
    .getByRole("button", { name: "Session actions", exact: true })
    .click();
  const continued = page.getByRole("dialog", {
    name: "Session actions",
    exact: true,
  });
  await expect(continued).not.toContainText("Native Chat is not connected");
  await expect(
    continued.getByRole("button", { name: "Continue this Chat", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          document.body.dataset.copiedCli = value;
        },
      },
    }),
  );
  await continued
    .getByRole("button", { name: "Copy original CLI preview", exact: true })
    .click();
  const original = saved(record.id).frames.find(
    (frame) => frame.event.kind === "user",
  )?.event;
  if (
    original?.kind !== "user" ||
    !("codexChat" in original) ||
    !original.codexChat
  )
    throw Error("Missing original native Chat snapshot");
  const serialized = serializeCodexChat(
    original.codexChat.launch,
    original.codexChat.capabilities,
  );
  await expect
    .poll(() => page.evaluate(() => document.body.dataset.copiedCli))
    .toBe(`${serialized.equivalentCommand}\n\n${serialized.stdinNote}`);
  const startsBeforeContinue = calls().filter(
    (row) =>
      row.kind === "rpc" &&
      ["thread/start", "thread/resume"].includes(row.method ?? ""),
  ).length;
  await continued
    .getByRole("button", { name: "Continue this Chat", exact: true })
    .click();
  const message = pane.getByRole("textbox", {
    name: "Session reply prompt",
    exact: true,
  });
  await expect(message).toBeFocused();
  expect(saved(record.id).turns).toHaveLength(1);
  expect(
    calls().filter(
      (row) =>
        row.kind === "rpc" &&
        ["thread/start", "thread/resume"].includes(row.method ?? ""),
    ).length,
  ).toBe(startsBeforeContinue);
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

test("native Chat keeps both turns' response and thread usage across follow-up, reload and complete export", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  mode("scoped-usage");
  const startsBefore = calls().filter(
      (row) => row.method === "turn/start",
    ).length,
    resumesBefore = calls().filter(
      (row) => row.method === "thread/resume",
    ).length;
  const { pane, record } = await startedChat(page);
  await expect.poll(() => saved(record.id).turns[0]?.phase).toBe("completed");
  const firstUsage = pane
    .locator(".af-owned-turn")
    .first()
    .getByRole("region", { name: "Native Chat usage", exact: true });
  await expect(
    firstUsage
      .getByRole("row")
      .filter({ hasText: /^Input/ })
      .getByRole("cell"),
  ).toHaveText(["9", "19"]);
  const reply = pane.getByRole("textbox", {
    name: "Session reply prompt",
    exact: true,
  });
  await reply.fill("Explicit follow-up for distinct reported usage scopes");
  const send = pane.getByRole("button", {
    name: "Send session message",
    exact: true,
  });
  await expect(send).toBeEnabled();
  await send.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(send).toBeFocused();
  await expect(send).toHaveCSS("outline-width", "2px");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => saved(record.id).turns.map((turn) => turn.phase))
    .toEqual(["completed", "completed"]);
  const assertScopes = async () => {
    const turns = pane.locator(".af-owned-turn");
    await expect(turns).toHaveCount(2);
    const older = turns
        .nth(0)
        .getByRole("region", { name: "Native Chat usage", exact: true }),
      newer = turns
        .nth(1)
        .getByRole("region", { name: "Native Chat usage", exact: true });
    await expect(
      pane.getByRole("region", { name: "Native Chat usage", exact: true }),
    ).toHaveCount(2);
    await expect(
      older
        .getByRole("row")
        .filter({ hasText: /^Input/ })
        .getByRole("cell"),
    ).toHaveText(["9", "19"]);
    await expect(
      newer
        .getByRole("row")
        .filter({ hasText: /^Input/ })
        .getByRole("cell"),
    ).toHaveText(["0", "42"]);
    await expect(
      newer
        .getByRole("row")
        .filter({ hasText: /^Output/ })
        .getByRole("cell"),
    ).toHaveText(["2", "8"]);
    await expect(newer).toContainText("Observed model");
    await expect(
      newer.getByRole("columnheader", {
        name: "Latest native response",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      newer.getByRole("columnheader", {
        name: "Native thread total",
        exact: true,
      }),
    ).toBeVisible();
  };
  await assertScopes();
  await reloadSettled(page);
  await assertScopes();
  if (process.env.CODEX_CHAT_USAGE_SHOTS) {
    // The minimum-desktop assertions above use the actual scrollable pane.
    // Give its full neutral usage card room for a legible review capture.
    await page.setViewportSize({ width: 1280, height: 1100 });
    const capture = pane
      .locator(".af-owned-turn")
      .nth(1)
      .getByRole("region", { name: "Native Chat usage", exact: true });
    await capture.evaluate((element) =>
      element.scrollIntoView({ block: "center", inline: "nearest" }),
    );
    await capture.screenshot({
      path: join(
        process.env.CODEX_CHAT_USAGE_SHOTS,
        "native-chat-turn-usage.png",
      ),
    });
    await page.setViewportSize({ width: 1100, height: 700 });
  }
  await pane
    .getByRole("button", { name: "Session actions", exact: true })
    .click();
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("dialog", { name: "Session actions", exact: true })
    .getByRole("button", { name: "Export saved transcript", exact: true })
    .click();
  const file = await (await downloading).path();
  if (!file) throw Error("Missing complete native usage transcript");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw Error("Invalid complete native usage transcript");
  }
  const exported = sessionTranscriptExportSchema.parse(raw).conversation,
    accepted = saved(record.id).turns.map((turn) => turn.requestId);
  expect(exported.turns.map((turn) => turn.requestId)).toEqual(accepted);
  expect(
    exported.frames
      .filter(
        (frame) =>
          frame.event.kind === "coding-chat" &&
          frame.event.event.kind === "usage",
      )
      .map((frame) => ({ turnId: frame.turnId, event: frame.event })),
  ).toMatchObject([
    {
      turnId: accepted[0],
      event: {
        event: {
          kind: "usage",
          usage: {
            lastResponse: { inputTokens: 9 },
            threadTotal: { inputTokens: 19 },
          },
        },
      },
    },
    {
      turnId: accepted[1],
      event: {
        event: {
          kind: "usage",
          usage: {
            lastResponse: { inputTokens: 0 },
            threadTotal: { inputTokens: 42 },
          },
        },
      },
    },
  ]);
  expect(calls().filter((row) => row.method === "turn/start")).toHaveLength(
    startsBefore + 2,
  );
  expect(calls().filter((row) => row.method === "thread/resume")).toHaveLength(
    resumesBefore + 1,
  );
});

test("native permission state cannot cross project scope or survive an interrupted feed and actual Stop", async ({
  page,
}) => {
  const before = calls().filter((row) => row.kind === "answer").length;
  const { pane, record } = await startedChat(page);
  const state = pane.locator("[data-session-state]");
  await expect(state).toHaveAttribute("data-session-state", "needs-permission");
  await page.route("**/sessions/*/events*", (route) =>
    route.abort("connectionreset"),
  );
  await reloadSettled(page);
  await expect(state).toHaveAttribute("data-session-state", "stale");
  await expect(
    pane.getByRole("button", { name: "Allow once", exact: true }),
  ).toHaveCount(0);
  expect(saved(record.id).turns[0]?.phase).toBe("running");
  await openSettled(
    page,
    `/index.html#/desktop/project/${beta.id}/sessions?selectionKind=session&selectionId=${record.id}`,
  );
  await expect(
    page.getByRole("region", { name: "Session conversation", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-session-state="needs-permission"]'),
  ).toHaveCount(0);
  await page.unroute("**/sessions/*/events*");
  await openSettled(
    page,
    `/index.html#/desktop/project/${alpha.id}/sessions?selectionKind=session&selectionId=${record.id}`,
  );
  await expect(state).toHaveAttribute("data-session-state", "needs-permission");
  await pane.getByRole("button", { name: "Stop session", exact: true }).click();
  await expect.poll(() => saved(record.id).turns[0]?.phase).toBe("cancelled");
  await expect(state).toHaveAttribute("data-session-state", "stopped");
  await expect(
    pane.getByRole("button", { name: "Allow once", exact: true }),
  ).toHaveCount(0);
  await reloadSettled(page);
  await expect(state).toHaveAttribute("data-session-state", "stopped");
  expect(calls().filter((row) => row.kind === "answer")).toHaveLength(before);
  expect(saved(record.id).turns).toHaveLength(1);
});

test("a decision held before native admission survives reload and checks only its original recorded intent", async ({
  page,
}) => {
  const before = calls().filter((row) => row.kind === "answer").length,
    { pane, record } = await startedChat(page);
  const approval = pane.getByRole("article", {
    name: "Native command approval",
    exact: true,
  });
  await expect(approval).toBeVisible();
  let release = () => {},
    received = () => {},
    completed = () => {},
    posts = 0;
  const held = new Promise<void>((resolve) => {
      received = resolve;
    }),
    delivery = new Promise<void>((resolve) => {
      release = resolve;
    }),
    delivered = new Promise<void>((resolve) => {
      completed = resolve;
    });
  const originals: unknown[] = [];
  await page.route(
    `**/projects/${alpha.id}/sessions/${record.id}/approval-decisions`,
    async (route) => {
      posts++;
      originals.push(route.request().postDataJSON());
      received();
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
        completed();
      }
    },
  );
  await approval
    .getByRole("button", { name: "Allow once", exact: true })
    .click();
  await held;
  try {
    expect(calls().filter((row) => row.kind === "answer")).toHaveLength(before);
    const metadata = await page.evaluate(() =>
      localStorage.getItem("agent-forge.codex-chat-decision-identities.v1"),
    );
    expect(metadata).not.toContain("PRIVATE");
    expect(metadata).not.toContain("inert example");
    expect(metadata).not.toContain(record.worktree);
    expect(metadata).not.toContain("nativeRequestId");
    await reloadSettled(page);
    await expect(
      pane.getByRole("button", {
        name: "Check original decision",
        exact: true,
      }),
    ).toBeVisible();
    await pane
      .getByRole("button", { name: "Check original decision", exact: true })
      .click();
    await expect(
      pane.getByText(
        "The original decision is not confirmed. It remains held; it was not resent.",
        { exact: true },
      ),
    ).toBeVisible();
    const allow = pane.getByRole("button", { name: "Allow once", exact: true });
    if (await allow.count()) await expect(allow).toBeDisabled();
    expect(posts).toBe(1);
    expect(calls().filter((row) => row.kind === "answer")).toHaveLength(before);
  } finally {
    release();
    await delivered;
  }
  await expect
    .poll(() => calls().filter((row) => row.kind === "answer").length)
    .toBe(before + 1);
  await pane
    .getByRole("button", { name: "Check original decision", exact: true })
    .click();
  await expect(
    pane.getByText(
      "The original decision intent is recorded. This does not confirm native delivery or execution.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(posts).toBe(1);
  expect(originals).toHaveLength(1);
  expect(
    await page.evaluate(() =>
      localStorage.getItem("agent-forge.codex-chat-decision-identities.v1"),
    ),
  ).toBe('{"version":1,"records":[]}');
});

for (const selected of ["decline", "cancel"] as const)
  test(`native command ${selected} uses one offered choice and cannot grant a session-wide allowance`, async ({
    page,
  }) => {
    const before = calls().filter((row) => row.kind === "answer").length,
      { pane, record } = await startedChat(page),
      approval = pane.getByRole("article", {
        name: "Native command approval",
        exact: true,
      });
    await expect(approval).toBeVisible();
    await expect(
      approval.getByRole("button", { name: /for this session/i }),
    ).toHaveCount(0);
    await approval
      .getByRole("button", {
        name: selected === "decline" ? "Decline" : "Cancel native request",
        exact: true,
      })
      .click();
    await expect
      .poll(() => calls().filter((row) => row.kind === "answer").length)
      .toBe(before + 1);
    expect(
      calls()
        .filter((row) => row.kind === "answer")
        .at(-1)?.result,
    ).toEqual({ decision: selected });
    await expect
      .poll(() => saved(record.id).turns[0]?.phase)
      .toBe(selected === "cancel" ? "failed" : "completed");
    await expect(approval).toHaveCount(0);
  });

test("file Allow stays unavailable without actual diffs and decline is still native", async ({
  page,
}) => {
  mode("approval-file");
  const before = calls().filter((row) => row.kind === "answer").length,
    { pane, record } = await startedChat(page),
    approval = pane.getByRole("article", {
      name: "Native file approval",
      exact: true,
    });
  await expect(approval).toContainText(
    "Actual file-change details are unavailable. Allow is disabled.",
  );
  await expect(
    approval.getByRole("button", {
      name: "Allow once · unavailable",
      exact: true,
    }),
  ).toBeDisabled();
  await approval.getByRole("button", { name: "Decline", exact: true }).click();
  await expect
    .poll(() => calls().filter((row) => row.kind === "answer").length)
    .toBe(before + 1);
  expect(
    calls()
      .filter((row) => row.kind === "answer")
      .at(-1)?.result,
  ).toEqual({ decision: "decline" });
  await expect.poll(() => saved(record.id).turns[0]?.phase).toBe("completed");
});

test("a synchronous draft edit before the next paint cannot dispatch an unreviewed Chat", async ({
  page,
}) => {
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/sessions`);
  const dialog = await composer(page);
  const before = records().length;
  let starts = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname ===
        `/__agent-forge/projects/${alpha.id}/sessions`
    )
      starts++;
  });
  await dialog.evaluate(async (element) => {
    const prompt = element.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Session prompt"]',
      ),
      start = [...element.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Start",
      );
    if (!prompt || !start || start.disabled)
      throw Error("No checked enabled Start");
    prompt.value = "PRIVATE unreviewed same-event-loop edit";
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
    start.click();
    // A rejected Start has no reservation; an accepted original completes its
    // lock transaction before this lock can observe the durable journal.
    await navigator.locks.request(
      "agent-forge.owned-session-start-identities.v1",
      () => {},
    );
  });
  await expect(
    dialog.getByRole("button", { name: "Start", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByText(
      "The Chat selection changed. Check supported options again before Start.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(starts).toBe(0);
  expect(records()).toHaveLength(before);
});

test("a background native approval read retains keyboard focus and dispatches no decision", async ({
  page,
}) => {
  const { pane, record } = await startedChat(page),
    allow = pane.getByRole("button", { name: "Allow once", exact: true });
  await expect(allow).toBeEnabled();
  await allow.focus();
  let release = () => {},
    received = () => {},
    once = false,
    decisions = 0;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    held = new Promise<void>((resolve) => {
      received = resolve;
    });
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/approval-decisions")
    )
      decisions++;
  });
  await page.route(
    `**/projects/${alpha.id}/sessions/${record.id}/approvals`,
    async (route) => {
      if (!once) {
        once = true;
        received();
        await gate;
      }
      await route.continue();
    },
  );
  try {
    await held;
    await expect(allow).toBeFocused();
    await expect(allow).toBeEnabled();
    expect(decisions).toBe(0);
  } finally {
    release();
  }
  await expect(allow).toBeFocused();
  await expect(allow).toBeEnabled();
  expect(decisions).toBe(0);
  await page.keyboard.press("Enter");
  await expect.poll(() => saved(record.id).turns[0]?.phase).toBe("completed");
  expect(decisions).toBe(1);
});

test("explicit Chat Stop waits for the actual native provider and helper to exit", async ({
  page,
}) => {
  mode("hang-text");
  const { pane, record } = await startedChat(page);
  await expect(
    pane.getByRole("article", { name: "Session reply", exact: true }),
  ).toContainText("private pending text");
  const process = calls()
    .filter((row) => row.kind === "tree")
    .at(-1);
  if (!process?.pid || !process.childPid)
    throw Error("No actual native process tree");
  const alive = (pid: number) => {
    try {
      if (
        processPlatform === "linux" &&
        /\) Z(?: |$)/.test(readFileSync(`/proc/${pid}/stat`, "utf8"))
      )
        return false;
      globalThis.process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const processPlatform = globalThis.process.platform;
  expect(alive(process.pid) && alive(process.childPid)).toBe(true);
  await pane.getByRole("button", { name: "Stop session", exact: true }).click();
  await expect.poll(() => saved(record.id).turns[0]?.phase).toBe("cancelled");
  await expect
    .poll(() => alive(process.pid ?? 0) || alive(process.childPid ?? 0))
    .toBe(false);
  await expect(
    pane.getByRole("button", { name: "Allow once", exact: true }),
  ).toHaveCount(0);
  await reloadSettled(page);
  await expect(pane.locator("[data-session-state]")).toHaveAttribute(
    "data-session-state",
    "stopped",
  );
  const outcome = pane.getByRole("region", {
    name: "Native Chat outcome",
    exact: true,
  });
  await expect(outcome).toContainText("Supervisor stopped the process");
  expect(
    saved(record.id).frames.some(
      (frame) =>
        frame.event.kind === "coding-chat" &&
        frame.event.event.kind === "outcome" &&
        frame.event.event.outcome.stopped,
    ),
  ).toBe(true);
});

test("Chat option checks show loading and failure without accepting a turn, then recover through a fresh native preview", async ({
  page,
}) => {
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/sessions`);
  let releaseChoices = () => {};
  const choicesGate = new Promise<void>((resolve) => {
    releaseChoices = resolve;
  });
  await page.route("**/__agent-forge/smiths", async (route) => {
    await choicesGate;
    await route.continue();
  });
  await page.getByRole("button", { name: "New session", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "New session · Alpha",
    exact: true,
  });
  await dialog.getByRole("button", { name: /Cx · Codex/ }).click();
  await dialog
    .getByRole("combobox", { name: "Session mode", exact: true })
    .selectOption("chat");
  try {
    await expect(
      dialog.getByRole("textbox", { name: "Session model", exact: true }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("combobox", { name: "Session effort", exact: true }),
    ).toBeDisabled();
  } finally {
    releaseChoices();
  }
  await expect(
    dialog.getByRole("combobox", { name: "Session smith", exact: true }),
  ).toHaveValue("codex-journeyman");
  await page.unroute("**/__agent-forge/smiths");
  await dialog
    .getByRole("textbox", { name: "Session prompt", exact: true })
    .fill("PRIVATE checked later");
  await dialog
    .getByRole("combobox", { name: "Session effort", exact: true })
    .selectOption("");
  let release = () => {},
    seen = () => {};
  const held = new Promise<void>((resolve) => {
      seen = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  const path = `**/projects/${alpha.id}/sessions/preview`;
  await page.route(path, async (route) => {
    seen();
    await gate;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        data: null,
        error:
          "Native capability check is unavailable. No conversation was started.",
      }),
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
    expect(records().filter((row) => !previous.has(row.id))).toEqual([]);
  } finally {
    release();
  }
  await expect(
    dialog.getByText(
      "Native capability check is unavailable. No conversation was started.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.unroute(path);
  await dialog
    .getByRole("button", { name: "Check supported options", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
  expect(records().filter((row) => !previous.has(row.id))).toEqual([]);
});

test("archived and foreign projects cannot advertise or answer an existing live Chat callback", async ({
  page,
}) => {
  const before = calls().filter((row) => row.kind === "answer").length,
    { pane, record } = await startedChat(page);
  await expect(
    pane.getByRole("button", { name: "Allow once", exact: true }),
  ).toBeEnabled();
  const pending = saved(record.id).frames.find(
    (frame) =>
      frame.event.kind === "coding-chat" &&
      frame.event.event.kind === "approval-request",
  )?.event;
  if (
    pending?.kind !== "coding-chat" ||
    pending.event.kind !== "approval-request"
  )
    throw Error("No saved native offer");
  const token = await pageToken(page);
  const foreign = await page.evaluate(
    async ({ project, id, token, header, approvalId, turnRequestId }) => {
      const base = `/__agent-forge/projects/${project}/sessions/${id}`,
        headers = { [header]: token, "Content-Type": "application/json" };
      const read = await fetch(`${base}/approvals`, { headers }),
        write = await fetch(`${base}/approval-decisions`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            turnRequestId,
            approvalId,
            decision: "accept",
          }),
        });
      return { read: read.status, write: write.status };
    },
    {
      project: beta.id,
      id: record.id,
      token,
      header: OPERATOR_HEADER,
      approvalId: pending.event.approval.id,
      turnRequestId: saved(record.id).turns[0]?.requestId,
    },
  );
  expect(foreign).toEqual({ read: 409, write: 409 });
  try {
    writeFileSync(
      catalogFile,
      JSON.stringify({
        ...catalog,
        revision: catalog.revision + 1,
        projects: catalog.projects.map((project) =>
          project.id === alpha.id ? { ...project, archived: true } : project,
        ),
      }),
    );
    await reloadSettled(page);
    await expect(
      pane.getByRole("button", { name: "Allow once", exact: true }),
    ).toHaveCount(0);
    await expect(
      pane.getByRole("button", {
        name: "Refresh native approvals",
        exact: true,
      }),
    ).toBeDisabled();
    const archived = await page.evaluate(
      async ({ project, id, token, header }) => {
        const response = await fetch(
          `/__agent-forge/projects/${project}/sessions/${id}/approvals`,
          { headers: { [header]: token } },
        );
        return response.status;
      },
      { project: alpha.id, id: record.id, token, header: OPERATOR_HEADER },
    );
    expect(archived).toBe(409);
    expect(calls().filter((row) => row.kind === "answer")).toHaveLength(before);
  } finally {
    writeFileSync(catalogFile, JSON.stringify(catalog));
  }
});

test("a native Chat provider failure stays failed and never reports an observed execution model", async ({
  page,
}) => {
  mode("provider-error");
  const { pane, record } = await startedChat(page);
  await expect.poll(() => saved(record.id).turns[0]?.phase).toBe("failed");
  await expect(pane.locator("[data-session-state]")).toHaveAttribute(
    "data-session-state",
    "error",
  );
  await expect(pane).toContainText(
    "The execution model is not reported by this native Chat protocol.",
  );
  expect(
    saved(record.id).frames.filter((frame) => frame.event.kind === "model"),
  ).toEqual([]);
  await expect(
    pane.getByRole("button", { name: "Allow once", exact: true }),
  ).toHaveCount(0);
});

test("the native approval deadline removes stale choices without answering the request", async ({
  page,
}) => {
  mode("approval-timeout");
  const before = calls().filter((row) => row.kind === "answer").length,
    { pane, record } = await startedChat(page),
    allow = pane.getByRole("button", { name: "Allow once", exact: true });
  await expect(allow).toBeEnabled();
  await expect.poll(() => saved(record.id).turns[0]?.phase).toBe("unknown");
  await expect(allow).toHaveCount(0);
  expect(calls().filter((row) => row.kind === "answer")).toHaveLength(before);
  await expect(
    pane.getByRole("button", { name: "Refresh native approvals", exact: true }),
  ).toBeDisabled();
});

test("a saved native timeout withdraws old choices before final metadata settles, and reload/export never revive or resend them", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  mode("outcome-held");
  const before = calls().filter((row) => row.method === "turn/start").length;
  const { pane, record } = await startedChat(page);
  const allow = pane.getByRole("button", { name: "Allow once", exact: true });
  await expect(allow).toBeEnabled();
  let releaseRead = () => {},
    received = () => {},
    rejectHeld = (_error: unknown) => {},
    consumed = () => {},
    heldOnce = false,
    decisions = 0;
  let fixtureFailure: unknown = null;
  const gate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const held = new Promise<void>((resolve, reject) => {
    received = resolve;
    rejectHeld = reject;
  });
  const releasedResponse = new Promise<void>((resolve) => {
    consumed = resolve;
  });
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/approval-decisions")
    )
      decisions++;
  });
  await page.route(
    `**/projects/${alpha.id}/sessions/${record.id}/approvals`,
    async (route) => {
      try {
        if (heldOnce) {
          await route.continue();
          return;
        }
        heldOnce = true;
        const response = await route.fetch({
          headers: {
            ...route.request().headers(),
            origin: new URL(route.request().url()).origin,
          },
        });
        if (response.status() !== 200)
          throw Error(
            `Protected approval fixture read refused: ${response.status()}`,
          );
        const body = await response.text();
        let raw: unknown;
        try {
          raw = JSON.parse(body);
        } catch {
          throw Error("Malformed protected approval fixture read");
        }
        const originalOffer = z
          .object({
            ok: z.literal(true),
            data: codexChatApprovalPageSchema,
            error: z.null(),
          })
          .strict()
          .parse(raw).data;
        const offered = saved(record.id).frames.find(
          (frame) =>
            frame.turnId === record.requestId &&
            frame.event.kind === "coding-chat" &&
            frame.event.event.kind === "approval-request",
        )?.event;
        if (
          offered?.kind !== "coding-chat" ||
          offered.event.kind !== "approval-request"
        )
          throw Error("No original native approval witness");
        expect(originalOffer.pending).toHaveLength(1);
        expect(originalOffer.pending[0]).toMatchObject({
          turnRequestId: record.requestId,
          actionable: true,
          approval: { id: offered.event.approval.id },
        });
        received();
        await gate;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body,
        });
        consumed();
      } catch (error) {
        fixtureFailure = error;
        rejectHeld(error);
        consumed();
        await route.abort().catch(() => {});
      }
    },
  );
  try {
    await pane
      .getByRole("button", { name: "Refresh native approvals", exact: true })
      .click();
    await held;
    await expect
      .poll(() => existsSync(join(HEARTH_HOME, "codex-chat-outcome-held.json")))
      .toBe(true);
    expect(saved(record.id).turns[0]?.phase).toBe("running");
    await expect(pane.locator("[data-session-state]")).toHaveAttribute(
      "data-session-state",
      "timed-out",
    );
    await expect(
      pane.getByRole("button", { name: "Stop session", exact: true }),
    ).toHaveCount(0);
    await expect(allow).toHaveCount(0);
    releaseRead();
    await releasedResponse;
    if (fixtureFailure) throw fixtureFailure;
    // Wait through the fetch/body and Preact effect/render boundary before
    // asserting that this genuinely actionable old response cannot revive UI.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(allow).toHaveCount(0);
    expect(decisions).toBe(0);
    await pane
      .getByRole("button", { name: "Session actions", exact: true })
      .click();
    const actions = page.getByRole("dialog", {
      name: "Session actions",
      exact: true,
    });
    await expect(
      actions.getByRole("button", {
        name: "Review native permissions",
        exact: true,
      }),
    ).toBeDisabled();
    await expect(
      actions.getByRole("button", { name: "Continue this Chat", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
  } finally {
    releaseRead();
    writeFileSync(
      join(HEARTH_HOME, "codex-chat-outcome-release"),
      "release this closed fixture only",
    );
  }
  await expect.poll(() => saved(record.id).turns[0]?.phase).toBe("unknown");
  await reloadSettled(page);
  await expect(pane.locator("[data-session-state]")).toHaveAttribute(
    "data-session-state",
    "timed-out",
  );
  const outcome = pane.getByRole("region", {
    name: "Native Chat outcome",
    exact: true,
  });
  await expect(outcome).toContainText("Time limit reached");
  await expect(outcome).toContainText("Supervisor stopped the process");
  if (process.env.CODEX_CHAT_OUTCOME_SHOTS) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await outcome.scrollIntoViewIfNeeded();
    await expect(outcome).toBeInViewport({ ratio: 1 });
    await outcome.screenshot({
      path: join(
        process.env.CODEX_CHAT_OUTCOME_SHOTS,
        "native-chat-outcome.png",
      ),
    });
    await page.setViewportSize({ width: 1100, height: 700 });
  }
  const tree = calls()
    .filter((row) => row.kind === "process")
    .at(-1);
  if (typeof tree?.pid !== "number")
    throw Error("No actual native process witness");
  expect(() => globalThis.process.kill(tree.pid!, 0)).toThrow();
  await pane
    .getByRole("button", { name: "Session actions", exact: true })
    .click();
  const download = page.waitForEvent("download");
  await page
    .getByRole("dialog", { name: "Session actions", exact: true })
    .getByRole("button", { name: "Export saved transcript", exact: true })
    .click();
  const exportedPath = await (await download).path();
  if (!exportedPath) throw Error("No complete transcript download");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(exportedPath, "utf8"));
  } catch {
    throw Error("Malformed complete transcript download");
  }
  const exported = sessionTranscriptExportSchema.parse(raw).conversation;
  expect(
    exported.frames.some(
      (frame) =>
        frame.event.kind === "coding-chat" &&
        frame.event.event.kind === "outcome" &&
        frame.event.event.outcome.timedOut,
    ),
  ).toBe(true);
  expect(calls().filter((row) => row.method === "turn/start")).toHaveLength(
    before + 1,
  );
  expect(decisions).toBe(0);
});
