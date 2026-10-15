import { expect, type Page, test } from "@playwright/test";
import { OPERATOR_HEADER, SURFACE_HEADER } from "../../scripts/hearth/paths";
import { openSettled } from "./fixtures";
import { createFromBuilder, requireStandIn, standInCalls } from "./stand-in";

/**
 * A bead as the source of a council run, from the Council page, through the
 * suite's real hearth and its `bd` stand-in. The bead is created through the
 * page first, so the stand-in knows it and each project's run has its own.
 * The profile is the simulated default: no model is called, and the run's
 * artifacts go to the run's own hearth home.
 */

const API = "/__agent-forge";

interface Stored {
  kind: string;
  beadId?: string;
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

test("a bead is previewed before it is sent: the page lists each part a run would send, starts nothing until Convene, and the run then packs that bead", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await openSettled(page, "/index.html#/bead-builder");
  await requireStandIn(page);
  const id = await createFromBuilder(page, "Council preview fixture");
  /** The council's reads of this bead the stand-in has seen, oldest first. */
  const reads = (): string[] =>
    standInCalls()
      .filter((call) => call[0] === "--readonly" && call[2] === id)
      .map((call) => call[1] ?? "");

  await openSettled(
    page,
    `/council.html?sourceType=bead&source=${encodeURIComponent(id)}`,
  );
  await expect(page.locator("#council-source-type")).toHaveValue("bead");
  await expect(page.locator("#council-source")).toHaveValue(id);
  const convene = page.getByRole("button", { name: "Convene council" });
  // Nothing read and nothing offered to send before the operator asks.
  await expect(convene).toBeDisabled();
  expect(reads()).toEqual([]);

  const posted = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.url().endsWith(`${API}/council/preview`),
  );
  await page.getByRole("button", { name: "Preview evidence" }).click();
  const request = await posted;
  expect(request.headers()[OPERATOR_HEADER]).toMatch(/^[0-9a-f]{64}$/);
  expect(request.headers()[SURFACE_HEADER]).toBe("ui");

  const listing = page.getByTestId("council-preview-listing").locator("li");
  await expect(listing).toHaveText([
    /^E1 acceptance criteria: \d+ bytes$/,
    "latest comments: none",
    "description: none",
  ]);
  await expect(page.locator(".af-evidence-preview")).toContainText(
    `${id}: Council preview fixture`,
  );
  expect(reads()).toEqual(["show", "comments"]);
  await expect(convene).toBeEnabled();
  // The preview is audited against the bead, and started no run.
  expect(
    (await eventsOf(page, id))
      .filter(
        (event) =>
          event.kind.startsWith("council.") || event.kind === "operator.action",
      )
      .map((event) => [event.kind, event.payload["action"] ?? null]),
  ).toEqual([["operator.action", "council.run.preview"]]);

  // Another bead in the field is another draft: the listing goes, and so does Convene.
  await page.fill("#council-source", `${id}.9`);
  await expect(listing).toHaveCount(0);
  await expect(convene).toBeDisabled();
  await page.fill("#council-source", id);
  await expect(listing).toHaveCount(3);
  await expect(convene).toBeEnabled();

  const started = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`${API}/council-api/runs`),
  );
  await convene.click();
  const answer = await started;
  expect(answer.status()).toBe(202);
  const runId =
    ((await answer.json()) as { data: { runId: string } }).data.runId ?? "";
  expect(runId).not.toBe("");

  // The simulated run ends by itself; it packed the same bead, read again.
  await expect
    .poll(
      async () =>
        (await eventsOf(page, id))
          .filter((event) => event.payload["councilRunId"] === runId)
          .map((event) => event.kind),
      { timeout: 60_000 },
    )
    .toEqual(["council.run.started", "council.run.finished"]);
  const job = await page.evaluate(
    async (url) => (await (await fetch(url)).json()).data,
    `${API}/council-api/runs/${encodeURIComponent(runId)}`,
  );
  expect(job.status).toBe("completed");
  expect(job.run.context.source).toMatchObject({ kind: "bead", locator: id });
  expect(reads()).toEqual(["show", "comments", "show", "comments"]);
});
