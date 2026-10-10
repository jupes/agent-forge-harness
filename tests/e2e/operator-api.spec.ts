import { expect, type Page, test } from "@playwright/test";
import {
  OPERATOR_HEADER,
  SURFACE_HEADER,
  TOKEN_ROUTE,
} from "../../scripts/hearth/paths";
import { stubForgeRun } from "./fixtures";

/**
 * The operator API, from a browser, through the dashboard's proxy.
 *
 * The hearth here is the real one the suite started (`main()`), so these
 * tests see what the page sees: the token route, the token check on a
 * mutation, the audit row and the council events in the ledger, and the event
 * stream. Requests are made from page context on purpose. A request the test
 * runner makes itself carries no `Origin` and is refused before the token is
 * looked at, which would prove nothing about the token.
 *
 * One test starts a real council run. The default council profile is
 * simulated (no model is called), its artifacts go to this run's own hearth
 * home, and nothing is written to Beads.
 */

const API = "/__agent-forge";

interface Envelope<T> {
  ok: boolean;
  data: T | null;
  error: string | null;
}

interface Answer<T> {
  status: number;
  body: Envelope<T>;
}

/** `fetch` from the page: same-origin, as the dashboard's own code calls the hearth. */
function fromPage<T>(
  page: Page,
  path: string,
  init?: { method: string; headers: Record<string, string>; body: string },
): Promise<Answer<T>> {
  return page.evaluate(
    async ({ url, options }) => {
      const response = await fetch(url, options);
      return { status: response.status, body: await response.json() };
    },
    { url: path, options: init },
  ) as Promise<Answer<T>>;
}

interface Stored {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
}

async function recorded(page: Page, kinds: string): Promise<Stored[]> {
  const answer = await fromPage<{ events: Stored[] }>(
    page,
    `${API}/events?limit=1000&kind=${kinds}`,
  );
  expect(answer.status).toBe(200);
  return answer.body.data?.events ?? [];
}

const START = {
  method: "POST",
  body: JSON.stringify({ sourceType: "text", source: "Review this." }),
};

test("a mutation from the page without the operator token is refused, and nothing is recorded", async ({
  page,
}) => {
  await page.goto("/council.html", { waitUntil: "networkidle" });
  const before = await recorded(page, "operator.action");

  const bare = await fromPage(page, `${API}/council/runs`, {
    ...START,
    headers: { "Content-Type": "application/json" },
  });
  expect(bare.status).toBe(403);
  expect(bare.body.ok).toBe(false);
  // The token refusal, not the origin one: the request was same-origin.
  expect(bare.body.error).toContain("operator token");

  for (const path of [`${API}/council/runs`, `${API}/council-api/runs`]) {
    const wrong = await fromPage(page, path, {
      ...START,
      headers: {
        "Content-Type": "application/json",
        [OPERATOR_HEADER]: "0".repeat(64),
      },
    });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error).toContain("operator token");
  }

  expect(await recorded(page, "operator.action")).toEqual(before);
});

test("the Council page starts a run with the operator token; the hearth records the action, then the run", async ({
  page,
}) => {
  await page.goto("/council.html", { waitUntil: "networkidle" });
  const token = (await fromPage<{ token: string }>(page, TOKEN_ROUTE)).body.data
    ?.token;
  expect(token, "the token route answers the page").toMatch(/^[0-9a-f]{64}$/);

  await page.fill(
    "#council-source",
    "Evaluate this plan for missing evidence.",
  );
  const posted = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.url().endsWith(`${API}/council-api/runs`),
  );
  await page.getByRole("button", { name: "Convene council" }).click();
  const request = await posted;

  expect(request.headers()[OPERATOR_HEADER]).toBe(token);
  expect(request.headers()[SURFACE_HEADER]).toBe("ui");
  const response = await request.response();
  expect(response?.status()).toBe(202);
  const job = ((await response?.json()) as Envelope<{ runId: string }>).data;
  const runId = job?.runId ?? "";
  expect(runId).not.toBe("");

  // The run is simulated and ends by itself; its end is the last thing recorded.
  const ofRun = (events: Stored[]): Stored[] =>
    events.filter(
      (event) =>
        event.payload["councilRunId"] === runId ||
        event.payload["target"] === runId,
    );
  await expect
    .poll(
      async () =>
        ofRun(
          await recorded(
            page,
            "operator.action,council.run.started,council.run.finished",
          ),
        ).map((event) => event.kind),
      { timeout: 30_000 },
    )
    .toEqual([
      "operator.action",
      "council.run.started",
      "council.run.finished",
    ]);

  const [action] = ofRun(await recorded(page, "operator.action"));
  expect(action?.payload).toEqual({
    action: "council.run.start",
    surface: "ui",
    target: runId,
  });
});

