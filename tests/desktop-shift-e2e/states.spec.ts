import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { z } from "zod";
import { FIXTURE_PROJECT_ID } from "../../scripts/projects/testing";
import { projectShiftsPageSchema } from "../../scripts/shifts/protocol";
import { SHIFT_STOP_REASONS, type ShiftStopReason } from "../../types/hearth";
import { openSettled } from "../e2e/fixtures";
import { bunPath } from "../e2e/servers";
import {
  FIXTURE_ROOT,
  fixtureCalls,
  HOME,
  holdStartup,
  REPOSITORY,
  STATE,
} from "./environment";

test.use({ viewport: { width: 1280, height: 900 } });

const route = `/index.html#/desktop/project/${FIXTURE_PROJECT_ID}/workbench`,
  path = `/__agent-forge/projects/${FIXTURE_PROJECT_ID}/shifts`,
  endpoint = `**${path}`;
const panel = (page: Page) =>
  page.getByRole("region", { name: "Bounded project shifts", exact: true });
async function heldOriginalCheck(
  page: Page,
  check: Locator,
  requestId: string,
) {
  const endpoint = `**${path}/requests/${requestId}`;
  let release = () => {},
    entered = () => {},
    requests = 0;
  const held = new Promise<void>((resolve) => {
      release = resolve;
    }),
    received = new Promise<void>((resolve) => {
      entered = resolve;
    });
  await page.route(endpoint, async (intercept) => {
    requests++;
    const actual = await intercept.fetch({
      headers: {
        ...(await intercept.request().allHeaders()),
        Origin: new URL(page.url()).origin,
      },
    });
    expect(actual.status()).toBe(200);
    entered();
    await held;
    await intercept.fulfill({ response: actual });
  });
  const list = panel(page).locator(".af-shift-list"),
    listNode = await list.elementHandle(),
    buttonNode = await check.elementHandle();
  if (!listNode || !buttonNode)
    throw Error("Missing focused Shift list witness.");
  try {
    await check.focus();
    await expect(check).toBeFocused();
    await page.keyboard.press("Enter");
    await received;
    await expect(list).toHaveAttribute("aria-busy", "true");
    expect(await listNode.evaluate((element) => element.isConnected)).toBe(
      true,
    );
    expect(await buttonNode.evaluate((element) => element.isConnected)).toBe(
      true,
    );
    await expect(check).toBeFocused();
  } finally {
    release();
  }
  try {
    await expect(list).toHaveAttribute("aria-busy", "false");
    expect(await listNode.evaluate((element) => element.isConnected)).toBe(
      true,
    );
    expect(await buttonNode.evaluate((element) => element.isConnected)).toBe(
      true,
    );
    await expect(check).toBeFocused();
    expect(requests).toBe(1);
  } finally {
    release();
    await page.unroute(endpoint);
  }
}
async function minimumDesktopFits(page: Page) {
  expect(
    await panel(page).evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= window.innerWidth;
    }),
  ).toBe(true);
}
const reasonLabels: Record<ShiftStopReason, string> = {
  elapsed: "Duration limit reached",
  operator: "Stopped by operator",
  throttle: "Stopped for host load",
  halted: "Stopped after halted work",
  drained: "Selected queue drained",
  count: "Maximum admitted beads reached",
  budget: "Spend cap reached",
  recovered: "Recovered and stopped",
};
function seed(mode: "reset" | "corrupt" | "gallery", witnessPid = process.pid) {
  const result = spawnSync(
    bunPath(),
    [
      resolve("tests/desktop-shift-e2e/seed-states.ts"),
      FIXTURE_ROOT,
      mode,
      String(witnessPid),
    ],
    { encoding: "utf8", timeout: 15000, windowsHide: true },
  );
  if (result.status !== 0)
    throw Error(
      `The closed state fixture refused: ${result.stdout}\n${result.stderr}`,
    );
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw Error("The state fixture returned no verified envelope.");
  }
  expect(value).toEqual({ ok: true, data: { mode }, error: null });
}
const fixedVersionProbe = z
  .object({
    kind: z.literal("version"),
    argv: z.tuple([z.literal("--version")]),
    stdin: z.literal(""),
    cwd: z.literal(REPOSITORY),
    pid: z.number().int().positive(),
    childPid: z.null(),
    secretPresent: z.literal(false),
    forged: z.literal(false),
    adapter: z.literal("1").optional(),
  })
  .strict();
const providerBytes = () =>
  ["claude.json", "codex.jsonl"].map((name) => {
    const file = join(STATE, name);
    if (!existsSync(file)) return null;
    const bytes = readFileSync(file, "utf8");
    if (name !== "codex.jsonl") return bytes;
    // Readiness may inspect the fixed version while this page loads. Preserve
    // every other byte/record, including malformed, unknown or task activity.
    return (
      bytes
        .split("\n")
        .filter((line) => {
          if (!line) return false;
          let record: unknown;
          try {
            record = JSON.parse(line);
          } catch {
            return true;
          }
          return !fixedVersionProbe.safeParse(record).success;
        })
        .join("\n") || null
    );
  });
