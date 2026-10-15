import { expect, type Page, test } from "@playwright/test";
import { openSettled } from "./fixtures";

/**
 * The Council page follows a running council on a stream that asks for deltas
 * (`?deltas=1`): the whole job once, then what changed, which the page folds
 * back into the job (`docs/js/council-run-follow.ts`, `bj90`).
 *
 * The hearth is the real one the suite started and the run is the simulated
 * default council (no model is called; its artifacts go to this run's own
 * hearth home). "The same as before" is measured against the stored run: a
 * page that opens `?run=<id>` reads the run whole, with no stream, which is
 * what the page showed at the end of a followed run before it asked for
 * deltas. The unit tests (`scripts/dashboard/council-run-follow.test.ts`)
 * drive the same rules with a stand-in stream, message by message.
 *
 * A followed page also reads the run again when its stream ends while the run
 * is still going, which would hide a page that ignores every delta: it would
 * end on the stored run all the same. So the tests that follow a run to its
 * end assert that the page made no read of it (a job it has rebuilt is
 * finished, and nothing is read again), and the test of the fallback follows
 * the bad delta with a message that must never be shown.
 */

const API = "/__agent-forge";
const RUN_STREAM = /\/council-api\/runs\/[^/?]+\/events(\?|$)/;
const RUN_READ = /\/council-api\/runs\/[^/?]+$/;

interface StreamRecord {
  url: string;
  /** The event name of each message the page's connection received. */
  kinds: string[];
}

/**
 * Record, for each run stream the page opens, its URL and the kind of each
 * message it receives, by reading a clone of the response in the page.
 */
async function recordStreams(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const records: StreamRecord[] = [];
    (window as unknown as { __streams: StreamRecord[] }).__streams = records;
    const original = window.fetch.bind(window);
    const recording = async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await original(input, init);
      const url =
        typeof input === "string"
          ? input
          : input instanceof Request
            ? input.url
            : String(input);
      if (/\/council-api\/runs\/[^/?]+\/events(\?|$)/.test(url)) {
        const record: StreamRecord = { url, kinds: [] };
        records.push(record);
        void (async () => {
          try {
            const reader = response.clone().body?.getReader();
            if (!reader) return;
            const decoder = new TextDecoder();
            let buffer = "";
            for (;;) {
              const { value, done } = await reader.read();
              if (done) return;
              buffer += decoder.decode(value, { stream: true });
              let end = buffer.indexOf("\n\n");
              while (end !== -1) {
                const block = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                const line = block
                  .split("\n")
                  .find((item) => item.startsWith("event: "));
                if (line) record.kinds.push(line.slice(7));
                end = buffer.indexOf("\n\n");
              }
            }
          } catch {
            // The page closed its end of the stream: nothing more to record.
          }
        })();
      }
      return response;
    };
    // justification: bun's types add `preconnect` to `fetch`; the page's does not have it.
    window.fetch = recording as typeof window.fetch;
  });
}

const streamsOf = (page: Page): Promise<StreamRecord[]> =>
  page.evaluate(
    () => (window as unknown as { __streams: StreamRecord[] }).__streams,
  );

/** The requests the page makes to follow a run: its streams, and its reads of one run. */
function watchRequests(page: Page): { streams: string[]; reads: string[] } {
  const seen = { streams: [] as string[], reads: [] as string[] };
  page.on("request", (request) => {
    if (request.method() !== "GET") return;
    if (RUN_STREAM.test(request.url())) seen.streams.push(request.url());
    else if (RUN_READ.test(new URL(request.url()).pathname))
      seen.reads.push(new URL(request.url()).pathname);
  });
  return seen;
}

