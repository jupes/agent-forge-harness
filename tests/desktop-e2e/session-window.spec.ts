import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { desktopRoute } from "../../apps/desktop/src/navigation";
import { sessionWindowHref } from "../../apps/desktop/src/session-window";
import { OPERATOR_HEADER } from "../../scripts/hearth/paths";
import { ownedCodingStateSchema } from "../../scripts/sessions/codex-owned-journal";
import { ownedSessionIdSchema } from "../../scripts/sessions/identity-protocol";
import { openSettled } from "../e2e/fixtures";
import { pageToken } from "../e2e/launch-link";
import { HEARTH_HOME } from "../e2e/servers";
import { seedObservationEvents } from "./observed-session-fixtures";
import { alpha, beta, seedProjects, workspace } from "./project-fixtures";

let cleanupSession: string | null = null;
test.beforeEach(() => {
  cleanupSession = null;
  seedProjects();
});
test.afterEach(async ({ page }) => {
  if (!cleanupSession) return;
  const id = cleanupSession;
  const read = () => {
    let raw: unknown;
    try {
      raw = JSON.parse(
        readFileSync(join(HEARTH_HOME, "conversations", id + ".json"), "utf8"),
      );
    } catch {
      throw Error("Isolated session cleanup journal unavailable");
    }
    return ownedCodingStateSchema.parse(raw);
  };
  const active = () =>
    read().turns.find((turn) =>
      ["accepted", "running", "cancelling"].includes(turn.phase),
    );
  const turn = active();
  if (!turn) return;
  const token = await pageToken(page);
  await page.evaluate(
    async (input) => {
      await fetch(
        `/__agent-forge/projects/${input.projectId}/sessions/${input.id}/stop`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [input.header]: input.token,
          },
          body: JSON.stringify({ requestId: input.requestId }),
        },
      );
    },
    {
      projectId: alpha.id,
      id,
      requestId: turn.requestId,
      token,
      header: OPERATOR_HEADER,
    },
  );
  await expect.poll(() => !!active(), { timeout: 5000 }).toBe(false);
});
function starts() {
  const file = join(HEARTH_HOME, "coding-fixture-starts.jsonl");
  return existsSync(file)
    ? readFileSync(file, "utf8").split("\n").filter(Boolean).length
    : 0;
}
function observed() {
  const sessionId = "popout-observed-" + randomUUID();
  seedObservationEvents([
    {
      kind: "session.started",
      workspace,
      beadId: "alpha-epic",
      sessionId,
      executor: {
        provider: "codex",
        model: "fixture-model",
        smith: "fixture-smith",
      },
      payload: { kind: "interactive" },
    },
    {
      kind: "tool.called",
      workspace,
      beadId: "alpha-epic",
      sessionId,
      payload: {
        tool: "Recorded compact read",
        argsHash: "private-not-transcript",
        durationMs: 12,
      },
    },
  ]);
  return { projectId: alpha.id, sessionId };
}

