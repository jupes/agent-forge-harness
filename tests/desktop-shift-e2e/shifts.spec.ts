import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import { PROJECT_SHIFT_IDENTITIES } from "../../apps/desktop/src/project-shift-identities";
import { FIXTURE_PROJECT_ID } from "../../scripts/projects/testing";
import { projectShiftStartSchema } from "../../scripts/shifts/protocol";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import {
  fixtureCalls,
  fixtureMode,
  holdStartup,
  resetTracker,
  STATE,
} from "./environment";

const route = `/index.html#/desktop/project/${FIXTURE_PROJECT_ID}/workbench`;
const panel = (page: Page) =>
  page.getByRole("region", { name: "Bounded project shifts", exact: true });
const dialog = (page: Page) =>
  page.getByRole("dialog", { name: "Review bounded project shift" });
async function review(page: Page) {
  await panel(page)
    .getByRole("button", { name: "Start shift", exact: true })
    .click();
  await expect(
    dialog(page).getByLabel("Duration", { exact: true }),
  ).toHaveValue("1m");
  await dialog(page).getByLabel("Base branch", { exact: true }).fill("main");
  await dialog(page)
    .getByLabel("Smith override", { exact: true })
    .selectOption("claude-journeyman");
  await dialog(page)
    .getByLabel("Epic filter", { exact: true })
    .selectOption("alpha-epic");
}
function actualProvider() {
  try {
    return z
      .object({
        pid: z.number().int().positive(),
        childPid: z.number().int().positive().nullable(),
        argv: z.array(z.string()),
        stdin: z.string(),
        cwd: z.string(),
      })
      .parse(JSON.parse(readFileSync(join(STATE, "claude.json"), "utf8")));
  } catch {
    return null;
  }
}
test.beforeEach(() => {
  resetTracker();
  fixtureMode("rich");
});

test("opening, editing and Cancel retain configured provenance and create no original, provider or tracker effect", async ({
  page,
}) => {
  await openSettled(page, route);
  const calls = fixtureCalls().filter(
    (row) =>
      typeof row === "object" &&
      row !== null &&
      "tool" in row &&
      row.tool === "bd" &&
      "args" in row &&
      Array.isArray(row.args) &&
      ["update", "comments"].includes(String(row.args[0])),
  );
  let starts = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname ===
        `/__agent-forge/projects/${FIXTURE_PROJECT_ID}/shifts`
    )
      starts++;
  });
  await review(page);
  await expect(dialog(page)).toContainText("agent-forge.toml");
  await expect(
    dialog(page).getByLabel("Per-run timeout (optional)", { exact: true }),
  ).toHaveValue("");
  await dialog(page).getByLabel("Duration", { exact: true }).fill("2h");
  await dialog(page).getByLabel("Concurrency", { exact: true }).fill("2");
  await dialog(page).getByLabel("Maximum beads", { exact: true }).fill("4");
  await dialog(page).getByLabel("Spend cap (USD)", { exact: true }).fill("10");
  await dialog(page).getByLabel("Repair attempts", { exact: true }).fill("3");
  await dialog(page)
    .getByLabel("Per-run timeout (optional)", { exact: true })
    .fill("20m");
  await dialog(page)
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(dialog(page)).not.toBeVisible();
  await expect(
    panel(page).getByRole("button", { name: "Start shift", exact: true }),
  ).toBeFocused();
  expect(starts).toBe(0);
  expect(existsSync(join(STATE, "claude.json"))).toBe(false);
  expect(
    await page.evaluate(
      (key) => localStorage.getItem(key),
      PROJECT_SHIFT_IDENTITIES,
    ),
  ).toBeNull();
  expect(
    fixtureCalls().filter(
      (row) =>
        typeof row === "object" &&
        row !== null &&
        "tool" in row &&
        row.tool === "bd" &&
        "args" in row &&
        Array.isArray(row.args) &&
        ["update", "comments"].includes(String(row.args[0])),
    ),
  ).toEqual(calls);
});

