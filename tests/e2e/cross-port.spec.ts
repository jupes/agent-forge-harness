import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, type Page, type Response, test } from "@playwright/test";
import { TOKEN_ROUTE } from "../../scripts/hearth/paths";
import { openSettled } from "./fixtures";
import { hearthToken } from "./launch-link";
import { DASHBOARD_URL } from "./servers";

/**
 * A page on another loopback port, in a browser that holds the dashboard's
 * session (`x1gs.3.31`; the session global setup saved).
 *
 * A browser keeps a cookie per host, not per port, and a page on another
 * port of 127.0.0.1 is same-site: SameSite=Strict still sends the session
 * cookie with that page's requests to the dashboard. So the cookie alone does
 * not stop such a page. These tests show what does: the hearth refuses each
 * request a page of another origin can make to the token route (403, the
 * front door: an `Origin` of another port, or `Sec-Fetch-Site: same-site`),
 * and the browser lets the page read nothing of an answer either way.
 *
 * The dashboard's dev server answers no CORS at all (`server.cors: false` in
 * `vite.dashboard.config.ts`): Vite's default reflected a loopback `Origin`,
 * which let such a page read what the dev server serves without any cookie.
 *
 * The other page is served by a small server this spec starts on a port the
 * system picks. The runner runs under Node, so it is `node:http`.
 */

const TOKEN_URL = `${DASHBOARD_URL}${TOKEN_ROUTE}`;

let other: Server | null = null;
let otherUrl = "";

