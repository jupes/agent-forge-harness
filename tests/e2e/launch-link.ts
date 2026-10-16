import type { Page } from "@playwright/test";
import { tokenPath } from "../../scripts/hearth/home";
import {
  launchBase,
  launchUrl,
  requestLaunch,
} from "../../scripts/hearth/launch";
import {
  LAUNCH_KEY,
  SESSION_KEY_HEADER,
  SESSION_KEY_STORAGE,
  TOKEN_ROUTE,
} from "../../scripts/hearth/paths";
import { readToken } from "../../scripts/hearth/token";
import { DASHBOARD_URL, HEARTH_HOME, HEARTH_PORT } from "./servers";

/**
 * Launch links for the suite's dashboard (`x1gs.3.31`), minted as the
 * launcher and `bun run dashboard:open` mint them: with the operator token
 * read from the suite's hearth's token file, from the hearth over its own
 * loopback socket. A page gets the operator token only once it has been
 * opened from one: global setup opens one and saves the session it gave
 * (`STORAGE_STATE`), which every spec's page starts with.
 */

/**
 * The suite's hearth's operator token, from its token file. The hearth's root
 * is the checkout, the directory the runner and its servers run in.
 */
export function hearthToken(): string {
  const token = readToken(tokenPath(HEARTH_HOME, process.cwd()));
  if (token === null)
    throw new Error(
      `The suite's hearth has no token file in ${HEARTH_HOME}: it did not start, or it is not the one this run started`,
    );
  return token;
}

/**
 * A fresh launch link for the dashboard: `/#launch=<secret>`, as the launcher
 * prints it; with a route (`/timeline?bead=x`),
 * `/index.html#/timeline?bead=x&launch=<secret>`; with another document
 * (`council.html`), `/council.html#launch=<secret>`.
 */
export async function launchLink(
  options: { route?: string; document?: string } = {},
): Promise<string> {
  const { secret } = await requestLaunch({
    home: HEARTH_HOME,
    root: process.cwd(),
    port: HEARTH_PORT,
    token: hearthToken(),
    surface: "cli",
  });
  const { route, document } = options;
  if (route === undefined && document === undefined)
    return launchUrl(DASHBOARD_URL, secret);
  // The address the dashboard bound, as the launcher's links name it.
  const base = launchBase(DASHBOARD_URL);
  const fragment =
    route === undefined
      ? `${LAUNCH_KEY}=${secret}`
      : `${route}${route.includes("?") ? "&" : "?"}${LAUNCH_KEY}=${secret}`;
  return `${base}${document ?? "index.html"}#${fragment}`;
}

/**
 * The token route asked from `page`, as the page's own client asks it:
 * same-origin, its cookie sent by the browser, and its session key read from
 * its origin's storage now and sent in `SESSION_KEY_HEADER` (none when it has
 * none). The status and the body, for a test to look at.
 */
export function tokenFromPage(
  page: Page,
): Promise<{ status: number; body: string }> {
  return page.evaluate(
    async ({ route, header, storage }) => {
      const key = window.localStorage.getItem(storage);
      const response = await fetch(
        route,
        key === null ? {} : { headers: { [header]: key } },
      );
      return { status: response.status, body: await response.text() };
    },
    {
      route: TOKEN_ROUTE,
      header: SESSION_KEY_HEADER,
      storage: SESSION_KEY_STORAGE,
    },
  );
}

/** The operator token, read through `page` with `tokenFromPage`; throws when it is not served. */
export async function pageToken(page: Page): Promise<string> {
  const { status, body } = await tokenFromPage(page);
  const token = (JSON.parse(body) as { data: { token?: unknown } | null }).data
    ?.token;
  if (status !== 200 || typeof token !== "string")
    throw new Error(`the token route answered the page ${status}`);
  return token;
}