test("a lost real Start response reloads its exact original and private attended reports without another provider turn", async ({
  page,
}) => {
  await openSettled(page, route);
  await review(page);
  await dialog(page).getByLabel("Duration", { exact: true }).fill("2h");
  await dialog(page)
    .getByLabel("Per-run timeout (optional)", { exact: true })
    .fill("20m");
  const starts: unknown[] = [];
  await page.route(
    `**/__agent-forge/projects/${FIXTURE_PROJECT_ID}/shifts`,
    async (intercept) => {
      if (intercept.request().method() !== "POST") return intercept.continue();
      starts.push(intercept.request().postDataJSON());
      const actual = await intercept.fetch();
      expect(actual.status()).toBe(202);
      await intercept.abort("failed");
    },
  );
  await dialog(page)
    .getByRole("button", { name: "Start reviewed shift", exact: true })
    .click();
  await expect(dialog(page)).not.toBeVisible();
  expect(starts).toHaveLength(1);
  const start = projectShiftStartSchema.parse(starts[0]);
  expect(start.options).toEqual({
    for: "2h",
    concurrency: 1,
    maxBeads: 1,
    maxUsd: 5,
    repairs: 0,
    base: "main",
    epic: "alpha-epic",
    smith: "claude-journeyman",
    runTimeout: "20m",
  });
  await reloadSettled(page);
  await expect(panel(page).locator("[data-shift]").last()).toHaveAttribute(
    "data-phase",
    "stopped",
    { timeout: 20000 },
  );
  const last = panel(page).locator("[data-shift]").last();
  await expect(last).toContainText("Started");
  await last.getByRole("button", { name: "Attend shift", exact: true }).click();
  const activity = panel(page).getByRole("region", {
    name: "Private shift activity",
    exact: true,
  });
  await expect(activity).toContainText("Verified saved turn: completed");
  await expect(
    activity.getByRole("region", { name: "Provider text", exact: true }),
  ).toContainText("Coding reply 🌱!");
  await expect(activity).toContainText("Reported activity");
  await activity.getByText("Turn model and usage", { exact: false }).click();
  await expect(activity).toContainText("fixture-served-model");
  await expect(activity).toContainText("20");
  await activity.getByText("Provider turn completed", { exact: true }).click();
  await expect(activity).toContainText("Process exit code");
  await expect(activity.getByRole("button", { name: /Send|Stop/ })).toHaveCount(
    0,
  );
  await activity.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "apps/desktop/docs/screenshots/project-shift-attended.png",
  });
  const actual = actualProvider();
  expect(actual).not.toBeNull();
  if (!actual) throw Error("No actual provider record");
  await last
    .getByRole("button", { name: "Check original", exact: true })
    .click();
  await reloadSettled(page);
  expect(starts).toHaveLength(1);
  expect(actualProvider()?.pid).toBe(actual.pid);
  expect(JSON.stringify(fixtureCalls())).not.toContain("foreign-work");
});

test("whole-shift Stop retains keyboard focus across a background read and waits for owned attempt exit", async ({
  page,
}) => {
  fixtureMode("hang-tree");
  await openSettled(page, route);
  await review(page);
  await dialog(page)
    .getByRole("button", { name: "Start reviewed shift", exact: true })
    .click();
  const row = panel(page).locator("[data-shift]").last();
  await expect(
    row.getByRole("button", { name: "Stop shift", exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await expect.poll(() => actualProvider()?.childPid ?? null).not.toBeNull();
  const actual = actualProvider();
  if (!actual) throw Error("No supervised fixture");
  let release: (() => void) | undefined;
  let entered = () => {},
    finished = () => {};
  const readEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const readFinished = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    `**/__agent-forge/projects/${FIXTURE_PROJECT_ID}/shifts`,
    async (intercept) => {
      if (intercept.request().method() !== "GET") return intercept.continue();
      entered();
      await held;
      await intercept.continue();
      finished();
    },
  );
  await panel(page)
    .getByRole("button", { name: "Refresh shifts", exact: true })
    .click();
  await readEntered;
  const stop = row.getByRole("button", { name: "Stop shift", exact: true });
  await stop.focus();
  await expect(stop).toBeFocused();
  let stopCalls = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname.endsWith("/stop")
    )
      stopCalls++;
  });
  await page.keyboard.press("Enter");
  await expect.poll(() => stopCalls).toBe(1);
  release?.();
  await readFinished;
  await page.unroute(`**/__agent-forge/projects/${FIXTURE_PROJECT_ID}/shifts`);
  await expect(row).toHaveAttribute("data-phase", "stopped", {
    timeout: 20000,
  });
  expect(stopCalls).toBe(1);
  for (const pid of [actual.pid, actual.childPid])
    if (pid)
      await expect
        .poll(() => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(false);
  await expect(
    row.getByRole("button", { name: "Stop shift", exact: true }),
  ).toHaveCount(0);
});

