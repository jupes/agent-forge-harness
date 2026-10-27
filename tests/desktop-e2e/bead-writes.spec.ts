import { expect, type Route, test } from "@playwright/test";
import { z } from "zod";
import { readState } from "../e2e/bd-stand-in-state";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import { BD_STAND_IN_STATE } from "../e2e/servers";
import { standInCalls } from "../e2e/stand-in";
import { alpha, beta, seedProjects } from "./project-fixtures";

test.beforeEach(() => seedProjects());
const createCalls = () => standInCalls().filter((args) => args[0] === "create");

test("New bead title and description stay separate across delayed options focus", async ({
  page,
}) => {
  let releaseOptions: (() => void) | undefined;
  let markOptionsFinished: (() => void) | undefined;
  let optionsHandlerStarted = false;
  let optionsReadEntered = false;
  const optionsFinished = new Promise<void>((resolve) => {
    markOptionsFinished = resolve;
  });
  const heldOptions = new Promise<void>((resolve) => {
    releaseOptions = resolve;
  });
  const optionsPath = "/__agent-forge/beads/options";
  const createPath = `/__agent-forge/projects/${alpha.id}/beads`;
  const optionsRoute = async (route: Route) => {
    if (route.request().method() !== "GET") return route.continue();
    optionsHandlerStarted = true;
    try {
      const request = route.request();
      const requestOrigin = new URL(request.url()).origin;
      const pageOrigin = new URL(page.url()).origin;
      const headers = await request.allHeaders();
      if (
        requestOrigin !== pageOrigin ||
        (headers.origin !== undefined && headers.origin !== requestOrigin) ||
        (headers["sec-fetch-site"] !== undefined &&
          headers["sec-fetch-site"] !== "same-origin")
      )
        throw Error(
          "The observed options read was not an actual same-origin read.",
        );
      const response = await route.fetch({
        headers: {
          ...headers,
          Origin: requestOrigin,
          "Sec-Fetch-Site": "same-origin",
        },
      });
      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        throw Error("The protected options read did not return valid JSON.");
      }
      const envelope = z
        .object({
          ok: z.literal(true),
          data: z
            .object({
              types: z
                .array(z.enum(["task", "feature", "bug", "chore", "epic"]))
                .min(1)
                .max(5),
              priorities: z
                .array(
                  z
                    .object({
                      value: z.enum(["P0", "P1", "P2", "P3", "P4"]),
                      tier: z.string().max(100),
                      meaning: z.string().max(1000),
                    })
                    .strict(),
                )
                .min(1)
                .max(5),
              defaultPriority: z.enum(["P0", "P1", "P2", "P3", "P4"]),
              complexities: z
                .array(z.enum(["low", "medium", "high"]))
                .length(3),
              limits: z
                .object({
                  title: z.number().int().positive().max(200),
                  description: z.number().int().positive().max(4000),
                  acceptance: z.number().int().positive().max(2000),
                  comment: z.number().int().positive().max(4000),
                  reason: z.number().int().positive().max(1000),
                  labels: z.number().int().positive().max(30),
                  label: z.number().int().positive().max(100),
                  fileMap: z.number().int().positive().max(100),
                })
                .strict(),
            })
            .strict(),
          error: z.null(),
        })
        .strict()
        .safeParse(raw);
      if (response.status() !== 200 || !envelope.success)
        throw Error("The protected options read could not be verified.");
      optionsReadEntered = true;
      await heldOptions;
      await route.fulfill({ response });
    } finally {
      markOptionsFinished?.();
    }
  };
  const optionsResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === optionsPath &&
      response.status() === 200,
    { timeout: 10_000 },
  );
  await page.route(`**${optionsPath}`, optionsRoute);
  try {
    await page.goto(`/index.html#/desktop/project/${alpha.id}/beads`, {
      waitUntil: "load",
    });
    await expect(
      page.getByRole("button", { name: "New bead", exact: true }),
    ).toBeVisible();
    await expect.poll(() => optionsReadEntered, { timeout: 10_000 }).toBe(true);
    await page.getByRole("button", { name: "New bead", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "New bead · Alpha" });
    await expect(dialog.getByRole("status")).toContainText(
      "Loading bead options",
    );

    await page.evaluate(() => {
      const nativeRequest = window.requestAnimationFrame.bind(window);
      const nativeCancel = window.cancelAnimationFrame.bind(window);
      const callbacks = new Map<number, FrameRequestCallback>();
      let nextId = 0;
      window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
        const id = ++nextId;
        callbacks.set(id, callback);
        return id;
      }) as typeof window.requestAnimationFrame;
      window.cancelAnimationFrame = ((id: number) => {
        callbacks.delete(id);
      }) as typeof window.cancelAnimationFrame;
      const target = window as typeof window & {
        __beadFocusFrameGate?: {
          pending(): number;
          release(): Promise<number>;
          restore(): void;
        };
      };
      target.__beadFocusFrameGate = {
        pending: () => callbacks.size,
        async release() {
          const queued = [...callbacks.values()];
          callbacks.clear();
          window.requestAnimationFrame = nativeRequest;
          window.cancelAnimationFrame = nativeCancel;
          await Promise.all(
            queued.map(
              (callback) =>
                new Promise<void>((resolve) => {
                  nativeRequest((time) => {
                    callback(time);
                    resolve();
                  });
                }),
            ),
          );
          return queued.length;
        },
        restore() {
          window.requestAnimationFrame = nativeRequest;
          window.cancelAnimationFrame = nativeCancel;
          callbacks.clear();
        },
      };
    });
    releaseOptions?.();
    await optionsResponse;
    const title = dialog.getByLabel("Title", { exact: true });
    const description = dialog.getByLabel("Description", { exact: true });
    await expect(title).toBeVisible();
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (
                window as typeof window & {
                  __beadFocusFrameGate?: { pending(): number };
                }
              ).__beadFocusFrameGate?.pending() ?? 0,
          ),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);

    await title.fill("Keep fields distinct");
    await dialog
      .getByRole("combobox", { name: "Parent epic", exact: true })
      .selectOption("alpha-epic");
    await description.fill("Preserve this");
    const releasedFrames = await page.evaluate(
      () =>
        (
          window as typeof window & {
            __beadFocusFrameGate?: { release(): Promise<number> };
          }
        ).__beadFocusFrameGate?.release() ?? Promise.resolve(0),
    );
    expect(releasedFrames).toBeGreaterThan(0);
    await page.keyboard.type(" separate description.");

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
        new URL(request.url()).pathname === createPath,
    );
    await dialog.getByRole("button", { name: "Create bead" }).click();
    const request = await createRequest;
    expect(request.postDataJSON()).toMatchObject({
      title: "Keep fields distinct",
      description: "Preserve this separate description.",
    });
  } finally {
    releaseOptions?.();
    await page
      .evaluate(() =>
        (
          window as typeof window & {
            __beadFocusFrameGate?: { restore(): void };
          }
        ).__beadFocusFrameGate?.restore(),
      )
      .catch(() => {});
    if (optionsHandlerStarted) await optionsFinished;
    await page.unroute(`**${optionsPath}`, optionsRoute);
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
