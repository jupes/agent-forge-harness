import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, type Route, test } from "@playwright/test";
import { z } from "zod";
import { projectBeadsPageSchema } from "../../scripts/projects/beads-protocol";
import { readState } from "../e2e/bd-stand-in-state";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import { BD_STAND_IN_STATE, bunPath, HEARTH_HOME } from "../e2e/servers";
import { standInCalls } from "../e2e/stand-in";
import { alpha, beta, seedProjects, workspace } from "./project-fixtures";

test.beforeEach(() => seedProjects());
const createCalls = () => standInCalls().filter((args) => args[0] === "create");

/** A real ledger notification makes the open Beads view perform a background read. */
function appendBeadsRefreshEvent(): void {
  const sessionId = randomUUID();
  const result = spawnSync(
    bunPath(),
    [
      "-e",
      `import { appendEvent } from "./scripts/ledger/append";
const result = appendEvent({kind:"session.started",workspace:process.argv[2],beadId:"alpha-epic",sessionId:process.argv[1],executor:{provider:"codex",model:"fixture-model",smith:"fixture-smith"},payload:{kind:"interactive"}});
if (!result.ok) throw new Error("The inert Beads refresh event was not recorded.");`,
      sessionId,
      workspace,
    ],
    {
      env: { ...process.env, AGENT_FORGE_HOME: HEARTH_HOME },
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    },
  );
  if (result.status !== 0)
    throw new Error("The inert Beads refresh event failed.");
}

