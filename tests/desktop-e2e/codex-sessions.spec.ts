import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { OPERATOR_HEADER } from "../../scripts/hearth/paths";
import { ownedCodingStateSchema } from "../../scripts/sessions/codex-owned-journal";
import { codexTaskStartSchema } from "../../scripts/sessions/codex-owned-protocol";
import { ownedCodingSessionSchema } from "../../scripts/sessions/codex-owned-wire-protocol";
import type { CodexTaskStartRequest } from "../../types/codex-owned-task";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import { pageToken } from "../e2e/launch-link";
import { HEARTH_HOME } from "../e2e/servers";
import { alpha, beta, seedProjects, workspace } from "./project-fixtures";

interface Call {
  kind: string;
  argv: string[];
  stdin: string;
  cwd: string;
  id: string;
  pid: number;
  childPid: number | null;
}
function calls(): Call[] {
  if (!existsSync(join(HEARTH_HOME, "codex-fixture-calls.jsonl"))) return [];
  try {
    return readFileSync(join(HEARTH_HOME, "codex-fixture-calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    throw Error("Invalid native Codex fixture recording.");
  }
}
function records() {
  try {
    const raw = JSON.parse(
      readFileSync(join(HEARTH_HOME, "sessions", "registry.json"), "utf8"),
    );
    return ownedCodingSessionSchema.array().parse(raw.records);
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
    throw Error("The isolated private Task journal is unavailable.");
  }
}
const tasks = () => calls().filter((call) => call.kind === "task");
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
let previous = new Set<string>();
test.beforeEach(() => {
  seedProjects();
  previous = new Set(records().map((record) => record.id));
  writeFileSync(
    join(HEARTH_HOME, "codex-fixture-mode.json"),
    JSON.stringify("normal"),
  );
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
      async ({ record, requestId, token, header }) => {
        await fetch(
          `/__agent-forge/projects/${record.projectId}/sessions/${record.id}/stop`,
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
async function chooseCodex(page: Page) {
  const dialog = page.getByRole("dialog", {
    name: "New session · Alpha",
    exact: true,
  });
  await dialog.getByRole("button", { name: /Cx · Codex/ }).click();
  await expect(
    dialog.getByRole("combobox", { name: "Session smith", exact: true }),
  ).toHaveValue("codex-journeyman");
  return dialog;
}
async function checkDefault(page: Page, prompt: string) {
  await page.getByRole("button", { name: "New session", exact: true }).click();
  const dialog = await chooseCodex(page);
  await dialog
    .getByRole("textbox", { name: "Session prompt", exact: true })
    .fill(prompt);
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
  ).toContainText("--sandbox");
  await expect(
    dialog.getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
  return dialog;
}
async function captureShot(
  target: Page | Locator,
  filename: string,
  options: Omit<NonNullable<Parameters<Page["screenshot"]>[0]>, "path"> = {},
) {
  const dir = process.env["SHOT_DIR"];
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await target.screenshot({ ...options, path: join(dir, filename) });
}

async function reenterCodexTask(
  dialog: Awaited<ReturnType<typeof chooseCodex>>,
  original: CodexTaskStartRequest,
) {
  await dialog
    .getByRole("textbox", { name: "Session prompt", exact: true })
    .fill(original.launch.prompt);
  await dialog
    .getByRole("combobox", { name: "Session repository", exact: true })
    .selectOption(original.repository);
  await dialog
    .getByRole("textbox", { name: "Session bead", exact: true })
    .fill(original.beadId ?? "");
  await dialog
    .getByRole("combobox", { name: "Session smith", exact: true })
    .selectOption(original.smith);
  await dialog
    .getByRole("textbox", { name: "Session model", exact: true })
    .fill(original.launch.model);
  await dialog
    .getByRole("combobox", { name: "Session effort", exact: true })
    .selectOption(original.launch.effort ?? "");
  await dialog
    .getByRole("combobox", { name: "Session sandbox", exact: true })
    .selectOption(original.launch.sandbox);
}

test("an explicit identity check recovers from an unavailable initial GET without writing", async ({
  page,
}) => {
  let identityGets = 0;
  let identityPosts = 0;
  let startPosts = 0;
  await page.route(
    `**/__agent-forge/projects/${alpha.id}/session-start-identities`,
    async (route) => {
      if (route.request().method() === "POST") identityPosts++;
      if (route.request().method() === "GET" && identityGets++ === 0) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            data: null,
            error: "temporary identity read failure",
          }),
        });
        return;
      }
      await route.continue();
    },
  );
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname ===
        `/__agent-forge/projects/${alpha.id}/sessions`
    )
      startPosts++;
  });

  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/sessions`);
  await expect.poll(() => identityGets).toBe(1);
  await page.getByRole("button", { name: "New session", exact: true }).click();
  const dialog = await chooseCodex(page);
  await expect(
    dialog.getByRole("button", { name: "Start", exact: true }),
  ).toBeDisabled();
  const checkServer = dialog.getByRole("button", {
    name: "Check server",
    exact: true,
  });
  await expect(checkServer).toBeEnabled();
  await checkServer.click();
  await expect.poll(() => identityGets).toBe(2);
  await expect(
    dialog.getByText(
      "No server-owned Start identity is recorded for this workspace.",
      { exact: true },
    ),
  ).toBeVisible();
  await dialog
    .getByRole("textbox", { name: "Session prompt", exact: true })
    .fill("No Start until the identity page can be checked");
  await dialog
    .getByRole("combobox", { name: "Session effort", exact: true })
    .selectOption("");
  await dialog
    .getByRole("button", { name: "Check supported options", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
  expect(identityPosts).toBe(0);
  expect(startPosts).toBe(0);
});

test("bead-prefilled Codex Task preserves honest effort controls and private context, reconciles a lost Start once, and reloads its actual identity", async ({
  page,
}) => {
  const before = tasks().length;
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
  const dialog = await chooseCodex(page);
  await expect(
    dialog.getByRole("textbox", { name: "Session bead", exact: true }),
  ).toHaveValue("alpha-epic");
  await expect(
    dialog.getByRole("combobox", { name: "Session mode", exact: true }),
  ).toHaveValue("task");
  await expect(
    dialog.getByRole("option", { name: /Chat · native approvals/ }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole("combobox", { name: "Session effort", exact: true }),
  ).toHaveValue("medium");
  const prompt = "  PRIVATE CODEX question 🌱\n";
  await dialog
    .getByRole("textbox", { name: "Session prompt", exact: true })
    .fill(prompt);
  await dialog
    .getByRole("button", { name: "Check supported options", exact: true })
    .click();
  await expect(
    dialog
      .getByRole("status")
      .filter({ hasText: "lack exact capability evidence" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("combobox", { name: "Session effort", exact: true }),
  ).toHaveValue("medium");
  await expect(
    dialog.getByRole("button", { name: "Start", exact: true }),
  ).toBeDisabled();
  await dialog
    .getByRole("combobox", { name: "Session effort", exact: true })
    .selectOption("");
  await dialog.getByLabel("Attach text", { exact: true }).setInputFiles({
    name: "private-note.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("PRIVATE CODEX attachment"),
  });
  await expect(
    dialog.getByRole("button", {
      name: "Remove attachment private-note.txt",
      exact: true,
    }),
  ).toBeVisible();
  await dialog
    .getByRole("combobox", { name: "Session sandbox", exact: true })
    .selectOption("workspace-write");
  await dialog
    .getByRole("button", { name: "Check supported options", exact: true })
    .click();
  const equivalent = dialog.getByRole("region", {
    name: "Equivalent session command",
    exact: true,
  });
  await expect(equivalent).toContainText("workspace-write");
  await expect(equivalent).not.toContainText("PRIVATE CODEX");
  expect(tasks()).toHaveLength(before);
  await page.setViewportSize({ width: 1280, height: 900 });
  await captureShot(page, "codex-task-composer.png", {
    style:
      '[aria-label="Session repository"], [aria-label="Registered session worktree"], [aria-label="Equivalent session command"] { visibility: hidden !important; }',
  });
  await dialog.locator(".af-dialog-body").evaluate((node) => {
    node.scrollTop = 0;
  });
  await captureShot(page, "codex-task-composer-prompt.png", {
    style:
      '[aria-label="Session repository"], [aria-label="Registered session worktree"], [aria-label="Equivalent session command"] { visibility: hidden !important; }',
  });
  let posted = 0;
  await page.route(
    `**/__agent-forge/projects/${alpha.id}/sessions`,
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      posted++;
      const raw = route.request().postDataJSON();
      expect(raw.provider).toBe("codex");
      expect(raw.launch.mode).toBe("task");
      expect(raw.beadId).toBe("alpha-epic");
      await route.fetch({
        headers: {
          ...(await route.request().allHeaders()),
          Origin: new URL(route.request().url()).origin,
          "Sec-Fetch-Site": "same-origin",
        },
      });
      await route.abort("failed");
    },
  );
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  await expect(
    page.getByRole("article", { name: "Session reply", exact: true }),
  ).toContainText("Codex Task reply 🌱");
  const record = records().find((record) => !previous.has(record.id));
  if (!record) throw Error("Missing owned Task receipt.");
  await expect.poll(() => journal(record.id).turns[0]?.phase).toBe("completed");
  expect(posted).toBe(1);
  expect(tasks()).toHaveLength(before + 1);
  const actual = tasks().at(-1);
  if (!actual) throw Error("Missing native Task.");
  expect(actual.argv).toContain("workspace-write");
  expect(actual.argv.join(" ")).not.toContain("PRIVATE CODEX");
  expect(actual.stdin).toContain(prompt);
  expect(actual.stdin).toContain("PRIVATE CODEX attachment");
  expect(actual.stdin).toContain("alpha-epic");
  expect(journal(record.id).binding?.sessionId).toBe(actual.id);
  await page.getByText("Session details", { exact: true }).click();
  await expect(page.getByText(actual.id, { exact: true })).toBeVisible();
  await expect(
    page.getByText("Observed model is not reported by Codex exec.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Reported input tokens", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Session reply prompt", exact: true }),
  ).toBeDisabled();
  await page.getByText(actual.id, { exact: true }).scrollIntoViewIfNeeded();
  await captureShot(page, "codex-task-session.png", {
    mask: [page.getByText(record.worktree, { exact: true })],
    style: ".af-owned-session-header pre { visibility: hidden !important; }",
    maskColor: "#3f424d",
  });
  await reloadSettled(page);
  await expect(
    page.getByRole("article", { name: "Session reply", exact: true }),
  ).toContainText("Codex Task reply 🌱");
  expect(tasks()).toHaveLength(before + 1);
  await openSettled(page, `/index.html#/desktop/project/${beta.id}/sessions`);
  await expect(page.locator(`a[href*="selectionId=${record.id}"]`)).toHaveCount(
    0,
  );
});