test("Starting Stop settles the held preflight tree before any record or provider and survives a lost reply and reload", async ({
  page,
}) => {
  const before = fixtureCalls().length,
    providerFile = join(STATE, "claude.json"),
    providerBefore = existsSync(providerFile)
      ? readFileSync(providerFile, "utf8")
      : null;
  holdStartup(true);
  try {
    await openSettled(page, route);
    await review(page);
    let starts = 0,
      stops = 0;
    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      const path = new URL(request.url()).pathname;
      if (path === `/__agent-forge/projects/${FIXTURE_PROJECT_ID}/shifts`)
        starts++;
      if (path.endsWith("/stop")) stops++;
    });
    await dialog(page)
      .getByRole("button", { name: "Start reviewed shift", exact: true })
      .click();
    const row = panel(page).locator("[data-shift]").last();
    await expect(row).toHaveAttribute("data-phase", "starting");
    const treeFile = join(STATE, "startup-tree.json"),
      tree = () => {
        try {
          return z
            .object({
              pid: z.number().int().positive(),
              childPid: z.number().int().positive(),
            })
            .parse(JSON.parse(readFileSync(treeFile, "utf8")));
        } catch {
          return null;
        }
      };
    await expect.poll(tree).not.toBeNull();
    const held = tree();
    if (!held) throw Error("Missing actual held preflight identity");
    await page.route(
      `**/__agent-forge/projects/${FIXTURE_PROJECT_ID}/shifts/*/stop`,
      async (intercept) => {
        const response = await intercept.fetch();
        expect(response.status()).toBe(202);
        await intercept.abort("failed");
      },
    );
    const stop = row.getByRole("button", { name: "Stop shift", exact: true });
    await expect(stop).toBeVisible();
    await stop.focus();
    await expect(stop).toBeFocused();
    const lost = page.waitForEvent("requestfailed", {
      predicate: (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname.endsWith("/stop"),
    });
    await page.keyboard.press("Enter");
    await expect.poll(() => stops).toBe(1);
    await lost;
    const alive = (pid: number) => {
      try {
        if (
          process.platform === "linux" &&
          /\) Z(?: |$)/.test(readFileSync(`/proc/${pid}/stat`, "utf8"))
        )
          return false;
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (const pid of [held.pid, held.childPid])
      await expect.poll(() => alive(pid)).toBe(false);
    await page.unroute(
      `**/__agent-forge/projects/${FIXTURE_PROJECT_ID}/shifts/*/stop`,
    );
    await reloadSettled(page);
    const restored = panel(page).locator("[data-shift]").last();
    await expect(restored).toHaveAttribute("data-phase", "stopped");
    await expect(restored).toContainText(
      "original held tree exited before a shift record",
    );
    await expect(restored).toContainText("No correlated actual shift record");
    await expect(restored.getByText("Started", { exact: true })).toHaveCount(0);
    expect(starts).toBe(1);
    expect(stops).toBe(1);
    expect(
      existsSync(providerFile) ? readFileSync(providerFile, "utf8") : null,
    ).toBe(providerBefore);
    expect(
      fixtureCalls()
        .slice(before)
        .filter(
          (row) =>
            row &&
            typeof row === "object" &&
            "tool" in row &&
            row.tool === "bd" &&
            "args" in row &&
            Array.isArray(row.args) &&
            ["update", "comments"].includes(String(row.args[0])),
        ),
    ).toEqual([]);
  } finally {
    holdStartup(false);
  }
});
