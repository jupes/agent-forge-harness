import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, type Request, test } from "@playwright/test";
import { z } from "zod";
import {
  keeperShiftStartReceiptSchema,
  keeperShiftStartRequestSchema,
} from "../../scripts/keeper/shift-start-protocol";
import { workspaceKey } from "../../scripts/projects/scope";
import { FIXTURE_PROJECT_ID } from "../../scripts/projects/testing";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import { bunPath } from "../e2e/servers";
import {
  checkedFixtureRoot,
  fixtureMode,
  HOME,
  REPOSITORY,
  resetTracker,
  STATE,
} from "./environment";

const keeperRoute = `/index.html#/desktop/project/${FIXTURE_PROJECT_ID}/keeper`;
const workbenchRoute = `/index.html#/desktop/project/${FIXTURE_PROJECT_ID}/workbench`;
const card = (page: Page) =>
  page.getByRole("article", { name: "Review a fixture Shift", exact: true });
const reviewDialog = (page: Page) =>
  page.getByRole("dialog", { name: "Review Keeper Shift", exact: true });
let fixtureProposalId = "";

function seedShiftProposal() {
  checkedFixtureRoot();
  const proposal = {
    title: "Review a fixture Shift",
    detail: "Review the full bounded Shift before starting.",
    action: {
      kind: "start-shift",
      durationMinutes: 45,
      concurrency: 2,
      beadLimit: 5,
      spendLimitUsd: 8,
    },
  };
  const program = `
    import { randomUUID } from "node:crypto";
    import { rmSync } from "node:fs";
    import { createConversationStore } from "./scripts/conversations/store";
    import { conversationFile } from "./scripts/conversations/paths";
    import { eventSchema } from "./scripts/conversations/protocol";
    const [projectId, text] = process.argv.slice(1);
    const home = process.env.AGENT_FORGE_HOME;
    if (!home) throw new Error("The isolated Keeper fixture home is missing.");
    rmSync(conversationFile(home, projectId), { force: true });
    const store = createConversationStore(home);
    const requestId = randomUUID(), owner = randomUUID();
    await store.accept(projectId, { requestId, expectedRevision: 0, text: "Fixture proposal", about: [] });
    await store.start(projectId, requestId, owner);
    await store.append(projectId, requestId, owner, { kind: "identity", provider: "claude", sessionId: randomUUID(), version: "fixture" });
    await store.append(projectId, requestId, owner, eventSchema.parse({ kind: "text", text }));
    await store.finish(projectId, requestId, owner, "completed", null);
    process.stdout.write(JSON.stringify({ sourceRequestId: requestId }) + "\\n");
  `;
  const seeded = spawnSync(
    bunPath(),
    [
      "-e",
      program,
      FIXTURE_PROJECT_ID,
      JSON.stringify({
        kind: "keeper.proposals.v1",
        message: "Review this inert fixture action.",
        proposals: [proposal],
      }),
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, AGENT_FORGE_HOME: HOME },
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    },
  );
  if (seeded.status !== 0)
    throw Error(
      `Could not seed the isolated Keeper conversation: ${seeded.stderr}`,
    );
  let seededIdentity: unknown;
  try {
    seededIdentity = JSON.parse(seeded.stdout.trim());
  } catch {
    throw Error("The isolated Keeper fixture returned no source identity.");
  }
  const identity = z
    .object({ sourceRequestId: z.string().uuid() })
    .parse(seededIdentity);
  fixtureProposalId = `proposal-${identity.sourceRequestId}-0`;
}

function fixtureProvider() {
  try {
    return z
      .object({
        pid: z.number().int().positive(),
        childPid: z.number().int().positive().nullable(),
      })
      .parse(JSON.parse(readFileSync(join(STATE, "claude.json"), "utf8")));
  } catch {
    return null;
  }
}

