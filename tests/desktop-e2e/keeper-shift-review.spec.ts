import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openSettled } from "../e2e/fixtures";
import { HEARTH_HOME } from "../e2e/servers";
import { alpha, seedKeeper, seedProjects, workspace } from "./project-fixtures";

const conversation = join(
  HEARTH_HOME,
  "conversations",
  `keeper-${alpha.id}.json`,
);

test.beforeEach(() => {
  seedProjects();
  rmSync(conversation, { force: true });
  writeFileSync(
    join(HEARTH_HOME, "coding-fixture-mode.json"),
    JSON.stringify("normal"),
  );
  seedKeeper([
    {
      kind: "text",
      text: JSON.stringify({
        kind: "keeper.proposals.v1",
        message: "Review this bounded project Shift.",
        proposals: [
          {
            title: "Review a bounded Shift",
            detail: "A proposal opens the complete current Shift form.",
            action: {
              kind: "start-shift",
              durationMinutes: 45,
              concurrency: 3,
              beadLimit: 8,
              spendLimitUsd: 12,
            },
          },
        ],
      }),
    },
  ]);
});

test("full Keeper and drawer reuse the Shift form; opening and Cancel cause no Start", async ({
  page,
}) => {
  let optionsReads = 0;
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const path = new URL(request.url()).pathname;
    if (
      /\/keeper\/proposals\/(approve|dismiss)$/.test(path) ||
      /\/keeper\/proposals\/[^/]+\/shift-start(?:\/[^/]+)?$/.test(path)
    )
      writes.push(path);
  });
  await page.route(`**/projects/${alpha.id}/shifts/options`, async (route) => {
    optionsReads += 1;
    await route.fulfill({
      json: {
        ok: true,
        data: {
          projectId: alpha.id,
          workspace,
          catalogRevision: 7,
          asOf: new Date().toISOString(),
          defaults: {
            for: { value: "20m", source: "project config" },
            concurrency: { value: 2, source: "project config" },
            maxBeads: { value: 5, source: "project config" },
            maxUsd: { value: 8, source: "project config" },
            repairs: { value: 2, source: "project config" },
            base: { value: "main", source: "project config" },
            runTimeout: { value: null, source: "Shift remaining time" },
          },
          limits: {
            durationMs: [60_000, 86_400_000],
            concurrency: [1, 8],
            maxBeads: [1, 100],
            maxUsd: 1000,
            repairs: [0, 8],
          },
          epics: [{ id: "alpha-epic", title: "Alpha epic" }],
          smiths: { names: ["claude-journeyman"], defaultSmith: null },
          availability: { start: true, reason: null },
        },
        error: null,
      },
    });
  });
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/keeper`);
  const fullCard = page.getByRole("article", {
    name: "Review a bounded Shift",
    exact: true,
  });
  await expect(
    fullCard.getByRole("button", { name: "Approve", exact: true }),
  ).toHaveCount(0);
  const fullOpen = fullCard.getByRole("button", {
    name: "Review Shift",
    exact: true,
  });
  await fullOpen.click();
  let dialog = page.getByRole("dialog", {
    name: "Review Keeper Shift",
    exact: true,
  });
  await expect(dialog.getByRole("textbox", { name: "Duration" })).toHaveValue(
    "45m",
  );
  await expect(
    dialog.getByRole("spinbutton", { name: "Concurrency" }),
  ).toHaveValue("3");
  await expect(
    dialog.getByRole("spinbutton", { name: "Maximum beads" }),
  ).toHaveValue("8");
  await expect(dialog).toContainText("project config");
  await expect(dialog).toContainText("Shift remaining time");
  await dialog.getByRole("textbox", { name: "Duration" }).fill("90m");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(fullOpen).toBeFocused();

  await page
    .getByRole("link", { name: "Overview", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "Ask Keeper", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Forge Keeper · Alpha" });
  const drawerCard = drawer.getByRole("article", {
    name: "Review a bounded Shift",
    exact: true,
  });
  const drawerOpen = drawerCard.getByRole("button", {
    name: "Review Shift",
    exact: true,
  });
  await drawerOpen.click();
  dialog = page.getByRole("dialog", {
    name: "Review Keeper Shift",
    exact: true,
  });
  await expect(dialog.getByRole("textbox", { name: "Duration" })).toHaveValue(
    "45m",
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(drawerOpen).toBeFocused();
  expect(optionsReads).toBe(2);
  expect(writes).toEqual([]);
});
