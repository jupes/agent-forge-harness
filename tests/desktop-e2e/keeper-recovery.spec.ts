import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Route, test } from "@playwright/test";
import type { ConversationState } from "../../types/conversation";
import type { KeeperRecoveryPage } from "../../types/keeper-recovery";
import { openSettled } from "../e2e/fixtures";
import { HEARTH_HOME } from "../e2e/servers";
import { alpha, beta, seedKeeper, seedProjects } from "./project-fixtures";

const journal = (id: string) =>
  join(HEARTH_HOME, "conversations", `keeper-${id}.json`);
const forwarded = async (route: Route) =>
  route.fetch({
    headers: {
      ...(await route.request().allHeaders()),
      Origin: new URL(route.request().url()).origin,
      "Sec-Fetch-Site": "same-origin",
    },
  });
function state(): ConversationState {
  try {
    return JSON.parse(readFileSync(journal(alpha.id), "utf8"));
  } catch {
    throw new Error("Private fixture journal is unavailable");
  }
}
const starts = () =>
  existsSync(join(HEARTH_HOME, "keeper-fixture-starts.jsonl"))
    ? readFileSync(join(HEARTH_HOME, "keeper-fixture-starts.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean).length
    : 0;
function record(): { argv: string[]; input: { message: string } } {
  try {
    const found = JSON.parse(
      readFileSync(join(HEARTH_HOME, "keeper-fixture-record.json"), "utf8"),
    );
    return { argv: found.args, input: JSON.parse(found.prompt) };
  } catch {
    throw new Error("Fake CLI recording is unavailable");
  }
}
test.beforeEach(() => {
  seedProjects();
  writeFileSync(
    join(HEARTH_HOME, "keeper-fixture-mode.json"),
    JSON.stringify("normal"),
  );
  for (const project of [alpha, beta])
    rmSync(journal(project.id), { force: true });
  seedKeeper([
    { kind: "text", text: "Keep this completed private conversation." },
    {
      kind: "context",
      used: 90,
      capacity: 100,
      basis: "reported",
      source: "Recorded test occupancy",
      asOf: "2026-10-22T12:00:00.000Z",
    },
  ]);
});
test.afterEach(async () => {
  await expect
    .poll(() =>
      state().turns.some((turn) =>
        ["accepted", "running", "cancelling"].includes(turn.phase),
      ),
    )
    .toBe(false);
});

test("a signed-out Keeper switches only on explicit confirmation, reconciles a lost answer, and shares selection with the drawer", async ({
  page,
}) => {
  const before = state(),
    beforeStarts = starts();
  let writes = 0;
  await page.route(
    "**/__agent-forge/projects/*/keeper/recovery*",
    async (route) => {
      const response = await forwarded(route);
      const body = (await response.json()) as {
        ok: boolean;
        data: KeeperRecoveryPage;
      };
      if (body.ok)
        for (const choice of body.data.choices)
          if (choice.smith.name === "claude-journeyman")
            choice.readiness = {
              ...choice.readiness,
              connection: "signed-out",
              canStart: false,
              reason:
                "This provider reports that it is signed out. Sign in through its CLI or choose another smith.",
            };
      await route.fulfill({ response, json: body });
    },
  );
  await page.route("**/keeper/continuations", async (route) => {
    writes++;
    await forwarded(route);
    await route.abort("failed");
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1100, height: 700 });
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/keeper`);
  await expect(
    page.getByText("Provider signed out", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Message the Keeper" })
    .fill("This draft survives the switch");
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled();
  expect(starts()).toBe(beforeStarts);
  await page.screenshot({
    path: "apps/desktop/docs/screenshots/keeper-recovery.png",
  });
  await page.getByRole("button", { name: "Review Start fresh" }).click();
  await page
    .getByRole("combobox", { name: "Keeper smith" })
    .selectOption("claude-master");
  await page.getByRole("combobox", { name: "Keeper smith" }).focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Use selected smith" }),
  ).toBeFocused();
  expect(
    await page
      .getByRole("button", { name: "Use selected smith" })
      .evaluate((node) => getComputedStyle(node).outlineWidth),
  ).toBe("2px");
  await page.keyboard.press("Enter");
  await expect(
    page.getByText(
      "Smith changed. The same provider conversation and saved history are retained. No turn was started.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(writes).toBe(1);
  expect(starts()).toBe(beforeStarts);
  expect(state().binding).toEqual(before.binding);
  expect(state().frames).toEqual(before.frames);
  await expect(
    page.getByRole("textbox", { name: "Message the Keeper" }),
  ).toHaveValue("This draft survives the switch");
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Control+j");
  const drawer = page.getByRole("dialog");
  await expect(
    drawer.getByRole("button", { name: "claude-master", exact: true }),
  ).toBeVisible();
  await expect(
    drawer.getByRole("textbox", { name: "Message the Keeper" }),
  ).toHaveValue("This draft survives the switch");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => state().turns.length).toBe(before.turns.length + 1);
  await expect.poll(() => state().turns.at(-1)?.phase).toBe("completed");
  expect(record().argv).toContain(before.binding?.sessionId);
  expect(record().argv).toContain("claude-opus-5-5");
  expect(starts()).toBe(beforeStarts + 1);
});

test("Start fresh retains exactly the reviewed summary and old history, then starts a new native conversation on the next explicit Send", async ({
  page,
}) => {
  const before = state(),
    beforeStarts = starts();
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/keeper`);
  await expect(page.locator(".af-keeper-context")).toBeVisible();
  await page.getByRole("button", { name: "Review Start fresh" }).click();
  const summary =
    "  Operator-reviewed summary: keep the agreed scope. <img src=x onerror=alert(1)>\n";
  await page
    .getByRole("textbox", {
      name: "Retained summary (review before continuing)",
    })
    .fill(summary);
  await page
    .getByRole("button", { name: "Start fresh with reviewed summary" })
    .click();
  await expect(
    page.getByText(
      "New provider conversation prepared. The reviewed summary and saved history are retained. No turn was started.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(starts()).toBe(beforeStarts);
  expect(state().binding).toBeNull();
  expect(state().frames).toEqual(before.frames);
  expect(state().keeperRecovery?.continuation.summary).toBe(summary);
  await expect(page.locator(".af-keeper-context")).toBeVisible();
  await page
    .getByRole("textbox", { name: "Message the Keeper" })
    .fill("Continue with the retained context");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => state().turns.length).toBe(before.turns.length + 1);
  await expect.poll(() => state().turns.at(-1)?.phase).toBe("completed");
  expect(record().argv).not.toContain("--resume");
  expect(record().input.message).toContain(summary);
  expect(state().binding?.sessionId).not.toBe(before.binding?.sessionId);
  expect(starts()).toBe(beforeStarts + 1);
  await page
    .getByRole("textbox", { name: "Message the Keeper" })
    .fill("Next turn");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => starts()).toBe(beforeStarts + 2);
  await expect.poll(() => state().turns.at(-1)?.phase).toBe("completed");
  expect(record().argv).toContain("--resume");
  expect(record().input.message).toBe("Next turn");
  expect(state().frames.slice(0, before.frames.length)).toEqual(before.frames);
});

test("rechecking readiness keeps keyboard focus and prevents duplicate reads while the answer is held", async ({
  page,
}) => {
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/keeper`);
  const recheck = page.getByRole("button", {
    name: "Recheck readiness",
    exact: true,
  });
  await expect(recheck).toBeEnabled();
  let checks = 0,
    release: (() => void) | undefined,
    began: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  await page.route(
    "**/__agent-forge/projects/*/keeper/recovery*",
    async (route) => {
      checks++;
      began?.();
      await held;
      const response = await forwarded(route);
      await route.fulfill({ response });
    },
  );
  try {
    await recheck.focus();
    await page.keyboard.press("Enter");
    await started;
    await expect(recheck).toBeFocused();
    await expect(recheck).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    expect(checks).toBe(1);
    release?.();
    await expect(recheck).toHaveAttribute("aria-disabled", "false");
    await expect(recheck).toBeFocused();
    expect(
      await recheck.evaluate((node) => getComputedStyle(node).outlineWidth),
    ).toBe("2px");
  } finally {
    release?.();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("exhaustion, missing Keeper adapter and unavailable reporting have distinct truthful copy and actions", async ({
  page,
}) => {
  const beforeStarts = starts();
  for (const condition of [
    "exhausted",
    "adapter-missing",
    "unreported",
  ] as const) {
    await page.unroute("**/__agent-forge/projects/*/keeper/recovery*");
    await page.route(
      "**/__agent-forge/projects/*/keeper/recovery*",
      async (route) => {
        const response = await forwarded(route),
          body = (await response.json()) as {
            ok: boolean;
            data: KeeperRecoveryPage;
          };
        if (body.ok)
          for (const choice of body.data.choices)
            if (choice.smith.name === body.data.selectedSmith)
              choice.readiness = {
                ...choice.readiness,
                connection:
                  condition === "adapter-missing"
                    ? "adapter-missing"
                    : "unknown",
                allowance:
                  condition === "exhausted" ? "exhausted" : "unreported",
                canStart: condition === "unreported",
                reason:
                  condition === "exhausted"
                    ? "Provider reports allowance exhausted; wait for reset or choose another smith."
                    : condition === "adapter-missing"
                      ? "No sealed read-only Keeper adapter is available."
                      : "Provider reporting is unavailable. No exhaustion is inferred; the checked adapter can run.",
              };
        await route.fulfill({ response, json: body });
      },
    );
    await openSettled(page, `/index.html#/desktop/project/${alpha.id}/keeper`);
    await page
      .getByRole("textbox", { name: "Message the Keeper" })
      .fill("Do not send automatically");
    await expect(
      page.getByText(
        condition === "exhausted"
          ? "Provider allowance exhausted"
          : condition === "adapter-missing"
            ? "Keeper adapter missing"
            : "Provider reporting unavailable",
        { exact: true },
      ),
    ).toBeVisible();
    if (condition === "unreported")
      await expect(
        page.getByRole("button", { name: "Send", exact: true }),
      ).toBeEnabled();
    else
      await expect(
        page.getByRole("button", { name: "Send", exact: true }),
      ).toBeDisabled();
    expect(starts()).toBe(beforeStarts);
    await page.goto("about:blank");
  }
});

test("Overview explains why its brief Refresh is unavailable and links to Keeper recovery", async ({
  page,
}) => {
  const reason =
    "The selected Keeper CLI is unavailable. Check its installation before asking for a brief.";
  await page.route(
    "**/__agent-forge/projects/*/keeper/recovery*",
    async (route) => {
      const response = await forwarded(route);
      const body = (await response.json()) as {
        ok: boolean;
        data: KeeperRecoveryPage;
      };
      if (body.ok)
        for (const choice of body.data.choices) {
          if (choice.smith.name === body.data.selectedSmith)
            choice.readiness = { ...choice.readiness, canStart: false, reason };
        }
      await route.fulfill({ response, json: body });
    },
  );
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/overview`);
  const brief = page.getByRole("region", { name: "Keeper brief", exact: true });
  await expect(
    brief.getByRole("button", { name: "Refresh brief", exact: true }),
  ).toBeDisabled();
  await expect(brief.getByText(reason, { exact: false })).toBeVisible();
  await brief.getByRole("link", { name: "Review Keeper readiness" }).click();
  await expect(page).toHaveURL(new RegExp(`/project/${alpha.id}/keeper$`));
  expect(state().turns).toHaveLength(1);
});