/** Convene the default (simulated) council on a text; the run id its start answered with. */
async function convene(page: Page): Promise<string> {
  await openSettled(page, "/council.html");
  await page.fill(
    "#council-source",
    "Evaluate this plan for missing evidence.",
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
  return runId;
}

/** What the page shows of a run: its seats, and its report with the discussion, verdict and transcript. */
async function shown(page: Page): Promise<{ seats: string; report: string }> {
  await expect(page.locator(".council-report .pill").first()).toHaveText(
    "completed",
    { timeout: 30_000 },
  );
  return {
    seats: (await page.locator(".af-seat-grid").textContent()) ?? "",
    report: (await page.locator(".council-report").textContent()) ?? "",
  };
}

/** The same run read whole, as a bookmark opens it: no stream. */
async function stored(
  page: Page,
  runId: string,
): Promise<{ seats: string; report: string }> {
  await openSettled(page, `/council.html?run=${runId}`);
  return shown(page);
}

/** The parts of the page that stand for the run: not empty, so a comparison of them proves something. */
async function expectPopulated(
  page: Page,
  view: { seats: string; report: string },
): Promise<void> {
  expect(view.seats).toContain("complete");
  expect(view.report).toContain("Inside the discussion");
  await expect(page.locator(".discussion-tabs button").first()).toBeVisible();
  await expect(page.locator(".council-report > h2").last()).not.toBeEmpty();
  await expect(page.locator(".af-notice-error")).toHaveCount(0);
}

test("a run is followed on a stream that asks for deltas: one whole job, then deltas, and the page ends with the seats, discussion and result a read of the stored run shows", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await recordStreams(page);
  const seen = watchRequests(page);
  const runId = await convene(page);

  const live = await shown(page);
  await expectPopulated(page, live);

  // One stream, asked for with deltas, and no read of the run: the job the
  // page rebuilt from the deltas was finished, so nothing was read again.
  expect(seen.streams).toHaveLength(1);
  const url = new URL(seen.streams[0] ?? "", "http://page.test");
  expect(url.pathname).toBe(`${API}/council-api/runs/${runId}/events`);
  expect(url.searchParams.get("deltas")).toBe("1");
  expect(seen.reads).toEqual([]);
  // The records are read by a clone of the response, a moment behind the page.
  // How many deltas come depends on when the stream opens: on a fast machine
  // the simulated run is already finished, and the hearth then sends the one
  // finished job. So only the shape is asserted here (a whole job first, and
  // nothing but deltas after it); that deltas arrive and rebuild the job is
  // held by the unit test against the real route with a run held open.
  await expect
    .poll(async () => (await streamsOf(page))[0]?.kinds.length ?? 0)
    .toBeGreaterThan(0);
  const kinds = (await streamsOf(page))[0]?.kinds ?? [];
  expect(kinds[0]).toBe("snapshot");
  expect(kinds.slice(1).every((kind) => kind === "delta")).toBe(true);

  expect(await stored(page, runId)).toEqual(live);
});

test("a delta the page cannot apply makes it read the run again: it closes that stream, trusts nothing after the delta, and ends showing the stored run", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const seen = watchRequests(page);
  // The hearth's own stream, cut down to what a faulty one could send: the
  // run's first job as it stands while running, a delta made for another run,
  // and then a job that says the run failed, which the page must never show.
  await page.route(RUN_STREAM, async (route) => {
    const real = await route.fetch();
    const first = (await real.text())
      .split("\n\n")
      .find((block) => block.startsWith("event: snapshot"));
    const job = JSON.parse(
      (first ?? "").split("\ndata: ")[1] ?? "{}",
    ) as Record<string, unknown>;
    const delta = {
      runId: "another-run",
      events: [],
      discussion: [],
      set: {},
      unset: [],
    };
    const send = (event: string, data: unknown): string =>
      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
      },
      body:
        send("snapshot", { ...job, status: "running" }) +
        send("delta", delta) +
        send("snapshot", { ...job, status: "failed", error: "NEVER SHOWN" }),
    });
  });

  const runId = await convene(page);
  const live = await shown(page);
  await expectPopulated(page, live);
  expect(live.report).not.toContain("NEVER SHOWN");

  // One read of the run (a start is a POST: the page reads nothing else of
  // it), and the run, now finished, is not followed again.
  expect(seen.reads).toEqual([`${API}/council-api/runs/${runId}`]);
  expect(seen.streams).toHaveLength(1);

  await page.unroute(RUN_STREAM);
  expect(await stored(page, runId)).toEqual(live);
});

test("a hearth that sends whole jobs on every update is still followed: the stream is asked for deltas and the page shows the same as the stored run", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await recordStreams(page);
  const seen = watchRequests(page);
  // The stream as it was before deltas: the same request without the parameter.
  await page.route(RUN_STREAM, async (route) => {
    const url = new URL(route.request().url());
    url.searchParams.delete("deltas");
    await route.continue({ url: url.toString() });
  });

  const runId = await convene(page);
  const live = await shown(page);
  await expectPopulated(page, live);

  expect(seen.streams).toHaveLength(1);
  expect(new URL(seen.streams[0] ?? "", "http://page.test").search).toBe(
    "?deltas=1",
  );
  expect(seen.reads).toEqual([]);
  await expect
    .poll(async () => (await streamsOf(page))[0]?.kinds.length ?? 0)
    .toBeGreaterThan(0);
  // One message when the run had finished before the stream opened, more otherwise.
  expect(new Set((await streamsOf(page))[0]?.kinds)).toEqual(
    new Set(["snapshot"]),
  );

  await page.unroute(RUN_STREAM);
  expect(await stored(page, runId)).toEqual(live);
});
