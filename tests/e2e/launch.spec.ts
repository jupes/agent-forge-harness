import { expect, type Page, test } from "@playwright/test";
import {
  LAUNCH_KEY,
  NO_SESSION_ERROR,
  SESSION_ROUTE,
  TOKEN_ROUTE,
} from "../../scripts/hearth/paths";
import { openSettled } from "./fixtures";
import { hearthToken, launchLink } from "./launch-link";
import { createButton, isList, requireStandIn, standInCalls } from "./stand-in";

/**
 * The dashboard's session (`x1gs.3.31`), in a browser that has none: these
 * tests clear the session every other spec's page starts with (global
 * setup's, from a launch link). The hearth is the suite's real one, and the
 * links are minted as `bun run dashboard:open` mints them.
 */
test.use({ storageState: { cookies: [], origins: [] } });

/** A token request from the page, same-origin, as the page's own client makes it. */
function tokenFromPage(page: Page): Promise<{ status: number; body: string }> {
  return page.evaluate(async (url) => {
    const response = await fetch(url);
    return { status: response.status, body: await response.text() };
  }, TOKEN_ROUTE);
}

/** The page's next exchange of a launch secret. */
function nextExchange(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === SESSION_ROUTE,
  );
}

test("a bare URL gets no operator token (401, how to relaunch); the launch link, opened in the same tab, does, keeps its route and leaves no secret in the address", async ({
  page,
  context,
}) => {
  const token = hearthToken();
  await openSettled(page, "/index.html#/timeline");
  const bare = await tokenFromPage(page);
  expect(bare.status).toBe(401);
  expect((JSON.parse(bare.body) as { error: unknown }).error).toBe(
    NO_SESSION_ERROR,
  );
  expect(bare.body).not.toContain(token);
  expect(await context.cookies()).toEqual([]);

  // Same path, so only the fragment changes: the page is not loaded again.
  const link = await launchLink("/timeline?bead=e2e-launch");
  const secret = link.slice(
    link.indexOf(`${LAUNCH_KEY}=`) + LAUNCH_KEY.length + 1,
  );
  expect(secret).toMatch(/^[0-9a-f]{64}$/);
  const exchanged = nextExchange(page);
  await openSettled(page, link);
  expect((await exchanged).status()).toBe(200);
  expect(new URL(page.url()).hash).toBe("#/timeline?bead=e2e-launch");
  expect(page.url()).not.toContain(secret);

  const cookies = await context.cookies();
  expect(
    cookies.map((cookie) => ({
      path: cookie.path,
      domain: cookie.domain,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      secure: cookie.secure,
      browserSession: cookie.expires === -1,
      value: cookie.value === secret || cookie.value === token,
    })),
  ).toEqual([
    {
      path: "/__agent-forge",
      domain: "127.0.0.1",
      httpOnly: true,
      sameSite: "Strict",
      secure: false,
      browserSession: true,
      value: false,
    },
  ]);
  // HttpOnly: no script of the page reads it.
  expect(await page.evaluate(() => document.cookie)).toBe("");
  const served = await tokenFromPage(page);
  expect(served.status).toBe(200);
  expect(
    (JSON.parse(served.body) as { data: { token: string } }).data.token,
  ).toBe(token);
});

test("on a bare URL a create is not sent: the bead builder says how to open the dashboard from its launcher, and nothing reaches bd", async ({
  page,
}) => {
  await openSettled(page, "/index.html#/bead-builder");
  await requireStandIn(page);
  const callsBefore = standInCalls().length;
  await page.fill("#bb-title", "Never sent without a session");
  await createButton(page).click();
  const result = page.locator("#bb-create-result");
  await expect(result).toHaveText(
    `Not sent: the page could not get an operator token from the control plane (${NO_SESSION_ERROR}). Nothing was changed.`,
  );
  await expect(result).toHaveAttribute("data-outcome", "failed");
  expect(
    standInCalls()
      .slice(callsBefore)
      .filter((call) => !isList(call)),
  ).toEqual([]);
});

test("a launch link works once: a second browser opened with the same link gets no session and no token", async ({
  page,
  browser,
}) => {
  const link = await launchLink();
  const first = nextExchange(page);
  await openSettled(page, link);
  expect((await first).status()).toBe(200);
  expect((await tokenFromPage(page)).status).toBe(200);

  const other = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  try {
    const second = await other.newPage();
    const refused = nextExchange(second);
    await openSettled(second, link);
    expect((await refused).status()).toBe(403);
    expect(new URL(second.url()).hash).toBe("");
    expect(await other.cookies()).toEqual([]);
    expect((await tokenFromPage(second)).status).toBe(401);
  } finally {
    await other.close();
  }
});
