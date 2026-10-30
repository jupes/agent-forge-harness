import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { runsHref } from "../../apps/desktop/src/project-runs-model";
import type { ConversationState } from "../../types/conversation";
import type { OwnedSessionRecord } from "../../types/owned-session";
import { openSettled } from "../e2e/fixtures";
import { HEARTH_HOME } from "../e2e/servers";
import { alpha, beta, seedProjects } from "./project-fixtures";

const protectedPosts: string[] = [];
let releaseIdentityRead: (() => void) | undefined;
const explicitStartTitle =
  "an attended prompt uses ordinary Preview and one identity-bound Start after a lost reply";
const explicitStartPosts = () => [
  `/__agent-forge/projects/${alpha.id}/sessions/preview`,
  `/__agent-forge/projects/${alpha.id}/session-start-identities`,
  `/__agent-forge/projects/${alpha.id}/sessions`,
];

const starts = () =>
  existsSync(join(HEARTH_HOME, "coding-fixture-starts.jsonl"))
    ? readFileSync(join(HEARTH_HOME, "coding-fixture-starts.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean).length
    : 0;
function records(): OwnedSessionRecord[] {
  try {
    return JSON.parse(
      readFileSync(join(HEARTH_HOME, "sessions", "registry.json"), "utf8"),
    ).records;
  } catch {
    return [];
  }
}
function journal(id: string): ConversationState {
  try {
    return JSON.parse(
      readFileSync(join(HEARTH_HOME, "conversations", `${id}.json`), "utf8"),
    );
  } catch {
    throw new Error("The isolated session journal is unavailable");
  }
}
const forward = async (route: import("@playwright/test").Route) =>
  route.fetch({
    headers: {
      ...(await route.request().allHeaders()),
      Origin: new URL(route.request().url()).origin,
      "Sec-Fetch-Site": "same-origin",
    },
  });

test.beforeEach(({ page }) => {
  seedProjects();
  protectedPosts.length = 0;
  releaseIdentityRead = undefined;
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST" && pathname.startsWith("/__agent-forge/"))
      protectedPosts.push(pathname);
  });
});

test.afterEach(async ({ page }, testInfo) => {
  releaseIdentityRead?.();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  expect(protectedPosts).toEqual(
    testInfo.title === explicitStartTitle ? explicitStartPosts() : [],
  );
});

test("New forge run opens attended preparation only after the scoped Runs read", async ({
  page,
}) => {
  await openRuns(page);
  const runs = page.getByRole("region", { name: "Project forge runs" });
  const launch = runs.getByRole("button", {
    name: "New forge run",
    exact: true,
  });
  await expect(launch).toBeEnabled();
  await launch.click();

  const preparation = page.getByRole("dialog");
  await expect(preparation).toBeVisible();
  await expect(
    preparation.getByRole("button", { name: "Start", exact: true }),
  ).toHaveCount(0);
});

test("Full and Mini show exact attended prompts, with Unattended visibly locked", async ({
  page,
}) => {
  await openRuns(page);
  await launchPreparation(page);
  const preparation = page.getByRole("dialog");
  await expect(
    preparation.getByRole("radio", { name: "Unattended" }),
  ).toBeDisabled();
  await expect(preparation).toContainText("wait for local model execution");
  const description = preparation.getByLabel("Feature description");
  const exactText = "  Preserve punctuation: (yes)!\nKeep --label=ready.";
  await description.fill(exactText);
  await preparation
    .getByRole("button", { name: "Review generated prompt" })
    .click();
  const prompt = preparation.locator(".af-new-forge-run-prompt");
  await expect(prompt).toHaveText(`/forgemaster --full ${exactText}`);
  await preparation.getByRole("button", { name: "Edit input" }).click();
  await preparation.getByLabel("Run size").selectOption("mini");
  await preparation
    .getByRole("button", { name: "Review generated prompt" })
    .click();
  await expect(prompt).toHaveText(`/forgemaster --mini ${exactText}`);
  const shotDirectory = process.env.SHOT_DIR;
  if (shotDirectory)
    await page.screenshot({
      path: join(shotDirectory, "forge-run-preparation.png"),
    });
  await preparation
    .getByRole("button", { name: "Continue to Claude composer" })
    .click();
  const composer = page.getByRole("dialog", { name: "New session · Alpha" });
  await expect(
    composer.getByLabel("Session prompt", { exact: true }),
  ).toHaveValue(`/forgemaster --mini ${exactText}`);
  if (shotDirectory)
    await page.screenshot({
      path: join(shotDirectory, "forge-run-composer-handoff.png"),
    });
  await composer.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(composer).toHaveCount(0);
});

