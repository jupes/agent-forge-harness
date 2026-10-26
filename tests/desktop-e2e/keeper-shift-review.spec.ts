import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { keeperProposalPageSchema } from "../../scripts/keeper/proposal-protocol";
import {
  keeperShiftStartHashes,
  keeperShiftStartReceiptSchema,
} from "../../scripts/keeper/shift-start-protocol";
import { keeperShiftStartRequestSchema } from "../../scripts/keeper/shift-start-wire";
import type { KeeperProposal } from "../../types/keeper-proposal";
import type { KeeperShiftStartRequest } from "../../types/keeper-shift-start";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import { HEARTH_HOME } from "../e2e/servers";
import { alpha, seedKeeper, seedProjects, workspace } from "./project-fixtures";

const conversation = join(
  HEARTH_HOME,
  "conversations",
  `keeper-${alpha.id}.json`,
);

async function captureMockedKeeperShiftProof(
  page: Page,
  label: string,
  fixtureIds: string[],
) {
  if (process.env["AGENT_FORGE_CAPTURE_KEEPER_SHIFT_PROOF"] !== "1") return;
  const screenshot = test.info().outputPath(`mocked-keeper-shift-${label}.png`);
  await page.screenshot({
    path: screenshot,
    fullPage: true,
    mask: [
      page.getByText(
        /(?:proposal-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      ),
      page.getByText(
        /[A-Za-z]:\\[^<>"|?*]+|\/(?:Users|home|tmp|var)\/[^<>"|?*]+/i,
      ),
      ...fixtureIds.map((id) => page.getByText(id, { exact: false })),
    ],
    maskColor: "#333333",
  });
  await test.info().attach(`Mocked Keeper Shift ${label}`, {
    path: screenshot,
    contentType: "image/png",
  });
}

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
  const sourceRequestId = "1a5832fa-7a21-403b-8184-44892f0d8d86";
  const action = {
    kind: "start-shift" as const,
    durationMinutes: 45,
    concurrency: 3,
    beadLimit: 8,
    spendLimitUsd: 12,
  };
  const proposal: KeeperProposal = {
    id: `proposal-${sourceRequestId}-0`,
    projectId: alpha.id,
    sourceRequestId,
    sourceHash: "a".repeat(64),
    createdAt: "2026-10-25T12:00:00.000Z",
    draft: {
      title: "Review a bounded Shift",
      detail: "A proposal opens the complete current Shift form.",
      action,
    },
  };
  const revision = 1;
  const original = {
    sourceHash: proposal.sourceHash,
    expectedRevision: revision,
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
    action,
    original,
  );
  const proposalRecord = {
    ...proposal,
    requestId,
    requestHash: hashes.reviewHash,
    operation: "approve" as const,
    auditEventId: 1,
    phase: "done" as const,
    pending: false,
    updatedAt: "2026-10-25T12:01:00.000Z",
    message: "Fixture original is done.",
    objects: [],
  };
  const proposalPage = keeperProposalPageSchema.parse({
    projectId: alpha.id,
    revision,
    conversationRevision: 1,
    request: null,
    asOf: "2026-10-25T12:01:00.000Z",
    complete: true,
    problems: [],
    proposals: [
      {
        proposal,
        record: proposalRecord,
        available: false,
        destinationAvailable: true,
        reason: null,
        activity: null,
      },
    ],
  });
  let phase: "approved" | "unknown" | "failed" | "done" = "done";
  const proposalPath = `**/projects/${alpha.id}/keeper/proposals?*`;
  await page.route(proposalPath, async (route) => {
    const body = keeperProposalPageSchema.parse({
      ...proposalPage,
      proposals: proposalPage.proposals.map((card) => ({
        ...card,
        record: card.record
          ? { ...card.record, phase, message: `Fixture original is ${phase}.` }
          : null,
      })),
    });
    await route.fulfill({ json: { ok: true, data: body, error: null } });
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
      const proposal = proposalPage.proposals[0]!.proposal;
      const record = {
        ...proposalRecord,
        phase,
        message: `Fixture original is ${phase}.`,
      };
      const receipt = keeperShiftStartReceiptSchema.parse({
        projectId: alpha.id,
        proposalId: proposal.id,
        revision,
        record,
        workspace,
        original,
        startHash: hashes.startHash,
        shift: null,
      });
      await route.fulfill({ json: { ok: true, data: receipt, error: null } });
    },
  );

  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/keeper`);
  await expect(
    page.getByRole("article", { name: "Review a bounded Shift", exact: true }),
  ).toContainText("Fixture original is done.");
  expect(proposalPage.proposals[0]?.proposal).toEqual(proposal);
  await captureMockedKeeperShiftProof(page, "full-keeper", [
    requestId,
    sourceRequestId,
    proposal.id,
    workspace,
  ]);

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
    if (nextPhase === "approved")
      await captureMockedKeeperShiftProof(page, "review-dialog", [
        requestId,
        sourceRequestId,
        proposal.id,
        workspace,
      ]);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

    await page
      .getByRole("link", { name: "Overview", exact: true })
      .first()
      .click();
    await reloadSettled(page);
    await page.getByRole("button", { name: "Ask Keeper", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Forge Keeper · Alpha" });
    const drawerCard = drawer.getByRole("article", {
      name: "Review a bounded Shift",
      exact: true,
    });
    await expect(drawerCard).toContainText(`Fixture original is ${nextPhase}.`);
    if (nextPhase === "approved")
      await captureMockedKeeperShiftProof(page, "drawer", [
        requestId,
        sourceRequestId,
        proposal.id,
        workspace,
      ]);
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