test.beforeAll(async () => {
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      "<!doctype html><title>Another program</title><p>A page on another port.</p>",
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  other = server;
  otherUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

test.afterAll(async () => {
  const server = other;
  other = null;
  if (server === null) return;
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
});

/** The next answer the browser gets from the token route, in any page of the test's context. */
function nextTokenAnswer(page: Page): Promise<Response> {
  return page
    .context()
    .waitForEvent("response", (response) => response.url() === TOKEN_URL);
}

/** What the browser sent with the request an answer came for: whether it held the session cookie. */
async function sentSession(response: Response): Promise<boolean> {
  const cookie = (await response.request().allHeaders())["cookie"] ?? "";
  return cookie.includes("agent_forge_session_");
}

/** One request a page made to the token route, as the browser's network layer saw it. */
interface Seen {
  /** The session cookie went with it (named, and blocked for no reason). */
  cookieSent: boolean;
  site: string | null;
  origin: string | null;
  /** The status the hearth answered, as received: also for an answer the browser then withheld from the page. */
  status: number | null;
  /** Why the browser withheld the answer from the page under CORS, if it did. */
  corsError: string | null;
}

/**
 * Watch `page`'s requests to the token route through the browser's own
 * network events (Chromium's protocol). A fetch whose answer CORS withholds
 * reaches the runner's `response` event never, and its request headers there
 * do not show the cookie; these events show both, and the status received.
 */
async function watchTokenRequests(page: Page): Promise<() => Seen[]> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  const tokenRequests = new Set<string>();
  const seen = new Map<string, Seen>();
  const entry = (id: string): Seen => {
    let found = seen.get(id);
    if (found === undefined) {
      found = {
        cookieSent: false,
        site: null,
        origin: null,
        status: null,
        corsError: null,
      };
      seen.set(id, found);
    }
    return found;
  };
  cdp.on("Network.requestWillBeSent", (event) => {
    if (event.request.url === TOKEN_URL) tokenRequests.add(event.requestId);
  });
  cdp.on("Network.requestWillBeSentExtraInfo", (event) => {
    const headers = Object.fromEntries(
      Object.entries(event.headers).map(([name, value]) => [
        name.toLowerCase(),
        String(value),
      ]),
    );
    const found = entry(event.requestId);
    found.cookieSent = event.associatedCookies.some(
      (associated) =>
        associated.cookie.name.startsWith("agent_forge_session_") &&
        associated.blockedReasons.length === 0,
    );
    found.site = headers["sec-fetch-site"] ?? null;
    found.origin = headers["origin"] ?? null;
  });
  cdp.on("Network.responseReceivedExtraInfo", (event) => {
    entry(event.requestId).status = event.statusCode;
  });
  cdp.on("Network.loadingFailed", (event) => {
    if (event.corsErrorStatus)
      entry(event.requestId).corsError = event.corsErrorStatus.corsError;
  });
  return () => [...tokenRequests].map((id) => entry(id));
}

test("the session is held: a page of the dashboard's own origin is served the token", async ({
  page,
}) => {
  await openSettled(page, "/index.html#/workbench");
  const served = await page.evaluate(async (url) => {
    const response = await fetch(url);
    return { status: response.status, body: await response.text() };
  }, TOKEN_ROUTE);
  expect(served.status).toBe(200);
  expect(served.body).toContain(hearthToken());
});

test("a page on another loopback port that fetches the token route with credentials (cors) is refused by the hearth, 403, though the browser sent the session, and reads nothing", async ({
  page,
}) => {
  const seen = await watchTokenRequests(page);
  await openSettled(page, otherUrl);
  const read = await page.evaluate(async (url) => {
    try {
      const response = await fetch(url, { credentials: "include" });
      return { read: await response.text() };
    } catch (error) {
      return { failed: String(error) };
    }
  }, TOKEN_URL);
  expect(read).toEqual({ failed: "TypeError: Failed to fetch" });
  await expect
    .poll(() => seen().map((request) => request.status))
    .toEqual([403]);
  const [request] = seen();
  expect({ ...request, corsError: request?.corsError !== null }).toEqual({
    cookieSent: true,
    site: "same-site",
    origin: new URL(otherUrl).origin,
    status: 403,
    corsError: true,
  });
});

test("a page on another loopback port that fetches the token route no-cors with credentials gets an opaque answer, and the hearth answered 403", async ({
  page,
}) => {
  const seen = await watchTokenRequests(page);
  await openSettled(page, otherUrl);
  const read = await page.evaluate(async (url) => {
    const response = await fetch(url, {
      mode: "no-cors",
      credentials: "include",
    });
    return {
      type: response.type,
      status: response.status,
      body: await response.text(),
    };
  }, TOKEN_URL);
  expect(read).toEqual({ type: "opaque", status: 0, body: "" });
  await expect
    .poll(() => seen().map((request) => request.status))
    .toEqual([403]);
  expect(seen()).toEqual([
    {
      cookieSent: true,
      site: "same-site",
      origin: null,
      status: 403,
      corsError: null,
    },
  ]);
});

test("a page on another loopback port that opens the token route in a window, or navigates its own tab there, is refused by the hearth, 403, and cannot read the window", async ({
  page,
}) => {
  const token = hearthToken();
  await openSettled(page, otherUrl);

  const popped = page.waitForEvent("popup");
  const windowAnswer = nextTokenAnswer(page);
  await page.evaluate((url) => {
    (globalThis as { opened?: Window | null }).opened = window.open(
      url,
      "_blank",
    );
  }, TOKEN_URL);
  const popup = await popped;
  await popup.waitForLoadState("load");
  const answer = await windowAnswer;
  expect({
    status: answer.status(),
    sentSession: await sentSession(answer),
  }).toEqual({ status: 403, sentSession: true });
  expect(await popup.textContent("body")).not.toContain(token);
  const fromOpener = await page.evaluate(() => {
    const opened = (globalThis as { opened?: Window | null }).opened;
    try {
      return `read: ${opened?.document.body.textContent ?? "nothing"}`;
    } catch (error) {
      return `blocked: ${(error as Error).name}`;
    }
  });
  expect(fromOpener).toBe("blocked: SecurityError");
  await popup.close();

  const navigated = nextTokenAnswer(page);
  await page.evaluate((url) => {
    window.location.href = url;
  }, TOKEN_URL);
  const own = await navigated;
  expect({
    status: own.status(),
    sentSession: await sentSession(own),
  }).toEqual({ status: 403, sentSession: true });
  await page.waitForLoadState("load");
  expect(await page.textContent("body")).not.toContain(token);
});

test("a page on another loopback port reads nothing the dashboard's dev server serves: not the page, not a source file, not the Beads snapshot the issue views load, not a hearth read it proxies", async ({
  page,
}) => {
  await openSettled(page, otherUrl);
  // The snapshot is generated and gitignored, so it may be absent (404, as in
  // CI): an answer of any status the page could read would fail this too.
  const paths = [
    "/index.html",
    "/js/operator.ts",
    "/data/beads.json",
    "/__agent-forge/health",
  ];
  const reads = await page.evaluate(
    async ({ base, paths }) => {
      const read: Record<string, string> = {};
      for (const path of paths) {
        try {
          const response = await fetch(`${base}${path}`);
          read[path] = `read ${response.status}`;
        } catch (error) {
          read[path] = String(error);
        }
      }
      return read;
    },
    { base: DASHBOARD_URL, paths },
  );
  expect(reads).toEqual(
    Object.fromEntries(
      paths.map((path) => [path, "TypeError: Failed to fetch"]),
    ),
  );
});