test("a scoped feature bead becomes the exact reviewed prompt input", async ({
  page,
}) => {
  await openRuns(page);
  await launchPreparation(page);
  const preparation = page.getByRole("dialog");
  await preparation.getByLabel("Use a scoped bead").check();
  const bead = preparation.getByLabel("Feature or epic bead");
  await expect(bead).toBeEnabled();
  await bead.selectOption("alpha-epic");
  await preparation
    .getByRole("button", { name: "Review generated prompt" })
    .click();
  await expect(preparation.locator(".af-new-forge-run-prompt")).toHaveText(
    "/forgemaster --full alpha-epic",
  );
  await expect(preparation).toContainText("Scoped bead: alpha-epic");
  await preparation.getByRole("button", { name: "Cancel" }).click();
});

test("the input UI refuses route and smith control tokens without transferring a prompt", async ({
  page,
}) => {
  await openRuns(page);
  await launchPreparation(page);
  const preparation = page.getByRole("dialog");
  const description = preparation.getByLabel("Feature description");
  for (const value of ["--FULL", "Use --mini=full", "Change --Smith=other"]) {
    await description.fill(value);
    await preparation
      .getByRole("button", { name: "Review generated prompt" })
      .click();
    await expect(preparation.getByRole("alert")).toContainText(
      "choose the route above",
    );
    await expect(preparation.locator(".af-new-forge-run-prompt")).toHaveCount(
      0,
    );
  }
  await expect(
    preparation.getByRole("button", { name: "Continue to Claude composer" }),
  ).toHaveCount(0);
  expect(protectedPosts).toEqual([]);
  await preparation.getByRole("button", { name: "Cancel" }).click();
});

