import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { inboxDispositionEntrySchema, inboxDispositionOriginalSchema, inboxDispositionReceiptSchema } from "../../types/inbox";
import { OPERATOR_HEADER } from "../../scripts/hearth/paths";
import { codexChatApprovalPageSchema, codexChatDecisionReceiptSchema } from "../../scripts/sessions/codex-chat-owned-protocol";
import { geminiChatApprovalPageSchema } from "../../scripts/sessions/gemini-chat-owned-protocol";
import { ownedCodingStateSchema } from "../../scripts/sessions/codex-owned-journal";
import { ownedCodingSessionSchema } from "../../scripts/sessions/codex-owned-wire-protocol";
import { openSettled } from "../e2e/fixtures";
import { pageToken } from "../e2e/launch-link";
import { HEARTH_HOME } from "../e2e/servers";
import { alpha, beta, seedProjects, workspace } from "./project-fixtures";

const writeJournalKey = "agent-forge.desktop-bead-writes.v1";
const sessionsPath = join(HEARTH_HOME, "sessions", "registry.json");
const geminiControlPath = join(HEARTH_HOME, "gemini-chat-fixture-calls.json.control");
let priorSessions = new Set<string>();
let releaseHeldDispositionRead: (() => void) | null = null;
let releaseHeldInboxRoutes: Array<() => void> = [];
let savedGeminiControl: Buffer | null = null;
let geminiControlCaptured = false;

function sessions() {
  try {
    return ownedCodingSessionSchema
      .array()
      .parse(JSON.parse(readFileSync(sessionsPath, "utf8")).records);
  } catch {
    return [];
  }
}

function savedSession(id: string) {
  return ownedCodingStateSchema.parse(
    JSON.parse(
      readFileSync(join(HEARTH_HOME, "conversations", `${id}.json`), "utf8"),
    ),
  );
}

function isPermissionDoneRequest(body: unknown): boolean {
  if (typeof body !== "object" || body === null || !("item" in body) || !("operation" in body)) return false;
  const item = body.item;
  return typeof item === "object" && item !== null && "sourceKind" in item &&
    item.sourceKind === "permission" && body.operation === "done";
}

test.beforeEach(() => {
  priorSessions = new Set(sessions().map((session) => session.id));
  seedProjects();
  writeFileSync(
    join(HEARTH_HOME, "codex-chat-fixture-mode.json"),
    JSON.stringify("approval-command"),
  );
});

test.afterEach(async ({ page }) => {
  releaseHeldDispositionRead?.();
  releaseHeldDispositionRead = null;
  for (const release of releaseHeldInboxRoutes.splice(0)) release();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  for (const session of sessions().filter((item) => !priorSessions.has(item.id))) {
    const active = savedSession(session.id).turns.find((turn) =>
      ["accepted", "running", "cancelling"].includes(turn.phase),
    );
    if (!active) continue;
    const token = await pageToken(page);
    await page.evaluate(
      async ({ projectId, sessionId, requestId, token, header }) => {
        await fetch(
          `/__agent-forge/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/stop`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", [header]: token },
            body: JSON.stringify({ requestId }),
          },
        );
      },
      {
        projectId: session.projectId,
        sessionId: session.id,
        requestId: active.requestId,
        token,
        header: OPERATOR_HEADER,
      },
    );
    await expect
      .poll(() =>
        savedSession(session.id).turns.some((turn) =>
          ["accepted", "running", "cancelling"].includes(turn.phase),
        ),
      )
      .toBe(false);
  }
  if (geminiControlCaptured) {
    if (savedGeminiControl) writeFileSync(geminiControlPath, savedGeminiControl);
    else if (existsSync(geminiControlPath)) unlinkSync(geminiControlPath);
  }
  savedGeminiControl = null;
  geminiControlCaptured = false;
});

