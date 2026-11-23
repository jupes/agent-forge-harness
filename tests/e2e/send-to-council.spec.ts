import { expect, type Page, test } from "@playwright/test";
import {
  BEADS,
  openSettled,
  reloadSettled,
  stubForgeRun,
  stubSnapshot,
} from "./fixtures";
import {
  createFromBuilder,
  requireStandIn,
  seedProposed,
  standInCalls,
  standInComments,
} from "./stand-in";

/**
 * Send to council (`x1gs.7.2`): the issue detail panel, each forge-run
 * checkpoint and each Workbench card link to the Council page with their
 * bead preselected. The run is convened there, on the simulated default
 * profile, through the suite's real hearth and its `bd` stand-in; when it
 * completes, the hearth posts the verdict back to the bead as one `review:`
 * comment. Each project's run creates its own bead first, through the page.
 */

const API = "/__agent-forge";

interface Stored {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
}

async function eventsOf(page: Page, bead: string): Promise<Stored[]> {
  return page.evaluate(
    async (url) => {
      const response = await fetch(url);
      const body = (await response.json()) as { data: { events: Stored[] } };
      return body.data.events;
    },
    `${API}/events?bead=${encodeURIComponent(bead)}&beadExact=1&limit=100`,
  );
}

const councilHref = (id: string): string =>
  `council.html?${new URLSearchParams({ sourceType: "bead", source: id })}`;

/** The Council page, opened from a link, with `id` preselected as its source. */
async function expectPreselected(page: Page, id: string): Promise<void> {
  await expect(page).toHaveURL(/\/council\.html\?/);
  await expect(page.locator("#council-source-type")).toHaveValue("bead");
  await expect(page.locator("#council-source")).toHaveValue(id);
}

test("Send to council from the issue detail panel: the bead is previewed and convened on the Council page with the simulated profile, and the hearth posts the verdict back as one review: comment that bd then prints with the bead", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openSettled(page, "/index.html#/bead-builder");
  await requireStandIn(page);
  const title = "Council verdict fixture";
  const id = await createFromBuilder(page, title);
  // The snapshot a rebuild from the tracker would give: it holds the bead.
  await stubSnapshot(page, {
    ...BEADS,
    issues: [
      ...BEADS.issues,
      {
        id,
        type: "task",
        title,
        status: "open",
        createdAt: "2026-10-14T00:00:00.000Z",
        updatedAt: "2026-10-14T00:00:00.000Z",
      },
    ],
  });
  await openSettled(page, "/index.html#/issues");
  await reloadSettled(page);
  await page.locator(`[data-issue-id="${id}"]`).click();
  const send = page
    .locator(".af-detail")
    .getByRole("link", { name: `Send ${id} to council` });
  await expect(send).toHaveAttribute("href", councilHref(id));
  await send.click();
  await expectPreselected(page, id);
  await expect(page.locator("#council-profile option:checked")).toHaveText(
    "Demo council (simulated, no model calls)",
  );

  // The bead is shown before it is sent, and the page says where the verdict goes.
  const preview = page.getByRole("button", { name: "Preview evidence" });
  const listing = page.getByTestId("council-preview-listing").locator("li");
  await preview.click();
  await expect(listing).toHaveText([
    /^E1 acceptance criteria: \d+ bytes$/,
    "latest comments: none",
    "description: none",
  ]);
  await expect(page.locator(".af-evidence-preview")).toContainText(
    `When the run completes, its verdict is posted to ${id} as a review: comment`,
  );

  const started = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`${API}/council-api/runs`),
  );
  await page.getByRole("button", { name: "Convene council" }).click();
  const answer = await started;
  expect(answer.status()).toBe(202);
  const runId =
    ((await answer.json()) as { data: { runId: string } }).data.runId ?? "";
  expect(runId).not.toBe("");
  // The page follows the run to its end, as it does any run.
  await expect(page.locator(".council-report .pill").first()).toHaveText(
    "completed",
    { timeout: 60_000 },
  );

  // One comment write, every value after `--`, carrying the run's verdict.
  const verdicts = (): string[][] =>
    standInCalls().filter(
      (call) => call[0] === "comments" && call[1] === "add" && call[4] === id,
    );
  await expect.poll(() => verdicts().length, { timeout: 30_000 }).toBe(1);
  const [call] = verdicts();
  expect(call?.slice(0, 5)).toEqual(["comments", "add", "--json", "--", id]);
  const text = call?.[5] ?? "";
  expect(text).toMatch(
    new RegExp(
      `^review: COUNCIL ${runId} (PASS|FAIL|UNREADABLE) — findings \\d+/\\d+/\\d+/\\d+ \\(blocker/high/medium/low\\)$`,
    ),
  );

  // The ledger holds the run's end against the bead, then the tracker write
  // (after the builder's create), and the comment says the outcome the
  // ledger recorded.
  await expect
    .poll(
      async () =>
        (await eventsOf(page, id))
          .filter(
            (event) =>
              event.payload["councilRunId"] === runId ||
              event.kind === "bead.transitioned",
          )
          .map((event) => [event.kind, event.payload["action"] ?? null]),
      { timeout: 30_000 },
    )
    .toEqual([
      ["bead.transitioned", "create"],
      ["council.run.started", null],
      ["council.run.finished", null],
      ["bead.transitioned", "comment"],
      ["council.verdict.comment", null],
    ]);
  const finished = (await eventsOf(page, id)).find(
    (event) => event.kind === "council.run.finished",
  );
  expect(text).toContain(
    ` ${String(finished?.payload["outcome"]).toUpperCase()} — `,
  );

  // The comment is on the bead: bd prints it with the bead's comments, and the
  // next preview of the bead lists it.
  expect(standInComments(id)).toEqual([
    {
      id: expect.any(String),
      issue_id: id,
      author: "operator",
      text,
      created_at: expect.stringMatching(/Z$/),
    },
  ]);
  await preview.click();
  await expect(listing).toHaveText([
    /^E1 acceptance criteria: \d+ bytes$/,
    /^E2 latest comments: 1 comment, \d+ bytes$/,
    "description: none",
  ]);
});

test("a Workbench card and each forge-run checkpoint link to the Council page with their bead preselected", async ({
  page,
}) => {
  // First, in a document of its own: the checkpoints come from the snapshot
  // the page reads when it loads.
  await stubForgeRun(page);
  await openSettled(page, "/index.html#/forge-run");
  await expect(page.locator(".af-checkpoint")).not.toHaveCount(0);
  const checkpoints = await page
    .locator(".af-checkpoint .af-checkpoint-meta code")
    .allInnerTexts();
  for (const checkpoint of checkpoints)
    await expect(
      page.getByRole("link", { name: `Send ${checkpoint} to council` }),
    ).toHaveAttribute("href", councilHref(checkpoint));

  await openSettled(page, "/index.html#/bead-builder");
  await requireStandIn(page);
  const id = await createFromBuilder(
    page,
    `Council link fixture ${Date.now()}`,
  );
  seedProposed(id);
  await openSettled(page, "/index.html#/workbench");
  const card = page.locator(`[data-column="proposed"] [data-bead="${id}"]`);
  await expect(card).toBeVisible();
  const send = card.getByRole("link", { name: `Send ${id} to council` });
  await expect(send).toHaveAttribute("href", councilHref(id));
  await send.click();
  await expectPreselected(page, id);
});
