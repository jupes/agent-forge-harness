import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { SESSION_KEY_STORAGE, SESSION_ROUTE } from "../../scripts/hearth/paths";
import { projectCatalogFixture } from "../../scripts/projects/testing";
import { writeState } from "../e2e/bd-stand-in-state";
import {
  BD_STAND_IN_BIN,
  BD_STAND_IN_SOURCE,
  BD_STAND_IN_STATE,
  bunPath,
  DASHBOARD_URL,
  GIT_STAND_IN_SOURCE,
  HEARTH_HOME,
  STORAGE_STATE,
} from "../e2e/servers";
import { alpha, fixtureEnvironment, MANIFEST, ROOT } from "./environment";
import teardown from "./teardown";

export default async function setup() {
  try {
    await initialize();
  } catch (error) {
    teardown();
    throw error;
  }
}

async function initialize() {
  const environment = fixtureEnvironment();
  mkdirSync(BD_STAND_IN_BIN, { recursive: true });
  mkdirSync(BD_STAND_IN_STATE, { recursive: true });
  const programs: Array<[string, string]> = [
    ["bd", BD_STAND_IN_SOURCE],
    ["git", GIT_STAND_IN_SOURCE],
    ["claude", resolve("tests/desktop-restart-e2e/claude-stand-in.ts")],
    ["codex", resolve("tests/desktop-e2e/codex-chat-cli-stand-in.ts")],
  ];
  for (const [name, source] of programs) {
    const executable = join(
      BD_STAND_IN_BIN,
      name + (process.platform === "win32" ? ".exe" : ""),
    );
    const built = spawnSync(
      bunPath(),
      ["build", "--compile", source, "--outfile", executable],
      { encoding: "utf8", env: environment, timeout: 60000 },
    );
    if (built.status !== 0)
      throw new Error(
        `Restart fixture ${name} compile failed: ${built.stderr}`,
      );
  }
  mkdirSync(join(ROOT, "docs"), { recursive: true });
  mkdirSync(join(HEARTH_HOME, "projects"), { recursive: true });
  mkdirSync(join(HEARTH_HOME, "user", ".agent-forge"), {
    recursive: true,
  });
  writeFileSync(
    join(HEARTH_HOME, "user", ".agent-forge", "config.toml"),
    '[smiths.codex-journeyman]\nprovider = "codex"\nmodel = "gpt-5-codex"\neffort = "medium"\nenabled = true\n',
    { mode: 0o600 },
  );
  writeFileSync(
    join(HEARTH_HOME, "codex-chat-fixture-mode.json"),
    JSON.stringify("fork-restart"),
    { mode: 0o600 },
  );
  writeFileSync(
    join(HEARTH_HOME, "projects", "catalog.json"),
    JSON.stringify(projectCatalogFixture(ROOT)),
    { mode: 0o600 },
  );
  writeState(BD_STAND_IN_STATE, {
    "alpha-epic": {
      id: "alpha-epic",
      title: "Restart fixture epic",
      issue_type: "epic",
      status: "open",
      priority: 2,
      labels: ["project:alpha"],
      created_at: alpha.createdAt,
      updated_at: alpha.updatedAt,
    },
  });
  const seeded = spawnSync(
    bunPath(),
    [
      "-e",
      `
    import { randomUUID } from "node:crypto";
    import { createConversationStore } from "./scripts/conversations/store";
    const store=createConversationStore(process.env.AGENT_FORGE_HOME), projectId=process.argv[1], repository=process.argv[2], requestId=randomUUID(), owner=randomUUID();
    await store.accept(projectId,{requestId,expectedRevision:0,text:"Recorded restart fixture question",about:[]});
    await store.start(projectId,requestId,owner);
    await store.append(projectId,requestId,owner,{kind:"identity",provider:"claude",sessionId:randomUUID(),version:"recorded-fixture"});
    await store.append(projectId,requestId,owner,{kind:"text",text:JSON.stringify({kind:"keeper.proposals.v1",message:"Review before Start",proposals:[{title:"Review restart recovery",detail:"Actual private intent and explicit retry",action:{kind:"start-session",provider:"claude",smith:"claude-journeyman",beadId:"alpha-epic",repository,worktree:"current",prompt:"Investigate the proposed bead"}}]})});
    await store.finish(projectId,requestId,owner,"completed",null);
  `,
      alpha.id,
      ROOT,
    ],
    { encoding: "utf8", env: environment, timeout: 15000 },
  );
  if (seeded.status !== 0)
    throw new Error(`Restart fixture seed failed: ${seeded.stderr}`);
  const manifest: unknown = JSON.parse(readFileSync(MANIFEST, "utf8"));
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !("url" in manifest) ||
    typeof manifest.url !== "string" ||
    new URL(manifest.url).origin !== DASHBOARD_URL
  )
    throw new Error("Invalid isolated desktop launch.");
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext(),
      page = await context.newPage();
    const exchanged = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === SESSION_ROUTE,
    );
    await page.goto(manifest.url, { waitUntil: "load" });
    if ((await exchanged).status() !== 200)
      throw new Error("The owned desktop did not exchange its actual launch.");
    await page.waitForFunction(
      (key) => localStorage.getItem(key) !== null,
      SESSION_KEY_STORAGE,
    );
    await context.storageState({ path: STORAGE_STATE });
  } finally {
    await browser.close();
  }
}