test("Inbox offers the current permission inline beside retained unknown writes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.addInitScript(
    ({ key, entries }) => {
      localStorage.setItem(key, JSON.stringify({ version: 1, entries }));
    },
    {
      key: writeJournalKey,
      entries: [
        {
          key: "inbox-write-fixture",
          projectId: alpha.id,
          workspace,
          action: "comment",
          beadId: "alpha-epic",
          title: "Fixture unknown write",
          createdId: null,
          stage: "write",
          phase: "unknown",
          message: "Outcome unknown: check the bead before doing anything else. This write will not be repeated automatically.",
        },
        {
          key: "inbox-beta-write-fixture",
          projectId: beta.id,
          workspace,
          action: "comment",
          beadId: "beta-epic",
          title: "Fixture Beta unknown write",
          createdId: null,
          stage: "write",
          phase: "unknown",
          message: "Outcome unknown: check the Beta bead before doing anything else. This write will not be repeated automatically.",
        },
      ],
    },
  );

  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/sessions`);
  await page.getByRole("button", { name: "New session", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "New session · Alpha",
    exact: true,
  });
  await dialog.getByRole("button", { name: /Cx · Codex/ }).click();
  await dialog
    .getByRole("combobox", { name: "Session mode", exact: true })
    .selectOption("chat");
  await expect(
    dialog.getByRole("combobox", { name: "Session smith", exact: true }),
  ).toHaveValue("codex-journeyman");
  await dialog
    .getByRole("combobox", { name: "Session effort", exact: true })
    .selectOption("");
  await dialog
    .getByRole("textbox", { name: "Session prompt", exact: true })
    .fill("Inbox permission fixture");
  await dialog
    .getByRole("button", { name: "Check supported options", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "Start", exact: true }).click();

  const conversation = page.getByRole("region", {
    name: "Session conversation",
    exact: true,
  });
  await expect(conversation).toBeVisible();
  await expect(
    conversation.getByRole("button", { name: "Allow once", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => sessions().filter((session) => !priorSessions.has(session.id)).length)
    .toBe(1);
  const session = sessions().find((candidate) => !priorSessions.has(candidate.id));
  if (!session) throw Error("The valid Inbox permission fixture session is absent.");

  const originalOffer = savedSession(session.id).frames.find(
    (frame) =>
      frame.turnId === session.requestId &&
      frame.event.kind === "coding-chat" &&
      frame.event.event.kind === "approval-request",
  )?.event;
  if (originalOffer?.kind !== "coding-chat")
    throw Error("The valid Inbox permission fixture has no original offer.");
  const originalEvent = originalOffer.event;
  if (originalEvent.kind !== "approval-request")
    throw Error("The valid Inbox permission fixture has no original offer.");

  const token = await pageToken(page);
  const setupRead = await page.evaluate(
    async ({ projectId, sessionId, token, header }) => {
      const response = await fetch(
        `/__agent-forge/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/approvals`,
        { headers: { [header]: token } },
      );
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return { status: response.status, body };
    },
    {
      projectId: alpha.id,
      sessionId: session.id,
      token,
      header: OPERATOR_HEADER,
    },
  );
  const setupEnvelope = z
    .object({
      ok: z.literal(true),
      data: codexChatApprovalPageSchema,
      error: z.null(),
    })
    .strict()
    .safeParse(setupRead.body);
  if (setupRead.status !== 200 || !setupEnvelope.success)
    throw Error("The protected setup approvals read was not a valid 200 fixture.");
  expect(
    setupEnvelope.data.data.pending.some(
      (pending) =>
        pending.turnRequestId === session.requestId &&
        pending.approval.id === originalEvent.approval.id &&
        pending.approval.availableDecisions.includes("accept"),
    ),
  ).toBe(true);

  let firstRecoveryRead = true;
  let markRecoveryReadStarted: () => void = () => {};
  const recoveryReadStarted = new Promise<void>((resolve) => { markRecoveryReadStarted = resolve; });
  let releaseRecoveryRead: () => void = () => {};
  const recoveryReadGate = new Promise<void>((resolve) => { releaseRecoveryRead = resolve; });
  let markRecoveryReadFinished: () => void = () => {};
  const recoveryReadFinished = new Promise<void>((resolve) => { markRecoveryReadFinished = resolve; });
  releaseHeldDispositionRead = releaseRecoveryRead;
  await page.route("**/inbox-dispositions/recovery", async (route) => {
    if (firstRecoveryRead) {
      firstRecoveryRead = false;
      markRecoveryReadStarted();
      await recoveryReadGate;
      await route.continue();
      const completed = await route.request().response();
      await completed?.finished();
      markRecoveryReadFinished();
      return;
    }
    await route.continue();
  });

  const approvalsPath =
    `/__agent-forge/projects/${alpha.id}/sessions/${session.id}/approvals`;
  let inboxNavigationStarted = false;
  let appApprovalReads = 0;
  let recoveryResponses = 0;
  let codexHistoryReads = 0;
  let decisionPosts = 0;
  const decisionRequests: Array<{ url: string; body: unknown }> = [];
  let dispositionWrites = 0;
  const dispositionRequests: Array<{ url: string; body: unknown }> = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      inboxNavigationStarted &&
      request.method() === "GET" &&
      url.pathname === approvalsPath
    )
      appApprovalReads++;
    if (request.method() === "GET" && url.pathname.endsWith(`/sessions/${session.id}`) && url.searchParams.has("requestId")) codexHistoryReads++;
    if (request.method() === "POST" && url.pathname.endsWith("/approval-decisions")) {
      decisionPosts++;
      decisionRequests.push({ url: url.pathname, body: request.postDataJSON() });
    }
    if (request.method() === "POST" && url.pathname.includes("/inbox-dispositions")) {
      dispositionWrites++;
      dispositionRequests.push({ url: url.pathname, body: request.postDataJSON() });
    }
  });
  page.on("response", (response) => {
    if (new URL(response.url()).pathname.endsWith("/inbox-dispositions/recovery")) recoveryResponses++;
  });
  inboxNavigationStarted = true;
  await page
    .getByRole("navigation", { name: "Global", exact: true })
    .getByRole("link", { name: "Inbox", exact: true })
    .click();
  await recoveryReadStarted;

  await expect(
    page
      .getByRole("region", { name: "Inbox", exact: true })
      .getByRole("heading", { name: "Inbox", exact: true }),
  ).toBeVisible();
  const inboxRegion = page.getByRole("region", { name: "Inbox", exact: true });
  const alphaNotice = inboxRegion.locator(".af-inbox-notice").filter({ has: inboxRegion.getByRole("heading", { name: "Fixture unknown write", exact: true }) });
  const betaNotice = inboxRegion.locator(".af-inbox-notice").filter({ has: inboxRegion.getByRole("heading", { name: "Fixture Beta unknown write", exact: true }) });
  await expect(alphaNotice.getByText("Outcome unknown", { exact: true })).toBeVisible();
  await expect(betaNotice.getByText("Outcome unknown", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Check alpha-epic", exact: true }),
  ).toBeVisible();
  expect(decisionPosts).toBe(0);

  // The original RED assertion remains on the same valid fixture path, now with the inline action present.
  await expect(
    page.getByRole("button", { name: "Allow once", exact: true }),
  ).toBeVisible();

  // Prove this route consumed the protected source read itself, apart from setup.
  await expect.poll(() => appApprovalReads).toBeGreaterThan(0);
  expect(decisionPosts).toBe(0);

  const codexPermissionCard = inboxRegion.locator(".af-inbox-card").filter({
    has: inboxRegion.getByRole("heading", { name: "Command permission", exact: true }),
  });
  await expect(codexPermissionCard.getByRole("button", { name: "Mark done · source unresolved", exact: true })).toBeDisabled();
  const outcomeNotice = inboxRegion.getByRole("heading", { name: "Write outcomes to check", exact: true });
  await expect(outcomeNotice).toBeVisible();
  const alphaProject = inboxRegion.locator('.af-inbox-project[aria-label="Alpha"]');
  const betaProject = inboxRegion.locator('.af-inbox-project[aria-label="Beta"]');
  const unknownAction = alphaProject.locator(".af-inbox-card").filter({
    has: alphaProject.getByRole("heading", { name: "Review comment outcome", exact: true }),
  });
  await expect(unknownAction.getByRole("button", { name: "Snooze 1 hour", exact: true })).toBeVisible();
  const betaAction = betaProject.locator(".af-inbox-card").filter({
    has: betaProject.getByRole("heading", { name: "Review comment outcome", exact: true }),
  });
  const betaPostsBeforeSelection = dispositionRequests.filter((request) => request.url.startsWith(`/__agent-forge/projects/${beta.id}/`)).length;
  let releaseApply: () => void = () => {};
  const applyGate = new Promise<void>((resolve) => { releaseApply = resolve; });
  releaseHeldInboxRoutes.push(releaseApply);
  let markApplyStarted: () => void = () => {};
  const applyStarted = new Promise<void>((resolve) => { markApplyStarted = resolve; });
  let markApplyFinished: () => void = () => {};
  const applyFinished = new Promise<void>((resolve) => { markApplyFinished = resolve; });
  let holdBetaApply = true;
  let holdBetaCollection = false;
  let releaseCollection: () => void = () => {};
  const collectionGate = new Promise<void>((resolve) => { releaseCollection = resolve; });
  releaseHeldInboxRoutes.push(releaseCollection);
  let markCollectionCaptured: () => void = () => {};
  const collectionCaptured = new Promise<void>((resolve) => { markCollectionCaptured = resolve; });
  let markCollectionFinished: () => void = () => {};
  const collectionFinished = new Promise<void>((resolve) => { markCollectionFinished = resolve; });
  await page.route(`**/projects/${beta.id}/inbox-dispositions`, async (route) => {
    if (route.request().method() === "POST" && holdBetaApply) {
      markApplyStarted();
      await applyGate;
      await route.continue();
      const completed = await route.request().response();
      await completed?.finished();
      holdBetaApply = false;
      markApplyFinished();
      return;
    }
    if (route.request().method() === "GET" && holdBetaCollection) {
      holdBetaCollection = false;
      const response = await route.fetch();
      markCollectionCaptured();
      await collectionGate;
      await route.fulfill({ response });
      const completed = await route.request().response();
      await completed?.finished();
      markCollectionFinished();
      return;
    }
    await route.continue();
  });
  await betaAction.getByRole("button", { name: "Snooze 1 hour", exact: true }).click();
  await applyStarted;
  let releaseScanRecovery: () => void = () => {};
  const scanRecoveryGate = new Promise<void>((resolve) => { releaseScanRecovery = resolve; });
  releaseHeldInboxRoutes.push(releaseScanRecovery);
  let holdScanRecovery = true;
  let markScanRecoveryCaptured: () => void = () => {};
  const scanRecoveryCaptured = new Promise<void>((resolve) => { markScanRecoveryCaptured = resolve; });
  await page.route("**/inbox-dispositions/recovery", async (route) => {
    if (!holdScanRecovery) return route.continue();
    holdScanRecovery = false;
    const response = await route.fetch();
    markScanRecoveryCaptured();
    await scanRecoveryGate;
    await route.fulfill({ response });
  });
  holdBetaCollection = true;
  await inboxRegion.getByRole("button", { name: "Refresh Inbox", exact: true }).click();
  await scanRecoveryCaptured;
  releaseScanRecovery();
  await collectionCaptured;
  releaseApply();
  await applyFinished;
  await expect(inboxRegion.getByText("Checking this Inbox action…", { exact: true })).toHaveCount(0);
  releaseCollection();
  await collectionFinished;
  await expect(inboxRegion.getByText("Refreshing saved Inbox dispositions…", { exact: true })).toHaveCount(0);
  const buckets = inboxRegion.getByRole("group", { name: "Inbox bucket", exact: true });
  await buckets.getByRole("button", { name: "Snoozed", exact: true }).click();
  await expect(betaProject.getByRole("heading", { name: "Review comment outcome", exact: true })).toBeVisible();
  await buckets.getByRole("button", { name: "Needs you", exact: true }).click();
  await expect.poll(() => dispositionRequests.filter((request) => request.url.startsWith(`/__agent-forge/projects/${beta.id}/`)).length).toBeGreaterThan(betaPostsBeforeSelection);
  const betaPostsBeforeAlphaDecision = dispositionRequests.filter((request) => request.url.startsWith(`/__agent-forge/projects/${beta.id}/`)).length;
  const alphaPostsBeforeCrossScopeAction = dispositionRequests.filter((request) => request.url.startsWith(`/__agent-forge/projects/${alpha.id}/`)).length;
  await unknownAction.getByRole("button", { name: "Snooze 1 hour", exact: true }).click();
  await expect.poll(() => dispositionRequests.filter((request) => request.url.startsWith(`/__agent-forge/projects/${alpha.id}/`)).length).toBeGreaterThan(alphaPostsBeforeCrossScopeAction);
  expect(dispositionRequests.filter((request) => request.url.startsWith(`/__agent-forge/projects/${beta.id}/`))).toHaveLength(betaPostsBeforeAlphaDecision);
  const decisionPath = `/__agent-forge/projects/${alpha.id}/sessions/${session.id}/approval-decisions`;
  const decisionResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === decisionPath,
  );
  await inboxRegion.getByRole("button", { name: "Allow once", exact: true }).click();
  const recordedDecision = await decisionResponse;
  expect(recordedDecision.status()).toBe(200);
  const receiptEnvelope = z.object({ ok: z.literal(true), data: codexChatDecisionReceiptSchema, error: z.null() }).strict().safeParse(await recordedDecision.json());
  if (!receiptEnvelope.success) throw Error("The protected Codex decision receipt was malformed.");
  expect(receiptEnvelope.data.data).toMatchObject({ projectId: alpha.id, sessionId: session.id, requestId: session.requestId, approvalId: originalEvent.approval.id, decision: "accept" });
  await expect.poll(() => decisionPosts).toBe(1);
  expect(decisionRequests).toHaveLength(1);
  expect(decisionRequests[0]).toMatchObject({
    url: `/__agent-forge/projects/${alpha.id}/sessions/${session.id}/approval-decisions`,
    body: { requestId: session.requestId, approvalId: originalEvent.approval.id, decision: "accept" },
  });
  await inboxRegion.getByRole("button", { name: "Refresh Inbox", exact: true }).click();
  await expect.poll(() => codexHistoryReads).toBeGreaterThan(0);
  const markDone = codexPermissionCard.getByRole("button", { name: "Mark done", exact: true });
  await expect(markDone).toBeEnabled();

  const reserveRequests: Array<{ requestId: unknown; body: unknown }> = [];
  let loseFirstReserve = true;
  const reservePattern = `**/projects/${alpha.id}/inbox-dispositions/requests`;
  const loseReserveOnce = async (route: import("@playwright/test").Route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = route.request().postDataJSON();
    const requestId = typeof body === "object" && body !== null && "requestId" in body ? body.requestId : null;
    reserveRequests.push({ requestId, body });
    if (loseFirstReserve) {
      loseFirstReserve = false;
      await route.abort();
      return;
    }
    await route.continue();
  };
  await page.route(reservePattern, loseReserveOnce);
  await buckets.getByRole("button", { name: "Snoozed", exact: true }).click();
  await unknownAction.getByRole("button", { name: "Snooze 1 hour", exact: true }).click();
  const actionHistory = inboxRegion.getByRole("region", { name: "Inbox action history", exact: true });
  await expect(actionHistory.getByRole("button", { name: "Review unconfirmed reservation", exact: true })).toBeVisible();
  await actionHistory.getByRole("button", { name: "Review unconfirmed reservation", exact: true }).click();
  await expect(inboxRegion.getByText(/A new Inbox acknowledgment may be reviewed separately\./)).toBeVisible();
  await unknownAction.getByRole("button", { name: "Snooze 1 hour", exact: true }).click();
  await expect.poll(() => reserveRequests.length).toBe(2);
  expect(reserveRequests[0]?.requestId).not.toBe(reserveRequests[1]?.requestId);
  expect(z.string().uuid().safeParse(reserveRequests[1]?.requestId).success).toBe(true);
  await buckets.getByRole("button", { name: "Snoozed", exact: true }).click();
  await expect(alphaProject.getByRole("heading", { name: "Review comment outcome", exact: true })).toBeVisible();
  await expect(alphaNotice.getByText("Outcome unknown", { exact: true })).toBeVisible();

  await page.emulateMedia({ reducedMotion: "reduce" });
  await buckets.getByRole("button", { name: "Snoozed", exact: true }).focus();
  await page.keyboard.press("Tab");
  const projectFilter = inboxRegion.getByRole("combobox", { name: "Filter Inbox by project", exact: true });
  await expect(projectFilter).toBeFocused();
  expect(await projectFilter.evaluate((element) => getComputedStyle(element).outlineWidth)).toBe("2px");
  expect(await inboxRegion.locator(".af-inbox-card").evaluate((element) => getComputedStyle(element).transitionDuration)).toBe("0s");

  const globalNav = page.getByRole("navigation", { name: "Global", exact: true });
  await globalNav.getByRole("link", { name: "Projects", exact: true }).click();
  const recoveryResponsesBeforeReturn = recoveryResponses;
  await globalNav.getByRole("link", { name: "Inbox", exact: true }).click();
  const returnedInbox = page.getByRole("region", { name: "Inbox", exact: true });
  await expect(returnedInbox.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
  await expect.poll(() => recoveryResponses).toBeGreaterThan(recoveryResponsesBeforeReturn);
  await expect(returnedInbox.getByText("Refreshing saved Inbox dispositions…", { exact: true })).toHaveCount(0);
  releaseRecoveryRead();
  releaseHeldDispositionRead = null;
  await recoveryReadFinished;
  const returnedBuckets = returnedInbox.getByRole("group", { name: "Inbox bucket", exact: true });
  await returnedBuckets.getByRole("button", { name: "Snoozed", exact: true }).click();
  await expect(returnedInbox.locator('.af-inbox-project[aria-label="Alpha"]').getByRole("heading", { name: "Review comment outcome", exact: true })).toBeVisible();
  await expect(returnedInbox.getByText("Outcome unknown", { exact: true })).toBeVisible();
  await returnedBuckets.getByRole("button", { name: "Needs you", exact: true }).click();

  await buckets.getByRole("button", { name: "Needs you", exact: true }).click();
  await expect(alphaProject.getByRole("heading", { name: "Review comment outcome", exact: true })).toHaveCount(0);
  await expect(alphaNotice.getByText("Outcome unknown", { exact: true })).toBeVisible();
  await expect(inboxRegion.getByRole("link", { name: "Check alpha-epic", exact: true })).toBeVisible();
  expect(decisionPosts).toBe(1);
  await inboxRegion.getByRole("button", { name: "I checked this write · dismiss", exact: true }).click();
  await expect(alphaNotice.getByText("Outcome unknown", { exact: true })).toHaveCount(0);
  expect(decisionPosts).toBe(1);

  const dispositionsBeforeHeldDone = dispositionRequests.length;
  await markDone.click();
  await expect(inboxRegion.getByRole("alert").last()).toBeVisible();
  expect(dispositionRequests).toHaveLength(dispositionsBeforeHeldDone);
  expect(dispositionRequests.some((request) => isPermissionDoneRequest(request.body))).toBe(false);

  const betaActionAfterHold = betaProject.locator(".af-inbox-card").filter({
    has: betaProject.getByRole("heading", { name: "Review comment outcome", exact: true }),
  });
  await buckets.getByRole("button", { name: "Snoozed", exact: true }).click();
  const betaPostsBeforeGlobalHold = dispositionRequests.filter((request) => request.url.startsWith(`/__agent-forge/projects/${beta.id}/`)).length;
  await betaActionAfterHold.getByRole("button", { name: "Snooze 1 hour", exact: true }).click();
  await expect(inboxRegion.getByRole("alert").last()).toBeVisible();
  expect(dispositionRequests.filter((request) => request.url.startsWith(`/__agent-forge/projects/${beta.id}/`))).toHaveLength(betaPostsBeforeGlobalHold);

});

test("Inbox reviews an unknown permission acknowledgment through both existing read owners", async ({ page }) => {
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/sessions`);
  await page.getByRole("button", { name: "New session", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New session · Alpha", exact: true });
  await dialog.getByRole("button", { name: /Cx · Codex/ }).click();
  await dialog.getByRole("combobox", { name: "Session mode", exact: true }).selectOption("chat");
  await dialog.getByRole("combobox", { name: "Session effort", exact: true }).selectOption("");
  await dialog.getByRole("textbox", { name: "Session prompt", exact: true }).fill("Inbox permission acknowledgment recovery fixture");
  await dialog.getByRole("button", { name: "Check supported options", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Start", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  const conversation = page.getByRole("region", { name: "Session conversation", exact: true });
  await expect(conversation.getByRole("button", { name: "Allow once", exact: true })).toBeVisible();
  await expect.poll(() => sessions().filter((session) => !priorSessions.has(session.id)).length).toBe(1);
  const session = sessions().find((candidate) => !priorSessions.has(candidate.id));
  if (!session) throw Error("The permission acknowledgment fixture session is absent.");
  const token = await pageToken(page);
  const setup = await page.evaluate(async ({ projectId, sessionId, token, header }) => {
    const response = await fetch(`/__agent-forge/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/approvals`, { headers: { [header]: token } });
    let body: unknown;
    try { body = await response.json(); } catch { body = null; }
    return { status: response.status, body };
  }, { projectId: alpha.id, sessionId: session.id, token, header: OPERATOR_HEADER });
  const setupPage = z.object({ ok: z.literal(true), data: codexChatApprovalPageSchema, error: z.null() }).strict().safeParse(setup.body);
  if (setup.status !== 200 || !setupPage.success || !setupPage.data.data.pending.some((offer) => offer.turnRequestId === session.requestId))
    throw Error("The protected setup read did not confirm the original pending permission.");

  let inboxApprovalReads = 0;
  let nativeDecisionPosts = 0;
  const requests: Array<{ requestId: unknown; body: unknown }> = [];
  let discardRequest: { url: string; body: unknown } | null = null;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith(`/sessions/${session.id}/approvals`) && request.method() === "GET") inboxApprovalReads++;
    if (url.pathname.endsWith("/approval-decisions") && request.method() === "POST") nativeDecisionPosts++;
    if (request.method() === "POST" && url.pathname.endsWith(`/requests/${String(requests[1]?.requestId)}/discard`)) discardRequest = { url: url.pathname, body: request.postDataJSON() };
  });
  let loseFirstReserve = true;
  let applyBody: unknown = null;
  let applyPath = "";
  let markApplyStarted: () => void = () => {};
  let markApplyFinished: () => void = () => {};
  const applyStarted = new Promise<void>((resolve) => { markApplyStarted = resolve; });
  const applyFinished = new Promise<void>((resolve) => { markApplyFinished = resolve; });
  await page.route(`**/projects/${alpha.id}/inbox-dispositions`, async (route) => {
    if (route.request().method() !== "POST" || !route.request().url().endsWith("/inbox-dispositions")) return route.fallback();
    applyBody = route.request().postDataJSON();
    applyPath = new URL(route.request().url()).pathname;
    markApplyStarted();
    await route.abort();
    markApplyFinished();
  });
  await page.route(`**/projects/${alpha.id}/inbox-dispositions/requests`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = route.request().postDataJSON();
    const requestId = typeof body === "object" && body !== null && "requestId" in body ? body.requestId : null;
    requests.push({ requestId, body });
    if (loseFirstReserve) {
      loseFirstReserve = false;
      await route.abort();
      return;
    }
    await route.continue();
  });
  await page.getByRole("navigation", { name: "Global", exact: true }).getByRole("link", { name: "Inbox", exact: true }).click();
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  const permission = inbox.locator(".af-inbox-card").filter({ has: inbox.getByRole("heading", { name: "Command permission", exact: true }) });
  await expect(permission.getByRole("button", { name: "Snooze 1 hour", exact: true })).toBeVisible();
  await permission.getByRole("button", { name: "Snooze 1 hour", exact: true }).click();
  const history = inbox.getByRole("region", { name: "Inbox action history", exact: true });
  await expect(history.getByRole("button", { name: "Review unconfirmed reservation", exact: true })).toBeVisible();
  await history.getByRole("button", { name: "Review unconfirmed reservation", exact: true }).click();
  await expect(inbox.getByText(/A new Inbox acknowledgment may be reviewed separately\./)).toBeVisible();
  await expect.poll(() => inboxApprovalReads).toBeGreaterThan(0);
  expect(nativeDecisionPosts).toBe(0);
  await permission.getByRole("button", { name: "Snooze 1 hour", exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[0]?.requestId).not.toBe(requests[1]?.requestId);
  expect(z.string().uuid().safeParse(requests[1]?.requestId).success).toBe(true);
  expect(nativeDecisionPosts).toBe(0);
  const persistedRequestId = String(requests[1]?.requestId);
  await applyStarted;
  await applyFinished;
  await expect(history.getByText(/reserve-unknown/)).toBeVisible();
  expect(applyPath).toBe(`/__agent-forge/projects/${alpha.id}/inbox-dispositions`);
  const reservedOriginal = inboxDispositionOriginalSchema.strict().safeParse(requests[1]?.body);
  const appliedOriginal = inboxDispositionOriginalSchema.strict().safeParse(applyBody);
  expect(reservedOriginal.success).toBe(true);
  expect(appliedOriginal.success).toBe(true);
  expect(applyBody).toEqual(requests[1]?.body);
  const exactReserve = await page.evaluate(async ({ projectId, requestId, token, header }) => {
    const response = await fetch(`/__agent-forge/projects/${encodeURIComponent(projectId)}/inbox-dispositions/requests/${encodeURIComponent(requestId)}`, { headers: { [header]: token } });
    let body: unknown; try { body = await response.json(); } catch { body = null; }
    return { status: response.status, body };
  }, { projectId: alpha.id, requestId: persistedRequestId, token, header: OPERATOR_HEADER });
  const reserveEnvelope = z.object({ ok: z.literal(true), data: z.object({ entry: inboxDispositionEntrySchema.nullable(), receipt: inboxDispositionReceiptSchema }).strict(), error: z.null() }).strict().safeParse(exactReserve.body);
  expect(exactReserve.status).toBe(200);
  expect(reserveEnvelope.success).toBe(true);
  if (!reserveEnvelope.success || !reservedOriginal.success) throw Error("The exact original reservation could not be verified before reload.");
  expect(reserveEnvelope.data.data.receipt.phase).toBe("reserved");
  expect(reserveEnvelope.data.data.receipt.original).toMatchObject({ ...reservedOriginal.data, projectId: alpha.id });
  await page.reload();
  const reloadedInbox = page.getByRole("region", { name: "Inbox", exact: true });
  const persistedOriginal = reloadedInbox.getByRole("region", { name: "Inbox action history", exact: true }).locator("article").filter({ hasText: `Request ${persistedRequestId}` });
  await expect(persistedOriginal.getByRole("button", { name: "Check exact original", exact: true })).toBeVisible();
  await persistedOriginal.getByRole("button", { name: "Check exact original", exact: true }).click();
  await expect(persistedOriginal.getByRole("button", { name: "Discard checked reservation", exact: true })).toBeEnabled();
  const discardFinished = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith(`/requests/${persistedRequestId}/discard`));
  await persistedOriginal.getByRole("button", { name: "Discard checked reservation", exact: true }).click();
  const discardedResponse = await discardFinished;
  await expect(persistedOriginal.getByRole("button", { name: "Discard checked reservation", exact: true })).toHaveCount(0);
  expect(discardRequest?.url).toBe(`/__agent-forge/projects/${alpha.id}/inbox-dispositions/requests/${persistedRequestId}/discard`);
  const discardOriginal = inboxDispositionOriginalSchema.strict().safeParse(discardRequest?.body);
  expect(discardOriginal.success).toBe(true);
  if (!discardOriginal.success || !reservedOriginal.success) throw Error("The discard request did not preserve the exact original.");
  expect(discardOriginal.data).toEqual(reservedOriginal.data);
  expect(discardOriginal.data.requestId).toBe(persistedRequestId);
  expect(discardedResponse.status()).toBe(200);
  const discardedEnvelope = z.object({ ok: z.literal(true), data: z.object({ entry: inboxDispositionEntrySchema.nullable(), receipt: inboxDispositionReceiptSchema }).strict(), error: z.null() }).strict().safeParse(await discardedResponse.json());
  expect(discardedEnvelope.success).toBe(true);
  if (!discardedEnvelope.success) throw Error("The discard reply did not match its strict success schema.");
  expect(discardedEnvelope.data.data.receipt).toMatchObject({ original: { ...discardOriginal.data, projectId: alpha.id }, phase: "refused", outcome: "refused", refusalCode: "discarded" });
  expect(nativeDecisionPosts).toBe(0);
});

