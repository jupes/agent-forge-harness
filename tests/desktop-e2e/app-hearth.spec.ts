import { mkdirSync } from "node:fs";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { z } from "zod";
import { version as rendererVersion } from "../../package.json";
import { appHearthSettingsSchema } from "../../scripts/desktop/app-hearth-protocol";
import type { NativeUpdateRequest } from "../../types/native-update";
import {
  nativeUpdateAuthorizationSchema,
  nativeUpdatePendingSchema,
} from "../../types/native-update";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import { HEARTH_PORT } from "../e2e/servers";
import { captureTextResponseThroughBrowserFetch } from "./browser-response-capture";
import { seedProjects } from "./project-fixtures";

test.beforeEach(seedProjects);
const panel = (page: Page) =>
  page.getByRole("region", { name: "Hearth", exact: true });
async function settings(page: Page) {
  await openSettled(page, "/#/desktop/app-settings");
  await expect(
    page.getByRole("heading", { name: "Hearth", exact: true }),
  ).toBeVisible();
}
test("Hearth Settings reads actual port, logical sizes and the owned nightly backup schedule", async ({
  page,
}) => {
  await settings(page);
  await expect(
    panel(page).getByText("Hearth diagnostics read.", { exact: true }),
  ).toBeVisible();
  const capture = await captureTextResponseThroughBrowserFetch(page, {
    method: "GET",
    origin: new URL(page.url()).origin,
    path: "/__agent-forge/app-settings/hearth",
  });
  let captured: { status: number; text: string };
  try {
    await panel(page)
      .getByRole("button", { name: "Check Hearth diagnostics", exact: true })
      .click();
    captured = await capture.response;
  } finally {
    await capture.dispose();
  }
  expect(captured.status).toBe(200);
  // The assertion consumes retained bytes after the response's document is gone.
  await page.goto("data:text/html,<title>Retire captured document</title>");
  await settings(page);
  let envelope: unknown;
  try {
    envelope = JSON.parse(captured.text);
  } catch {
    throw Error("Captured diagnostics response was not valid JSON");
  }

  if (
    envelope === null ||
    typeof envelope !== "object" ||
    !("ok" in envelope) ||
    envelope.ok !== true ||
    !("data" in envelope)
  )
    throw Error("Missing diagnostics envelope");
  const data = appHearthSettingsSchema.parse(envelope.data);
  expect(data.port).toBe(HEARTH_PORT);
  expect(data.port).not.toBe(Number(new URL(page.url()).port));
  await expect(
    panel(page).getByText(String(HEARTH_PORT), { exact: true }),
  ).toBeVisible();
  await expect(
    panel(page).getByText(data.ledger.path, { exact: true }),
  ).toBeVisible();
  await expect(
    panel(page).getByText(
      "Nightly backups run at 00:00 UTC while Hearth is running.",
      { exact: false },
    ),
  ).toBeVisible();
  expect(data.upkeep.nightlyBackup?.phase).toBe("scheduled");
  if (!data.upkeep.nightlyBackup?.nextAttemptAt)
    throw Error("Missing next backup attempt");
  // The reopened page is a newer observation: its schedule can advance at midnight.
  const nextBackup = panel(page)
    .locator("p")
    .filter({ hasText: /^Next scheduled attempt \(UTC\):/ })
    .locator("time");
  await expect(nextBackup).toHaveCount(1);
  await expect(nextBackup).toBeVisible();
  const displayed = await nextBackup.evaluate((element) => ({
    at: element.getAttribute("datetime"),
    text: element.textContent?.trim(),
  }));
  if (!displayed.at) throw Error("Displayed backup time missing");
  expect(displayed.at).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
  expect(new Date(displayed.at).toISOString()).toBe(displayed.at);
  expect(displayed.text).toBe(displayed.at);
  await expect(
    panel(page).getByText("This status covers this Hearth lifetime only.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(panel(page).getByText("None.", { exact: false })).toBeVisible();
  await expect(
    panel(page).getByRole("button", { name: "Restart hearth", exact: true }),
  ).toBeEnabled();
  await page.setViewportSize({ width: 1100, height: 700 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const check = panel(page).getByRole("button", {
    name: "Check Hearth diagnostics",
    exact: true,
  });
  await page.keyboard.press("Tab");
  await check.focus();
  await expect(check).toBeFocused();
  expect(await check.evaluate((el) => getComputedStyle(el).outlineWidth)).toBe(
    "2px",
  );
  expect(await check.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe(
    "solid",
  );
  mkdirSync(".tmp/screenshots/hearth-settings", { recursive: true });
  await page.screenshot({
    path: ".tmp/screenshots/hearth-settings/settings-1100.png",
    mask: [panel(page).getByText(data.ledger.path, { exact: true })],
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await panel(page).screenshot({
    path: ".tmp/screenshots/hearth-settings/hearth-dark.png",
    mask: [panel(page).getByText(data.ledger.path, { exact: true })],
  });
  await page.getByLabel("Theme", { exact: true }).selectOption("light");
  await page
    .getByRole("button", { name: "Save appearance", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-af-theme", "light");
  await expect(check).toBeEnabled();
  await panel(page).screenshot({
    path: ".tmp/screenshots/hearth-settings/hearth-light.png",
    mask: [panel(page).getByText(data.ledger.path, { exact: true })],
  });
  await page.getByLabel("Theme", { exact: true }).selectOption("dark");
  await page
    .getByRole("button", { name: "Save appearance", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-af-theme", "dark");
});
test("failed or malformed diagnostics retain last-read values and recover only through a fresh verified read", async ({
  page,
}) => {
  let mode: "failure" | "live" | "malformed" = "failure";
  await page.route("**/__agent-forge/app-settings/hearth", async (route) => {
    if (mode === "live") return route.continue();
    return route.fulfill({
      status: mode === "failure" ? 503 : 200,
      contentType: "application/json",
      body: JSON.stringify(
        mode === "failure"
          ? { ok: false, data: null, error: "fixture unavailable" }
          : {
              ok: true,
              data: {
                version: 1,
                port: 12345,
                execution: { names: ["RAW_SECRET=value"] },
              },
              error: null,
            },
      ),
    });
  });
  await settings(page);
  await expect(
    panel(page).getByText("No verified diagnostics are available.", {
      exact: true,
    }),
  ).toBeVisible();
  const check = panel(page).getByRole("button", {
    name: "Check Hearth diagnostics",
    exact: true,
  });
  mode = "live";
  await check.click();
  await expect(
    panel(page).getByText(String(HEARTH_PORT), { exact: true }),
  ).toBeVisible();
  mode = "malformed";
  await check.click();
  await expect(
    panel(page)
      .getByRole("alert")
      .filter({ hasText: "Showing last read values" }),
  ).toBeVisible();
  await expect(
    panel(page).getByText(String(HEARTH_PORT), { exact: true }),
  ).toBeVisible();
  await expect(panel(page)).not.toContainText("RAW_SECRET=value");
  mode = "live";
  await check.click();
  await expect(
    panel(page).getByText("Hearth diagnostics read.", { exact: true }),
  ).toBeVisible();
});
test("Settings restart uses the frame recovery owner and preserves its unknown-outcome fence across navigation", async ({
  page,
}) => {
  await settings(page);
  let posts = 0;
  await page.route("**/__agent-forge/desktop/restart", async (route) => {
    posts++;
    await route.abort("failed");
  });
  const restart = panel(page).getByRole("button", {
    name: "Restart hearth",
    exact: true,
  });
  await expect(restart).toBeEnabled();
  await restart.evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect(
    panel(page).getByText("Outcome unknown.", { exact: false }),
  ).toBeVisible();
  await expect(restart).toBeDisabled();
  expect(posts).toBe(1);
  await openSettled(page, "/#/desktop");
  await settings(page);
  await expect(
    panel(page).getByRole("button", { name: "Restart hearth", exact: true }),
  ).toBeDisabled();
  await expect(
    panel(page).getByText("Outcome unknown.", { exact: false }),
  ).toBeVisible();
  expect(posts).toBe(1);
});

test("Updates makes no automatic request and checks a reported stable release only through the explicit keyboard action", async ({
  page,
}) => {
  let calls = 0,
    release = () => {};
  const held = new Promise<void>((done) => {
    release = done;
  });
  await page.route(
    "**/__agent-forge/app-settings/updates/check",
    async (route) => {
      calls++;
      expect(route.request().method()).toBe("POST");
      expect(route.request().postDataJSON()).toEqual({});
      await held;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          error: null,
          data: {
            state: "newer",
            currentVersion: rendererVersion,
            checkedAt: "2026-11-10T00:00:00Z",
            release: {
              tag: "v1.0.0",
              url: "https://github.com/jupes/agent-forge-harness/releases/tag/v1.0.0",
              publishedAt: "2026-11-01T00:00:00Z",
            },
          },
        }),
      });
    },
  );
  try {
    await settings(page);
    const updates = page.getByRole("region", { name: "Updates", exact: true });
    await expect(
      updates.getByText("Updates have not been checked.", { exact: true }),
    ).toBeVisible();
    expect(calls).toBe(0);
    const check = updates.getByRole("button", {
      name: "Check for updates",
      exact: true,
    });
    await page.keyboard.press("Tab");
    await check.focus();
    await expect(check).toBeFocused();
    expect(
      await check.evaluate((el) => getComputedStyle(el).outlineWidth),
    ).toBe("2px");
    await page.keyboard.press("Enter");
    await expect(check).toBeDisabled();
    await expect.poll(() => calls).toBe(1);
    release();
    await expect(check).toBeEnabled();
    await expect(
      updates.getByText(
        "The reported stable release is newer than this renderer.",
        { exact: true },
      ),
    ).toBeVisible();
    const url = updates.getByLabel("Official release URL", { exact: true });
    await expect(url).toHaveValue(
      "https://github.com/jupes/agent-forge-harness/releases/tag/v1.0.0",
    );
    await expect(url).toHaveAttribute("readonly", "");
    await expect(
      updates.getByText("This check reads release metadata only.", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(updates.locator("a")).toHaveCount(0);
    await page.setViewportSize({ width: 1100, height: 700 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(calls).toBe(1);
  } finally {
    release();
  }
});

test("an unavailable update check retains and labels the last reported release without claiming it is current", async ({
  page,
}) => {
  let calls = 0;
  await page.route(
    "**/__agent-forge/app-settings/updates/check",
    async (route) => {
      calls++;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          error: null,
          data:
            calls === 1
              ? {
                  state: "newer",
                  currentVersion: rendererVersion,
                  checkedAt: "2026-11-10T00:00:00Z",
                  release: {
                    tag: "v1.0.0",
                    url: "https://github.com/jupes/agent-forge-harness/releases/tag/v1.0.0",
                    publishedAt: "2026-11-01T00:00:00Z",
                  },
                }
              : {
                  state: "unavailable",
                  currentVersion: rendererVersion,
                  checkedAt: "2026-11-10T00:01:00Z",
                  reason: "not-found",
                },
        }),
      });
    },
  );
  await settings(page);
  const updates = page.getByRole("region", { name: "Updates", exact: true });
  const check = updates.getByRole("button", {
    name: "Check for updates",
    exact: true,
  });
  await check.click();
  await expect(
    updates.getByText("Release information checked.", { exact: true }),
  ).toBeVisible();
  await check.click();
  await expect(updates.getByRole("alert")).toContainText(
    "Update availability is unknown.",
  );
  await expect(
    updates.getByText(
      "Showing the last verified result; it may be out of date.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    updates.getByLabel("Official release URL", { exact: true }),
  ).toHaveValue(
    "https://github.com/jupes/agent-forge-harness/releases/tag/v1.0.0",
  );
  expect(calls).toBe(2);
});

const updateRequestSchema = z.union([
  nativeUpdateAuthorizationSchema,
  z.strictObject({
    operation: z.literal("status"),
    requestId: z.string().uuid().nullable(),
  }),
]);
async function signedUpdateFixture(
  page: Page,
  mode: "reply" | "lost" = "reply",
) {
  const calls: NativeUpdateRequest[] = [],
    trace: string[] = [];
  await page.exposeFunction("__AF_UPDATE_RECORD", (raw: unknown) => {
    const request = updateRequestSchema.parse(raw);
    calls.push(request);
    trace.push("native:" + request.operation);
  });
  await page.addInitScript(
    ({ mode, currentVersion }) => {
      Object.defineProperty(window, "__TAURI_INTERNALS__", {
        value: {
          async invoke(
            command: string,
            input: { request: NativeUpdateRequest },
          ) {
            if (command !== "native_update")
              throw Error("Unsupported fixture command");
            const request = input.request,
              record: unknown = Reflect.get(window, "__AF_UPDATE_RECORD");
            if (typeof record !== "function") throw Error("No native observer");
            await Reflect.apply(record, window, [request]);
            const idKey = "fixture-update-id",
              phaseKey = "fixture-update-phase";
            if (request.operation === "check") {
              sessionStorage.setItem(idKey, request.requestId);
              sessionStorage.setItem(phaseKey, "available");
            }
            if (request.operation === "download")
              sessionStorage.setItem(phaseKey, "downloaded");
            if (request.operation === "install") {
              sessionStorage.setItem(phaseKey, "install-unknown");
              if (mode === "lost") throw Error("PRIVATE_NATIVE_FAILURE");
            }
            const state = sessionStorage.getItem(phaseKey) ?? "unavailable";
            return {
              ok: true,
              error: null,
              data: {
                schemaVersion: 1,
                currentVersion,
                scopeKey: "d".repeat(64),
                requestId: sessionStorage.getItem(idKey),
                version: state === "unavailable" ? null : "1.0.0",
                state,
              },
            };
          },
        },
      });
    },
    { mode, currentVersion: rendererVersion },
  );
  await page.route(
    "**/__agent-forge/app-settings/native-updates/authorize",
    async (route) => {
      expect(route.request().method()).toBe("POST");
      const request = nativeUpdateAuthorizationSchema.parse(
        route.request().postDataJSON(),
      );
      if (request.operation === "install") {
        const raw = await page.evaluate(() =>
          localStorage.getItem("agent-forge:native-update:v1"),
        );
        if (!raw) throw Error("Missing persisted install intent");
        let pending: unknown;
        try {
          pending = JSON.parse(raw);
        } catch {
          throw Error("Invalid install intent JSON");
        }
        expect(nativeUpdatePendingSchema.parse(pending).requestId).toBe(
          request.requestId,
        );
        trace.push("persisted:install");
      }
      trace.push("audit:" + request.operation);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          error: null,
          data: { ...request, schemaVersion: 1, authorized: true },
        }),
      });
    },
  );
  return { calls, trace };
}
async function blockedUpdateClickWitness(
  page: Page,
  button: Locator,
  count: () => number,
  label: string,
) {
  const name = (await button.textContent())?.trim();
  if (!name) throw Error("Missing update action label");
  await page.evaluate((name) => {
    const block = (event: Event) => {
      const button =
        event.target instanceof Element ? event.target.closest("button") : null;
      if (button?.textContent?.trim() === name) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    Reflect.set(window, "__AF_UPDATE_CLICK_BLOCK", block);
    document.addEventListener("click", block, true);
  }, name);
  try {
    await button.click();
    let rejected = false;
    try {
      await expect.poll(count, { timeout: 500 }).toBe(1);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message.replace(/\x1b\[[0-9;]*m/g, "")
          : "";
      if (!/Expected:\s+1/.test(message) || !/Received:\s+0/.test(message))
        throw error;
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect(count()).toBe(0);
    console.log(
      "[native-update-ui-negative] " +
        label +
        " positive witness refused while its click path was blocked",
    );
  } finally {
    await page.evaluate(() => {
      const block: unknown = Reflect.get(window, "__AF_UPDATE_CLICK_BLOCK");
      if (typeof block === "function")
        Reflect.apply(document.removeEventListener, document, [
          "click",
          block,
          true,
        ]);
      Reflect.deleteProperty(window, "__AF_UPDATE_CLICK_BLOCK");
    });
  }
}
test("native signed update preparation requires separate reviewed confirmation and preserves a native original outcome", async ({
  page,
}) => {
  const f = await signedUpdateFixture(page);
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await settings(page);
  const updates = page.getByRole("region", {
    name: "Install signed updates",
    exact: true,
  });
  expect(f.trace.filter((x) => x.startsWith("audit:"))).toEqual([]);
  expect(f.calls.every((x) => x.operation === "status")).toBe(true);
  const check = updates.getByRole("button", {
    name: "Check signed package",
    exact: true,
  });
  await page.keyboard.press("Tab");
  await check.focus();
  await expect(check).toBeFocused();
  await expect
    .poll(() => check.evaluate((el) => getComputedStyle(el).outlineWidth))
    .toBe("2px");
  await page.keyboard.press("Enter");
  await updates
    .getByRole("button", { name: "Download signed update", exact: true })
    .click();
  await expect(
    updates.getByRole("button", { name: "Review installation", exact: true }),
  ).toBeVisible();
  expect(f.calls.filter((x) => x.operation === "install")).toHaveLength(0);
  await updates
    .getByRole("button", { name: "Review installation", exact: true })
    .click();
  await updates
    .getByRole("button", { name: "Cancel installation", exact: true })
    .click();
  expect(f.calls.filter((x) => x.operation === "install")).toHaveLength(0);
  await updates
    .getByRole("button", { name: "Review installation", exact: true })
    .click();
  const confirm = updates.getByRole("button", {
    name: "Install update and close Forge",
    exact: true,
  });
  mkdirSync(".tmp/screenshots/updates", { recursive: true });
  await updates.screenshot({
    path: ".tmp/screenshots/updates/signed-update-review-1100.png",
  });
  await blockedUpdateClickWitness(
    page,
    confirm,
    () => f.calls.filter((x) => x.operation === "install").length,
    "install",
  );
  await confirm.focus();
  await expect(confirm).toBeFocused();
  await expect
    .poll(() => confirm.evaluate((el) => getComputedStyle(el).outlineWidth))
    .toBe("2px");
  await page.keyboard.press("Enter");
  await expect(
    updates.getByRole("button", {
      name: "Check original installation outcome",
      exact: true,
    }),
  ).toBeVisible();
  expect(f.calls.filter((x) => x.operation === "install")).toHaveLength(1);
  expect(f.trace.filter((x) => x !== "native:status")).toEqual([
    "audit:check",
    "native:check",
    "audit:download",
    "native:download",
    "persisted:install",
    "audit:install",
    "native:install",
  ]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("a lost native signed update reply reloads its exact journal without browser metadata and never repeats installation", async ({
  page,
}) => {
  const f = await signedUpdateFixture(page, "lost");
  await settings(page);
  const updates = page.getByRole("region", {
    name: "Install signed updates",
    exact: true,
  });
  await updates
    .getByRole("button", { name: "Check signed package", exact: true })
    .click();
  await updates
    .getByRole("button", { name: "Download signed update", exact: true })
    .click();
  await updates
    .getByRole("button", { name: "Review installation", exact: true })
    .click();
  await updates
    .getByRole("button", {
      name: "Install update and close Forge",
      exact: true,
    })
    .click();
  const recover = updates.getByRole("button", {
    name: "Check original installation outcome",
    exact: true,
  });
  await expect(recover).toBeVisible();
  await expect(page.locator("body")).not.toContainText(
    "PRIVATE_NATIVE_FAILURE",
  );
  const before = f.calls.filter((x) => x.operation === "status").length;
  await blockedUpdateClickWitness(
    page,
    recover,
    () => f.calls.filter((x) => x.operation === "status").length - before,
    "recovery",
  );
  await recover.focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(() => f.calls.filter((x) => x.operation === "status").length - before)
    .toBe(1);
  await page.evaluate(() =>
    localStorage.removeItem("agent-forge:native-update:v1"),
  );
  await reloadSettled(page);
  await expect(
    page
      .getByRole("region", { name: "Install signed updates", exact: true })
      .getByRole("button", {
        name: "Check original installation outcome",
        exact: true,
      }),
  ).toBeVisible();
  expect(f.calls.filter((x) => x.operation === "install")).toHaveLength(1);
  expect(f.calls.at(-1)).toEqual({ operation: "status", requestId: null });
  expect(f.trace.filter((x) => x.startsWith("audit:"))).toEqual([
    "audit:check",
    "audit:download",
    "audit:install",
  ]);
});
