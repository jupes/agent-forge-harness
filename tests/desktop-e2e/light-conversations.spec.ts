import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { OPERATOR_HEADER } from "../../scripts/hearth/paths";
import { ownedCodingStateSchema } from "../../scripts/sessions/codex-owned-journal";
import { ownedCodingSessionSchema } from "../../scripts/sessions/codex-owned-wire-protocol";
import { openSettled } from "../e2e/fixtures";
import { pageToken } from "../e2e/launch-link";
import { HEARTH_HOME } from "../e2e/servers";
import { alpha, seedKeeper, seedProjects } from "./project-fixtures";

function records() {
  const path = join(HEARTH_HOME, "sessions", "registry.json");
  if (!existsSync(path)) return [];
  try {
    return ownedCodingSessionSchema
      .array()
      .parse(JSON.parse(readFileSync(path, "utf8")).records);
  } catch {
    throw Error("The isolated session registry is unreadable.");
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
    throw Error("The isolated owned conversation is unreadable.");
  }
}
async function appearance(page: Page, theme: string) {
  await openSettled(page, "/#/desktop/app-settings");
  const select = page.getByLabel("Theme", { exact: true });
  await expect(select).toBeEnabled();
  await select.selectOption(theme);
  const save = page.getByRole("button", {
    name: "Save appearance",
    exact: true,
  });
  if (await save.isEnabled()) {
    await save.click();
    await expect(save).toBeDisabled();
    await expect(select).toBeEnabled();
  }
  await expect(select).toHaveValue(theme);
}
async function contrast(element: Locator, focus = false) {
  await expect(element).toBeVisible();
  const value = await element.evaluate((el, focused) => {
    const parse = (value: string) => {
      const c = (value.match(/[\d.]+/g) ?? []).map(Number);
      return [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, c[3] ?? 1];
    };
    const blend = (front: number[], back: number[]) =>
      front
        .slice(0, 3)
        .map((c, i) => c * front[3]! + back[i]! * (1 - front[3]!));
    const ancestors: Element[] = [];
    for (let node: Element | null = el; node; node = node.parentElement)
      ancestors.unshift(node);
    let background = [255, 255, 255];
    for (const node of ancestors) {
      if (focused && node === el) break;
      const style = getComputedStyle(node);
      if (style.backgroundImage !== "none" || Number(style.opacity) !== 1)
        throw Error(
          "Contrast measurement needs an opaque, unfiltered surface.",
        );
      background = blend(parse(style.backgroundColor), background);
    }
    const style = getComputedStyle(el);
    const foreground = blend(
      parse(focused ? style.outlineColor : style.color),
      background,
    );
    const luminance = (rgb: number[]) => {
      const c = rgb.map((v) => {
        const n = v / 255;
        return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    };
    const a = luminance(foreground),
      b = luminance(background);
    return {
      ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
      foreground,
      background,
    };
  }, focus);
  expect(value.ratio, JSON.stringify(value)).toBeGreaterThanOrEqual(
    focus ? 3 : 4.5,
  );
}
async function keyboardFocus(page: Page, target: Locator) {
  await page.keyboard.press("Tab");
  await target.focus();
  await expect(target).toBeFocused();
  expect(await target.evaluate((el) => el.matches(":focus-visible"))).toBe(
    true,
  );
  await expect(target).toHaveCSS("outline-width", "2px");
  await contrast(target, true);
}
async function fits(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}
async function screenshot(page: Page, path: string) {
  await page.screenshot({
    path: `test-results/light-conversations/${path}.png`,
    mask: [
      page.locator(".af-owned-session-header p, .af-session-report-source"),
    ],
  });
}

test("saved Light conversation text, file reports and inert diffs remain readable and keyboard operable", async ({
  page,
}) => {
  const modePath = join(HEARTH_HOME, "codex-chat-fixture-mode.json");
  const priorMode = existsSync(modePath) ? readFileSync(modePath) : null;
  const previous = new Set(records().map((record) => record.id));
  let originalTheme: string | null = null;
  let startSent = false;
  let stopToken: string | null = null;
  let owned: { id: string; projectId: string; requestId: string } | null = null;
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST")
      posts.push(new URL(request.url()).pathname);
  });
  const exercise = async () => {
    seedProjects();
    seedKeeper([
      {
        kind: "text",
        text: "### Recorded Keeper reply\n\n| Bead | Status |\n| --- | --- |\n| `alpha-epic` | Open |\n\n```sh\nprintf 'recorded display only'\n```\n\n[Project reference](https://example.invalid/)",
      },
    ]);
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
    await openSettled(page, "/#/desktop/app-settings");
    await expect(page.getByLabel("Theme", { exact: true })).toBeEnabled();
    originalTheme = await page
      .getByLabel("Theme", { exact: true })
      .inputValue();
    await appearance(page, "light");
    await openSettled(page, "/#/desktop");
    await expect(page.locator("html")).toHaveAttribute(
      "data-af-theme",
      "light",
    );
    await contrast(page.locator(".af-project-card h2 a").first());
    await fits(page);
    await screenshot(page, "projects-light-1100");
    await openSettled(page, `/#/desktop/project/${alpha.id}/keeper`);
    const reply = page.getByRole("article", {
      name: "Keeper reply",
      exact: true,
    });
    await expect(reply.locator("table")).toContainText("alpha-epic");
    for (const selector of ["h3", "td", "code", "a"])
      await contrast(reply.locator(selector).first());
    await keyboardFocus(
      page,
      reply.getByRole("link", { name: "Project reference" }),
    );
    await fits(page);
    await page.setViewportSize({ width: 1100, height: 1200 });
    await reply.screenshot({
      path: "test-results/light-conversations/keeper-reply-light.png",
    });
    await page.setViewportSize({ width: 1100, height: 700 });
    expect(posts.filter((path) => path.endsWith("/messages"))).toHaveLength(0);
    writeFileSync(modePath, JSON.stringify("file-changes"));
    await openSettled(page, `/#/desktop/project/${alpha.id}/sessions`);
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
    await dialog
      .getByRole("combobox", { name: "Session effort", exact: true })
      .selectOption("");
    await dialog
      .getByRole("textbox", { name: "Session prompt", exact: true })
      .fill("Recorded light surface qualification");
    await dialog
      .getByRole("button", { name: "Check supported options", exact: true })
      .click();
    const start = dialog.getByRole("button", { name: "Start", exact: true });
    await expect(start).toBeEnabled();
    stopToken = await pageToken(page);
    startSent = true;
    await start.click();
    await expect
      .poll(() => records().filter((record) => !previous.has(record.id)).length)
      .toBe(1);
    const record = records().find((record) => !previous.has(record.id));
    if (!record || record.projectId !== alpha.id || record.provider !== "codex")
      throw Error("The exact isolated Codex Start was not identified.");
    owned = {
      id: record.id,
      projectId: record.projectId,
      requestId: record.requestId,
    };
    const pane = page.getByRole("region", {
      name: "Session conversation",
      exact: true,
    });
    await expect(pane).toBeVisible();
    await expect
      .poll(
        () => {
          try {
            const turns = journal(record.id).turns;
            return (
              turns.length === 1 &&
              turns[0]?.requestId === record.requestId &&
              turns[0].phase === "completed"
            );
          } catch {
            return false;
          }
        },
        { timeout: 5000 },
      )
      .toBe(true);
    const turns = journal(record.id).turns;
    expect(turns).toHaveLength(1);
    expect(turns[0]?.requestId).toBe(owned.requestId);
    await expect(page.locator("html")).toHaveAttribute(
      "data-af-theme",
      "light",
    );
    await contrast(pane.locator(".af-owned-question p"));
    await contrast(
      pane.locator(".af-owned-reply .af-keeper-markdown p").first(),
    );
    const activity = pane.getByRole("region", {
      name: "Reported session activity",
      exact: true,
    });
    const report = activity
      .locator("details")
      .filter({ hasText: "Item: reported-files-a" });
    const summary = report.locator("summary");
    await expect(summary).toHaveText("File changes · Reported completed");
    await contrast(summary);
    await keyboardFocus(page, summary);
    expect(
      await summary.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.width >= 24 && r.height >= 24;
      }),
    ).toBe(true);
    await page.keyboard.press("Enter");
    await expect(report).toHaveAttribute("open", "");
    await contrast(report.locator(".af-session-report-label"));
    await contrast(report.locator("code").first());
    const diff = report.getByRole("region", {
      name: "Reported native diff",
      exact: true,
    });
    await expect(diff).toHaveText(
      "-old native line\n+<script>native patch stays text</script>",
    );
    await contrast(diff);
    await page.keyboard.press("Tab");
    await expect(diff).toBeFocused();
    await expect(diff).toHaveCSS("outline-width", "2px");
    await contrast(diff, true);
    await expect(activity.locator("button, a, script, iframe")).toHaveCount(0);
    await expect(
      pane.getByRole("button", { name: "Allow once", exact: true }),
    ).toHaveCount(0);
    await fits(page);
    await page.setViewportSize({ width: 1100, height: 1200 });
    await report.screenshot({
      path: "test-results/light-conversations/session-file-report-light.png",
      mask: [report.locator(".af-session-report-source")],
      maskColor: "#f3f5fe",
    });
    expect(
      posts.filter(
        (path) => path === `/__agent-forge/projects/${alpha.id}/sessions`,
      ),
    ).toHaveLength(1);
  };
  const cleanup = async () => {
    if (startSent) {
      const created = records().filter((record) => !previous.has(record.id));
      if (
        created.length !== 1 ||
        created[0]?.projectId !== alpha.id ||
        created[0]?.provider !== "codex"
      )
        throw Error("Cleanup cannot identify the original isolated Start.");
      const record = created[0],
        turns = journal(record.id).turns;
      if (turns.length !== 1 || !turns[0])
        throw Error("Cleanup cannot identify the original turn.");
      const turn = turns[0];
      if (
        owned &&
        (record.id !== owned.id || turn.requestId !== owned.requestId)
      )
        throw Error("Cleanup identity changed.");
      if (turn.phase === "unknown")
        throw Error("The original isolated Start remains unknown.");
      if (["accepted", "running", "cancelling"].includes(turn.phase)) {
        if (!stopToken) throw Error("Original Stop token was not captured.");
        const deadline = Date.now() + 5000;
        const response = await page.evaluate(
          async ({ projectId, id, requestId, token, header }) => {
            const response = await fetch(
              `/__agent-forge/projects/${projectId}/sessions/${id}/stop`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  [header]: token,
                },
                body: JSON.stringify({ requestId }),
                signal: AbortSignal.timeout(5000),
              },
            );
            return { status: response.status, text: await response.text() };
          },
          {
            projectId: record.projectId,
            id: record.id,
            requestId: turn.requestId,
            token: stopToken,
            header: OPERATOR_HEADER,
          },
        );
        expect(response.status).toBe(200);
        let value: unknown;
        try {
          value = JSON.parse(response.text);
        } catch {
          throw Error("Original Stop response was unreadable.");
        }
        expect(value).toMatchObject({ ok: true });
        await expect
          .poll(
            () =>
              journal(record.id).turns.find(
                (item) => item.requestId === turn.requestId,
              )?.phase,
            { timeout: Math.max(1, deadline - Date.now()) },
          )
          .toBe("cancelled");
      }
    }
  };
  const restore = async () => {
    if (priorMode === null) {
      if (existsSync(modePath)) unlinkSync(modePath);
    } else writeFileSync(modePath, priorMode);
    if (originalTheme !== null && !page.isClosed())
      await appearance(page, originalTheme);
  };
  const failures: unknown[] = [];
  for (const step of [exercise, cleanup, restore]) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      "Light conversation qualification or cleanup failed.",
    );
});