test("dirty composer drafts require Keep or Replace and are not changed by Keep", async ({
  page,
}) => {
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/sessions`);
  await page
    .getByRole("button", { name: "New session", exact: true })
    .first()
    .click();
  const composer = page.getByRole("dialog");
  const existingPrompt = "Keep my carefully edited draft.";
  await composer
    .getByLabel("Session prompt", { exact: true })
    .fill(existingPrompt);
  const repository = composer.getByLabel("Session repository", { exact: true });
  const smith = composer.getByLabel("Session smith", { exact: true });
  await expect(repository).toBeEnabled();
  await expect(smith).toBeEnabled();
  const selectedRepository = await repository.inputValue();
  const selectedSmith = await smith.inputValue();
  await composer.getByRole("button", { name: "Cancel", exact: true }).click();

  await navigateToRuns(page);
  await launchPreparation(page);
  let preparation = page.getByRole("dialog");
  await preparation
    .getByLabel("Feature description")
    .fill("A separate request");
  await preparation
    .getByRole("button", { name: "Review generated prompt" })
    .click();
  await preparation
    .getByRole("button", { name: "Continue to Claude composer" })
    .click();
  await expect(preparation).toContainText("already has a draft");
  await preparation.getByRole("button", { name: "Keep current draft" }).click();
  const keptDraftComposer = page.getByRole("dialog", {
    name: "New session · Alpha",
  });
  await expect(
    keptDraftComposer.getByLabel("Session prompt", { exact: true }),
  ).toHaveValue(existingPrompt);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();

  await navigateToRuns(page);
  await launchPreparation(page);
  preparation = page.getByRole("dialog");
  await preparation.getByLabel("Feature description").fill("Replace with this");
  await preparation
    .getByRole("button", { name: "Review generated prompt" })
    .click();
  await preparation
    .getByRole("button", { name: "Continue to Claude composer" })
    .click();
  await preparation
    .getByRole("button", { name: "Replace current draft" })
    .click();
  const replacedComposer = page.getByRole("dialog", {
    name: "New session · Alpha",
  });
  await expect(
    replacedComposer.getByLabel("Session prompt", { exact: true }),
  ).toHaveValue("/forgemaster --full Replace with this");
  await expect(
    replacedComposer.getByLabel("Session repository", { exact: true }),
  ).toHaveValue(selectedRepository);
  await expect(
    replacedComposer.getByLabel("Session smith", { exact: true }),
  ).toHaveValue(selectedSmith);
});

test("Replace changes only feature fields and preserves provider modes", async ({
  page,
}) => {
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/sessions`);
  await page
    .getByRole("button", { name: "New session", exact: true })
    .first()
    .click();
  const composer = page.getByRole("dialog", { name: "New session · Alpha" });
  const provider = composer.getByRole("group", { name: "Provider" });
  const prompt = composer.getByLabel("Session prompt", { exact: true });
  await prompt.fill("@bead:alpha-epic");
  await composer
    .getByRole("group", { name: "Mention suggestions" })
    .getByRole("button", { name: /bead alpha-epic/ })
    .click();
  await expect(
    composer.getByText("About bead alpha-epic", { exact: false }),
  ).toBeVisible();
  const existingPrompt = "Keep all of this composer metadata";
  await prompt.fill(existingPrompt);
  await composer
    .getByLabel("Session attachments", { exact: true })
    .setInputFiles({
      name: "existing.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("preserve unless replaced"),
    });
  await expect(
    composer.getByText("text · existing.txt", { exact: false }),
  ).toBeVisible();
  await composer.getByLabel("Session bead", { exact: true }).fill("alpha-epic");
  await composer
    .getByLabel("Session mode", { exact: true })
    .selectOption("task");
  await expect(
    composer.getByLabel("Session repository", { exact: true }),
  ).toBeEnabled();
  await expect(
    composer.getByLabel("Session smith", { exact: true }),
  ).toBeEnabled();
  await expect(
    composer.getByLabel("Session effort", { exact: true }),
  ).toBeEnabled();
  await composer
    .getByLabel("Session effort", { exact: true })
    .selectOption("high");
  const selectedRepository = await composer
    .getByLabel("Session repository", { exact: true })
    .inputValue();
  const selectedWorktree = await composer
    .getByLabel("Where the session runs")
    .inputValue();
  const selectedSmith = await composer
    .getByLabel("Session smith", { exact: true })
    .inputValue();
  const selectedEffort = await composer
    .getByLabel("Session effort", { exact: true })
    .inputValue();

  await provider.getByRole("button", { name: /Codex/ }).click();
  await composer
    .getByLabel("Session mode", { exact: true })
    .selectOption("chat");
  await expect(
    composer.getByLabel("Session prompt", { exact: true }),
  ).toHaveValue(existingPrompt);
  await provider.getByRole("button", { name: /Gemini/ }).click();
  await composer
    .getByLabel("Session mode", { exact: true })
    .selectOption("chat");
  await expect(
    composer.getByLabel("Session prompt", { exact: true }),
  ).toHaveValue(existingPrompt);
  await provider.getByRole("button", { name: /Claude/ }).click();
  await expect(
    composer.getByLabel("Session prompt", { exact: true }),
  ).toHaveValue(existingPrompt);
  await composer.getByRole("button", { name: "Cancel", exact: true }).click();

  await navigateToRuns(page);
  await launchPreparation(page);
  let preparation = page.getByRole("dialog");
  await preparation
    .getByLabel("Feature description")
    .fill("Keep the complete existing draft");
  await preparation
    .getByRole("button", { name: "Review generated prompt" })
    .click();
  await preparation
    .getByRole("button", { name: "Continue to Claude composer" })
    .click();
  await preparation.getByRole("button", { name: "Keep current draft" }).click();
  const kept = page.getByRole("dialog", { name: "New session · Alpha" });
  await expect(kept.getByLabel("Session prompt", { exact: true })).toHaveValue(
    existingPrompt,
  );
  await expect(
    kept.getByLabel("Session repository", { exact: true }),
  ).toHaveValue(selectedRepository);
  await expect(
    kept.getByLabel("Where the session runs", { exact: true }),
  ).toHaveValue(selectedWorktree);
  await expect(kept.getByLabel("Session smith", { exact: true })).toHaveValue(
    selectedSmith,
  );
  await expect(kept.getByLabel("Session bead", { exact: true })).toHaveValue(
    "alpha-epic",
  );
  await expect(kept.getByLabel("Session mode", { exact: true })).toHaveValue(
    "task",
  );
  await expect(kept.getByLabel("Session effort", { exact: true })).toHaveValue(
    selectedEffort,
  );
  await expect(
    kept.getByText("text · existing.txt", { exact: false }),
  ).toBeVisible();
  await expect(
    kept.getByText("About bead alpha-epic", { exact: false }),
  ).toBeVisible();
  const keptProvider = kept.getByRole("group", { name: "Provider" });
  await keptProvider.getByRole("button", { name: /Codex/ }).click();
  await expect(kept.getByLabel("Session mode", { exact: true })).toHaveValue(
    "chat",
  );
  await keptProvider.getByRole("button", { name: /Gemini/ }).click();
  await expect(kept.getByLabel("Session mode", { exact: true })).toHaveValue(
    "chat",
  );
  await keptProvider.getByRole("button", { name: /Claude/ }).click();
  await kept.getByRole("button", { name: "Cancel", exact: true }).click();

  await navigateToRuns(page);
  await launchPreparation(page);
  preparation = page.getByRole("dialog");
  await preparation
    .getByLabel("Feature description")
    .fill("Replace only the forge feature fields");
  await preparation
    .getByRole("button", { name: "Review generated prompt" })
    .click();
  await preparation
    .getByRole("button", { name: "Continue to Claude composer" })
    .click();
  await preparation
    .getByRole("button", { name: "Replace current draft" })
    .click();

  const replaced = page.getByRole("dialog", { name: "New session · Alpha" });
  await expect(
    replaced.getByLabel("Session prompt", { exact: true }),
  ).toHaveValue("/forgemaster --full Replace only the forge feature fields");
  await expect(
    replaced.getByLabel("Session repository", { exact: true }),
  ).toHaveValue(selectedRepository);
  await expect(
    replaced.getByLabel("Where the session runs", { exact: true }),
  ).toHaveValue(selectedWorktree);
  await expect(
    replaced.getByLabel("Session smith", { exact: true }),
  ).toHaveValue(selectedSmith);
  await expect(
    replaced.getByLabel("Session mode", { exact: true }),
  ).toHaveValue("task");
  await expect(
    replaced.getByLabel("Session effort", { exact: true }),
  ).toHaveValue(selectedEffort);
  await expect(
    replaced.getByLabel("Session bead", { exact: true }),
  ).toHaveValue("");
  await expect(
    replaced.getByText("text · existing.txt", { exact: false }),
  ).toHaveCount(0);
  await expect(
    replaced.getByText("About bead alpha-epic", { exact: false }),
  ).toHaveCount(0);
  const replacedProvider = replaced.getByRole("group", { name: "Provider" });
  await replacedProvider.getByRole("button", { name: /Codex/ }).click();
  await expect(
    replaced.getByLabel("Session mode", { exact: true }),
  ).toHaveValue("chat");
  await expect(
    replaced.getByLabel("Session prompt", { exact: true }),
  ).toHaveValue("/forgemaster --full Replace only the forge feature fields");
  await replacedProvider.getByRole("button", { name: /Gemini/ }).click();
  await expect(
    replaced.getByLabel("Session mode", { exact: true }),
  ).toHaveValue("chat");
  await expect(
    replaced.getByLabel("Session prompt", { exact: true }),
  ).toHaveValue("/forgemaster --full Replace only the forge feature fields");
});

