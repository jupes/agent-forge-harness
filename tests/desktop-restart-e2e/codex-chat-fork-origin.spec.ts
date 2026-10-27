import { existsSync, readFileSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import {
  expect,
  type Page,
  type Request,
  type Route,
  test,
} from "@playwright/test";
import { SESSION_START_IDENTITIES } from "../../apps/desktop/src/session-start-identities";
import {
  OPERATOR_HEADER,
  SESSION_KEY_STORAGE,
  SESSION_ROUTE,
} from "../../scripts/hearth/paths";
import { ownedCodingStateSchema } from "../../scripts/sessions/codex-owned-journal";
import {
  ownedCodingSessionSchema,
  ownedCodingStartReceiptSchema,
} from "../../scripts/sessions/codex-owned-wire-protocol";
import { sessionStartIdentityReplySchema } from "../../scripts/sessions/identity-protocol";
import {
  codexChatForkIdentityMetadataSchema,
  sessionOperationIdentityPageSchema,
} from "../../scripts/sessions/session-operation-identities-protocol";
import { captureTextResponseThroughBrowserFetch } from "../desktop-e2e/browser-response-capture";
import { verifiedIdentityReadBarrier } from "../desktop-e2e/session-start-read-barrier";
import { pageToken } from "../e2e/launch-link";
import { DASHBOARD_PORT, HEARTH_HOME } from "../e2e/servers";
import { forkProject, ROOT } from "./environment";

const FORK_RESTART_PATH = "/__desktop-restart-fixture/restart-host-fork";
const CONTROL_HEADER = "x-agent-forge-fixture-secret";
const INITIAL_STORAGE_KEY = "__fork_restart_initial_storage__";

type SessionRow = ReturnType<typeof ownedCodingSessionSchema.parse>;
type FixtureCall = {
  kind: string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  argvCategory?: "version-probe" | "help-probe" | "app-server-stdio" | "other";
};

const FIXTURE_CALL_KINDS = [
  "version",
  "help",
  "process",
  "rpc",
  "notification",
  "answer",
] as const;

let forkOriginFailureFacts: (() => Record<string, unknown>) | null = null;
let forkBaseRestoreNeeded = false;
let forkBaseRestoreStatus: "not-needed" | "verified" | "failed" = "not-needed";

test.afterEach(async ({ page }, testInfo) => {
  let restorationError: unknown = null;
  if (forkBaseRestoreNeeded) {
    try {
      await restoreBaseOrigin();
      forkBaseRestoreNeeded = false;
      forkBaseRestoreStatus = "verified";
    } catch (error) {
      restorationError = error;
      forkBaseRestoreStatus = "failed";
    }
  }
  if (testInfo.errors.length === 0 && restorationError)
    throw new Error("The restart fixture did not restore its base origin.");
  if (testInfo.errors.length === 0 || !forkOriginFailureFacts) return;
  try {
    let currentOrigin: string | null = null;
    try {
      const currentUrl = page.url();
      if (currentUrl !== "about:blank")
        currentOrigin = new URL(currentUrl).origin;
    } catch {
      // Keep the last observed origin when the page is no longer readable.
    }
    let facts: Record<string, unknown>;
    try {
      facts = forkOriginFailureFacts();
      if (currentOrigin) facts.origin = currentOrigin;
      facts.baseOriginRestore = forkBaseRestoreStatus;
    } catch {
      facts = { availability: "unavailable" };
    }
    let body = JSON.stringify(facts);
    if (Buffer.byteLength(body, "utf8") > 8 * 1024)
      body = JSON.stringify({ availability: "unavailable", reason: "cap" });
    await testInfo.attach("fork-origin-failure-facts.json", {
      body: Buffer.from(body, "utf8"),
      contentType: "application/json",
    });
  } catch {
    // Diagnostics are best effort and must not replace the original failure.
  }
});

function safeIdentityFacts(
  identity: ReturnType<typeof codexChatForkIdentityMetadataSchema.parse>,
) {
  return {
    requestId: identity.requestId,
    requestHash: identity.requestHash,
    parentSessionId: identity.parentSessionId,
    throughTurnRequestId: identity.throughTurnRequestId,
    state: identity.state,
    ...(identity.childSessionId
      ? { childSessionId: identity.childSessionId }
      : {}),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`The owned ${label} was invalid.`);
  }
}

function rows(): SessionRow[] {
  const path = join(HEARTH_HOME, "sessions", "registry.json");
  if (!existsSync(path)) return [];
  const parsed = record(
    parseJson(readFileSync(path, "utf8"), "session registry"),
  );
  return ownedCodingSessionSchema.array().parse(parsed?.["records"]);
}

function saved(id: string) {
  return ownedCodingStateSchema.parse(
    parseJson(
      readFileSync(join(HEARTH_HOME, "conversations", `${id}.json`), "utf8"),
      "owned conversation",
    ),
  );
}

function calls(): FixtureCall[] {
  const path = join(HEARTH_HOME, "codex-chat-fixture-calls.jsonl");
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  if (size > 8 * 1024 * 1024)
    throw new Error("Codex fixture call log exceeded its bound.");
  const lines = readFileSync(path, "utf8").split("\n");
  if (lines.length > 4097)
    throw new Error("Codex fixture call log exceeded its row bound.");
  return lines
    .filter((line) => line.length > 0)
    .map((line) => record(parseJson(line, "Codex fixture event")))
    .filter((value): value is Record<string, unknown> => value !== null)
    .map((value) => ({
      kind: String(value["kind"] ?? ""),
      ...(typeof value["method"] === "string"
        ? { method: value["method"] }
        : {}),
      ...(record(value["params"]) ? { params: record(value["params"])! } : {}),
      ...(value["result"] !== undefined ? { result: value["result"] } : {}),
      ...(value["kind"] === "version"
        ? { argvCategory: "version-probe" as const }
        : value["kind"] === "help"
          ? { argvCategory: "help-probe" as const }
          : value["kind"] === "process"
            ? {
                argvCategory:
                  Array.isArray(value["argv"]) &&
                  value["argv"].length === 2 &&
                  value["argv"][0] === "app-server" &&
                  value["argv"][1] === "--stdio"
                    ? ("app-server-stdio" as const)
                    : ("other" as const),
              }
            : {}),
    }));
}

