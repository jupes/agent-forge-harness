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
});