const trackerWrites = () =>
  fixtureCalls().filter(
    (row) =>
      row !== null &&
      typeof row === "object" &&
      "tool" in row &&
      row.tool === "bd" &&
      "args" in row &&
      Array.isArray(row.args) &&
      ["update", "comments"].includes(String(row.args[0])),
  );
function watchCommands(page: Page) {
  const commands: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname.startsWith(path)
    )
      commands.push(new URL(request.url()).pathname);
  });
  return commands;
}

test("held authenticated reads announce loading before verified empty and retain keyboard focus under reduced motion", async ({
  page,
}) => {
  seed("reset");
  const providers = providerBytes(),
    writes = trackerWrites(),
    commands = watchCommands(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let actualRead = false;
  await page.route(endpoint, async (intercept) => {
    const actual = await intercept.fetch({
      headers: {
        ...(await intercept.request().allHeaders()),
        origin: new URL(intercept.request().url()).origin,
      },
    });
    expect(actual.status()).toBe(200);
    actualRead = true;
    await held;
    await intercept.fulfill({ response: actual });
  });
  // The new document deliberately has an unfinished GET. Keep the standard
  // navigation witness, but release the read before awaiting its quiet period.
  const opened = openSettled(page, route);
  void opened.catch(() => {});
  try {
    await expect.poll(() => actualRead).toBe(true);
    const status = panel(page).getByRole("status");
    await expect(status).toHaveText("Loading project shifts…");
    await expect(status).toHaveAttribute("aria-live", "polite");
    await expect(
      panel(page).getByText("No project shifts reported.", { exact: true }),
    ).toHaveCount(0);
    await expect(panel(page).locator(".af-shift-list")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    const skeleton = panel(page).locator(".af-shift-skeleton");
    await expect(skeleton).toHaveAttribute("aria-hidden", "true");
    expect(
      await skeleton.evaluate(
        (element) => getComputedStyle(element).animationName,
      ),
    ).toBe("none");
    const refresh = panel(page).getByRole("button", {
      name: "Refresh shifts",
      exact: true,
    });
    await refresh.focus();
    await expect(refresh).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(status).toHaveText("Loading project shifts…");
    await panel(page).scrollIntoViewIfNeeded();
    await page.screenshot({
      path: "apps/desktop/docs/screenshots/project-shift-loading.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 1100, height: 700 });
    await status.scrollIntoViewIfNeeded();
    await minimumDesktopFits(page);
    await page.screenshot({
      path: "apps/desktop/docs/screenshots/project-shift-loading-minimum.png",
      fullPage: true,
    });
    release?.();
    await opened;
    await expect(
      panel(page).getByText("No project shifts reported.", { exact: true }),
    ).toBeVisible();
    await expect(refresh).toBeFocused();
    await expect(panel(page).locator(".af-shift-list")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    expect(commands).toEqual([]);
    expect(providerBytes()).toEqual(providers);
    expect(trackerWrites()).toEqual(writes);
  } finally {
    release?.();
    await opened.catch(() => {});
  }
});

test("a real unsupported private journal read announces failure without false empty and explicit keyboard Refresh recovers", async ({
  page,
}) => {
  seed("corrupt");
  const journal = join(HOME, "project-shifts", "starts.json"),
    original = readFileSync(journal, "utf8"),
    providers = providerBytes(),
    writes = trackerWrites(),
    commands = watchCommands(page);
  try {
    const refused = page.waitForResponse(
      (reply) =>
        new URL(reply.url()).pathname === path &&
        reply.request().method() === "GET",
    );
    await openSettled(page, route);
    expect((await refused).status()).toBe(503);
    await expect(panel(page).getByRole("alert")).toContainText(
      "Refresh shifts",
    );
    await expect(
      panel(page).getByText("No project shifts reported.", { exact: true }),
    ).toHaveCount(0);
    expect(readFileSync(journal, "utf8")).toBe(original);
    await page.screenshot({
      path: "apps/desktop/docs/screenshots/project-shift-read-error.png",
      fullPage: true,
    });
    seed("reset");
    const refresh = panel(page).getByRole("button", {
      name: "Refresh shifts",
      exact: true,
    });
    await refresh.focus();
    await page.keyboard.press("Enter");
    await expect(panel(page).getByRole("alert")).toHaveCount(0);
    await expect(
      panel(page).getByText("No project shifts reported.", { exact: true }),
    ).toBeVisible();
    await expect(refresh).toBeFocused();
    expect(commands).toEqual([]);
    expect(providerBytes()).toEqual(providers);
    expect(trackerWrites()).toEqual(writes);
  } finally {
    seed("reset");
  }
});

test("protected metadata renders Throttled and every canonical stopped reason with keyboard access and no command", async ({
  page,
}) => {
  const witness = spawn(bunPath(), ["-e", "setTimeout(() => {}, 90000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    witness.once("spawn", resolve);
    witness.once("error", reject);
  });
  if (!witness.pid) throw Error("Missing inert gallery liveness witness.");
  const exited = new Promise<void>((resolve) =>
    witness.once("exit", () => resolve()),
  );
  try {
    seed("gallery", witness.pid);
    const providers = providerBytes(),
      writes = trackerWrites(),
      commands = watchCommands(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const reply = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === path &&
        response.request().method() === "GET",
    );
    await openSettled(page, route);
    const actual = await reply;
    expect(actual.status()).toBe(200);
    let envelope: unknown;
    try {
      envelope = await actual.json();
    } catch {
      throw Error("The real metadata read was not JSON.");
    }
    if (
      !envelope ||
      typeof envelope !== "object" ||
      !("ok" in envelope) ||
      envelope.ok !== true ||
      !("data" in envelope)
    )
      throw Error("The real metadata read was refused.");
    const observed = projectShiftsPageSchema.parse(envelope.data);
    expect(
      observed.items.filter((item) => item.observation.phase === "throttled"),
    ).toHaveLength(1);
    expect(
      observed.items
        .filter((item) => item.observation.phase === "stopped")
        .map((item) => item.observation.reason)
        .sort(),
    ).toEqual([...SHIFT_STOP_REASONS].sort());
    const throttled = panel(page).locator('[data-phase="throttled"]');
    await expect(throttled).toContainText(
      "Throttled · waiting for host capacity",
    );
    await expect(throttled).toContainText("100% / 50%");
    for (const reason of SHIFT_STOP_REASONS) {
      const label = reasonLabels[reason];
      const row = panel(page)
        .locator('[data-phase="stopped"]')
        .filter({ hasText: label });
      await expect(row).toHaveCount(1);
      await expect(row).toContainText("Stopped");
      const check = row.getByRole("button", {
        name: "Check original",
        exact: true,
      });
      if (reason === "elapsed") {
        const elapsed = observed.items.find(
          (item) => item.observation.reason === reason,
        );
        if (!elapsed) throw Error("Missing verified duration-stop original.");
        await heldOriginalCheck(page, check, elapsed.intent.request.requestId);
      } else {
        await check.focus();
        await expect(check).toBeFocused();
        await page.keyboard.press("Enter");
      }
      await expect(check).toBeFocused();
      const bounds = row.getByText("Reviewed original bounds", { exact: true });
      await bounds.focus();
      await page.keyboard.press("Enter");
      await expect(row.locator("details")).toHaveAttribute("open", "");
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await throttled
      .getByText("Throttled · waiting for host capacity", { exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: "apps/desktop/docs/screenshots/project-shift-states.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 1100, height: 700 });
    await throttled
      .getByText("Throttled · waiting for host capacity", { exact: true })
      .scrollIntoViewIfNeeded();
    await minimumDesktopFits(page);
    await page.screenshot({
      path: "apps/desktop/docs/screenshots/project-shift-states-minimum.png",
      fullPage: true,
    });
    expect(commands).toEqual([]);
    expect(providerBytes()).toEqual(providers);
    expect(trackerWrites()).toEqual(writes);
  } finally {
    witness.kill();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Error("The inert gallery witness did not exit.")),
            2000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    seed("reset");
  }
});

test("an actually refused disposable Git preflight shows Failed to start without invented actual metrics", async ({
  page,
}) => {
  seed("reset");
  holdStartup(true);
  const providers = providerBytes(),
    writes = trackerWrites(),
    commands = watchCommands(page);
  try {
    await openSettled(page, route);
    await panel(page)
      .getByRole("button", { name: "Start shift", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Review bounded project shift",
    });
    await expect(dialog.getByLabel("Duration", { exact: true })).toHaveValue(
      "1m",
    );
    await dialog.getByLabel("Base branch", { exact: true }).fill("main");
    await dialog
      .getByLabel("Smith override", { exact: true })
      .selectOption("claude-journeyman");
    await dialog
      .getByLabel("Epic filter", { exact: true })
      .selectOption("alpha-epic");
    await dialog
      .getByRole("button", { name: "Start reviewed shift", exact: true })
      .click();
    await expect
      .poll(() => existsSync(join(STATE, "startup-tree.json")))
      .toBe(true);
    holdStartup(false); // The already-held disposable fetch now refuses, without a Stop request.
    const row = panel(page).locator("[data-shift]").last();
    await expect(row).toHaveAttribute("data-phase", "failed", {
      timeout: 20000,
    });
    await expect(row).toContainText("Failed to start");
    await expect(row).toContainText("No correlated actual shift record");
    await expect(row.getByText("Started", { exact: true })).toHaveCount(0);
    await expect(
      row.getByRole("button", { name: "Stop shift", exact: true }),
    ).toHaveCount(0);
    await page.screenshot({
      path: "apps/desktop/docs/screenshots/project-shift-failed.png",
      fullPage: true,
    });
    expect(commands).toEqual([path]);
    expect(providerBytes()).toEqual(providers);
    expect(trackerWrites()).toEqual(writes);
  } finally {
    holdStartup(false);
  }
});
