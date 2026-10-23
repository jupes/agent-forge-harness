import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { OPERATOR_HEADER } from "../../scripts/hearth/paths";
import { sessionTranscriptExportSchema } from "../../scripts/sessions/library-protocol";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import { pageToken } from "../e2e/launch-link";
import { HEARTH_HOME } from "../e2e/servers";
import { alpha, beta, seedProjects, workspace } from "./project-fixtures";

const log = join(HEARTH_HOME, "gemini-fixture-calls.jsonl");
function records(): Record<string, unknown>[] {
  if (!existsSync(log)) return [];
  try {
    return readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  } catch {
    throw Error("The inert Gemini recording is invalid");
  }
}
async function post(page: Page, path: string, body: unknown) {
  const token = await pageToken(page);
  return page.evaluate(
    async ({ path, body, token, header }) => {
      const response = await fetch(`/__agent-forge${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", [header]: token },
        body: JSON.stringify(body),
      });
      return { status: response.status, answer: await response.json() };
    },
    { path, body, token, header: OPERATOR_HEADER },
  );
}
test.beforeEach(() => {
  seedProjects();
  writeFileSync(`${log}.control`, JSON.stringify({ mode: "normal" }));
});

async function start(page: Page, mode: string) {
  writeFileSync(`${log}.control`, JSON.stringify({ mode }));
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/sessions`);
  const request = {
    requestId: randomUUID(),
    provider: "gemini",
    smith: "gemini-example",
    repository: workspace,
    worktree: workspace,
    beadId: "alpha-epic",
    about: [{ kind: "bead", id: "alpha-epic" }],
    launch: {
      route: "gemini-cli",
      mode: "task",
      prompt: "PRIVATE-GEMINI-BROWSER-REQUEST",
      approvalMode: "plan",
      attachments: [
        { kind: "text", name: "private-note", text: "PRIVATE-INLINE-DATA" },
      ],
    },
  };
  const priorTasks = records().filter((row) => row.kind === "task").length;
  const preview = await post(
    page,
    `/projects/${alpha.id}/sessions/preview`,
    request,
  );
  expect(preview.status).toBe(200);
  expect(preview.answer.data.serialized.stdin).toContain(request.launch.prompt);
  expect(records().filter((row) => row.kind === "task")).toHaveLength(
    priorTasks,
  );
  const accepted = await post(page, `/projects/${alpha.id}/sessions`, request);
  expect(accepted.status).toBe(202);
  const id: string = accepted.answer.data.session.id;
  await openSettled(
    page,
    `/index.html#/desktop/project/${alpha.id}/sessions?selectionKind=session&selectionId=${id}`,
  );
  const view = page.getByRole("region", {
    name: "Session conversation",
    exact: true,
  });
  await expect(view).toBeVisible();
  return { id, request, priorTasks, view };
}

test("actual Gemini Task private viewer retains native denial/usage, exact original, full export and archive through reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const f = await start(page, "denied");
  await expect(f.view.getByText("Gm · Gemini", { exact: true })).toBeVisible();
  await expect(
    f.view.getByText("Private reply 🌱", { exact: true }),
  ).toBeVisible();
  await expect(
    f.view.getByText("Native Task outcome: completed", { exact: true }),
  ).toBeVisible();
  await expect(
    f.view.getByText(
      "Configured model: auto-gemini-example · Gemini CLI 0.65.0",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    f.view.getByText(/gemini-actual-example: 23 input/),
  ).toBeVisible();
  const denied = f.view.getByText("run_shell_command · failed", {
    exact: true,
  });
  await denied.focus();
  await page.keyboard.press("Enter");
  await expect(
    f.view.getByText("policy_violation: Synthetic policy refusal", {
      exact: true,
    }),
  ).toBeVisible();
  expect(records().filter((row) => row.kind === "task")).toHaveLength(
    f.priorTasks + 1,
  );
  const capture = process.env["SHOT_DIR"];
  if (capture) {
    const inspector = page.getByRole("button", {
      name: "Hide inspector",
      exact: true,
    });
    if (await inspector.isVisible()) await inspector.click();
    await page.setViewportSize({ width: 1280, height: 1000 });
    mkdirSync(capture, { recursive: true });
    await page.screenshot({
      path: join(capture, "gemini-owned-task.png"),
      style:
        '.af-owned-question, .af-owned-reply, .af-owned-session-header details, .af-owned-session-header .af-session-note, [aria-label="Gemini native text"] pre, .af-session-activity details pre { visibility: hidden !important; }',
    });
  }
  const retried = await post(page, `/projects/${alpha.id}/sessions`, f.request);
  expect(retried.status).toBe(202);
  await reloadSettled(page);
  await expect(
    page.getByText("Native Task outcome: completed", { exact: true }),
  ).toBeVisible();
  expect(records().filter((row) => row.kind === "task")).toHaveLength(
    f.priorTasks + 1,
  );
  await page
    .getByRole("button", { name: "Session actions", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Session actions",
    exact: true,
  });
  const download = page.waitForEvent("download");
  await dialog
    .getByRole("button", { name: "Export saved transcript", exact: true })
    .click();
  const file = await (await download).path();
  if (!file) throw Error("The complete Gemini transcript download is absent");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw Error("The private export is invalid JSON");
  }
  const exported = sessionTranscriptExportSchema.parse(raw);
  expect(exported.session.provider).toBe("gemini");
  expect(exported.conversation.frames[0]?.event).toMatchObject({
    kind: "user",
    text: f.request.launch.prompt,
    geminiTask: { launch: { attachments: f.request.launch.attachments } },
  });
  await dialog
    .getByRole("button", { name: "Archive session", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Restore session", exact: true }),
  ).toBeEnabled();
  await dialog
    .getByRole("button", { name: "Restore session", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Archive session", exact: true }),
  ).toBeEnabled();
  const foreign = await post(page, `/projects/${beta.id}/sessions`, f.request);
  expect(foreign.status).toBe(409);
  expect(records().filter((row) => row.kind === "task")).toHaveLength(
    f.priorTasks + 1,
  );
});

test("keyboard Stop of an actual Gemini Task ends the provider/helper tree and retains the stopped original after reload", async ({
  page,
}) => {
  const f = await start(page, "hang-tree");
  try {
    await expect(
      f.view.getByText("Private reply 🌱", { exact: true }),
    ).toBeVisible();
    const task = records()
        .filter((row) => row.kind === "task")
        .at(-1),
      pid = task?.pid,
      helperPid = task?.childPid;
    if (typeof pid !== "number" || typeof helperPid !== "number")
      throw Error("The inert Gemini tree identities were not recorded");
    const stop = f.view.getByRole("button", {
      name: "Stop session",
      exact: true,
    });
    await stop.focus();
    await page.keyboard.press("Enter");
    await expect(
      f.view
        .locator(".af-owned-turn")
        .getByRole("status")
        .filter({ hasText: /^Stop confirmed\./ }),
    ).toBeVisible();
    for (const actualPid of [pid, helperPid])
      await expect
        .poll(() => {
          try {
            process.kill(actualPid, 0);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(false);
    await reloadSettled(page);
    await expect(
      page
        .locator(".af-owned-turn")
        .getByRole("status")
        .filter({ hasText: /^Stop confirmed\./ }),
    ).toBeVisible();
    expect(records().filter((row) => row.kind === "task")).toHaveLength(
      f.priorTasks + 1,
    );
  } finally {
    await post(page, `/projects/${alpha.id}/sessions/${f.id}/stop`, {
      requestId: f.request.requestId,
    });
  }
});

test("Gemini split Markdown replies copy exactly while streaming and survive reload with unchanged native export", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const release = `${log}.markdown-release`;
  if (existsSync(release)) unlinkSync(release);
  const expected =
    "**Readable**\n\n```ts\nconst answer = 42;\n```\n\n[Safe link](https://example.com) [Blocked](javascript:alert)\n\n<img src=x onerror=alert(1)>";
  const f = await start(page, "markdown");
  try {
    const replies = f.view.getByRole("article", {
      name: "Session reply",
      exact: true,
    });
    await expect(replies).toHaveCount(1);
    const first = replies.first();
    await expect(first.locator("strong")).toHaveText("Readable");
    await expect(first.locator("pre code")).toHaveText("const answer = 42;");
    await expect(
      first.getByRole("link", { name: "Safe link" }),
    ).toHaveAttribute("href", "https://example.com");
    await expect(first.getByRole("link", { name: "Blocked" })).toHaveCount(0);
    await expect(first.locator("img,script")).toHaveCount(0);
    await expect(first).toContainText("<img src=x onerror=alert(1)>");
    await expect(f.view).not.toContainText("USER ECHO MUST STAY ABSENT");
    await expect(first.locator(".af-session-streaming-caret")).toHaveCount(1);
    await page.evaluate(() =>
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            document.body.dataset.geminiCopied = value;
          },
        },
      }),
    );
    const copy = first.getByRole("button", {
      name: "Copy session reply",
      exact: true,
    });
    await copy.focus();
    await expect(copy).toBeFocused();
    await expect(copy).toHaveCSS("outline-width", "2px");
    await page.keyboard.press("Enter");
    await expect
      .poll(() => page.evaluate(() => document.body.dataset.geminiCopied))
      .toBe(expected);
    writeFileSync(release, "release original once");
    await expect(
      f.view.getByText("Native Task outcome: completed", { exact: true }),
    ).toBeVisible();
    await expect(replies).toHaveCount(3);
    await expect(replies.nth(1).locator("strong")).toHaveText(
      "Separate complete report",
    );
    await expect(replies.nth(2)).toContainText(
      "Separate delta after complete.",
    );
    await expect(f.view.locator(".af-session-streaming-caret")).toHaveCount(0);
    expect((await replies.allTextContents()).join("\n")).not.toContain(
      "PRIVATE_TOOL_TEXT",
    );
    await expect(
      f.view.getByText(/gemini-actual-example: 23 input/),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await reloadSettled(page);
    await expect(replies).toHaveCount(3);
    await expect(replies.first().locator("strong")).toHaveText("Readable");
    await expect(f.view.locator(".af-session-streaming-caret")).toHaveCount(0);
    expect(records().filter((row) => row.kind === "task")).toHaveLength(
      f.priorTasks + 1,
    );
    const capture = process.env["SHOT_DIR"];
    if (capture) {
      mkdirSync(capture, { recursive: true });
      await first.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: join(capture, "gemini-task-markdown.png"),
        style:
          ".af-owned-question, .af-owned-session-header details, .af-owned-session-header .af-session-note { visibility:hidden!important; }",
      });
    }
    await f.view
      .getByRole("button", { name: "Session actions", exact: true })
      .click();
    const download = page.waitForEvent("download");
    await page
      .getByRole("dialog", { name: "Session actions", exact: true })
      .getByRole("button", { name: "Export saved transcript", exact: true })
      .click();
    const file = await (await download).path();
    if (!file) throw Error("The complete Gemini transcript download is absent");
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw Error("Invalid exported native transcript");
    }
    const exported = sessionTranscriptExportSchema.parse(raw);
    const text = exported.conversation.frames.flatMap((frame) =>
      frame.event.kind === "coding-gemini-task" &&
      frame.event.event.kind === "text"
        ? [frame.event.event]
        : [],
    );
    expect(text).toEqual([
      { kind: "text", text: "**Read", delta: true },
      { kind: "text", text: "able**\n\n```ts\nconst answer = ", delta: true },
      {
        kind: "text",
        text: "42;\n```\n\n[Safe link](https://example.com) [Blocked](javascript:alert)\n\n<img src=x onerror=alert(1)>",
        delta: true,
      },
      { kind: "text", text: "**Separate complete report**", delta: false },
      { kind: "text", text: "Separate delta after complete.", delta: true },
    ]);
    expect(
      exported.conversation.frames.some((frame) => frame.event.kind === "text"),
    ).toBe(false);
  } finally {
    writeFileSync(release, "release held fixture on failure");
  }
});