function registeredShiftIds(): string[] {
  const program = `
    import { createProjectShiftRegistry } from "./scripts/shifts/registry";
    const [home, root, projectId] = process.argv.slice(1);
    const records = createProjectShiftRegistry({ home, root }).list(projectId);
    process.stdout.write(JSON.stringify(records.map(({ shiftId }) => shiftId)) + "\\n");
  `;
  const read = spawnSync(
    bunPath(),
    ["-e", program, HOME, REPOSITORY, FIXTURE_PROJECT_ID],
    {
      cwd: process.cwd(),
      env: { ...process.env, AGENT_FORGE_HOME: HOME },
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    },
  );
  if (read.status !== 0)
    throw Error(
      `Could not read the production Shift registry (status ${String(read.status)}, signal ${String(read.signal)}): ${read.stderr}`,
    );
  let raw: unknown;
  try {
    raw = JSON.parse(read.stdout.trim());
  } catch {
    throw Error("The production Shift registry reader returned invalid JSON.");
  }
  return z
    .array(z.string().regex(/^shift-\d{8}-\d{6}-[0-9a-f]{4}$/))
    .parse(raw);
}

function providerAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const admissionExecutorSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    effort: z.string().optional(),
    smith: z.string().optional(),
    sessionId: z.string().optional(),
  })
  .strict();
const admissionEventBaseSchema = z.object({
  id: z.number().int().positive(),
  beadId: z.string().nullable(),
  runId: z.string().nullable(),
  sessionId: z.string().nullable(),
  executor: admissionExecutorSchema.nullable(),
});
const admissionEvidenceSchema = z.array(
  z.discriminatedUnion("kind", [
    admissionEventBaseSchema.extend({
      kind: z.literal("operator.action"),
      payload: z
        .object({
          action: z.string().min(1),
          surface: z.enum(["ui", "cli", "mcp", "api"]),
          target: z.string().optional(),
        })
        .passthrough(),
    }),
    admissionEventBaseSchema.extend({
      kind: z.literal("shift.started"),
      payload: z
        .object({
          shiftId: z.string().regex(/^shift-\d{8}-\d{6}-[0-9a-f]{4}$/),
          concurrency: z.number().int().positive(),
          durationMs: z.number().int().nonnegative().optional(),
          filter: z.string().optional(),
          maxBeads: z.number().int().positive().optional(),
          maxUsd: z.number().finite().nonnegative().optional(),
        })
        .passthrough(),
    }),
    admissionEventBaseSchema.extend({
      kind: z.literal("session.started"),
      runId: z.string().min(1).nullable(),
      sessionId: z.string().min(1).nullable(),
      payload: z
        .object({
          source: z.string().optional(),
          kind: z
            .enum(["interactive", "teammate", "subagent", "headless", "remote"])
            .optional(),
          worktree: z.string().min(1).optional(),
          parentSessionId: z.string().min(1).optional(),
        })
        .passthrough(),
    }),
  ]),
);

function shiftAdmissionEvidence(shiftId: string) {
  const program = `
    import { queryEvents } from "./scripts/ledger/query";
    const [workspace, path, proposalId, shiftId] = process.argv.slice(1);
    const audit = queryEvents({ workspace, kinds: ["operator.action"] }, { path }).filter(event => event.payload.action === "keeper.proposal.shift.start" && event.payload.target === proposalId);
    const execution = queryEvents({ workspace, shiftId }, { path }).filter(event => event.kind === "shift.started" || event.kind === "session.started");
    process.stdout.write(JSON.stringify([...audit, ...execution].map(event => ({ id: event.id, kind: event.kind, payload: event.payload, beadId: event.beadId ?? null, runId: event.runId ?? null, sessionId: event.sessionId ?? null, executor: event.executor ?? null }))) + "\\n");
  `;
  const read = spawnSync(
    bunPath(),
    [
      "-e",
      program,
      REPOSITORY,
      join(HOME, "ledger.db"),
      fixtureProposalId,
      shiftId,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, AGENT_FORGE_HOME: HOME },
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    },
  );
  if (read.status !== 0)
    throw Error(
      `Could not read isolated Shift admission evidence: ${read.stderr}`,
    );
  let raw: unknown;
  try {
    raw = JSON.parse(read.stdout.trim());
  } catch {
    throw Error("The isolated Shift admission evidence was not valid JSON.");
  }
  return admissionEvidenceSchema.parse(raw);
}

