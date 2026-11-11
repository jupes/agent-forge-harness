import { expect, type Page, test } from "@playwright/test";
import type {
  LedgerCompactionRequest,
  LedgerCompactionStatus,
} from "../../scripts/desktop/ledger-compaction-protocol";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import { seedProjects } from "./project-fixtures";

test.beforeEach(seedProjects);
const ready: LedgerCompactionStatus = {
  canCompact: true,
  checkedAt: "2026-11-10T12:00:00Z",
  record: { version: 1, revision: 0, ledgerKey: "d".repeat(64), last: null },
};
const panel = (page: Page) =>
  page.getByRole("region", { name: "Ledger compaction", exact: true });
const completed = (requestId: string): LedgerCompactionStatus => ({
  ...ready,
  record: {
    ...ready.record,
    revision: 1,
    last: {
      requestId,
      state: "completed",
      startedAt: ready.checkedAt,
      cutoffAt: "2026-08-12T12:00:00Z",
      events: 3,
      days: 1,
    },
  },
});
const json = (data: LedgerCompactionStatus) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ ok: true, data, error: null }),
});

test("machine-wide compaction needs a fresh acknowledgement, supports keyboard cancel, and sends one reviewed request while pending", async ({
  page,
}) => {
  let posts = 0,
    release = () => {};
  const held = new Promise<void>((done) => {
    release = done;
  });
  await page.route("**/__agent-forge/app-settings/ledger/compaction", (route) =>
    route.fulfill(json(ready)),
  );
  await page.route(
    "**/__agent-forge/app-settings/ledger/compact",
    async (route) => {
      posts++;
      const request = route.request().postDataJSON() as LedgerCompactionRequest;
      expect(request).toMatchObject({
        expectedLedgerKey: ready.record.ledgerKey,
        expectedRevision: 0,
        acknowledge90Days: true,
      });
      await held;
      await route.fulfill(json(completed(request.requestId)));
    },
  );
  try {
    await openSettled(page, "/#/desktop/app-settings");
    const region = panel(page),
      ack = region.getByRole("checkbox"),
      submit = region.getByRole("button", {
        name: "Compact older events",
        exact: true,
      });
    await expect(
      region.getByText("Compaction status read.", { exact: true }),
    ).toBeVisible();
    await expect(submit).toBeDisabled();
    expect(posts).toBe(0);
    await ack.focus();
    await expect(ack).toBeFocused();
    expect(await ack.evaluate((el) => getComputedStyle(el).outlineWidth)).toBe(
      "2px",
    );
    await page.keyboard.press("Space");
    await expect(submit).toBeEnabled();
    await region
      .getByRole("button", { name: "Cancel review", exact: true })
      .click();
    await expect(ack).not.toBeChecked();
    await expect(submit).toBeDisabled();
    expect(posts).toBe(0);
    await ack.focus();
    await page.keyboard.press("Space");
    await submit.focus();
    await page.keyboard.press("Enter");
    await expect(submit).toBeDisabled();
    await expect(ack).toBeDisabled();
    await expect.poll(() => posts).toBe(1);
    release();
    await expect(
      region.getByText("Confirmed: 3 events from 1 day compacted", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(ack).not.toBeChecked();
    await expect(submit).toBeDisabled();
    await page.setViewportSize({ width: 1100, height: 700 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(posts).toBe(1);
  } finally {
    release();
  }
});

test("a lost compaction response survives reload and cannot replay until its exact completed receipt is read", async ({
  page,
}) => {
  let posts = 0,
    operation: string | null = null,
    snapshot = ready;
  await page.route("**/__agent-forge/app-settings/ledger/compaction", (route) =>
    route.fulfill(json(snapshot)),
  );
  await page.route(
    "**/__agent-forge/app-settings/ledger/compact",
    async (route) => {
      posts++;
      operation = (route.request().postDataJSON() as LedgerCompactionRequest)
        .requestId;
      await route.abort("failed");
    },
  );
  await openSettled(page, "/#/desktop/app-settings");
  const region = panel(page),
    ack = region.getByRole("checkbox"),
    submit = region.getByRole("button", {
      name: "Compact older events",
      exact: true,
    });
  await expect(ack).toBeEnabled();
  await ack.check();
  await submit.click();
  await expect(
    region.getByText("Compaction outcome is unknown.", { exact: false }),
  ).toBeVisible();
  await reloadSettled(page);
  await expect(
    region.getByText("Compaction outcome is unknown.", { exact: false }),
  ).toBeVisible();
  await expect(submit).toBeDisabled();
  await expect(ack).toBeDisabled();
  expect(posts).toBe(1);
  if (!operation) throw Error("Expected one captured operation");
  snapshot = completed(operation);
  await region
    .getByRole("button", { name: "Check compaction status", exact: true })
    .click();
  await expect(
    region.getByText("Confirmed: 3 events from 1 day compacted", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(ack).toBeEnabled();
  await expect(ack).not.toBeChecked();
  await expect(submit).toBeDisabled();
  expect(posts).toBe(1);
});