function fixtureCallFacts() {
  try {
    const rows = calls();
    if (rows.length > 4096) return { state: "over-limit" as const };
    const kindCounts = Object.fromEntries(
        FIXTURE_CALL_KINDS.map((kind) => [kind, 0]),
      ) as Record<(typeof FIXTURE_CALL_KINDS)[number], number>,
      argvCategories = {
        versionProbe: 0,
        helpProbe: 0,
        appServerStdio: 0,
        other: 0,
      };
    for (const row of rows) {
      if (
        FIXTURE_CALL_KINDS.includes(
          row.kind as (typeof FIXTURE_CALL_KINDS)[number],
        )
      )
        kindCounts[row.kind as (typeof FIXTURE_CALL_KINDS)[number]]++;
      if (row.argvCategory === "version-probe") argvCategories.versionProbe++;
      else if (row.argvCategory === "help-probe") argvCategories.helpProbe++;
      else if (row.argvCategory === "app-server-stdio")
        argvCategories.appServerStdio++;
      else if (row.argvCategory === "other") argvCategories.other++;
    }
    return { state: "available" as const, kindCounts, argvCategories };
  } catch {
    return { state: "unavailable" as const };
  }
}

function rpcCount(method: string): number {
  return calls().filter((row) => row.kind === "rpc" && row.method === method)
    .length;
}

type ParentStartReadFacts = {
  stage:
    | "prepared"
    | "preview-pending"
    | "identity-read-held"
    | "reads-released"
    | "start-dispatched"
    | "start-receipted";
  identityGetCount: number;
  sessionGetCount: number;
  identityStatus: number | null;
  sessionStatus: number | null;
  identityScopeMatched: boolean | null;
  identityValid: boolean | null;
  sessionValid: boolean | null;
  sessionRows: number | null;
  checkingVisible: boolean | null;
  startDisabledWhileHeld: boolean | null;
  reservePosts: number;
  startPosts: number;
  errorVisibleWhileHeld: boolean | null;
  timingMs: {
    previewResponse: number | null;
    identityRead: number | null;
    heldUiObserved: number | null;
    readsReleased: number | null;
    startClick: number | null;
    reserveRequest: number | null;
    startRequest: number | null;
    startReceipt: number | null;
    readyAfterReads: number | null;
  };
};