test("closing a Codex observer leaves its Task running; explicit Stop confirms the actual native process tree is gone", async ({
  page,
}) => {
  const before = tasks().length;
  writeFileSync(
    join(HEARTH_HOME, "codex-fixture-mode.json"),
    JSON.stringify("hang"),
  );
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/sessions`);
  const dialog = await checkDefault(page, "Wait for my explicit Stop");
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  await expect(
    page.getByRole("article", { name: "Session reply", exact: true }),
  ).toContainText("Codex Task reply 🌱");
  const record = records().find((record) => !previous.has(record.id)),
    actual = tasks().at(-1);
  if (!record || !actual?.childPid)
    throw Error("Missing running Task process tree.");
  expect(alive(actual.pid)).toBe(true);
  expect(alive(actual.childPid)).toBe(true);
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
  expect(journal(record.id).turns[0]?.phase).toBe("running");
  await openSettled(
    page,
    `/index.html#/desktop/project/${alpha.id}/sessions?selectionKind=session&selectionId=${record.id}`,
  );
  await page.getByRole("button", { name: "Stop session", exact: true }).click();
  await expect.poll(() => journal(record.id).turns[0]?.phase).toBe("cancelled");
  await expect
    .poll(() => alive(actual.pid) || alive(actual.childPid ?? 0))
    .toBe(false);
  await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
  expect(tasks()).toHaveLength(before + 1);
});