async function waitForShiftAdmissionEvidence(shiftId: string) {
  let latest = shiftAdmissionEvidence(shiftId);
  const counts = () => ({
    canonicalStarts: latest.filter((event) => event.kind === "shift.started")
      .length,
    providerStarts: latest.filter((event) => event.kind === "session.started")
      .length,
  });
  try {
    await expect
      .poll(
        () => {
          latest = shiftAdmissionEvidence(shiftId);
          return {
            canonicalStarted: counts().canonicalStarts > 0,
            providerStarted: counts().providerStarts > 0,
          };
        },
        {
          timeout: 25_000,
          intervals: [250, 500, 750],
          message:
            "Wait for this original Shift's persisted canonical and provider admission events",
        },
      )
      .toEqual({ canonicalStarted: true, providerStarted: true });
  } catch (error) {
    const facts = {
      shiftId,
      counts: counts(),
      events: latest.slice(0, 6).map((event) => ({
        id: event.id,
        kind: event.kind,
        payload:
          event.kind === "shift.started"
            ? {
                shiftId: event.payload.shiftId,
                concurrency: event.payload.concurrency,
                durationMs: event.payload.durationMs,
                maxBeads: event.payload.maxBeads,
                maxUsd: event.payload.maxUsd,
                filter: event.payload.filter,
              }
            : event.kind === "operator.action"
              ? {
                  action: event.payload.action,
                  surface: event.payload.surface,
                  target: event.payload.target,
                }
              : {
                  source: event.payload.source,
                  kind: event.payload.kind,
                  hasWorktree: event.payload.worktree !== undefined,
                },
        beadId: event.beadId,
        runId: event.runId,
        sessionId: event.sessionId,
        executor:
          event.executor === null
            ? null
            : {
                provider: event.executor.provider,
                model: event.executor.model,
                smith: event.executor.smith,
              },
      })),
    };
    try {
      await test.info().attach("Keeper Shift admission wait facts", {
        body: JSON.stringify(facts, null, 2),
        contentType: "application/json",
      });
    } catch {
      // Keep the source-based wait failure primary if the report cannot attach.
    }
    throw error;
  }
  return latest;
}

test.beforeEach(() => {
  checkedFixtureRoot();
  resetTracker();
  fixtureMode("hang-tree");
  rmSync(join(STATE, "claude.json"), { force: true });
  seedShiftProposal();
});

