import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { tokenPath } from "../../scripts/hearth/home";
import { launchUrl, requestLaunch } from "../../scripts/hearth/launch";
import { SESSION_KEY_STORAGE, SESSION_ROUTE } from "../../scripts/hearth/paths";
import { readToken } from "../../scripts/hearth/token";
import { resolveCheckout } from "../../scripts/ledger/workspace";
import { projectCatalogFixture } from "../../scripts/projects/testing";
import {
  BD_STAND_IN_BIN,
  BD_STAND_IN_STATE,
  bunPath,
  DASHBOARD_URL,
  HEARTH_HOME,
  HEARTH_PORT,
  STORAGE_STATE,
} from "../e2e/servers";
import {
  EMPTY_HOME,
  FIXTURE_ROOT,
  fixturePlan,
  REPOSITORY,
} from "./environment";

export default async function setup() {
  mkdirSync(BD_STAND_IN_BIN, { recursive: true });
  mkdirSync(BD_STAND_IN_STATE, { recursive: true });
  const build = (source: string, name: string) => {
    const destination = join(
        BD_STAND_IN_BIN,
        process.platform === "win32" ? `${name}.exe` : name,
      ),
      result = spawnSync(
        bunPath(),
        ["build", "--compile", resolve(source), "--outfile", destination],
        { encoding: "utf8", timeout: 60_000 },
      );
    if (result.status !== 0)
      throw new Error(
        `The dedicated ${name} fixture did not compile: ${result.stderr}`,
      );
    return destination;
  };
  const bd = build("tests/e2e/bd-stand-in.ts", "bd");
  build("tests/desktop-e2e/keeper-cli-stand-in.ts", "claude");
  const git = build("tests/desktop-worktree-e2e/git-stand-in.ts", "git");
  const refused = spawnSync(git, ["worktree", "list", "--porcelain", "-z"], {
    cwd: process.cwd(),
    env: { ...process.env, AGENT_FORGE_WORKTREE_FIXTURE_ROOT: FIXTURE_ROOT },
    encoding: "utf8",
    timeout: 10_000,
  });
  if (refused.status === 0)
    throw new Error(
      "The dedicated Git fixture did not fence the real checkout.",
    );
  if (process.platform !== "win32") {
    const caseAlias = join(FIXTURE_ROOT, "Repository");
    mkdirSync(caseAlias);
    const alias = spawnSync(git, ["worktree", "list", "--porcelain", "-z"], {
      cwd: caseAlias,
      env: { ...process.env, AGENT_FORGE_WORKTREE_FIXTURE_ROOT: FIXTURE_ROOT },
      encoding: "utf8",
      timeout: 10_000,
    });
    if (alias.status === 0)
      throw new Error(
        "The Git fixture treated distinct case-sensitive directories as one repository.",
      );
  }
  const listed = spawnSync(git, ["worktree", "list", "--porcelain", "-z"], {
    cwd: REPOSITORY,
    env: { ...process.env, AGENT_FORGE_WORKTREE_FIXTURE_ROOT: FIXTURE_ROOT },
    encoding: "utf8",
    timeout: 10_000,
  });
  if (listed.status !== 0 || !listed.stdout.includes(fixturePlan().base))
    throw new Error(
      `The temporary Git fixture could not list its known base: ${listed.stderr}`,
    );
  const seeded = spawnSync(bd, ["list", "--json"], {
    cwd: REPOSITORY,
    env: { ...process.env, BD_STAND_IN_STATE },
    encoding: "utf8",
    timeout: 10_000,
  });
  if (seeded.status !== 0 || seeded.stdout.trim() !== "[]")
    throw new Error("The dedicated tracker fixture did not answer.");
  mkdirSync(join(HEARTH_HOME, "projects"), { recursive: true });
  writeFileSync(
    join(HEARTH_HOME, "projects", "catalog.json"),
    JSON.stringify(
      projectCatalogFixture(resolveCheckout(REPOSITORY).workspace),
    ),
  );
  writeFileSync(
    join(HEARTH_HOME, "coding-fixture-mode.json"),
    JSON.stringify("normal"),
  );
  const token = readToken(tokenPath(HEARTH_HOME, REPOSITORY));
  if (!token)
    throw new Error(
      "The dedicated hearth did not start for the temporary repository.",
    );
  const minted = await requestLaunch({
    home: HEARTH_HOME,
    root: REPOSITORY,
    port: HEARTH_PORT,
    token,
    surface: "cli",
  });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext(),
      page = await context.newPage();
    const exchange = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === SESSION_ROUTE,
    );
    await page.goto(launchUrl(DASHBOARD_URL, minted.secret), {
      waitUntil: "load",
    });
    if ((await exchange).status() !== 200)
      throw new Error(
        "The ordinary temporary-repository launch exchange failed.",
      );
    await page.waitForFunction(
      (storage) => localStorage.getItem(storage) !== null,
      SESSION_KEY_STORAGE,
    );
    await context.storageState({ path: STORAGE_STATE });
  } finally {
    await browser.close();
  }
  // A separate, empty OS home prevents the fixture from reading operator config.
  if (EMPTY_HOME === process.env["USERPROFILE"])
    throw new Error("The runner unexpectedly uses the fixture's empty home.");
}
