import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { keeperShiftStartHashes } from "../../scripts/keeper/shift-start-protocol";
import { keeperShiftStartRequestSchema } from "../../scripts/keeper/shift-start-wire";
import type { KeeperProposal } from "../../types/keeper-proposal";
import type { KeeperShiftStartRequest } from "../../types/keeper-shift-start";
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

test("recorded Shift cards reopen the saved original after reload from Keeper and the drawer", async ({
  page,
}) => {
  const requestId = "913c01ee-e854-4d0e-8d6c-a246304d74a1";
  const sourcePage: { proposal: KeeperProposal | null; revision: number } = {
    proposal: null,
    revision: 0,
  };
  let phase: "approved" | "unknown" | "failed" | "done" = "done";
  const proposalPath = `**/projects/${alpha.id}/keeper/proposals?*`;
  await page.route(proposalPath, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const card = body.data?.proposals?.find(
      (item: { proposal?: { draft?: { action?: { kind?: string } } } }) =>
        item.proposal?.draft?.action?.kind === "start-shift",
    );
    if (card) {
      sourcePage.proposal = card.proposal;
      sourcePage.revision = body.data.revision;
      const original = {
        sourceHash: card.proposal.sourceHash,
        expectedRevision: body.data.revision,
        start: {
          requestId,
          expectedCatalogRevision: 7,
          options: {
            for: "45m",
            concurrency: 3,
            maxBeads: 8,
            maxUsd: 12,
            repairs: 2,
            base: "main",
          },
        },
      };
      const bounds = card.proposal.draft.action;
      if (bounds.kind !== "start-shift")
        throw new Error("Expected Shift proposal");
      const hashes = keeperShiftStartHashes(
        alpha.id,
        card.proposal.id,
        workspace,
        {
          durationMinutes: bounds.durationMinutes,
          concurrency: bounds.concurrency,
          beadLimit: bounds.beadLimit,
          spendLimitUsd: bounds.spendLimitUsd,
        },
        original,
      );
      card.record = {
        ...card.proposal,
        requestId,
        requestHash: hashes.reviewHash,
        operation: "approve",
        auditEventId: 1,
        phase,
        pending: false,
        updatedAt: new Date().toISOString(),
        message: `Fixture original is ${phase}.`,
        objects: [],
      };
    }
    await route.fulfill({ response, json: body });
  });
  await page.route(`**/projects/${alpha.id}/shifts/options`, async (route) => {
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
  const protectedReads: string[] = [];
  const starts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST") starts.push(request.url());
  });
  await page.route(
    `**/__agent-forge/projects/${alpha.id}/keeper/proposals/*/shift-start/*`,
    async (route) => {
      protectedReads.push(route.request().url());
      const proposal = sourcePage.proposal;
      if (!proposal) throw new Error("Missing Keeper proposal source");
      const action = proposal.draft.action;
      if (action.kind !== "start-shift")
        throw new Error("Expected Shift proposal");
      const original = {
        sourceHash: proposal.sourceHash,
        expectedRevision: sourcePage.revision,
        start: {
          requestId,
          expectedCatalogRevision: 7,
          options: {
            for: "45m",
            concurrency: 3,
            maxBeads: 8,
            maxUsd: 12,
            repairs: 2,
            base: "main",
          },
        },
      };
      const hashes = keeperShiftStartHashes(
        alpha.id,
        proposal.id,
        workspace,
        {
          durationMinutes: action.durationMinutes,
          concurrency: action.concurrency,
          beadLimit: action.beadLimit,
          spendLimitUsd: action.spendLimitUsd,
        },
        original,
      );
      const record = {
        ...proposal,
        requestId,
        requestHash: hashes.reviewHash,
        operation: "approve",
        auditEventId: 1,
        phase,
        pending: false,
        updatedAt: new Date().toISOString(),
        message: `Fixture original is ${phase}.`,
        objects: [],
      };
      await route.fulfill({
        json: {
          ok: true,
          data: {
            projectId: alpha.id,
            proposalId: proposal.id,
            revision: sourcePage.revision,
            record,
            workspace,
            original,
            startHash: hashes.startHash,
            shift: null,
          },
          error: null,
        },
      });
    },
  );

  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/keeper`);
  await expect(
    page.getByRole("article", { name: "Review a bounded Shift", exact: true }),
  ).toContainText("Fixture original is done.");
  expect(sourcePage.proposal).not.toBeNull();

  for (const nextPhase of ["approved", "unknown", "failed", "done"] as const) {
    phase = nextPhase;
    await page.reload();
    await expect(
      page.getByRole("article", {
        name: "Review a bounded Shift",
        exact: true,
      }),
    ).toContainText(`Fixture original is ${nextPhase}.`);
    const reopen = page.getByRole("button", {
      name: "Review original Start",
      exact: true,
    });
    await expect(reopen).toBeVisible();
    await reopen.click();
    let dialog = page.getByRole("dialog", {
      name: "Review Keeper Shift",
      exact: true,
    });
    await expect(dialog).toContainText("Exact original");
    await expect(dialog).toContainText(requestId);
    await expect
      .poll(() => protectedReads.length)
      .toBe(
        nextPhase === "approved"
          ? 1
          : nextPhase === "unknown"
            ? 3
            : nextPhase === "failed"
              ? 5
              : 7,
      );
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

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
    await expect(drawerCard).toContainText(`Fixture original is ${nextPhase}.`);
    await drawerCard
      .getByRole("button", { name: "Review original Start", exact: true })
      .click();
    dialog = page.getByRole("dialog", {
      name: "Review Keeper Shift",
      exact: true,
    });
    await expect(dialog).toContainText("Exact original");
    await expect(dialog).toContainText(requestId);
    await expect
      .poll(() => protectedReads.length)
      .toBe(
        nextPhase === "approved"
          ? 2
          : nextPhase === "unknown"
            ? 4
            : nextPhase === "failed"
              ? 6
              : 8,
      );
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await drawer
      .getByRole("link", { name: "Open full conversation", exact: true })
      .click();
  }
  expect(protectedReads).toHaveLength(8);
  expect(
    protectedReads.every((url) => url.includes(encodeURIComponent(requestId))),
  ).toBe(true);
  expect(starts).toEqual([]);
});