async function openNewSession(
  page: Page,
  url: string,
  reportFacts: (facts: ParentStartReadFacts) => void,
): Promise<SessionRow> {
  if (
    page.url() === "about:blank" ||
    new URL(page.url()).origin !== new URL(url).origin
  )
    await page.goto(url);
  const sessionsUrl = new URL(
    `/index.html#/desktop/project/${encodeURIComponent(forkProject.id)}/sessions`,
    url,
  );
  if (
    new URL(page.url()).pathname !== sessionsUrl.pathname ||
    new URL(page.url()).hash !== sessionsUrl.hash
  )
    await page.goto(sessionsUrl.toString());
  const newSessionButton = page.getByRole("button", {
    name: "New session",
    exact: true,
  });
  await expect(newSessionButton).toBeEnabled();
  await newSessionButton.click();
  const dialog = page.getByRole("dialog", {
    name: "New session · Alpha",
    exact: true,
  });
  await dialog.getByRole("button", { name: /Cx · Codex/ }).click();
  await dialog
    .getByRole("combobox", { name: "Session mode", exact: true })
    .selectOption("chat");
  await dialog
    .getByRole("combobox", { name: "Session effort", exact: true })
    .selectOption("");
  await expect(
    dialog.getByRole("combobox", { name: "Session smith", exact: true }),
  ).toHaveValue("codex-journeyman");
  await dialog
    .getByRole("textbox", { name: "Session prompt", exact: true })
    .fill("Fork restart parent start");
  let sessionsArrived!: () => void;
  const sessionsRead = new Promise<void>((resolve) => {
    sessionsArrived = resolve;
  });
  const facts: ParentStartReadFacts = {
    stage: "prepared",
    identityGetCount: 0,
    sessionGetCount: 0,
    identityStatus: null,
    sessionStatus: null,
    identityScopeMatched: null,
    identityValid: null,
    sessionValid: null,
    sessionRows: null,
    checkingVisible: null,
    startDisabledWhileHeld: null,
    errorVisibleWhileHeld: null,
    reservePosts: 0,
    startPosts: 0,
    timingMs: {
      previewResponse: null,
      identityRead: null,
      heldUiObserved: null,
      readsReleased: null,
      startClick: null,
      reserveRequest: null,
      startRequest: null,
      startReceipt: null,
      readyAfterReads: null,
    },
  };
  const startedAt = performance.now();
  reportFacts(facts);
  const expectedOrigin = new URL(page.url()).origin;
  const sessionsPath = `/__agent-forge/projects/${forkProject.id}/sessions`;
  let gateReads = false;
  let previewCompleted = false;
  let previewRequested = false;
  const observePreviewRequest = (request: Request) => {
    const requestUrl = new URL(request.url());
    if (
      request.method() === "POST" &&
      requestUrl.origin === expectedOrigin &&
      requestUrl.pathname ===
        `/__agent-forge/projects/${forkProject.id}/sessions/preview`
    )
      previewRequested = true;
  };
  const workspace = forkProject.workspaces[0]?.root;
  if (!workspace) throw new Error("The Fork parent workspace is unavailable.");
  const identityRead = await verifiedIdentityReadBarrier(page, {
    projectId: forkProject.id,
    workspace,
    shouldHold: () => previewRequested,
  });
  const readMatcher = (candidate: URL) => candidate.pathname === sessionsPath;
  const readHandler = async (route: Route) => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    if (
      !gateReads ||
      !previewCompleted ||
      request.method() !== "GET" ||
      requestUrl.origin !== expectedOrigin
    ) {
      await route.continue();
      return;
    }
    facts.sessionGetCount++;
    const response = await route
      .fetch({
        headers: {
          ...(await request.allHeaders()),
          Origin: requestUrl.origin,
          "Sec-Fetch-Site": "same-origin",
        },
      })
      .catch(() => null);
    if (!response) {
      facts.sessionValid = false;
      await route.abort("failed").catch(() => {});
      sessionsArrived();
      return;
    }
    facts.sessionStatus = response.status();
    try {
      const envelope = record(await response.json());
      if (envelope?.["ok"] === true && Array.isArray(envelope["data"])) {
        facts.sessionRows = ownedCodingSessionSchema
          .array()
          .parse(envelope["data"]).length;
        facts.sessionValid = true;
      } else {
        facts.sessionValid = false;
      }
    } catch {
      facts.sessionValid = false;
    }
    try {
      await route.fulfill({ response });
    } finally {
      sessionsArrived();
    }
  };
  const previewResponse = page.waitForResponse((response) => {
    const responseUrl = new URL(response.url());
    return (
      response.request().method() === "POST" &&
      responseUrl.origin === expectedOrigin &&
      responseUrl.pathname ===
        `/__agent-forge/projects/${forkProject.id}/sessions/preview`
    );
  });
  await expect(
    dialog
      .getByRole("region", { name: "Original Start requests", exact: true })
      .getByRole("button", { name: "Check server", exact: true }),
  ).toBeEnabled();
  identityRead.arm();
  page.on("request", observePreviewRequest);
  await page.route(readMatcher, readHandler);
  facts.stage = "preview-pending";
  gateReads = true;
  try {
    await dialog
      .getByRole("button", { name: "Check supported options", exact: true })
      .click();
    const preview = await previewResponse;
    facts.timingMs.previewResponse = Math.round(performance.now() - startedAt);
    expect(preview.status()).toBe(200);
    previewCompleted = true;
    await expect.poll(identityRead.held).toBe(true);
    facts.identityGetCount = identityRead.heldReadCount();
    facts.identityStatus = 200;
    facts.identityValid = true;
    facts.identityScopeMatched = true;
    facts.stage = "identity-read-held";
    facts.timingMs.identityRead = Math.round(performance.now() - startedAt);
    expect(facts.identityStatus).toBe(200);
    expect(facts.identityValid).toBe(true);
    expect(facts.identityScopeMatched).toBe(true);
    if (facts.sessionGetCount > 0) {
      await sessionsRead;
      expect(facts.sessionStatus).toBe(200);
      expect(facts.sessionValid).toBe(true);
    }
    const starts = dialog.getByRole("button", { name: "Start", exact: true });
    await expect(
      dialog
        .getByRole("status")
        .filter({ hasText: "Checking the server-owned identity page…" }),
    ).toBeVisible();
    await expect(starts).toBeDisabled();
    facts.checkingVisible = true;
    facts.startDisabledWhileHeld = true;
    facts.errorVisibleWhileHeld =
      (await dialog.getByRole("alert").count()) > 0 ||
      (await dialog.locator(".af-session-warning").count()) > 0;
    facts.timingMs.heldUiObserved = Math.round(performance.now() - startedAt);
  } finally {
    gateReads = false;
    facts.timingMs.readsReleased = Math.round(performance.now() - startedAt);
    facts.stage = "reads-released";
    await identityRead.release();
    await identityRead.dispose();
    await page.unroute(readMatcher, readHandler);
    page.off("request", observePreviewRequest);
  }
  await expect(
    dialog
      .getByRole("region", { name: "Original Start requests", exact: true })
      .getByRole("status")
      .filter({ hasText: "Checking the server-owned identity page…" }),
  ).toBeHidden();
  await expect(
    dialog.getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
  facts.timingMs.readyAfterReads = Math.round(performance.now() - startedAt);
  const before = new Set(rows().map((item) => item.id));
  const reservePath = `/__agent-forge/projects/${forkProject.id}/session-start-identities`;
  const startPath = `/__agent-forge/projects/${forkProject.id}/sessions`;
  let reserveRequestId: string | null = null;
  let reserveRequestHash: string | null = null;
  const countStartRequests = (request: Request) => {
    const requestUrl = new URL(request.url());
    if (request.method() !== "POST" || requestUrl.origin !== expectedOrigin)
      return;
    if (requestUrl.pathname === reservePath) {
      facts.reservePosts++;
      facts.timingMs.reserveRequest = Math.round(performance.now() - startedAt);
    }
    if (requestUrl.pathname === startPath) {
      facts.startPosts++;
      facts.timingMs.startRequest = Math.round(performance.now() - startedAt);
    }
  };
  page.on("request", countStartRequests);
  const reserveResponse = page.waitForResponse(async (response) => {
    const responseUrl = new URL(response.url());
    if (
      response.request().method() !== "POST" ||
      responseUrl.origin !== expectedOrigin ||
      responseUrl.pathname !== reservePath
    )
      return false;
    const envelope = record(await response.json().catch(() => null));
    if (envelope?.["ok"] !== true) return false;
    const reply = sessionStartIdentityReplySchema.parse(envelope["data"]);
    expect(reply.scope).toEqual({
      family: "owned-session-start",
      projectId: forkProject.id,
      workspace: forkProject.workspaces[0]?.root,
    });
    expect(reply.identity).toMatchObject({
      provider: "codex",
      mode: "chat",
      state: "reserved",
    });
    reserveRequestId = reply.identity.requestId;
    reserveRequestHash = reply.identity.requestHash;
    return true;
  });
  const startRequest = page.waitForRequest((request) => {
    const requestUrl = new URL(request.url());
    return (
      request.method() === "POST" &&
      requestUrl.origin === expectedOrigin &&
      requestUrl.pathname === startPath
    );
  });
  const startResponse = page.waitForResponse((response) => {
    const responseUrl = new URL(response.url());
    return (
      response.request().method() === "POST" &&
      responseUrl.origin === expectedOrigin &&
      responseUrl.pathname === startPath
    );
  });
  facts.stage = "start-dispatched";
  facts.timingMs.startClick = Math.round(performance.now() - startedAt);
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  let receiptSession: SessionRow | null = null;
  try {
    const [reserved, startReq, started] = await Promise.all([
      reserveResponse,
      startRequest,
      startResponse,
    ]);
    expect(reserved.status()).toBe(200);
    expect(started.status()).toBe(202);
    const startBody = record(startReq.postDataJSON());
    const startEnvelope = record(await started.json());
    if (startEnvelope?.["ok"] !== true)
      throw new Error("The actual parent Start receipt was invalid.");
    const receipt = ownedCodingStartReceiptSchema.parse(startEnvelope["data"]);
    receiptSession = receipt.session;
    expect(receipt.session.requestId).toBe(reserveRequestId);
    expect(receipt.session.requestHash).toBe(reserveRequestHash);
    expect(receipt.session.provider).toBe("codex");
    expect(receipt.session.mode).toBe("chat");
    expect(startBody?.["requestId"]).toBe(reserveRequestId);
    expect(facts.reservePosts).toBe(1);
    expect(facts.startPosts).toBe(1);
    facts.timingMs.startReceipt = Math.round(performance.now() - startedAt);
    facts.stage = "start-receipted";
    reportFacts(facts);
  } finally {
    page.off("request", countStartRequests);
  }
  const pane = page.getByRole("region", {
    name: "Session conversation",
    exact: true,
  });
  await expect(pane).toBeVisible();
  await expect
    .poll(() => rows().filter((item) => !before.has(item.id)).length)
    .toBe(1);
  const parent = rows().find((item) => !before.has(item.id));
  if (!parent)
    throw new Error("The actual Codex Chat parent was not recorded.");
  expect(parent.requestId).toBe(receiptSession?.requestId);
  expect(parent.requestHash).toBe(receiptSession?.requestHash);
  await expect(pane).toContainText("Hello world");
  expect(
    readFileSync(join(ROOT, "codex-sync-fixture-marker.txt"), "utf8"),
  ).toBe("inert sync ran\n");
  return parent;
}