test("Inbox binds Gemini options to its exact offer and recovers a held original without resending", async ({ page }) => {
  test.setTimeout(60_000);
  geminiControlCaptured = true;
  savedGeminiControl = existsSync(geminiControlPath) ? readFileSync(geminiControlPath) : null;
  writeFileSync(geminiControlPath, JSON.stringify({ mode: "permission-tree" }));
  await page.addInitScript(({ key, projectId, workspace: root }) => localStorage.setItem(key, JSON.stringify({ version: 1, entries: [{ key: "beta-context-write", projectId, workspace: root, action: "comment", beadId: "beta-epic", title: "Beta context write", createdId: null, stage: "write", phase: "unknown", message: "Outcome unknown; check before repeating." }] })), { key: writeJournalKey, projectId: beta.id, workspace });
  await page.route("**/__agent-forge/smiths", async (route) => {
    const request = route.request();
    const response = await route.fetch({
      headers: { ...(await request.allHeaders()), Origin: new URL(request.url()).origin, "Sec-Fetch-Site": "same-origin" },
    });
    const parsed = z.object({ ok: z.literal(true), data: z.record(z.string(), z.unknown()), error: z.null() }).passthrough().safeParse(await response.json());
    if (!parsed.success || !Array.isArray(parsed.data.data.smiths)) throw Error("The protected fixture smith index was not verified.");
    const smiths = parsed.data.data.smiths.filter((item) => {
      const row = z.object({ name: z.string() }).passthrough().safeParse(item);
      return !row.success || row.data.name !== "gemini-example";
    });
    await route.fulfill({
      response,
      json: { ...parsed.data, data: { ...parsed.data.data, smiths: [...smiths, { name: "gemini-example", provider: "gemini", model: "configured-example", effort: "default", enabled: true, tags: [] }] } },
    });
  });
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/sessions`);
  await page.getByRole("button", { name: "New session", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New session · Alpha", exact: true });
  await dialog.getByRole("button", { name: /Gm · Gemini/ }).click();
  await dialog.getByRole("combobox", { name: "Session mode", exact: true }).selectOption("chat");
  await expect(dialog.getByRole("combobox", { name: "Session smith", exact: true })).toHaveValue("gemini-example");
  await dialog.getByRole("combobox", { name: "Where the session runs", exact: true }).selectOption("main");
  await dialog.getByRole("textbox", { name: "Session bead", exact: true }).fill("alpha-epic");
  await dialog.getByRole("textbox", { name: "Session prompt", exact: true }).fill("Inbox Gemini permission fixture");
  await dialog.getByRole("button", { name: "Check supported options", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Start", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  await expect.poll(() => sessions().filter((item) => !priorSessions.has(item.id) && item.provider === "gemini").length).toBe(1);
  const session = sessions().find((item) => !priorSessions.has(item.id) && item.provider === "gemini");
  if (!session) throw Error("The valid Gemini Inbox fixture session is absent.");
  const token = await pageToken(page);
  const setup = await page.evaluate(async ({ projectId, sessionId, token, header }) => {
    const response = await fetch(`/__agent-forge/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/approvals`, { headers: { [header]: token } });
    let body: unknown;
    try { body = await response.json(); } catch { body = null; }
    return { status: response.status, body };
  }, { projectId: alpha.id, sessionId: session.id, token, header: OPERATOR_HEADER });
  const setupEnvelope = z.object({ ok: z.literal(true), data: geminiChatApprovalPageSchema, error: z.null() }).strict().safeParse(setup.body);
  if (setup.status !== 200 || !setupEnvelope.success) throw Error("The protected Gemini setup read was not a valid 200 fixture.");
  const offer = setupEnvelope.data.data.pending.find((item) => item.turnRequestId === session.requestId);
  if (!offer || offer.approval.options.length === 0) throw Error("The protected Gemini fixture had no exact offered option.");

  const approvalsPattern = `**/sessions/${session.id}/approvals**`;
  let decisionPosts = 0;
  let betaDispositionPosts = 0;
  let alphaDispositionPosts = 0;
  let staleReadHit = false;
  let originalReceiptReads = 0;
  const decisionRequests: Array<{ url: string; body: unknown }> = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname.endsWith("/approval-decisions")) {
      decisionPosts++;
      decisionRequests.push({ url: url.pathname, body: request.postDataJSON() });
    }
    if (request.method() === "POST" && url.pathname.endsWith("/inbox-dispositions/requests")) {
      if (url.pathname.startsWith(`/__agent-forge/projects/${beta.id}/`)) betaDispositionPosts++;
      if (url.pathname.startsWith(`/__agent-forge/projects/${alpha.id}/`)) alphaDispositionPosts++;
    }
    if (request.method() === "GET" && url.pathname.endsWith(`/sessions/${session.id}/approvals`) && url.searchParams.has("requestId")) originalReceiptReads++;
  });
  await openSettled(page, `/index.html#/desktop/inbox?project=${encodeURIComponent(beta.id)}`);
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  const betaContext = inbox.locator('.af-inbox-project[aria-label="Beta"]');
  const betaWriteCard = betaContext.locator(".af-inbox-card").filter({ has: betaContext.getByRole("heading", { name: "Review comment outcome", exact: true }) });
  await expect(betaWriteCard.getByRole("button", { name: "Snooze 1 hour", exact: true })).toBeVisible();
  await betaWriteCard.getByRole("button", { name: "Snooze 1 hour", exact: true }).click();
  await expect.poll(() => betaDispositionPosts).toBe(1);
  await expect(betaWriteCard).toHaveCount(0);
  const betaPostsBeforeAlphaDecision = betaDispositionPosts;
  await expect(page.getByRole("link", { name: "Choose project: Beta", exact: true })).toBeVisible();
  const geminiCard = inbox.locator(".af-inbox-card").filter({ has: inbox.getByRole("heading", { name: "Gemini permission", exact: true }) });
  await expect(geminiCard.getByRole("button", { name: "Allow once", exact: true })).toBeVisible();
  await expect(geminiCard.getByRole("button", { name: "Mark done · source unresolved", exact: true })).toBeDisabled();

  const foreignTurn = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const foreignHandler = async (route: import("@playwright/test").Route) => {
    if (route.request().method() !== "GET") return route.continue();
    staleReadHit = true;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: { pending: [{ ...offer, turnRequestId: foreignTurn }], receipt: null }, error: null }) });
  };
  await page.route(approvalsPattern, foreignHandler);
  await geminiCard.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect.poll(() => staleReadHit).toBe(true);
  await expect(geminiCard.getByText("Live native approvals could not be verified. Refresh before choosing a decision.", { exact: true })).toBeVisible();
  expect(decisionPosts).toBe(0);
  await page.unroute(approvalsPattern, foreignHandler);
  await inbox.getByRole("button", { name: "Refresh Inbox", exact: true }).click();
  await expect(geminiCard.getByRole("button", { name: "Allow once", exact: true })).toBeVisible();

  const decisionPattern = `**/sessions/${session.id}/approval-decisions`;
  const lostReply = async (route: import("@playwright/test").Route) => {
    await route.fetch();
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, data: null, error: "The fixture reply was lost after dispatch." }) });
  };
  await page.route(decisionPattern, lostReply);
  await geminiCard.getByRole("button", { name: offer.approval.options[0]!.name, exact: true }).click();
  await expect.poll(() => decisionPosts).toBe(1);
  expect(decisionRequests).toHaveLength(1);
  expect(decisionRequests[0]?.url).toBe(`/__agent-forge/projects/${alpha.id}/sessions/${session.id}/approval-decisions`);
  const geminiDecision = z.object({
    requestId: z.string().uuid(),
    turnRequestId: z.literal(session.requestId),
    approvalId: z.literal(offer.approval.id),
    optionId: z.literal(offer.approval.options[0]!.optionId),
  }).strict().safeParse(decisionRequests[0]?.body);
  if (!geminiDecision.success) throw Error("The Gemini wire request did not preserve the exact offered option.");
  expect(decisionRequests[0]?.url).toBe(`/__agent-forge/projects/${alpha.id}/sessions/${session.id}/approval-decisions`);
  expect(betaDispositionPosts).toBe(betaPostsBeforeAlphaDecision);
  expect(alphaDispositionPosts).toBe(0);
  await expect(geminiCard.getByText("Original decision held; no replacement will be sent.", { exact: true })).toBeVisible();
  await page.unroute(decisionPattern, lostReply);
  await inbox.getByRole("button", { name: "Refresh Inbox", exact: true }).click();
  const heldCard = inbox.locator(".af-inbox-card").filter({ has: inbox.getByRole("heading", { name: "Original permission decision held", exact: true }) });
  await expect(heldCard.getByRole("button", { name: "Check original decision", exact: true })).toBeVisible();
  await heldCard.getByRole("button", { name: "Check original decision", exact: true }).click();
  await expect.poll(() => originalReceiptReads).toBeGreaterThan(0);
  expect(decisionPosts).toBe(1);
  await expect(geminiCard.getByRole("button", { name: "Mark done", exact: true })).toBeEnabled();
  const terminalDone = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === `/__agent-forge/projects/${alpha.id}/inbox-dispositions/requests`);
  const terminalApply = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === `/__agent-forge/projects/${alpha.id}/inbox-dispositions` && request.postDataJSON().operation === "done");
  await geminiCard.getByRole("button", { name: "Mark done", exact: true }).click();
  const terminalDoneRequest = await terminalDone;
  const terminalApplyRequest = await terminalApply;
  expect(terminalApplyRequest.postDataJSON()).toEqual(terminalDoneRequest.postDataJSON());
  expect(terminalApplyRequest.postDataJSON().requestId).toBe(terminalDoneRequest.postDataJSON().requestId);
  const terminalDoneBody = terminalDoneRequest.postDataJSON();
  const doneOriginal = inboxDispositionOriginalSchema.strict().safeParse(terminalDoneBody);
  expect(doneOriginal.success).toBe(true);
  if (!doneOriginal.success) throw Error("The positive Done request did not match the strict original schema.");
  expect(Object.keys(doneOriginal.data).sort()).toEqual(["expectedCatalogRevision", "expectedRevision", "item", "operation", "requestId", "workspace"].sort());
  expect(Object.keys(doneOriginal.data.item).sort()).toEqual(["sourceKind", "sourceRevision", "stableItemId"].sort());
  expect(doneOriginal.data.item.sourceKind).toBe("permission");
  expect(doneOriginal.data.operation).toBe("done");
  const terminalDoneResponse = await terminalApplyRequest.response();
  expect(terminalDoneResponse?.status()).toBe(200);
  await terminalDoneResponse?.finished();
  const doneEnvelope = z.object({ ok: z.literal(true), data: z.object({ entry: inboxDispositionEntrySchema.nullable(), receipt: inboxDispositionReceiptSchema }).strict(), error: z.null() }).strict().safeParse(await terminalDoneResponse?.json());
  expect(doneEnvelope.success).toBe(true);
  if (!doneEnvelope.success || !doneOriginal.success) throw Error("The Done reply was not a strict success envelope.");
  expect(doneEnvelope.data.data.receipt).toMatchObject({ original: { ...doneOriginal.data, projectId: alpha.id }, phase: "applied", outcome: "applied", resultingValue: "done" });
  expect(doneEnvelope.data.data.entry).not.toBeNull();
  expect(doneEnvelope.data.data.entry).toMatchObject({ projectId: alpha.id, workspace, item: doneOriginal.data.item, revision: doneOriginal.data.expectedRevision + 1, operation: "done" });
  await expect(geminiCard.getByRole("heading", { name: "Gemini permission", exact: true })).toHaveCount(0);
  expect(decisionPosts).toBe(1);
});
