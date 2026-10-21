import { join } from "node:path";
import { expect, type Request, test } from "@playwright/test";
import type { CouncilServiceJob } from "../../scripts/council/service";
import { OPERATOR_HEADER, SURFACE_HEADER } from "../../scripts/hearth/paths";
import type { EventsPage, LedgerEvent } from "../../types/hearth";
import { openSettled } from "./fixtures";
import { pageToken } from "./launch-link";
import { createFromBuilder, requireStandIn, standInCalls } from "./stand-in";

test("verdict status follows the page ledger after council SSE ends, survives reload and clears between jobs", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    // Keep the real page snapshot/stream; inject a delayed metadata notification.
    window.fetch = (async (...args: Parameters<typeof fetch>) => {
      const response = await original(...args);
      if (!String(args[0]).endsWith("/__agent-forge/stream") || !response.body)
        return response;
      let opened = () => {};
      const ready = new Promise<void>((resolve) => {
        opened = resolve;
      });
      let buffered = "";
      const decoder = new TextDecoder();
      const stream = new TransformStream<Uint8Array, Uint8Array>({
        start(controller) {
          (
            window as unknown as { verdictEvent(event: unknown): void }
          ).verdictEvent = async (event) => {
            await ready;
            controller.enqueue(
              new TextEncoder().encode(
                `event: delta\ndata: ${JSON.stringify(event)}\n\n`,
              ),
            );
          };
        },
        transform(chunk, controller) {
          controller.enqueue(chunk);
          buffered += decoder.decode(chunk, { stream: true });
          const snapshot = buffered.indexOf("event: snapshot");
          if (snapshot >= 0 && buffered.indexOf("\n\n", snapshot) >= 0)
            opened();
        },
      });
      return new Response(response.body.pipeThrough(stream), {
        headers: response.headers,
      });
    }) as typeof fetch;
  });
  await openSettled(page, "/index.html#/bead-builder");
  await requireStandIn(page);
  const bead = await createFromBuilder(page, "Verdict status fixture");
  const token = await pageToken(page);
  const runId = `status-${info.project.name}-${Date.now()}`;
  const started = await page.evaluate(
    async ({ bead, token, runId, header, surface }) => {
      const response = await fetch("/__agent-forge/council-api/runs", {
        method: "POST",
        headers: {
          [header]: token,
          [surface]: "ui",
          "content-type": "application/json",
        },
        body: JSON.stringify({ sourceType: "bead", source: bead, runId }),
      });
      return response.status;
    },
    { bead, token, runId, header: OPERATOR_HEADER, surface: SURFACE_HEADER },
  );
  expect(started).toBe(202);
  let recorded: LedgerEvent[] = [];
  await page.route("**/__agent-forge/events?**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("kind") !== "council.verdict.comment")
      return route.continue();
    expect(url.searchParams.get("beadExact")).toBe("1");
    await route.fulfill({
      json: {
        ok: true,
        data: { events: recorded, cursor: 1, more: false } satisfies EventsPage,
        error: null,
      },
    });
  });
  let finished: CouncilServiceJob | undefined;
  await expect
    .poll(async () => {
      finished = await page.evaluate(
        async ({ runId, token, header }) =>
          (
            await (
              await fetch(`/__agent-forge/council-api/runs/${runId}`, {
                headers: { [header]: token },
              })
            ).json()
          ).data,
        { runId, token, header: OPERATOR_HEADER },
      );
      return finished?.status;
    })
    .toBe("completed");
  const other = structuredClone(finished!);
  other.runId = "status-other";
  other.run!.context.source.displayName = "Another review";
  // End the council SSE deterministically before delivering the comment metadata.
  await page.route(`**/council-api/runs/${runId}`, (route) =>
    route.fulfill({
      json: { ok: true, data: { ...finished, status: "running" }, error: null },
    }),
  );
  await page.route(`**/council-api/runs/${runId}/events?*`, (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: `event: snapshot\ndata: ${JSON.stringify(finished)}\n\n`,
    }),
  );
  await page.route("**/council-api/runs", (route) =>
    route.fulfill({ json: { ok: true, data: [finished, other], error: null } }),
  );
  await page.route("**/council-api/runs/status-other", (route) =>
    route.fulfill({ json: { ok: true, data: other, error: null } }),
  );
  let streamEnded = false;
  const streamTerminated = (request: Request): void => {
    if (request.url().includes(`/runs/${runId}/events`)) streamEnded = true;
  };
  // The completed snapshot closes the fetch with AbortController. Depending
  // on timing Chromium reports finished or cancelled; both end this stream.
  page.on("requestfinished", streamTerminated);
  page.on("requestfailed", streamTerminated);
  await openSettled(page, `/council.html?run=${runId}`);
  await expect(page.locator(".council-report .pill").first()).toHaveText(
    "completed",
    { timeout: 30_000 },
  );
  const notice = page.getByTestId("council-verdict-status");
  await expect(notice).toContainText("status not known");
  await expect.poll(() => streamEnded).toBe(true);
  for (const [index, status] of (
    ["posted", "refused", "unknown", "posted"] as const
  ).entries()) {
    const event: LedgerEvent = {
      id: 1_000_000 + index,
      ulid: `fixture-${index}`,
      ts: new Date().toISOString(),
      workspace: "fixture",
      beadId: bead,
      kind: "council.verdict.comment",
      payload: { councilRunId: runId, status },
    };
    recorded = [event];
    // A reload can finish the verdict read before the page's ledger stream
    // has installed its injection seam. Wait for that actual readiness.
    await page.waitForFunction(
      () =>
        typeof (window as unknown as { verdictEvent?: unknown })
          .verdictEvent === "function",
    );
    await page.evaluate(
      (event) =>
        (
          window as unknown as { verdictEvent(event: unknown): void }
        ).verdictEvent(event),
      event,
    );
    await expect(notice).toContainText(
      status === "posted"
        ? "posted to the bead"
        : status === "refused"
          ? "write was refused"
          : "status not known",
    );
    if (status === "posted") {
      await page.reload();
      await expect(notice).toContainText("posted to the bead");
      if (process.env["SHOT_DIR"])
        await page.screenshot({
          path: join(process.env["SHOT_DIR"], `${info.project.name}.png`),
          fullPage: true,
        });
    }
  }
  await page.getByRole("button", { name: /Another review/ }).click();
  await expect(notice).toContainText("status not known");
  expect(
    standInCalls().filter(
      (call) => call[0] === "comments" && call[1] === "add" && call[4] === bead,
    ),
  ).toHaveLength(1);
});