async function createCompletedSourceTurn(
  page: Page,
  parent: SessionRow,
  label: string,
): Promise<{ parent: SessionRow; turnId: string }> {
  const prior = new Set(saved(parent.id).turns.map((turn) => turn.requestId));
  const pane = page.getByRole("region", {
    name: "Session conversation",
    exact: true,
  });
  await page
    .getByRole("textbox", { name: "Session reply prompt", exact: true })
    .fill(`PRIVATE Fork source ${label}`);
  await pane
    .getByRole("button", { name: "Send session message", exact: true })
    .click();
  let turnId: string | null = null;
  await expect
    .poll(() => {
      const turn = saved(parent.id).turns.find(
        (candidate) => !prior.has(candidate.requestId),
      );
      if (turn?.phase === "completed") turnId = turn.requestId;
      return turn?.phase ?? null;
    })
    .toBe("completed");
  if (!turnId) throw new Error("The actual source turn did not complete.");
  return { parent, turnId };
}

async function originalReview(page: Page, parentId: string, turnId: string) {
  const opener = page.getByRole("button", {
    name: `Review Fork through ${turnId.slice(0, 8)}`,
    exact: true,
  });
  await opener.click();
  const dialog = page.getByRole("dialog", {
    name: "Review native Codex Fork",
    exact: true,
  });
  await expect(dialog).toContainText("Saved completed parent turn");
  await expect(dialog).toContainText("PRIVATE Fork source");
  const nativeParentId = saved(parentId).binding?.sessionId;
  if (nativeParentId) await expect(dialog).not.toContainText(nativeParentId);
  return dialog;
}

async function issueRestart(): Promise<{ url: string; status: number }> {
  const manifestPath = join(HEARTH_HOME, "restart-fixture.json");
  const manifest = record(
    parseJson(readFileSync(manifestPath, "utf8"), "restart manifest"),
  );
  const control = record(manifest?.["fixtureControl"]);
  const port = control?.["port"],
    secret = control?.["secret"];
  if (
    typeof port !== "number" ||
    typeof secret !== "string" ||
    !/^[a-f0-9]{64}$/.test(secret)
  )
    throw new Error("The owned Fork restart control was not verified.");
  const response = await new Promise<{ status: number; body: string }>(
    (resolve, reject) => {
      let deadline: ReturnType<typeof setTimeout>;
      const request = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: FORK_RESTART_PATH,
          method: "POST",
          headers: { [CONTROL_HEADER]: secret, "Content-Length": "0" },
        },
        (incoming) => {
          let body = "";
          incoming.setEncoding("utf8");
          incoming.on("data", (chunk: string) => {
            body += chunk;
            if (body.length > 8192) incoming.destroy();
          });
          incoming.on("end", () => {
            clearTimeout(deadline);
            resolve({ status: incoming.statusCode ?? 0, body });
          });
          incoming.on("error", (error) => {
            clearTimeout(deadline);
            reject(error);
          });
        },
      );
      deadline = setTimeout(
        () =>
          request.destroy(
            new Error("The bounded owned host replacement timed out."),
          ),
        60_000,
      );
      request.on("error", (error) => {
        clearTimeout(deadline);
        reject(error);
      });
      request.end();
    },
  );
  const envelope = record(parseJson(response.body, "Fork restart response"));
  const data = record(envelope?.["data"]);
  if (
    response.status !== 200 ||
    envelope?.["ok"] !== true ||
    typeof data?.["url"] !== "string"
  )
    throw new Error("The owned Fork host replacement failed.");
  return { url: data["url"], status: response.status };
}

async function restoreBaseOrigin(): Promise<void> {
  const manifest = record(
    parseJson(
      readFileSync(join(HEARTH_HOME, "restart-fixture.json"), "utf8"),
      "restart manifest",
    ),
  );
  const control = record(manifest?.["fixtureControl"]);
  const port = control?.["port"],
    secret = control?.["secret"];
  if (
    typeof port !== "number" ||
    typeof secret !== "string" ||
    !/^[a-f0-9]{64}$/.test(secret)
  )
    throw new Error("The owned fixture restore control was not verified.");
  const result = await new Promise<{ status: number; body: string }>(
    (resolve, reject) => {
      const request = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/__desktop-restart-fixture/restore-base-origin",
          method: "POST",
          headers: { [CONTROL_HEADER]: secret, "Content-Length": "0" },
        },
        (incoming) => {
          let body = "";
          incoming.setEncoding("utf8");
          incoming.on("data", (chunk: string) => {
            body += chunk;
            if (body.length > 8192) incoming.destroy();
          });
          incoming.on("end", () => {
            clearTimeout(deadline);
            resolve({ status: incoming.statusCode ?? 0, body });
          });
          incoming.on("error", (error) => {
            clearTimeout(deadline);
            reject(error);
          });
        },
      );
      const deadline = setTimeout(
        () =>
          request.destroy(
            new Error("The bounded fixture base-origin restore timed out."),
          ),
        60_000,
      );
      request.on("error", (error) => {
        clearTimeout(deadline);
        reject(error);
      });
      request.end();
    },
  );
  const envelope = record(parseJson(result.body, "fixture restore response"));
  const data = record(envelope?.["data"]);
  if (
    result.status !== 200 ||
    envelope?.["ok"] !== true ||
    typeof data?.["url"] !== "string" ||
    typeof data["pid"] !== "number" ||
    !Number.isSafeInteger(data["pid"]) ||
    new URL(data["url"]).origin !== `http://127.0.0.1:${DASHBOARD_PORT}`
  )
    throw new Error("The owned fixture base origin could not be verified.");
}

async function observeEmptyFirstDocument(page: Page, generation: number) {
  const key = `${INITIAL_STORAGE_KEY}_${generation}`;
  await page.addInitScript(
    ({ identityKey, sessionKey, observationKey }) => {
      if (sessionStorage.getItem(observationKey) === null)
        sessionStorage.setItem(
          observationKey,
          JSON.stringify({
            identity: localStorage.getItem(identityKey),
            sessionKey: localStorage.getItem(sessionKey),
            localStorageLength: localStorage.length,
            localStorageKeys: Array.from(
              { length: localStorage.length },
              (_, index) => localStorage.key(index),
            ),
          }),
        );
    },
    {
      identityKey: SESSION_START_IDENTITIES,
      sessionKey: SESSION_KEY_STORAGE,
      observationKey: key,
    },
  );
  return key;
}