test("a checkpoint review is posted with the operator token", async ({
  page,
}) => {
  // The review itself is intercepted, as in every other spec: no test writes
  // to Beads. What is checked here is what the page sends.
  const posts = await stubForgeRun(page);
  const headers: Array<Record<string, string>> = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/dev-api/forge-run/review")
    )
      headers.push(request.headers());
  });
  await page.goto("/index.html#/forge-run", { waitUntil: "networkidle" });
  const token = (await fromPage<{ token: string }>(page, TOKEN_ROUTE)).body.data
    ?.token;

  await page.getByRole("button", { name: "Approve checkpoint" }).click();
  await expect(page.locator(".af-review-result")).toContainText(
    "demo-primitives",
  );

  expect(posts).toHaveLength(1);
  expect(headers).toHaveLength(1);
  expect(headers[0]?.[OPERATOR_HEADER]).toBe(token);
  expect(headers[0]?.[SURFACE_HEADER]).toBe("ui");
});

test("the hearth stream reaches an EventSource through the dashboard: a snapshot, then a delta", async ({
  page,
}) => {
  await page.goto("/council.html", { waitUntil: "networkidle" });
  const token = (await fromPage<{ token: string }>(page, TOKEN_ROUTE)).body.data
    ?.token;

  const seen = await page.evaluate(
    ({ api, header, value }) =>
      new Promise<{
        snapshot: Record<string, unknown>;
        delta: Record<string, unknown>;
        deltaId: string;
        waitedMs: number;
      }>((resolve, reject) => {
        const source = new EventSource(`${api}/stream`);
        let snapshot: Record<string, unknown> | null = null;
        let acted = 0;
        const fail = (reason: string): void => {
          source.close();
          reject(new Error(reason));
        };
        const timer = setTimeout(() => fail("no delta within 10 s"), 10_000);
        source.addEventListener("snapshot", (event) => {
          snapshot = JSON.parse((event as MessageEvent<string>).data);
          // Something to be told about: cancel a run that does not exist. The
          // service refuses it, and the attempt is an audited action.
          acted = performance.now();
          void fetch(`${api}/council/runs/no-such-run/cancel`, {
            method: "POST",
            headers: { "Content-Type": "application/json", [header]: value },
            body: "{}",
          });
        });
        source.addEventListener("delta", (event) => {
          const message = event as MessageEvent<string>;
          const delta = JSON.parse(message.data) as Record<string, unknown>;
          const payload = delta["payload"] as Record<string, unknown>;
          if (payload["target"] !== "no-such-run" || snapshot === null) return;
          clearTimeout(timer);
          source.close();
          resolve({
            snapshot,
            delta,
            deltaId: message.lastEventId,
            waitedMs: performance.now() - acted,
          });
        });
        source.onerror = () => fail("the stream closed");
      }),
    { api: API, header: OPERATOR_HEADER, value: token ?? "" },
  );

  expect(typeof seen.snapshot["cursor"]).toBe("number");
  // Each collection is an envelope, read or not. The queue is read with a
  // read-only `bd list` where `bd` is installed and reports its absence in CI;
  // smiths and config depend on the machine's own config file. Only what this
  // run's ledger and this checkout decide is required to have been read.
  for (const name of [
    "sessions",
    "runs",
    "queue",
    "reservations",
    "smiths",
    "config",
  ]) {
    const collection = seen.snapshot[name] as Envelope<unknown>;
    expect(typeof collection.ok, name).toBe("boolean");
    expect(collection.ok ? collection.error : collection.data, name).toBeNull();
  }
  for (const name of ["sessions", "runs", "reservations"])
    expect((seen.snapshot[name] as Envelope<unknown>).ok, name).toBe(true);

  expect(seen.delta["kind"]).toBe("operator.action");
  expect(seen.delta["payload"]).toMatchObject({
    action: "council.run.cancel",
    target: "no-such-run",
  });
  expect(Number(seen.deltaId)).toBe(seen.delta["id"]);
  expect(Number(seen.deltaId)).toBeGreaterThan(
    seen.snapshot["cursor"] as number,
  );
  expect(seen.waitedMs).toBeLessThan(2000);
});
