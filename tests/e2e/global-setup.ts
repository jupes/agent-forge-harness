import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { loopbackProxyVariable } from "../../scripts/hearth/loopback";
import {
  LAUNCH_KEY,
  SESSION_KEY_STORAGE,
  SESSION_ROUTE,
} from "../../scripts/hearth/paths";
import { launchLink } from "./launch-link";
import { sweepFinishedRunHomes } from "./run-homes";
import {
  BD_STAND_IN_BIN,
  BD_STAND_IN_SOURCE,
  BD_STAND_IN_STATE,
  bunPath,
  GIT_STAND_IN_SOURCE,
  HEARTH_HOME,
  STORAGE_STATE,
} from "./servers";

/**
 * Open the dashboard once through its real launch flow, in a browser, and
 * keep the session it was given for every spec (`use.storageState` in
 * `playwright.config.ts`): the page gets the operator token only with that
 * session (`x1gs.3.31`). The link is minted as `bun run dashboard:open`
 * mints one, from the suite's hearth's token file; the page takes the secret
 * out of its fragment and exchanges it, as for the operator. A run that
 * cannot get a session stops here, before any spec runs without one.
 */
async function saveLaunchedSession(): Promise<void> {
  const link = await launchLink();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const exchanged = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === SESSION_ROUTE,
    );
    await page.goto(link, { waitUntil: "load" });
    const answer = await exchanged;
    if (answer.status() !== 200)
      throw new Error(
        `The suite's dashboard did not exchange its launch link (HTTP ${answer.status()}): ${await answer.text()}`,
      );
    if (new URL(page.url()).hash.includes(`${LAUNCH_KEY}=`))
      throw new Error("The launch secret was left in the page's address");
    // The session's other half, the key, in the origin's storage: the saved
    // state carries it with the cookie (Playwright saves localStorage per origin).
    await page.waitForFunction(
      (storage) => window.localStorage.getItem(storage) !== null,
      SESSION_KEY_STORAGE,
      { timeout: 10_000 },
    );
    await context.storageState({ path: STORAGE_STATE });
  } finally {
    await browser.close();
  }
}

/**
 * Build the stand-in for `bd` before any test runs.
 *
 * The suite's servers are already up when this runs (Playwright starts them
 * first), with a PATH that names the directory built here. Nothing has asked
 * for `bd` yet: a hearth looks for it only when a request needs it. Until this
 * has run, the hearth finds no `bd` at all, which is the safe way to be early.
 *
 * It is compiled, not left as a script: a hearth runs `bd` by name with an
 * argument array, and only a real program of that name receives the arguments
 * exactly as they were given. Built once per run, into the run's home; the
 * teardown removes it.
 *
 * A build that fails, or a program that does not answer, stops the run: the
 * tests must not start against a `bd` nobody checked.
 *
 * The stand-in for `git` (`git-stand-in.ts`) is built into the same directory
 * and checked the same way: it answers the bead source's worktree listing, so
 * a council pack in the suite is the same on every machine (x1gs.7.14).
 *
 * First it removes the homes of earlier runs that are over
 * (`sweepFinishedRunHomes`): on Windows a run's teardown cannot remove its
 * own. That never stops the run.
 *
 * Last, once the stand-ins answer, it opens the dashboard from a launch link
 * and saves the session that gave it (`saveLaunchedSession`).
 */
export default async function globalSetup(): Promise<void> {
  // The helpers ask the hearth on 127.0.0.1 with Node's fetch, which sends
  // that to HTTP_PROXY when NODE_USE_ENV_PROXY is on: the operator token with it.
  const proxied = loopbackProxyVariable(process.env, "node");
  if (proxied !== null)
    throw new Error(
      `The browser suite was started with NODE_USE_ENV_PROXY on, ${proxied} set and no NO_PROXY entry of 127.0.0.1 or *: its requests to the hearth would go to that proxy. Start it with NO_PROXY=127.0.0.1, or without NODE_USE_ENV_PROXY.`,
    );

  const swept = sweepFinishedRunHomes(HEARTH_HOME, tmpdir());
  if (swept.length > 0)
    console.log(
      `[e2e] removed ${swept.length} hearth home(s) earlier runs left in ${tmpdir()}`,
    );

  mkdirSync(BD_STAND_IN_BIN, { recursive: true });
  mkdirSync(BD_STAND_IN_STATE, { recursive: true });
  const program = join(
    BD_STAND_IN_BIN,
    process.platform === "win32" ? "bd.exe" : "bd",
  );
  const built = spawnSync(
    bunPath(),
    ["build", "--compile", BD_STAND_IN_SOURCE, "--outfile", program],
    { encoding: "utf8" },
  );
  if (built.status !== 0 || !existsSync(program))
    throw new Error(
      `The stand-in for bd could not be built (exit ${built.status}):\n${built.stdout}\n${built.stderr}`,
    );

  const asked = spawnSync(program, ["list", "--json"], {
    encoding: "utf8",
    env: { ...process.env, BD_STAND_IN_STATE },
  });
  if (asked.status !== 0 || asked.stdout.trim() !== "[]")
    throw new Error(
      `The stand-in for bd was built but does not answer (exit ${asked.status}): ${asked.stdout}${asked.stderr}`,
    );

  const git = join(
    BD_STAND_IN_BIN,
    process.platform === "win32" ? "git.exe" : "git",
  );
  const gitBuilt = spawnSync(
    bunPath(),
    ["build", "--compile", GIT_STAND_IN_SOURCE, "--outfile", git],
    { encoding: "utf8" },
  );
  if (gitBuilt.status !== 0 || !existsSync(git))
    throw new Error(
      `The stand-in for git could not be built (exit ${gitBuilt.status}):\n${gitBuilt.stdout}\n${gitBuilt.stderr}`,
    );
  const listed = spawnSync(git, ["worktree", "list", "--porcelain", "-z"], {
    encoding: "utf8",
    cwd: HEARTH_HOME,
  });
  if (listed.status !== 0 || !listed.stdout.startsWith("worktree "))
    throw new Error(
      `The stand-in for git was built but does not answer (exit ${listed.status}): ${listed.stdout}${listed.stderr}`,
    );

  await saveLaunchedSession();
}