test("a reserved Start after reload continues only after exact same-UUID body re-entry", async ({
  page,
}) => {
  const before = tasks().length;
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/sessions`);
  const dialog = await checkDefault(page, "Exact body re-entry after reload");
  const starts: CodexTaskStartRequest[] = [];
  await page.route(
    `**/__agent-forge/projects/${alpha.id}/sessions`,
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      const parsed = codexTaskStartSchema.safeParse(
        route.request().postDataJSON(),
      );
      if (!parsed.success) throw Error("Invalid Codex Task Start fixture.");
      starts.push(parsed.data);
      if (starts.length === 1) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            data: null,
            error: "synthetic lost Start reply",
          }),
        });
        return;
      }
      await route.continue();
    },
  );

  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  await expect(
    dialog.getByText("codex task · reserved", { exact: true }),
  ).toBeVisible();
  expect(starts).toHaveLength(1);
  expect(tasks()).toHaveLength(before);

  await reloadSettled(page);
  await page.getByRole("button", { name: "New session", exact: true }).click();
  const reloaded = await chooseCodex(page);
  const original = starts[0];
  if (!original) throw Error("Missing original frozen Start request.");
  await reenterCodexTask(reloaded, original);
  const continueButton = reloaded.getByRole("button", {
    name: "Continue exact original",
    exact: true,
  });
  await expect(continueButton).toBeEnabled();
  await continueButton.click();

  await expect(
    page.getByRole("article", { name: "Session reply", exact: true }),
  ).toContainText("Codex Task reply 🌱");
  expect(starts).toHaveLength(2);
  expect(starts[1]).toEqual(original);
  expect(tasks()).toHaveLength(before + 1);
});

test("confirmed reserved retirement reads back the tombstone before a new UUID can start", async ({
  page,
}) => {
  const before = tasks().length;
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/sessions`);
  const dialog = await checkDefault(page, "Retire only the reserved UUID");
  const starts: CodexTaskStartRequest[] = [];
  await page.route(
    `**/__agent-forge/projects/${alpha.id}/sessions`,
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      const parsed = codexTaskStartSchema.safeParse(
        route.request().postDataJSON(),
      );
      if (!parsed.success) throw Error("Invalid Codex Task Start fixture.");
      starts.push(parsed.data);
      if (starts.length === 1) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            data: null,
            error: "synthetic lost Start reply",
          }),
        });
        return;
      }
      await route.continue();
    },
  );

  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  await expect(
    dialog.getByText("codex task · reserved", { exact: true }),
  ).toBeVisible();
  const originalId = starts[0]?.requestId;
  if (!originalId) throw Error("Missing reserved Start UUID.");
  await dialog
    .getByRole("button", { name: "Review retirement", exact: true })
    .click();
  const retirement = page.getByRole("dialog", {
    name: "Retire this reserved Start?",
    exact: true,
  });
  await expect(retirement.getByText(originalId, { exact: true })).toBeVisible();
  await retirement
    .getByRole("button", { name: "Retire this UUID", exact: true })
    .click();
  await expect(
    dialog.getByText("codex task · retired", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
  expect(tasks()).toHaveLength(before);

  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  await expect(
    page.getByRole("article", { name: "Session reply", exact: true }),
  ).toContainText("Codex Task reply 🌱");
  expect(starts).toHaveLength(2);
  expect(starts[1]?.requestId).not.toBe(originalId);
  expect(tasks()).toHaveLength(before + 1);
});

