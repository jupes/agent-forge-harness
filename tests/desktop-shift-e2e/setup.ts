import "./environment";
import { chromium } from "@playwright/test";
import { tokenPath } from "../../scripts/hearth/home";
import { launchUrl, requestLaunch } from "../../scripts/hearth/launch";
import { SESSION_KEY_STORAGE, SESSION_ROUTE } from "../../scripts/hearth/paths";
import { readToken } from "../../scripts/hearth/token";
import { DASHBOARD_URL, HEARTH_PORT, STORAGE_STATE } from "../e2e/servers";
import { HOME, REPOSITORY } from "./environment";
export default async function setup() {
  const token = readToken(tokenPath(HOME, REPOSITORY));
  if (!token) throw Error("The isolated attended hearth has no token.");
  const launch = await requestLaunch({
    home: HOME,
    root: REPOSITORY,
    port: HEARTH_PORT,
    token,
    surface: "cli",
  });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext(),
      page = await context.newPage();
    const exchanged = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === SESSION_ROUTE,
    );
    await page.goto(launchUrl(DASHBOARD_URL, launch.secret), {
      waitUntil: "load",
    });
    if ((await exchanged).status() !== 200)
      throw Error("The isolated attended launch exchange failed.");
    await page.waitForFunction(
      (name) => localStorage.getItem(name) !== null,
      SESSION_KEY_STORAGE,
    );
    await context.storageState({ path: STORAGE_STATE });
  } finally {
    await browser.close();
  }
}