test("New bead title and description stay separate across a background refresh", async ({
  page,
}) => {
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/beads`);
  await page.getByRole("button", { name: "New bead", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New bead · Alpha" });
  const title = dialog.getByLabel("Title", { exact: true });
  const description = dialog.getByLabel("Description", { exact: true });
  await title.fill("Keep fields distinct");
  await dialog
    .getByRole("combobox", { name: "Parent epic", exact: true })
    .selectOption("alpha-epic");

  let releaseRead: (() => void) | undefined;
  let markReadFinished: (() => void) | undefined;
  let readEntered = false;
  let refreshHandlerStarted = false;
  const readFinished = new Promise<void>((resolve) => {
    markReadFinished = resolve;
  });
  const heldRead = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const listPath = `/__agent-forge/projects/${alpha.id}/beads`;
  const refreshHandler = async (route: Route) => {
    if (route.request().method() !== "GET") return route.continue();
    refreshHandlerStarted = true;
    try {
      const request = route.request();
      const requestOrigin = new URL(request.url()).origin;
      const headers = await request.allHeaders();
      if (
        headers.origin !== requestOrigin ||
        headers["sec-fetch-site"] !== "same-origin"
      )
        throw Error(
          "The observed Beads refresh was not an actual same-origin read.",
        );
      const response = await route.fetch({ headers });
      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        throw Error("The protected Beads refresh did not return valid JSON.");
      }
      const envelope = z
        .object({
          ok: z.literal(true),
          data: projectBeadsPageSchema,
          error: z.null(),
        })
        .strict()
        .safeParse(raw);
      if (
        response.status() !== 200 ||
        !envelope.success ||
        envelope.data.data.projectId !== alpha.id ||
        envelope.data.data.workspace !== workspace ||
        !envelope.data.data.complete
      )
        throw Error("The protected Beads refresh could not be verified.");
      readEntered = true;
      await heldRead;
      await route.fulfill({ response });
    } finally {
      markReadFinished?.();
    }
  };
  const refreshed = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === listPath &&
      response.status() === 200,
    { timeout: 10_000 },
  );
  await page.route(`**${listPath}`, refreshHandler);
  try {
    appendBeadsRefreshEvent();
    await expect.poll(() => readEntered, { timeout: 10_000 }).toBe(true);
    await description.fill("Preserve this separate description.");
    await description.click();
    releaseRead?.();
    await refreshed;

    const stateAfterRead = await dialog.evaluate((root) => {
      const control = (labelText: string) => {
        const label = Array.from(root.querySelectorAll("label")).find((item) =>
          item.textContent?.trim().startsWith(labelText),
        );
        return (
          label?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
            "input, textarea",
          ) ?? null
        );
      };
      const titleControl = control("Title");
      const descriptionControl = control("Description");
      return {
        title: titleControl?.value ?? null,
        description: descriptionControl?.value ?? null,
        titleFocused: document.activeElement === titleControl,
        descriptionFocused: document.activeElement === descriptionControl,
      };
    });
    expect(stateAfterRead).toEqual({
      title: "Keep fields distinct",
      description: "Preserve this separate description.",
      titleFocused: false,
      descriptionFocused: true,
    });

    const createRequest = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname === listPath,
    );
    await dialog.getByRole("button", { name: "Create bead" }).click();
    const request = await createRequest;
    expect(request.postDataJSON()).toMatchObject({
      title: "Keep fields distinct",
      description: "Preserve this separate description.",
    });
  } finally {
    releaseRead?.();
    if (refreshHandlerStarted) await readFinished;
    await page.unroute(`**${listPath}`, refreshHandler);
  }
});

test("rich New bead, Proposed, claim, live comment and evidence close use confirmed scoped writes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/beads`);
  const open = page.getByRole("button", { name: "New bead", exact: true });
  await expect(open).toBeEnabled();
  const before = createCalls().length;
  await open.click();
  let dialog = page.getByRole("dialog", { name: "New bead · Alpha" });
  await expect(dialog.getByLabel("Title", { exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(open).toBeFocused();
  expect(createCalls()).toHaveLength(before);
  await open.click();
  dialog = page.getByRole("dialog", { name: "New bead · Alpha" });
  await dialog
    .getByLabel("Title", { exact: true })
    .fill("Verify the forge lantern");
  await dialog
    .getByRole("combobox", { name: "Type", exact: true })
    .selectOption("feature");
  await dialog
    .getByRole("combobox", { name: "Priority", exact: true })
    .selectOption("P4");
  await dialog
    .getByRole("combobox", { name: "Parent epic", exact: true })
    .selectOption("alpha-epic");
  await dialog
    .getByLabel("Description", { exact: true })
    .fill("Keep the exact description.");
  await dialog
    .getByLabel("Acceptance criteria · one per line", { exact: true })
    .fill("Verify the lantern\nRecord the evidence");
  await dialog
    .getByLabel("Labels · comma separated", { exact: true })
    .fill("desktop, reviewed");
  await dialog
    .getByRole("combobox", { name: "Complexity", exact: true })
    .selectOption("low");
  await dialog
    .getByLabel("File map · one relative glob per line", { exact: true })
    .fill("apps/desktop/src/**");
  await dialog
    .getByRole("combobox", { name: "Initial state", exact: true })
    .selectOption("proposed");
  await page.screenshot({
    path: "apps/desktop/docs/screenshots/beads-new-options.png",
  });
  await dialog.getByLabel("Title", { exact: true }).focus();
  await page.screenshot({
    path: "apps/desktop/docs/screenshots/beads-new.png",
  });
  await dialog
    .getByRole("button", { name: "Create bead", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("as Proposed");
  expect(createCalls()).toHaveLength(before + 1);
  const bead = Object.values(readState(BD_STAND_IN_STATE)).find(
    (item) => item.title === "Verify the forge lantern",
  );
  if (!bead) throw Error("Missing created fixture bead");
  expect(bead.priority).toBe(4);
  expect(bead.labels).toEqual(
    expect.arrayContaining([
      "project:alpha",
      "desktop",
      "reviewed",
      "complexity:low",
      "queue:proposed",
    ]),
  );
  expect(bead.labels).not.toContain("queue:approved");
  expect(bead.description).toContain("## Files\napps/desktop/src/**");
  expect(bead.acceptance_criteria).toBe(
    "- [ ] Verify the lantern\n- [ ] Record the evidence",
  );
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .getByRole("region", { name: "Current bead write" })
    .getByRole("link", { name: `Check ${bead.id}`, exact: true })
    .click();
  const panel = page
    .getByRole("main")
    .getByRole("region", { name: `Bead ${bead.id}`, exact: true });
  await panel.getByRole("button", { name: "Claim", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "Claim", exact: true }),
  ).toBeDisabled();
  await expect
    .poll(() => readState(BD_STAND_IN_STATE)[bead.id]?.status)
    .toBe("in_progress");
  await panel.getByRole("button", { name: "Comment", exact: true }).click();
  await panel
    .getByLabel("Comment text", { exact: true })
    .fill("worklog: verified the isolated fixture");
  await panel.getByRole("button", { name: "Add comment", exact: true }).click();
  await panel.getByRole("tab", { name: "Comments", exact: true }).click();
  await expect(panel.getByRole("tabpanel")).toContainText(
    "worklog: verified the isolated fixture",
  );
  await panel.getByRole("button", { name: "Close bead", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "Close with evidence", exact: true }),
  ).toBeDisabled();
  await panel
    .getByLabel("Evidence for closing", { exact: true })
    .fill("ac: all criteria verified by the fake tracker journey");
  await panel
    .getByRole("button", { name: "Close with evidence", exact: true })
    .click();
  await expect
    .poll(() => readState(BD_STAND_IN_STATE)[bead.id]?.status)
    .toBe("closed");
  await expect(panel).toContainText("closed");
  await expect(
    panel.getByRole("button", { name: "Claim", exact: true }),
  ).toBeDisabled();
});

test("lost create reply stays held in Inbox across project navigation and reload without repeating", async ({
  page,
}) => {
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/beads`);
  const before = createCalls().length;
  await page.route(
    `**/__agent-forge/projects/${alpha.id}/beads`,
    async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch({
        headers: {
          ...(await route.request().allHeaders()),
          Origin: new URL(route.request().url()).origin,
          "Sec-Fetch-Site": "same-origin",
        },
      });
      expect(response.status()).toBe(201);
      await route.abort("connectionreset");
    },
  );
  await page.getByRole("button", { name: "New bead", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New bead · Alpha" });
  await dialog
    .getByLabel("Title", { exact: true })
    .fill("Preserve a lost write receipt");
  await dialog
    .getByRole("combobox", { name: "Parent epic", exact: true })
    .selectOption("alpha-epic");
  await dialog
    .getByRole("button", { name: "Create bead", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("Outcome unknown");
  expect(createCalls()).toHaveLength(before + 1);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.goto(`/index.html#/desktop/project/${beta.id}/beads`);
  await expect(
    page.getByText("Preserve a lost write receipt", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "Global", exact: true })
    .getByRole("link", { name: "Inbox", exact: true })
    .click();
  const inbox = page.getByRole("region", { name: "Bead write outcomes" });
  await expect(inbox).toContainText("Preserve a lost write receipt");
  await reloadSettled(page);
  await expect(inbox).toContainText("Outcome unknown");
  await inbox
    .getByRole("link", { name: "Check project beads", exact: true })
    .click();
  await page.getByRole("button", { name: "New bead", exact: true }).click();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("button", { name: "Create bead", exact: true }),
  ).toBeDisabled();
  expect(createCalls()).toHaveLength(before + 1);
});

test("two desktop windows serialize shared write history and retain both lost receipts after reload", async ({
  page,
  context,
}) => {
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/beads`);
  const second = await context.newPage();
  await openSettled(second, `/index.html#/desktop/project/${beta.id}/beads`);
  let release = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let applied = () => {};
  const firstApplied = new Promise<void>((resolve) => {
    applied = resolve;
  });
  const before = createCalls().length;
  await page.route(
    `**/__agent-forge/projects/${alpha.id}/beads`,
    async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch({
        headers: {
          ...(await route.request().allHeaders()),
          Origin: new URL(route.request().url()).origin,
          "Sec-Fetch-Site": "same-origin",
        },
      });
      expect(response.status()).toBe(201);
      applied();
      await hold;
      await route.abort("connectionreset");
    },
  );
  await second.route(
    `**/__agent-forge/projects/${beta.id}/beads`,
    async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch({
        headers: {
          ...(await route.request().allHeaders()),
          Origin: new URL(route.request().url()).origin,
          "Sec-Fetch-Site": "same-origin",
        },
      });
      expect(response.status()).toBe(201);
      await route.abort("connectionreset");
    },
  );
  try {
    await page.getByRole("button", { name: "New bead", exact: true }).click();
    const a = page.getByRole("dialog", { name: "New bead · Alpha" });
    await a
      .getByLabel("Title", { exact: true })
      .fill("Retain the Alpha window receipt");
    await a
      .getByRole("combobox", { name: "Parent epic", exact: true })
      .selectOption("alpha-epic");
    await a.getByRole("button", { name: "Create bead", exact: true }).click();
    await firstApplied;
    await second.getByRole("button", { name: "New bead", exact: true }).click();
    const b = second.getByRole("dialog", { name: "New bead · Beta" });
    await b
      .getByLabel("Title", { exact: true })
      .fill("Retain the Beta window receipt");
    await b
      .getByRole("combobox", { name: "Parent epic", exact: true })
      .selectOption("beta-epic");
    await b.getByRole("button", { name: "Create bead", exact: true }).click();
    await expect(
      b.getByRole("button", { name: "Create bead", exact: true }),
    ).toBeDisabled();
    expect(createCalls()).toHaveLength(before + 1);
    release();
    await expect(a.getByRole("status")).toContainText("Outcome unknown");
    await expect(b.getByRole("status")).toContainText("Outcome unknown");
    expect(createCalls()).toHaveLength(before + 2);
    await page.goto("/index.html#/desktop/inbox");
    await reloadSettled(page);
    const inbox = page.getByRole("region", { name: "Bead write outcomes" });
    await expect(inbox).toContainText("Retain the Alpha window receipt");
    await expect(inbox).toContainText("Retain the Beta window receipt");
    expect(createCalls()).toHaveLength(before + 2);
  } finally {
    release();
    await second.close();
  }
});