test("A-to-B-to-A navigation invalidates an open Run review", async ({
  page,
}) => {
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/sessions`);
  await page
    .getByRole("button", { name: "New session", exact: true })
    .first()
    .click();
  const composer = page.getByRole("dialog", { name: "New session · Alpha" });
  const originalPrompt = "Keep this session draft after stale navigation";
  await composer
    .getByLabel("Session prompt", { exact: true })
    .fill(originalPrompt);
  await composer.getByRole("button", { name: "Cancel", exact: true }).click();
  await navigateToRuns(page);
  await launchPreparation(page);
  const preparation = page.getByRole("dialog");
  await preparation.getByLabel("Feature description").fill("Stale review");
  await preparation
    .getByRole("button", { name: "Review generated prompt" })
    .click();

  await page.evaluate(
    (hash) => {
      window.location.hash = hash;
    },
    runsHref(beta.id, null),
  );
  await expect(page).toHaveURL(new RegExp(beta.id));
  await expect(
    page.getByRole("heading", {
      name: "No forge runs in this served checkout",
      exact: true,
    }),
  ).toBeVisible();
  await navigateToRuns(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page
      .getByRole("region", { name: "Project forge runs" })
      .getByRole("button", { name: "New forge run", exact: true }),
  ).toBeEnabled();
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, `/desktop/project/${alpha.id}/sessions`);
  await expect(page).toHaveURL(new RegExp(`${alpha.id}/sessions`));
  await page.getByRole("button", { name: "New session", exact: true }).click();
  const unchanged = page.getByRole("dialog", { name: "New session · Alpha" });
  await expect(
    unchanged.getByLabel("Session prompt", { exact: true }),
  ).toHaveValue(originalPrompt);
  await unchanged.getByRole("button", { name: "Cancel", exact: true }).click();
  await navigateToRuns(page);
  await launchPreparation(page);
  const freshPreparation = page.getByRole("dialog");
  await freshPreparation
    .getByLabel("Feature description")
    .fill("Fresh review after navigation");
  await freshPreparation
    .getByRole("button", { name: "Review generated prompt" })
    .click();
  await expect(freshPreparation.locator(".af-new-forge-run-prompt")).toHaveText(
    "/forgemaster --full Fresh review after navigation",
  );
  await freshPreparation.getByRole("button", { name: "Cancel" }).click();
  expect(protectedPosts).toEqual([]);
});

test("an attended prompt uses ordinary Preview and one identity-bound Start after a lost reply", async ({
  page,
}) => {
  const beforeStarts = starts();
  const beforeRecords = records().length;
  writeFileSync(
    join(HEARTH_HOME, "coding-fixture-mode.json"),
    JSON.stringify("normal"),
  );
  await openRuns(page);
  await launchPreparation(page);
  const preparation = page.getByRole("dialog");
  await preparation
    .getByLabel("Feature description")
    .fill("One reviewed request");
  await preparation
    .getByRole("button", { name: "Review generated prompt" })
    .click();
  await preparation
    .getByRole("button", { name: "Continue to Claude composer" })
    .click();

  const composer = page.getByRole("dialog", { name: "New session · Alpha" });
  const expectedPrompt = "/forgemaster --full One reviewed request";
  await expect(
    composer.getByLabel("Session prompt", { exact: true }),
  ).toHaveValue(expectedPrompt);
  await composer.getByLabel("Session effort", { exact: true }).selectOption("");
  await composer
    .getByRole("button", { name: "Check supported options", exact: true })
    .click();
  const start = composer.getByRole("button", { name: "Start", exact: true });
  await expect(start).toBeEnabled();

  let holdRecovery = false;
  let recoveryReadHeld = false;
  let releaseRecovery!: () => void;
  const recoveryGate = new Promise<void>((resolve) => {
    releaseRecovery = resolve;
  });
  releaseIdentityRead = releaseRecovery;
  await page.route(
    `**/__agent-forge/projects/${alpha.id}/session-start-identities`,
    async (route) => {
      if (
        route.request().method() !== "GET" ||
        !holdRecovery ||
        recoveryReadHeld
      ) {
        await route.continue();
        return;
      }
      recoveryReadHeld = true;
      await recoveryGate;
      await route.continue();
    },
  );
  await page.route(
    `**/__agent-forge/projects/${alpha.id}/sessions`,
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      holdRecovery = true;
      await forward(route);
      await route.abort("failed");
    },
  );
  const allowedStartPosts = explicitStartPosts();
  await start.click();
  await expect.poll(() => recoveryReadHeld).toBe(true);
  expect(starts()).toBe(beforeStarts + 1);
  expect(records()).toHaveLength(beforeRecords + 1);
  const original = records().at(-1);
  if (!original)
    throw new Error("The fixture Start did not retain its original");
  let providerInput: { argv: string[]; stdin: string };
  try {
    const recorded: unknown = JSON.parse(
      readFileSync(join(HEARTH_HOME, "coding-fixture-record.json"), "utf8"),
    );
    if (
      !recorded ||
      typeof recorded !== "object" ||
      Array.isArray(recorded) ||
      !("argv" in recorded) ||
      !Array.isArray(recorded.argv) ||
      !("stdin" in recorded) ||
      typeof recorded.stdin !== "string"
    )
      throw new Error("Invalid provider input recording");
    const argv = recorded.argv.filter(
      (value): value is string => typeof value === "string",
    );
    if (argv.length !== recorded.argv.length)
      throw new Error("Invalid provider argv recording");
    providerInput = { argv, stdin: recorded.stdin };
  } catch {
    throw new Error("The inert provider input recording is unavailable");
  }
  expect(providerInput.stdin.includes(expectedPrompt)).toBe(true);
  expect(providerInput.argv.join("\u0000").includes(expectedPrompt)).toBe(
    false,
  );

  await navigateToRuns(page);
  await launchPreparation(page);
  const heldPreparation = page.getByRole("dialog");
  await heldPreparation
    .getByLabel("Feature description")
    .fill("A separate review remains blocked");
  await heldPreparation
    .getByRole("button", { name: "Review generated prompt" })
    .click();
  await heldPreparation
    .getByRole("button", { name: "Continue to Claude composer" })
    .click();
  await expect(heldPreparation.getByRole("alert")).toContainText(
    /identity read to finish|original session request is unresolved/i,
  );
  expect(protectedPosts).toEqual(allowedStartPosts);
  expect(starts()).toBe(beforeStarts + 1);

  releaseRecovery();
  releaseIdentityRead = undefined;
  await expect.poll(() => records().length).toBe(beforeRecords + 1);
  const created = records().at(-1);
  if (!created) throw new Error("The fixture Start did not retain its session");
  expect(created.id).toBe(original.id);
  expect(created.requestId).toBe(original.requestId);
  await expect
    .poll(() => journal(created.id).turns.at(-1)?.phase)
    .toBe("completed");
  expect(created.projectId).toBe(alpha.id);
  expect(created.requestId).toBe(journal(created.id).turns[0]?.requestId);
  expect(journal(created.id).turns).toHaveLength(1);
  expect(starts()).toBe(beforeStarts + 1);
  expect(protectedPosts).toEqual(allowedStartPosts);
});

async function openRuns(page: import("@playwright/test").Page) {
  await openSettled(page, `/index.html${runsHref(alpha.id, null)}`);
  await expect(
    page.getByRole("heading", {
      name: "No forge runs in this served checkout",
      exact: true,
    }),
  ).toBeVisible();
}

async function launchPreparation(page: import("@playwright/test").Page) {
  const runs = page.getByRole("region", { name: "Project forge runs" });
  const launch = runs.getByRole("button", {
    name: "New forge run",
    exact: true,
  });
  await expect(launch).toBeEnabled();
  await launch.click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

async function navigateToRuns(page: import("@playwright/test").Page) {
  await page.evaluate(
    (hash) => {
      window.location.hash = hash;
    },
    runsHref(alpha.id, null),
  );
  await expect(
    page.getByRole("heading", {
      name: "No forge runs in this served checkout",
      exact: true,
    }),
  ).toBeVisible();
}