test("a lost Keeper Shift Start reply recovers one exact original after reload on both surfaces", async ({
  page,
}) => {
  test.setTimeout(120_000);
  let primaryError: unknown = null;
  const cleanupProblems: string[] = [];
  let shiftId: string | null = null;
  let originalRequestId: string | null = null;
  let baselineShiftIds = new Set<string>();
  let provider: ReturnType<typeof fixtureProvider> = null;
  let requestObserver: ((request: Request) => void) | null = null;
  const startBodies: unknown[] = [];
  const keeperWrites: string[] = [];
  const protectedReads: unknown[] = [];
  const protectedReadPaths: string[] = [];
  try {
    await openSettled(page, workbenchRoute);
    baselineShiftIds = new Set(
      await page
        .locator("[data-shift]")
        .evaluateAll((rows) =>
          rows
            .map((row) => row.getAttribute("data-shift"))
            .filter((id): id is string => id !== null),
        ),
    );
    for (const id of registeredShiftIds()) baselineShiftIds.add(id);
    await openSettled(page, keeperRoute);
    await card(page)
      .getByRole("button", { name: "Review Shift", exact: true })
      .click();
    let dialog = reviewDialog(page);
    await expect(dialog.getByRole("textbox", { name: "Duration" })).toHaveValue(
      "45m",
    );
    await dialog.getByRole("textbox", { name: "Duration" }).fill("1m");
    await dialog.getByRole("spinbutton", { name: "Concurrency" }).fill("1");
    await dialog.getByRole("spinbutton", { name: "Maximum beads" }).fill("1");
    await dialog.getByRole("spinbutton", { name: "Spend cap (USD)" }).fill("5");
    await dialog.getByRole("spinbutton", { name: "Repair attempts" }).fill("0");
    await dialog.getByRole("textbox", { name: "Base branch" }).fill("main");
    await dialog
      .getByRole("combobox", { name: "Epic filter" })
      .selectOption("alpha-epic");
    await dialog
      .getByRole("combobox", { name: "Smith override" })
      .selectOption("claude-journeyman");
    await dialog
      .getByRole("textbox", { name: "Per-run timeout (optional)" })
      .fill("20m");

    requestObserver = (request) => {
      if (request.method() !== "POST") return;
      const path = new URL(request.url()).pathname;
      if (
        path.includes(`/projects/${FIXTURE_PROJECT_ID}/keeper/proposals/`) ||
        path === `/__agent-forge/projects/${FIXTURE_PROJECT_ID}/shifts`
      )
        keeperWrites.push(path);
    };
    page.on("request", requestObserver);
    await page.route(
      `**/__agent-forge/projects/${FIXTURE_PROJECT_ID}/keeper/proposals/*/shift-start`,
      async (intercept) => {
        if (intercept.request().method() !== "POST")
          return intercept.continue();
        const parsed = keeperShiftStartRequestSchema.safeParse(
          intercept.request().postDataJSON(),
        );
        if (!parsed.success) {
          await intercept.abort("failed");
          throw Error("The reviewed Keeper Shift request was invalid.");
        }
        startBodies.push(parsed.data);
        originalRequestId = parsed.data.start.requestId;
        let responseProblem: string | null = null;
        try {
          const actual = await intercept.fetch({
            headers: {
              ...(await intercept.request().allHeaders()),
              origin: new URL(page.url()).origin,
              "sec-fetch-site": "same-origin",
            },
          });
          if (actual.status() !== 200)
            throw Error(`Keeper Shift Start returned ${actual.status()}.`);
          const body = await actual.json();
          const receipt = keeperShiftStartReceiptSchema.safeParse(body.data);
          if (!receipt.success)
            throw Error("The admitted Keeper original receipt was invalid.");
          if (
            receipt.data.original.start.requestId !==
              parsed.data.start.requestId ||
            JSON.stringify(receipt.data.original) !==
              JSON.stringify(parsed.data)
          )
            throw Error(
              "The admitted receipt did not retain the exact reviewed request.",
            );
          shiftId = receipt.data.shift?.intent.shiftId ?? null;
          if (!shiftId)
            throw Error(
              "The real Keeper Start admission has no canonical Shift receipt.",
            );
          provider = fixtureProvider();
        } catch (error) {
          responseProblem =
            error instanceof Error
              ? error.message
              : "Start response verification failed.";
        }
        await intercept.abort("failed");
        if (responseProblem) throw Error(responseProblem);
      },
    );
    await page.route(
      `**/__agent-forge/projects/${FIXTURE_PROJECT_ID}/keeper/proposals/*/shift-start/*`,
      async (intercept) => {
        if (intercept.request().method() !== "GET") return intercept.continue();
        protectedReadPaths.push(new URL(intercept.request().url()).pathname);
        const actual = await intercept.fetch({
          headers: {
            ...(await intercept.request().allHeaders()),
            origin: new URL(page.url()).origin,
            "sec-fetch-site": "same-origin",
          },
        });
        if (actual.ok()) {
          const body = await actual.json();
          const receipt = keeperShiftStartReceiptSchema.safeParse(body.data);
          if (receipt.success) protectedReads.push(receipt.data);
          await intercept.fulfill({ response: actual, json: body });
        } else await intercept.fulfill({ response: actual });
      },
    );

    await dialog
      .getByRole("button", { name: "Start reviewed shift", exact: true })
      .click();
    await expect(dialog).toContainText(
      "Check the exact original Shift request",
    );
    expect(startBodies).toHaveLength(1);
    const reviewed = keeperShiftStartRequestSchema.parse(startBodies[0]);
    expect(reviewed.start.options).toEqual({
      for: "1m",
      concurrency: 1,
      maxBeads: 1,
      maxUsd: 5,
      repairs: 0,
      base: "main",
      epic: "alpha-epic",
      smith: "claude-journeyman",
      runTimeout: "20m",
    });
    const requestId = originalRequestId;
    if (!requestId) throw Error("The reviewed Start UUID was not retained.");
    const admittedShiftId = shiftId;
    if (!admittedShiftId)
      throw Error("The actual canonical Shift ID was not retained.");
    expect(registeredShiftIds()).toContain(admittedShiftId);
    const evidenceAfterAdmission =
      await waitForShiftAdmissionEvidence(admittedShiftId);
    const keeperAudit = evidenceAfterAdmission.filter(
      (event) => event.kind === "operator.action",
    );
    const canonicalStart = evidenceAfterAdmission.filter(
      (event) => event.kind === "shift.started",
    );
    expect(keeperAudit).toHaveLength(1);
    expect(canonicalStart).toHaveLength(1);
    expect(keeperAudit[0]?.payload).toMatchObject({
      action: "keeper.proposal.shift.start",
      surface: "ui",
      target: fixtureProposalId,
    });
    expect(keeperAudit[0]!.id).toBeLessThan(canonicalStart[0]!.id);
    expect(canonicalStart[0]!.payload).toMatchObject({
      shiftId: admittedShiftId,
      concurrency: 1,
      durationMs: 60_000,
      maxBeads: 1,
      maxUsd: 5,
      filter: "epic:alpha-epic",
    });
    const providerAdmissions = evidenceAfterAdmission.filter(
      (event) => event.kind === "session.started",
    );
    expect(providerAdmissions).toHaveLength(1);
    expect(providerAdmissions[0]).toMatchObject({
      beadId: "alpha-work",
      runId: `alpha-work-${admittedShiftId}`,
      sessionId: expect.any(String),
      payload: {
        source: "headless:claude",
        kind: "headless",
      },
      executor: {
        provider: "claude",
        model: expect.any(String),
        smith: "claude-journeyman",
      },
    });
    await expect.poll(() => fixtureProvider()).not.toBeNull();
    provider = fixtureProvider();
    if (!provider)
      throw Error("The inert provider fixture did not record its owned PID.");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

    const writesBeforeKeeperReopen = keeperWrites.length;
    await reloadSettled(page);
    await expect(
      card(page).getByRole("button", {
        name: "Review original Start",
        exact: true,
      }),
    ).toBeVisible();
    await card(page)
      .getByRole("button", { name: "Review original Start", exact: true })
      .click();
    dialog = reviewDialog(page);
    await expect(dialog).toContainText("Exact original");
    await expect(dialog).toContainText(requestId);
    await expect.poll(() => protectedReads.length).toBe(1);
    const recovered = keeperShiftStartReceiptSchema.parse(protectedReads[0]);
    expect(recovered.original).toEqual(reviewed);
    expect(recovered.record.requestId).toBe(requestId);
    expect(recovered.record.auditEventId).toBe(keeperAudit[0]?.id);
    shiftId ??= recovered.shift?.intent.shiftId ?? null;
    const fullProtectedPath = protectedReadPaths[0];
    if (!fullProtectedPath)
      throw Error("The full Keeper protected read did not complete.");
    expect(recovered.projectId).toBe(FIXTURE_PROJECT_ID);
    expect(recovered.proposalId).toBe(fixtureProposalId);
    expect(workspaceKey(recovered.workspace)).toBe(workspaceKey(REPOSITORY));
    expect(fullProtectedPath).toBe(
      `/__agent-forge/projects/${FIXTURE_PROJECT_ID}/keeper/proposals/${fixtureProposalId}/shift-start/${requestId}`,
    );
    expect(keeperWrites).toEqual([
      `/__agent-forge/projects/${FIXTURE_PROJECT_ID}/keeper/proposals/${fixtureProposalId}/shift-start`,
    ]);
    expect(keeperWrites.slice(writesBeforeKeeperReopen)).toEqual([]);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

    await page
      .getByRole("link", { name: "Overview", exact: true })
      .first()
      .click();
    await reloadSettled(page);
    await page.getByRole("button", { name: "Ask Keeper", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Forge Keeper · Alpha" });
    await drawer
      .getByRole("article", { name: "Review a fixture Shift", exact: true })
      .getByRole("button", { name: "Review original Start", exact: true })
      .click();
    dialog = reviewDialog(page);
    await expect(dialog).toContainText(requestId);
    await expect.poll(() => protectedReads.length).toBe(2);
    expect(
      keeperShiftStartReceiptSchema.parse(protectedReads[1]).original,
    ).toEqual(reviewed);
    const drawerProtectedPath = protectedReadPaths[1];
    if (!drawerProtectedPath)
      throw Error("The drawer Keeper protected read did not complete.");
    expect(drawerProtectedPath).toBe(
      `/__agent-forge/projects/${FIXTURE_PROJECT_ID}/keeper/proposals/${fixtureProposalId}/shift-start/${requestId}`,
    );
    expect(keeperWrites).toEqual([
      `/__agent-forge/projects/${FIXTURE_PROJECT_ID}/keeper/proposals/${fixtureProposalId}/shift-start`,
    ]);
    expect(keeperWrites.slice(writesBeforeKeeperReopen)).toEqual([]);
    const completedEvidence = shiftAdmissionEvidence(admittedShiftId);
    expect(
      completedEvidence.filter((event) => event.kind === "operator.action"),
    ).toHaveLength(1);
    expect(
      completedEvidence.filter((event) => event.kind === "shift.started"),
    ).toHaveLength(1);
    expect(
      completedEvidence.filter((event) => event.kind === "session.started"),
    ).toHaveLength(1);
    expect(
      registeredShiftIds().filter((id) => !baselineShiftIds.has(id)),
    ).toEqual([admittedShiftId]);
  } catch (error) {
    primaryError = error;
  } finally {
    await page
      .unroute(
        `**/__agent-forge/projects/${FIXTURE_PROJECT_ID}/keeper/proposals/*/shift-start`,
      )
      .catch((error: unknown) => {
        cleanupProblems.push(
          error instanceof Error ? error.message : String(error),
        );
      });
    await page
      .unroute(
        `**/__agent-forge/projects/${FIXTURE_PROJECT_ID}/keeper/proposals/*/shift-start/*`,
      )
      .catch((error: unknown) => {
        cleanupProblems.push(
          error instanceof Error ? error.message : String(error),
        );
      });
    if (requestObserver) page.off("request", requestObserver);
    provider ??= fixtureProvider();
    try {
      const startDialog = reviewDialog(page);
      if (await startDialog.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await page.keyboard.press("Escape");
      }
    } catch (cleanupError) {
      cleanupProblems.push(
        cleanupError instanceof Error
          ? cleanupError.message
          : String(cleanupError),
      );
    }
    try {
      const keeperDrawer = page.getByRole("dialog", {
        name: "Forge Keeper · Alpha",
        exact: true,
      });
      if (await keeperDrawer.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await page.keyboard.press("Escape");
      }
    } catch (cleanupError) {
      cleanupProblems.push(
        cleanupError instanceof Error
          ? cleanupError.message
          : String(cleanupError),
      );
    }
    if (shiftId === null) {
      try {
        shiftId =
          registeredShiftIds().find((id) => !baselineShiftIds.has(id)) ?? null;
      } catch (cleanupError) {
        cleanupProblems.push(
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError),
        );
      }
    }
    if (shiftId === null) {
      try {
        await openSettled(page, workbenchRoute);
        const newShift = await page
          .locator("[data-shift]")
          .evaluateAll(
            (rows, baselineIds) =>
              rows
                .map((row) => row.getAttribute("data-shift"))
                .find(
                  (id): id is string =>
                    id !== null && !baselineIds.includes(id),
                ) ?? null,
            [...baselineShiftIds],
          );
        shiftId = newShift;
      } catch (cleanupError) {
        cleanupProblems.push(
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError),
        );
      }
    }
    if (shiftId && provider === null) {
      try {
        await expect
          .poll(() => fixtureProvider(), { timeout: 10_000 })
          .not.toBeNull();
        provider = fixtureProvider();
      } catch (cleanupError) {
        cleanupProblems.push(
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError),
        );
      }
    }
    if (shiftId) {
      try {
        await openSettled(page, workbenchRoute);
        const row = page.locator(`[data-shift="${shiftId}"]`);
        await expect(row).toBeVisible({ timeout: 10_000 });
        const stop = row.getByRole("button", {
          name: "Stop shift",
          exact: true,
        });
        if ((await stop.count()) > 0) {
          await stop.click({ timeout: 5_000 });
        }
        await expect(row).toHaveAttribute("data-phase", "stopped", {
          timeout: 10_000,
        });
      } catch (cleanupError) {
        cleanupProblems.push(
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError),
        );
      }
    }
    if (provider) {
      for (const pid of [provider.pid, provider.childPid]) {
        if (pid === null) continue;
        try {
          await expect
            .poll(() => providerAlive(pid), { timeout: 20_000 })
            .toBe(false);
        } catch (cleanupError) {
          cleanupProblems.push(
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError),
          );
        }
      }
    }
  }
  if (cleanupProblems.length > 0) {
    try {
      await test.info().attach("Keeper Shift cleanup failures", {
        body: cleanupProblems.join("\n"),
        contentType: "text/plain",
      });
    } catch (attachmentError) {
      if (primaryError === null) primaryError = attachmentError;
    }
  }
  if (primaryError === null && cleanupProblems.length > 0)
    primaryError = Error("Keeper Shift fixture cleanup did not complete.");
  if (primaryError !== null) throw primaryError;
});