async function authenticateNewHost(
  page: Page,
  url: string,
  generation: number,
) {
  const origin = new URL(url).origin;
  const storageKey = await observeEmptyFirstDocument(page, generation);
  const exchanged = page.waitForResponse((response) => {
    const requestUrl = new URL(response.url());
    return (
      response.request().method() === "POST" &&
      requestUrl.origin === origin &&
      requestUrl.pathname === SESSION_ROUTE
    );
  });
  await page.goto(url);
  expect((await exchanged).status()).toBe(200);
  const key = await page.evaluate(
    (name) => localStorage.getItem(name),
    SESSION_KEY_STORAGE,
  );
  expect(key).toMatch(/^[a-f0-9]{64}$/);
  const observed = record(
    parseJson(
      (await page.evaluate(
        (name) => sessionStorage.getItem(name),
        storageKey,
      )) ?? "null",
      "first-document storage observation",
    ),
  );
  expect(observed?.["identity"]).toBeNull();
  expect(observed?.["sessionKey"]).toBeNull();
  expect(observed?.["localStorageLength"]).toBe(0);
  expect(observed?.["localStorageKeys"]).toEqual([]);
  return origin;
}

async function selectSession(page: Page, origin: string, sessionId: string) {
  await page.evaluate(
    (hash) => {
      window.location.hash = hash;
    },
    `#/desktop/project/${forkProject.id}/sessions?selectionKind=session&selectionId=${encodeURIComponent(sessionId)}`,
  );
  await expect(
    page.getByRole("region", { name: "Session conversation", exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).origin).toBe(origin);
}

async function readIdentityPage(page: Page, origin: string) {
  const token = await pageToken(page);
  const response = await page.evaluate(
    async ({ path, header, value }) => {
      const result = await fetch(path, { headers: { [header]: value } });
      return { status: result.status, text: await result.text() };
    },
    {
      path: `/__agent-forge/projects/${forkProject.id}/session-operation-identities`,
      header: OPERATOR_HEADER,
      value: token,
    },
  );
  expect(response.status).toBe(200);
  expect(new URL(page.url()).origin).toBe(origin);
  return sessionOperationIdentityPageSchema.parse(
    record(parseJson(response.text, "operation identity page"))?.["data"],
  );
}

async function readForkOriginal(page: Page, origin: string, requestId: string) {
  const token = await pageToken(page);
  const response = await page.evaluate(
    async ({ path, header, value }) => {
      const result = await fetch(path, { headers: { [header]: value } });
      return { status: result.status, text: await result.text() };
    },
    {
      path: `/__agent-forge/projects/${forkProject.id}/codex-chat-forks/${encodeURIComponent(requestId)}`,
      header: OPERATOR_HEADER,
      value: token,
    },
  );
  expect(response.status).toBe(200);
  expect(new URL(page.url()).origin).toBe(origin);
  return codexChatForkIdentityMetadataSchema.parse(
    record(parseJson(response.text, "saved Fork original"))?.["data"],
  );
}

async function holdEffectfulRoute(
  page: Page,
  suffix: string,
  expectedState: "reserved" | "linked",
) {
  let effectArrived!: () => void;
  let release!: () => void;
  let replyAborted!: () => void;
  const arrived = new Promise<void>((resolve) => {
    effectArrived = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const aborted = new Promise<void>((resolve) => {
    replyAborted = resolve;
  });
  let metadata: ReturnType<
    typeof codexChatForkIdentityMetadataSchema.parse
  > | null = null;
  let handlerEntered = false;
  const matcher = (url: URL) => url.pathname.endsWith(suffix);
  const handler = async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    handlerEntered = true;
    const origin = new URL(route.request().url()).origin;
    const pageOrigin = new URL(page.url()).origin;
    const headers = await route.request().allHeaders();
    if (
      origin !== pageOrigin ||
      headers["origin"] !== origin ||
      (headers["sec-fetch-site"] !== undefined &&
        headers["sec-fetch-site"] !== "same-origin")
    )
      throw new Error(
        "The browser Fork request did not carry its actual origin.",
      );
    const response = await route.fetch({ headers });
    if (!response.ok())
      throw new Error(
        `The actual Fork operation returned ${response.status()}.`,
      );
    const envelope = record(await response.json());
    if (envelope?.["ok"] !== true)
      throw new Error("The actual Fork operation envelope was invalid.");
    metadata = codexChatForkIdentityMetadataSchema.parse(envelope["data"]);
    if (metadata.state !== expectedState)
      throw new Error("The actual Fork operation state was unexpected.");
    effectArrived();
    try {
      await held;
      await route.abort("connectionfailed").catch(() => {});
    } finally {
      replyAborted();
    }
  };
  await page.route(matcher, handler);
  return {
    arrived,
    aborted,
    metadata: () => metadata,
    async release() {
      release();
      if (handlerEntered)
        await Promise.race([
          aborted,
          new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
        ]);
      await page.unroute(matcher, handler);
    },
  };
}

async function operationRows(page: Page, origin: string) {
  return (await readIdentityPage(page, origin)).operations.filter(
    (item) => item.family === "codex-chat-fork",
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto(
    `/index.html#/desktop/project/${encodeURIComponent(forkProject.id)}/sessions`,
  );
});

test("two actual host replacements recover the exact Fork original before and after native effect", async ({
  page,
}) => {
  test.setTimeout(180_000);
  forkBaseRestoreNeeded = false;
  forkBaseRestoreStatus = "not-needed";
  const startWrites: string[] = [];
  const identityWrites: string[] = [];
  const forkBodies: Array<{ path: string; body: unknown }> = [];
  const knownIdentities: Array<Record<string, unknown>> = [];
  let observedOrigin = "unavailable";
  let stage = "initializing";
  const forksBefore = rpcCount("thread/fork");
  const startsBefore = rpcCount("thread/start");
  let parentStartFacts: ParentStartReadFacts | null = null;
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const url = new URL(request.url());
    if (url.pathname === `/__agent-forge/projects/${forkProject.id}/sessions`)
      startWrites.push(url.pathname);
    if (
      url.pathname.startsWith(
        `/__agent-forge/projects/${forkProject.id}/sessions/`,
      ) &&
      (url.pathname.endsWith("/fork-reservations") ||
        url.pathname.endsWith("/forks") ||
        (url.pathname.includes("/fork-reservations/") &&
          url.pathname.endsWith("/retire")))
    ) {
      identityWrites.push(url.pathname);
      forkBodies.push({ path: url.pathname, body: request.postDataJSON() });
    }
  });
  forkOriginFailureFacts = () => {
    let sessionFacts: Array<Record<string, unknown>> | null = null;
    let nativeCalls: Array<Record<string, unknown>> | null = null;
    try {
      sessionFacts = rows()
        .slice(0, 32)
        .map((row) => {
          const origin = record(row.origin);
          return {
            sessionId: row.id,
            projectId: row.projectId,
            originKind: origin?.["kind"] ?? null,
            originParentSessionId: origin?.["parentSessionId"] ?? null,
            originRequestId: origin?.["requestId"] ?? null,
          };
        });
    } catch {
      sessionFacts = null;
    }
    try {
      const counts = new Map<string, number>();
      for (const call of calls().slice(0, 128)) {
        if (call.kind !== "rpc" || !call.method) continue;
        const threadId = call.params?.["threadId"];
        const key = `${call.method}\u0000${typeof threadId === "string" ? threadId : "unavailable"}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      nativeCalls = [...counts.entries()].slice(0, 32).map(([key, count]) => {
        const [method, threadId] = key.split("\u0000");
        return { method, threadId, count };
      });
    } catch {
      nativeCalls = null;
    }
    return {
      version: 1,
      stage,
      origin: observedOrigin,
      projectId: forkProject.id,
      identities: knownIdentities.slice(0, 8),
      posts: forkBodies.slice(0, 32).map((entry) => ({
        path: entry.path,
        requestId: record(entry.body)?.["requestId"] ?? null,
      })),
      nativeRpcCounts: nativeCalls,
      fixtureCalls: fixtureCallFacts(),
      sessions: sessionFacts,
      counts: {
        startPosts: startWrites.length,
        identityPosts: identityWrites.length,
        forkRpcCalls: rpcCount("thread/fork"),
        startRpcCalls: rpcCount("thread/start"),
      },
      parentStart: parentStartFacts,
    };
  };

  const firstManifestText = readFileSync(
    join(HEARTH_HOME, "restart-fixture.json"),
    "utf8",
  );
  const firstManifest = record(
    parseJson(firstManifestText, "restart manifest"),
  );
  const firstUrl = firstManifest?.["url"];
  if (typeof firstUrl !== "string")
    throw new Error("The first owned host URL is unavailable.");
  let currentUrl = firstUrl;
  let currentOrigin = new URL(firstUrl).origin;
  observedOrigin = currentOrigin;
  let beforeFirstReplacement = { starts: 0, writes: 0, forks: 0 };

  const captureParentStartFacts = (facts: ParentStartReadFacts) => {
    parentStartFacts = facts;
  };
  const firstParent = await openNewSession(
    page,
    currentUrl,
    captureParentStartFacts,
  );
  stage = "first-parent-created";
  let first = await createCompletedSourceTurn(page, firstParent, "A");
  stage = "first-source-turn-completed";
  const firstReview = await originalReview(page, first.parent.id, first.turnId);
  const firstReservation = await holdEffectfulRoute(
    page,
    `/sessions/${first.parent.id}/fork-reservations`,
    "reserved",
  );
  try {
    await firstReview
      .getByRole("button", { name: "Reserve this exact Fork", exact: true })
      .click();
    await firstReservation.arrived;
    const firstIdentity = firstReservation.metadata();
    if (!firstIdentity)
      throw new Error("The first Fork reservation was not captured.");
    expect(firstIdentity).toMatchObject({
      parentSessionId: first.parent.id,
      throughTurnRequestId: first.turnId,
      state: "reserved",
    });
    knownIdentities.push(safeIdentityFacts(firstIdentity));
    stage = "first-reservation-response-held";
    beforeFirstReplacement = {
      starts: startWrites.length,
      writes: identityWrites.length,
      forks: rpcCount("thread/fork"),
    };
    forkBaseRestoreNeeded = true;
    const firstRestart = await issueRestart();
    currentUrl = firstRestart.url;
    currentOrigin = await authenticateNewHost(page, currentUrl, 1);
    observedOrigin = currentOrigin;
    stage = "first-new-origin-authenticated";
  } finally {
    await firstReservation.release();
  }
  await selectSession(page, currentOrigin, first.parent.id);
  expect(startWrites).toHaveLength(beforeFirstReplacement.starts);
  expect(identityWrites).toHaveLength(beforeFirstReplacement.writes);
  expect(rpcCount("thread/fork")).toBe(beforeFirstReplacement.forks);
  const firstPage = await readIdentityPage(page, currentOrigin);
  expect(firstPage.scope).toEqual({
    projectId: forkProject.id,
    workspace: forkProject.workspaces[0]?.root,
  });
  const firstIdentityBefore = firstPage.operations.filter(
    (item) => item.family === "codex-chat-fork",
  );
  expect(firstIdentityBefore).toContainEqual(firstReservation.metadata());
  const firstOriginal = await readForkOriginal(
    page,
    currentOrigin,
    firstReservation.metadata()!.requestId,
  );
  expect(firstOriginal).toMatchObject({
    requestId: firstReservation.metadata()!.requestId,
    requestHash: firstReservation.metadata()!.requestHash,
    parentSessionId: first.parent.id,
    throughTurnRequestId: first.turnId,
    state: "reserved",
  });
  stage = "first-reservation-recovered";
  expect(rpcCount("thread/fork")).toBe(forksBefore);
  const beforeExplicitFirstDispatch = {
    starts: startWrites.length,
    identity: identityWrites.length,
  };
  const reviewA = await originalReview(page, first.parent.id, first.turnId);
  await expect(reviewA).toContainText(
    `${firstIdentityBefore[0]?.requestId} · reserved`,
  );
  expect(startWrites.length).toBe(beforeExplicitFirstDispatch.starts);
  expect(identityWrites.length).toBe(beforeExplicitFirstDispatch.identity);

  const firstRequestId = firstReservation.metadata()!.requestId;
  const firstRequestHash = firstReservation.metadata()!.requestHash;
  const retirementCapture = await captureTextResponseThroughBrowserFetch(page, {
    method: "POST",
    origin: currentOrigin,
    path: `/__agent-forge/projects/${forkProject.id}/sessions/${first.parent.id}/fork-reservations/${firstRequestId}/retire`,
  });
  let retirementHttp: { status: number; text: string };
  try {
    await reviewA
      .getByRole("button", {
        name: "Retire verified not-sent original",
        exact: true,
      })
      .click();
    retirementHttp = await retirementCapture.response;
  } finally {
    await retirementCapture.dispose();
  }
  expect(retirementHttp.status).toBe(200);
  const retirementEnvelope = record(
    parseJson(retirementHttp.text, "retired Fork original"),
  );
  if (retirementEnvelope?.["ok"] !== true)
    throw new Error("The Fork reservation retirement was not confirmed.");
  const firstRetired = codexChatForkIdentityMetadataSchema.parse(
    retirementEnvelope["data"],
  );
  expect(firstRetired).toMatchObject({
    requestId: firstRequestId,
    requestHash: firstRequestHash,
    parentSessionId: first.parent.id,
    throughTurnRequestId: first.turnId,
    state: "retired",
  });
  knownIdentities.push(safeIdentityFacts(firstRetired));
  stage = "first-reservation-retired";
  await expect(reviewA).toContainText(`${firstRequestId} · retired`);
  const retiredReadIdentity = await readForkOriginal(
    page,
    currentOrigin,
    firstRequestId,
  );
  expect(retiredReadIdentity).toMatchObject({
    requestId: firstRequestId,
    requestHash: firstRequestHash,
    parentSessionId: first.parent.id,
    throughTurnRequestId: first.turnId,
    state: "retired",
  });
  expect(rpcCount("thread/fork")).toBe(forksBefore);

  const replacementReserveCapture =
    await captureTextResponseThroughBrowserFetch(page, {
      method: "POST",
      origin: currentOrigin,
      path: `/__agent-forge/projects/${forkProject.id}/sessions/${first.parent.id}/fork-reservations`,
    });
  let replacementReserveHttp: { status: number; text: string };
  try {
    await reviewA
      .getByRole("button", {
        name: "Reserve a new Fork from this turn",
        exact: true,
      })
      .click();
    replacementReserveHttp = await replacementReserveCapture.response;
  } finally {
    await replacementReserveCapture.dispose();
  }
  expect(replacementReserveHttp.status).toBe(200);
  const replacementReserveEnvelope = record(
    parseJson(replacementReserveHttp.text, "replacement Fork reservation"),
  );
  if (replacementReserveEnvelope?.["ok"] !== true)
    throw new Error("The replacement Fork reservation was not confirmed.");
  const firstReplacement = codexChatForkIdentityMetadataSchema.parse(
    replacementReserveEnvelope["data"],
  );
  expect(firstReplacement).toMatchObject({
    parentSessionId: first.parent.id,
    throughTurnRequestId: first.turnId,
    state: "reserved",
  });
  knownIdentities.push(safeIdentityFacts(firstReplacement));
  stage = "replacement-reserved";
  expect(firstReplacement.requestId).not.toBe(firstRequestId);
  expect(firstReplacement.requestHash).not.toBe(firstRequestHash);
  const historyACapture = await captureTextResponseThroughBrowserFetch(page, {
    method: "GET",
    origin: currentOrigin,
    path: `/__agent-forge/projects/${forkProject.id}/codex-chat-forks/${firstRequestId}`,
  });
  let historyAHttp: { status: number; text: string };
  try {
    await reviewA
      .getByRole("button", {
        name: `Inspect Fork original ${firstRequestId.slice(0, 8)} · retired`,
        exact: true,
      })
      .click();
    historyAHttp = await historyACapture.response;
  } finally {
    await historyACapture.dispose();
  }
  expect(historyAHttp.status).toBe(200);
  const historyAEnvelope = record(
    parseJson(historyAHttp.text, "retired Fork history"),
  );
  expect(
    codexChatForkIdentityMetadataSchema.parse(historyAEnvelope?.["data"]),
  ).toMatchObject({
    requestId: firstRequestId,
    requestHash: firstRequestHash,
    state: "retired",
  });
  await expect(
    reviewA.getByRole("button", {
      name: "Reserve a new Fork from this turn",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(rpcCount("thread/fork")).toBe(forksBefore);
  await reviewA
    .getByRole("button", {
      name: `Inspect Fork original ${firstReplacement.requestId.slice(0, 8)} · reserved`,
      exact: true,
    })
    .click();

  const firstLinkedCapture = await captureTextResponseThroughBrowserFetch(
    page,
    {
      method: "POST",
      origin: currentOrigin,
      path: `/__agent-forge/projects/${forkProject.id}/sessions/${first.parent.id}/forks`,
    },
  );
  let firstLinkedHttp: { status: number; text: string };
  try {
    await reviewA
      .getByRole("button", {
        name: "Create the native child thread once",
        exact: true,
      })
      .click();
    firstLinkedHttp = await firstLinkedCapture.response;
  } finally {
    await firstLinkedCapture.dispose();
  }
  expect(firstLinkedHttp.status).toBe(200);
  const firstLinkedEnvelope = record(
    parseJson(firstLinkedHttp.text, "linked Fork response"),
  );
  if (firstLinkedEnvelope?.["ok"] !== true)
    throw new Error("The first native Fork response was invalid.");
  const firstLinked = codexChatForkIdentityMetadataSchema.parse(
    firstLinkedEnvelope["data"],
  );
  knownIdentities.push(safeIdentityFacts(firstLinked));
  stage = "replacement-linked";
  expect(firstLinked).toMatchObject({
    requestId: firstReplacement.requestId,
    requestHash: firstReplacement.requestHash,
    parentSessionId: first.parent.id,
    throughTurnRequestId: first.turnId,
    state: "linked",
  });
  await expect.poll(() => rpcCount("thread/fork")).toBe(forksBefore + 1);
  const firstReplacementBodies = forkBodies.filter(
    (entry) => record(entry.body)?.["requestId"] === firstReplacement.requestId,
  );
  expect(firstReplacementBodies).toHaveLength(2);
  expect(firstReplacementBodies[0]?.body).toEqual(
    firstReplacementBodies[1]?.body,
  );
  expect(firstReplacementBodies[0]?.body).toMatchObject({
    requestId: firstReplacement.requestId,
    throughTurnRequestId: first.turnId,
  });
  expect(
    calls().find((row) => row.kind === "rpc" && row.method === "thread/fork")
      ?.params,
  ).toMatchObject({ threadId: saved(first.parent.id).binding?.sessionId });
  const firstChild = rows().find(
    (item) =>
      item.id !== first.parent.id &&
      item.origin?.kind === "codex-chat-fork" &&
      item.origin.parentSessionId === first.parent.id,
  );
  if (!firstChild)
    throw new Error("The first linked child record is unavailable.");
  await page.keyboard.press("Escape");
  await expect(reviewA).toBeHidden();

  const secondParent = await openNewSession(
    page,
    currentUrl,
    captureParentStartFacts,
  );
  stage = "second-parent-created";
  const second = await createCompletedSourceTurn(page, secondParent, "B");
  stage = "second-source-turn-completed";
  const reviewB = await originalReview(page, second.parent.id, second.turnId);
  const secondReservation = await holdEffectfulRoute(
    page,
    `/sessions/${second.parent.id}/forks`,
    "linked",
  );
  let secondIdentity: ReturnType<
    typeof codexChatForkIdentityMetadataSchema.parse
  > | null = null;
  let beforeSecondReplacement = { forks: 0, starts: 0, writes: 0 };
  try {
    await reviewB
      .getByRole("button", { name: "Reserve this exact Fork", exact: true })
      .click();
    const createChild = reviewB.getByRole("button", {
      name: "Create the native child thread once",
      exact: true,
    });
    await expect(createChild).toBeEnabled();
    await createChild.click();
    await secondReservation.arrived;
    secondIdentity = secondReservation.metadata();
    if (!secondIdentity)
      throw new Error("The second linked Fork was not captured.");
    expect(secondIdentity).toMatchObject({
      parentSessionId: second.parent.id,
      throughTurnRequestId: second.turnId,
      state: "linked",
    });
    knownIdentities.push(safeIdentityFacts(secondIdentity));
    stage = "second-linked-response-held";
    await expect.poll(() => rpcCount("thread/fork")).toBe(forksBefore + 2);
    beforeSecondReplacement = {
      forks: rpcCount("thread/fork"),
      starts: startWrites.length,
      writes: identityWrites.length,
    };
    forkBaseRestoreNeeded = true;
    const secondRestart = await issueRestart();
    currentUrl = secondRestart.url;
    currentOrigin = await authenticateNewHost(page, currentUrl, 2);
    observedOrigin = currentOrigin;
    stage = "second-new-origin-authenticated";
  } finally {
    await secondReservation.release();
  }
  await selectSession(page, currentOrigin, second.parent.id);
  expect(rpcCount("thread/fork")).toBe(beforeSecondReplacement.forks);
  expect(startWrites).toHaveLength(beforeSecondReplacement.starts);
  expect(identityWrites).toHaveLength(beforeSecondReplacement.writes);
  const noReplay = {
    forks: rpcCount("thread/fork"),
    starts: startWrites.length,
    identityWrites: identityWrites.length,
  };
  const recoveredRows = await operationRows(page, currentOrigin);
  for (const identity of [
    firstRetired,
    firstLinked,
    secondReservation.metadata(),
  ])
    expect(recoveredRows).toContainEqual(identity);
  const recoveredFirst = await readForkOriginal(
    page,
    currentOrigin,
    firstLinked.requestId,
  );
  expect(recoveredFirst).toMatchObject({
    requestId: firstLinked.requestId,
    requestHash: firstLinked.requestHash,
    parentSessionId: first.parent.id,
    throughTurnRequestId: first.turnId,
    state: "linked",
    childSessionId: firstLinked.childSessionId,
  });
  const recoveredRetiredFirst = await readForkOriginal(
    page,
    currentOrigin,
    firstRequestId,
  );
  expect(recoveredRetiredFirst).toMatchObject({
    requestId: firstRequestId,
    requestHash: firstRequestHash,
    parentSessionId: first.parent.id,
    throughTurnRequestId: first.turnId,
    state: "retired",
  });
  const recoveredSecond = await readForkOriginal(
    page,
    currentOrigin,
    secondReservation.metadata()!.requestId,
  );
  expect((await readIdentityPage(page, currentOrigin)).scope).toEqual({
    projectId: forkProject.id,
    workspace: forkProject.workspaces[0]?.root,
  });
  expect(recoveredSecond).toMatchObject({
    requestId: secondReservation.metadata()!.requestId,
    requestHash: secondReservation.metadata()!.requestHash,
    parentSessionId: second.parent.id,
    throughTurnRequestId: second.turnId,
    state: "linked",
    childSessionId: secondReservation.metadata()!.childSessionId,
  });
  await expect(
    page.getByRole("button", {
      name: `Review Fork through ${second.turnId.slice(0, 8)}`,
      exact: true,
    }),
  ).toBeVisible();
  const reviewSecond = await originalReview(
    page,
    second.parent.id,
    second.turnId,
  );
  await expect(
    reviewSecond.getByRole("region", {
      name: "Fork child conversation",
      exact: true,
    }),
  ).toBeVisible();
  expect(rpcCount("thread/fork")).toBe(noReplay.forks);
  expect(startWrites).toHaveLength(noReplay.starts);
  expect(identityWrites).toHaveLength(noReplay.identityWrites);
  expect(rpcCount("thread/start")).toBe(startsBefore + 2);
  expect(rpcCount("thread/fork")).toBe(forksBefore + 2);
  expect(secondReservation.metadata()!.childSessionId).not.toBe(firstChild.id);
  const secondReplacementBodies = forkBodies.filter(
    (entry) =>
      record(entry.body)?.["requestId"] ===
      secondReservation.metadata()!.requestId,
  );
  expect(secondReplacementBodies).toHaveLength(2);
  expect(secondReplacementBodies[0]?.body).toEqual(
    secondReplacementBodies[1]?.body,
  );
  expect(secondReplacementBodies[0]?.body).toMatchObject({
    requestId: secondReservation.metadata()!.requestId,
    throughTurnRequestId: second.turnId,
  });
  const nativeForks = calls().filter(
    (row) => row.kind === "rpc" && row.method === "thread/fork",
  );
  expect(nativeForks[0]?.params).toMatchObject({
    threadId: saved(first.parent.id).binding?.sessionId,
  });
  expect(nativeForks[1]?.params).toMatchObject({
    threadId: saved(second.parent.id).binding?.sessionId,
  });
  expect(rpcCount("thread/start")).toBe(startsBefore + 2);

  const proof = record(
    parseJson(
      readFileSync(
        join(HEARTH_HOME, "desktop-host-fork-replacement-proof-v2.json"),
        "utf8",
      ),
      "Fork replacement proof",
    ),
  );
  expect(proof?.["version"]).toBe(2);
  expect(proof?.["generations"]).toHaveLength(2);
  const generations = proof?.["generations"] as Array<Record<string, unknown>>;
  expect(
    new Set(
      generations.flatMap((item) => [
        item["oldDesktopHostPort"],
        item["newDesktopHostPort"],
      ]),
    ).size,
  ).toBe(3);
  expect(generations[0]?.["newDesktopHostPort"]).toBe(
    generations[1]?.["oldDesktopHostPort"],
  );
  expect(
    new Set(
      generations.flatMap((item) => [
        item["oldOwnedHearthPid"],
        item["newOwnedHearthPid"],
      ]),
    ).size,
  ).toBe(3);
  expect(
    new Set(
      generations.flatMap((item) => [
        item["oldHostOwner"],
        item["newHostOwner"],
      ]),
    ).size,
  ).toBe(3);
  expect(
    generations.every(
      (item) => item["controlPort"] === generations[0]?.["controlPort"],
    ),
  ).toBe(true);
});