test("reload keeps a pre-admission Start identity held until its original protected admission is found", async ({
  page,
}) => {
  const before = tasks().length;
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/sessions`);
  const dialog = await checkDefault(
    page,
    "Original request may arrive after reload",
  );
  let release = () => {},
    received = () => {},
    completed = () => {};
  const originalStart: { current: CodexTaskStartRequest | null } = {
    current: null,
  };
  let identityWrites = 0;
  let startPosts = 0;
  let protectedOriginalReads = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      request.method() === "POST" &&
      url.pathname.includes("/session-start-identities")
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
  const held = new Promise<void>((resolve) => {
      received = resolve;
    }),
    delivery = new Promise<void>((resolve) => {
      release = resolve;
    }),
    delivered = new Promise<void>((resolve) => {
      completed = resolve;
    });
  await page.route(
    `**/__agent-forge/projects/${alpha.id}/sessions`,
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      const parsed = codexTaskStartSchema.safeParse(
        route.request().postDataJSON(),
      );
      if (!parsed.success) throw Error("Invalid original Codex Task Start.");
      originalStart.current = parsed.data;
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
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  await held;
  expect(tasks()).toHaveLength(before);
  try {
    await reloadSettled(page);
    await page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    const reloaded = page.getByRole("dialog", {
      name: "New session · Alpha",
      exact: true,
    });
    await expect(
      reloaded.getByRole("region", { name: "Original Start requests" }),
    ).toBeVisible();
    await expect(
      reloaded.getByRole("button", { name: "Check server", exact: true }),
    ).toBeVisible();
    await expect(
      reloaded.getByRole("button", { name: "Start", exact: true }),
    ).toBeDisabled();
    await expect(
      reloaded.getByText("codex task · reserved", { exact: true }),
    ).toBeVisible();
    const heldOriginal = originalStart.current;
    if (!heldOriginal) throw Error("Missing held original Start request.");
    const identityRow = reloaded
      .locator(".af-start-identities-list li")
      .filter({ hasText: heldOriginal.requestId });
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
    await expect(
      reloaded.getByRole("button", {
        name: "Continue exact original",
        exact: true,
      }),
    ).toBeDisabled();
    await reloaded
      .getByRole("button", { name: "Review retirement", exact: true })
      .click();
    const retirement = page.getByRole("dialog", {
      name: "Retire this reserved Start?",
      exact: true,
    });
    await expect(retirement.locator("dd").nth(0)).toHaveText(
      `${alpha.id} · ${workspace}`,
    );
    await expect(retirement.locator("dd").nth(1)).toHaveText("codex · task");
    await expect(retirement.locator("dd").nth(2)).toHaveText(
      heldOriginal.requestId,
    );
    await expect(retirement.locator("dd").nth(3)).toHaveText(
      listedRequestHash ?? "",
    );
    await captureShot(retirement, "session-start-retirement-dialog.png", {
      mask: [retirement.locator("dd").nth(0)],
    });
    await retirement
      .getByRole("button", { name: "Keep reserved", exact: true })
      .click();
    expect(tasks()).toHaveLength(before);
  } finally {
    release();
    await delivered;
    await expect.poll(() => tasks().length).toBe(before + 1);
  }
  const sessionDialog = page.getByRole("dialog", {
    name: "New session · Alpha",
    exact: true,
  });
  await sessionDialog
    .getByRole("button", { name: "Check server", exact: true })
    .click();
  const heldOriginal = originalStart.current;
  if (!heldOriginal) throw Error("Missing original Start request.");
  const admittedRow = sessionDialog
    .locator(".af-start-identities-list li")
    .filter({ hasText: heldOriginal.requestId });
  await expect(admittedRow).toContainText("admitted");
  await expect(
    sessionDialog.getByRole("button", {
      name: "Continue exact original",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(identityWrites).toBe(1);
  expect(startPosts).toBe(1);
  expect(protectedOriginalReads).toBe(0);
  await admittedRow
    .getByRole("button", { name: "Inspect original", exact: true })
    .click();
  await expect(
    admittedRow.getByRole("link", { name: "Open original session" }),
  ).toBeVisible();
  await expect.poll(() => protectedOriginalReads).toBeGreaterThan(0);
  await admittedRow
    .getByRole("link", { name: "Open original session" })
    .click();
  await expect(
    page.getByRole("article", { name: "Session reply", exact: true }),
  ).toContainText("Codex Task reply 🌱");
  expect(tasks()).toHaveLength(before + 1);
  expect(identityWrites).toBe(1);
  expect(startPosts).toBe(1);
});
