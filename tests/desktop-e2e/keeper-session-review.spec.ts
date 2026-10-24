import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openSettled } from "../e2e/fixtures";
import { HEARTH_HOME } from "../e2e/servers";
import {
  alpha,
  beta,
  seedKeeper,
  seedProjects,
  workspace,
} from "./project-fixtures";

const count = (file: string) =>
  existsSync(join(HEARTH_HOME, file))
    ? readFileSync(join(HEARTH_HOME, file), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean).length
    : 0;
test.beforeEach(() => {
  seedProjects();
  for (const project of [alpha, beta])
    rmSync(join(HEARTH_HOME, "conversations", `keeper-${project.id}.json`), {
      force: true,
    });
  writeFileSync(
    join(HEARTH_HOME, "coding-fixture-mode.json"),
    JSON.stringify("normal"),
  );
  seedKeeper([
    {
      kind: "text",
      text: JSON.stringify({
        kind: "keeper.proposals.v1",
        message: "Review this session before starting.",
        proposals: [
          {
            title: "Review the scoped session",
            detail: "An inert source proposal for the shared composer.",
            action: {
              kind: "start-session",
              provider: "claude",
              smith: "claude-journeyman",
              beadId: "alpha-epic",
              repository: workspace,
              worktree: "new",
              prompt: "Investigate the proposed bead",
            },
          },
        ],
      }),
    },
  ]);
});

test("Keeper review opens the shared composer; edits, Cancel, drawer navigation and keyboard focus cause no approval, Start or Git action", async ({
  page,
}) => {
  const before = count("coding-fixture-starts.jsonl"),
    writes: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/sessions(?:\/|$)|\/session-worktrees|\/keeper\/proposals\//.test(
        new URL(request.url()).pathname,
      )
    )
      writes.push(request.url());
  });
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/keeper`);
  const card = page.getByRole("article", {
    name: "Review the scoped session",
    exact: true,
  });
  const opener = card.getByRole("button", {
    name: "Review & start",
    exact: true,
  });
  await expect(opener).toBeEnabled();
  await expect(
    card.getByRole("button", { name: "Approve", exact: true }),
  ).toHaveCount(0);
  await opener.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", {
    name: "Review Keeper session · Alpha",
    exact: true,
  });
  const prompt = dialog.getByRole("textbox", {
    name: "Session prompt",
    exact: true,
  });
  await expect(prompt).toHaveValue("Investigate the proposed bead");
  await expect(prompt).toBeEditable();
  await expect(
    dialog.getByRole("button", { name: /^Cx · Codex/ }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: /^Gm · Gemini/ }),
  ).toBeDisabled();
  await expect(
    dialog.getByText("Keeper session reviews support Claude here.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("combobox", { name: "Where the session runs" }),
  ).toHaveValue("new");
  await expect(
    dialog.getByRole("combobox", { name: "Session smith" }),
  ).toHaveValue("claude-journeyman");
  await prompt.fill("Keep my separate reviewed draft");
  await dialog
    .getByRole("combobox", { name: "Session mode" })
    .selectOption("chat");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(opener).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(opener).toBeFocused();
  expect(
    await opener.evaluate((element) => ({
      width: getComputedStyle(element).outlineWidth,
      style: getComputedStyle(element).outlineStyle,
    })),
  ).toEqual({ width: "2px", style: "solid" });
  await page
    .getByRole("link", { name: "Overview", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "Ask Keeper", exact: true }).click();
  const drawer = page.getByRole("dialog", {
    name: "Forge Keeper · Alpha",
    exact: true,
  });
  await drawer
    .getByRole("button", { name: "Review & start", exact: true })
    .click();
  await expect(prompt).toHaveValue("Keep my separate reviewed draft");
  await expect(
    dialog.getByRole("combobox", { name: "Session mode" }),
  ).toHaveValue("chat");
  await page.keyboard.press("Escape");
  await expect(drawer).toBeVisible();
  await expect(
    drawer.getByRole("button", { name: "Review & start", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "New session", exact: true }).click();
  const ordinary = page.getByRole("dialog", {
    name: "New session · Alpha",
    exact: true,
  });
  await expect(
    ordinary.getByRole("button", { name: /^Cx · Codex/ }),
  ).toBeEnabled();
  await expect(
    ordinary.getByRole("button", { name: /^Gm · Gemini/ }),
  ).toBeEnabled();
  await expect(
    ordinary.getByRole("textbox", { name: "Session prompt", exact: true }),
  ).toHaveValue("");
  await ordinary.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(writes).toEqual([]);
  expect(count("coding-fixture-starts.jsonl")).toBe(before);
  if (process.env["SHOT_DIR"]) {
    // Capture only after the actual compact-viewport behavior and no-write facts.
    await page.getByRole("button", { name: "Ask Keeper", exact: true }).click();
    await drawer
      .getByRole("button", { name: "Review & start", exact: true })
      .click();
    await expect(prompt).toHaveValue("Keep my separate reviewed draft");
    mkdirSync(process.env["SHOT_DIR"], { recursive: true });
    await page.setViewportSize({ width: 1280, height: 1400 });
    try {
      await dialog.screenshot({
        path: join(process.env["SHOT_DIR"], "keeper-session-review.png"),
        animations: "disabled",
        mask: [dialog.getByRole("combobox", { name: "Session repository" })],
        maskColor: "#3f424d",
      });
    } finally {
      await page.setViewportSize({ width: 1100, height: 700 });
    }
  }
});