test("an invalid native target stays unavailable without mounting main navigation or project readers", async ({
  page,
}) => {
  const projectReads: string[] = [];
  const before = starts();
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/__agent-forge/projects")) projectReads.push(path);
  });
  await page.addInitScript(() =>
    Object.defineProperty(window, "__AF_SESSION_WINDOW_TARGET__", {
      value: { projectId: "invalid", sessionId: "invalid" },
      writable: false,
      configurable: false,
    }),
  );
  await openSettled(page, `/#/desktop/project/${alpha.id}/sessions`);
  await expect(
    page.getByRole("heading", {
      name: "This session window could not be verified",
      exact: true,
    }),
  ).toBeVisible();
  await page.keyboard.press("Control+k");
  await page.keyboard.press("Control+j");
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(projectReads).toEqual([]);
  expect(starts()).toBe(before);
});
test("compact owned Chat reuses the current transcript and composer and updates the main view", async ({
  page,
  context,
}) => {
  writeFileSync(
    join(HEARTH_HOME, "coding-fixture-mode.json"),
    JSON.stringify("normal"),
  );
  const before = starts();
  await openSettled(page, `/#/desktop/project/${alpha.id}/sessions`);
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
    .fill("Existing compact Chat fixture");
  await dialog
    .getByRole("combobox", { name: "Session mode", exact: true })
    .selectOption("chat");
  await dialog
    .getByRole("combobox", { name: "Session effort", exact: true })
    .selectOption("");
  await dialog
    .getByRole("button", { name: "Check supported options", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  await expect(
    page.getByRole("article", { name: "Session reply", exact: true }),
  ).toContainText("Coding reply 🌱");
  const selected = desktopRoute(new URL(page.url()).hash).selection;
  if (selected?.kind !== "session")
    throw Error("The isolated Chat did not select its admitted session");
  cleanupSession = ownedSessionIdSchema.parse(selected.id);
  const target = { projectId: alpha.id, sessionId: selected.id };
  expect(starts()).toBe(before + 1);
  const child = await context.newPage();
  await child.addInitScript(
    (value) =>
      Object.defineProperty(window, "__AF_SESSION_WINDOW_TARGET__", {
        value: Object.freeze(value),
        writable: false,
        configurable: false,
      }),
    target,
  );
  await child.setViewportSize({ width: 720, height: 820 });
  await openSettled(child, "/" + sessionWindowHref(target));
  await expect(
    child.getByRole("region", { name: "Session transcript", exact: true }),
  ).toContainText("Existing compact Chat fixture");
  await expect(
    child.getByRole("article", { name: "Session reply", exact: true }),
  ).toContainText("Coding reply 🌱");
  await expect(
    child.getByRole("textbox", { name: "Session reply prompt", exact: true }),
  ).toBeEnabled();
  expect(starts()).toBe(before + 1);
  const secondTarget = observed();
  const secondChild = await context.newPage();
  await secondChild.addInitScript(
    (value) =>
      Object.defineProperty(window, "__AF_SESSION_WINDOW_TARGET__", {
        value: Object.freeze(value),
        writable: false,
        configurable: false,
      }),
    secondTarget,
  );
  await openSettled(secondChild, "/" + sessionWindowHref(secondTarget));
  await expect(
    secondChild.getByRole("region", {
      name: "Observed session details",
      exact: true,
    }),
  ).toContainText(secondTarget.sessionId);
  await child
    .getByRole("textbox", { name: "Session reply prompt", exact: true })
    .fill("Reply from the existing compact view");
  await child
    .getByRole("button", { name: "Send session message", exact: true })
    .click();
  await expect(
    child.getByRole("article", { name: "Session reply", exact: true }),
  ).toHaveCount(2);
  await expect(
    page.getByRole("region", { name: "Session transcript", exact: true }),
  ).toContainText("Reply from the existing compact view");
  expect(starts()).toBe(before + 2);
  mkdirSync("test-results/session-window-evidence", { recursive: true });
  await child.screenshot({
    path: "test-results/session-window-evidence/owned-compact.png",
  });
  await child.close();
  await secondChild.close();
  await expect(
    page.getByRole("textbox", { name: "Session reply prompt", exact: true }),
  ).toBeEnabled();
  expect(starts()).toBe(before + 2);
});
test("the main session view sends only its selected identity through the native bridge", async ({
  page,
}) => {
  const target = observed(),
    before = starts(),
    calls: unknown[] = [];
  await page.exposeFunction(
    "fixtureSessionWindow",
    (command: string, args: unknown) => {
      calls.push({ command, args });
      return { state: "created", label: "session-popout-1" };
    },
  );
  await page.addInitScript(() => {
    const surface = window as Window & {
      fixtureSessionWindow?: (
        command: string,
        args: unknown,
      ) => Promise<unknown>;
    };
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {
        invoke: (command: string, args: unknown) =>
          surface.fixtureSessionWindow
            ? surface.fixtureSessionWindow(command, args)
            : Promise.reject(Error("Missing isolated window fixture")),
      },
    });
  });
  await openSettled(
    page,
    "/" + sessionWindowHref(target).replace("&sessionWindow=1", ""),
  );
  await page
    .getByRole("button", { name: "Pop out session", exact: true })
    .click();
  await expect(
    page.getByText("Session window opened.", { exact: false }),
  ).toBeVisible();
  expect(calls).toEqual([
    { command: "open_session_popout", args: { request: target } },
  ]);
  expect(starts()).toBe(before);
});
test("compact observed session retains scope and metadata without sidebars, private transcript or provider dispatch", async ({
  page,
}) => {
  const target = observed(),
    before = starts();
  await page.addInitScript(
    (value) =>
      Object.defineProperty(window, "__AF_SESSION_WINDOW_TARGET__", {
        value: Object.freeze(value),
        writable: false,
        configurable: false,
      }),
    target,
  );
  await page.setViewportSize({ width: 720, height: 820 });
  await openSettled(page, "/" + sessionWindowHref(target));
  const detail = page.getByRole("region", {
    name: "Observed session details",
    exact: true,
  });
  await expect(detail).toContainText(target.sessionId);
  await expect(detail).toContainText("Recorded compact read");
  await expect(detail).not.toContainText("private-not-transcript");
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await expect(page.getByRole("complementary")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Pop out session", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Session reply prompt", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  mkdirSync("test-results/session-window-evidence", { recursive: true });
  await page.screenshot({
    path: "test-results/session-window-evidence/observed-compact.png",
  });
  await page.evaluate((hash) => {
    location.hash = hash;
  }, `#/desktop/project/${beta.id}/sessions?selectionKind=session&selectionId=foreign&sessionWindow=1`);
  await expect(
    page.getByText("This session window address changed", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Control+k");
  await page.keyboard.press("Control+j");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "New session", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Observed session details", exact: true }),
  ).toHaveCount(0);
  expect(starts()).toBe(before);
});
