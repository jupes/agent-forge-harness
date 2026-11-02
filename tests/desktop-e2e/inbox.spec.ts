import { createHash, randomUUID } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { CODEX_CHAT_DECISION_IDENTITIES } from "../../apps/desktop/src/codex-chat-decision-identities";
import { expect, test, type CDPSession, type Page, type Request, type Route } from "@playwright/test";
import { z } from "zod";
import { GEMINI_CHAT_DECISION_IDENTITIES } from "../../apps/desktop/src/gemini-chat-decision-identities";
import { OPERATOR_HEADER } from "../../scripts/hearth/paths";
import {
  codexChatApprovalPageSchema,
  codexChatDecisionReceiptSchema,
  codexChatDecisionRequestSchema,
  CODEX_FILE_DETAILS_UNAVAILABLE,
} from "../../scripts/sessions/codex-chat-owned-protocol";
import { ownedCodingStateSchema } from "../../scripts/sessions/codex-owned-journal";
import { conversationReceiptSchema } from "../../scripts/conversations/protocol";
import { ownedCodingSessionSchema } from "../../scripts/sessions/codex-owned-wire-protocol";
import { geminiChatApprovalPageSchema, geminiChatDecisionReceiptSchema, geminiChatDecisionRequestSchema } from "../../scripts/sessions/gemini-chat-owned-protocol";
import {
  inboxDispositionEntrySchema,
  inboxDispositionOriginalSchema,
  inboxDispositionReceiptSchema,
  inboxDispositionRecoverySchema,
  inboxDispositionStoreSchema,
} from "../../types/inbox";
import { openSettled } from "../e2e/fixtures";
import { pageToken } from "../e2e/launch-link";
import { DASHBOARD_URL, HEARTH_HOME } from "../e2e/servers";
import { workspaceKey } from "../../scripts/projects/scope";
import { alpha, beta, seedProjects, workspace } from "./project-fixtures";

const pendingRouteTasks = new Set<Promise<void>>();
const completedRouteFailures = new Set<unknown>();
const ownedRelevantRequests = new Set<Request>();
const pendingResponseFinishes = new Set<Promise<void>>();
const pendingCleanupObservers = new Set<Promise<void>>();
const cleanupOperationFailures = new Set<unknown>();
const expectedRouteAborts = new Set<Request>();
const observedExpectedRouteAborts = new Set<Request>();
let rejectPendingTerminalRoute: ((error: unknown) => void) | null = null;
const ownedRoutes: Array<{ page: Page; matcher: string; handler: (route: Route) => Promise<void> }> = [];
const ownedCdpSessions: CDPSession[] = [];
const ownedTraceClosers: Array<() => void> = [];
let invalidateHeldChoiceSession: ((page: Page, deadline: number) => Promise<void>) | null = null;
let rejectOwnedRouteFailure: (error: unknown) => void = () => {};
let ownedRouteFailure: Promise<never>;
function resetOwnedRouteFailure() {
  ownedRouteFailure = new Promise<never>((_resolve, reject) => { rejectOwnedRouteFailure = reject; });
  void ownedRouteFailure.catch(() => {});
}
function waitForRouteSignal<T>(signal: Promise<T>): Promise<T> {
  return Promise.race([signal, ownedRouteFailure]);
}
resetOwnedRouteFailure();

function recordOwnedFailure(error: unknown) {
  completedRouteFailures.add(error);
  rejectOwnedRouteFailure(error);
  rejectPendingTerminalRoute?.(error);
}
function isRelevantInboxRequest(request: Request): boolean {
  const url = new URL(request.url());
  const pathname = url.pathname;
  if (!pathname.startsWith("/__agent-forge/")) return false;
  return pathname === "/__agent-forge/inbox-dispositions/recovery" ||
    pathname.includes("/inbox-dispositions") ||
    pathname.endsWith("/approvals") ||
    pathname.endsWith("/approval-decisions") ||
    (request.method() === "POST" && pathname.includes("/sessions/")) ||
    (request.method() === "GET" && pathname.includes("/sessions/") && url.searchParams.has("requestId"));
}
function isInitialGlobalRecovery(request: Request): boolean {
  const url = new URL(request.url());
  return request.method() === "GET" && url.origin === new URL(DASHBOARD_URL).origin && url.pathname === "/__agent-forge/inbox-dispositions/recovery" && url.search === "";
}
function watchRelevantRequests(page: Page) {
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame() && !request.redirectedFrom()) {
      if (inboxFirstDocumentNavigationSeen) inboxPhysicalWindowOpen = false;
      else { inboxFirstDocumentNavigationSeen = true; inboxPhysicalWindowOpen = true; }
    }
    if (isRelevantInboxRequest(request)) ownedRelevantRequests.add(request);
    if (isInitialGlobalRecovery(request)) recordInboxPhysical({ phase: inboxRecoveryPhase, time: performance.now(), event: "request-start", correlation: "unknown" });
  });
  page.on("requestfinished", (request) => {
    if (isInitialGlobalRecovery(request)) recordInboxPhysical({ phase: inboxRecoveryPhase, time: performance.now(), event: "request-finished", correlation: "unknown" });
    ownedRelevantRequests.delete(request);
  });
  page.on("requestfailed", (request) => {
    if (isInitialGlobalRecovery(request)) recordInboxPhysical({ phase: inboxRecoveryPhase, time: performance.now(), event: "request-failed", correlation: "unknown" });
    if (!ownedRelevantRequests.delete(request)) return;
    if (expectedRouteAborts.delete(request)) { observedExpectedRouteAborts.add(request); return; }
    const failure = request.failure();
    recordOwnedFailure(Error("Relevant Inbox request failed: " + request.method() + " " + request.url() + " " + (failure?.errorText ?? "unknown network failure")));
  });
  page.on("response", (response) => {
    const request = response.request();
    if (isInitialGlobalRecovery(request)) recordInboxPhysical({ phase: inboxRecoveryPhase, time: performance.now(), event: "response", status: response.status(), correlation: "unknown" });
    if (!ownedRelevantRequests.has(request)) return;
    let task!: Promise<void>;
    let finishTerminal!: () => void;
    const terminalRequest = new Promise<void>((resolve) => { finishTerminal = resolve; });
    const onRequestFinished = (completed: Request) => {
      if (completed === request) finishTerminal();
    };
    const onRequestFailed = (failed: Request) => {
      if (failed === request) finishTerminal();
    };
    page.on("requestfinished", onRequestFinished);
    page.on("requestfailed", onRequestFailed);
    const finished = response.finished().then((error) => {
      if (error !== null) recordOwnedFailure(Error("Relevant Inbox response did not finish: " + request.url() + " " + error));
    });
    task = Promise.race([finished, terminalRequest]).then(() => undefined).catch((error: unknown) => { recordOwnedFailure(error); }).finally(() => {
      page.off("requestfinished", onRequestFinished);
      page.off("requestfailed", onRequestFailed);
      pendingResponseFinishes.delete(task);
    });
    pendingResponseFinishes.add(task);
  });
}
async function withinCleanupDeadline<T>(operation: Promise<T>, deadline: number, label: string): Promise<T> {
  const observer = operation.then(() => undefined, (error: unknown) => { cleanupOperationFailures.add(error); });
  pendingCleanupObservers.add(observer);
  void observer.then(() => pendingCleanupObservers.delete(observer));
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw Error(label + " exceeded the shared cleanup deadline.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(Error(label + " exceeded the shared cleanup deadline.")), remaining); })]);
  } finally { if (timer) clearTimeout(timer); }
}
function markExpectedRouteAbort(request: Request) { expectedRouteAborts.add(request); }
async function leaveSessionsForCleanup(page: Page, deadline: number): Promise<void> {
  if (page.isClosed()) throw Error("Page unavailable before invalidating the held Sessions decision.");
  const timeout = Math.max(1, deadline - performance.now());
  await page.getByRole("navigation", { name: "Global", exact: true }).getByRole("link", { name: "Inbox", exact: true }).click({ timeout });
  await expect(page.getByRole("region", { name: "Inbox", exact: true }).getByRole("heading", { name: "Inbox", exact: true })).toBeVisible({ timeout: Math.max(1, deadline - performance.now()) });
}

async function ownRoute(page: Page, matcher: string, handler: (route: Route) => Promise<void>): Promise<void> {
  const ownedHandler = (route: Route): Promise<void> => {
    let task!: Promise<void>;
    task = (async () => {
      try { await handler(route); }
      catch (error) { recordOwnedFailure(error); throw error; }
      finally { pendingRouteTasks.delete(task); }
    })();
    pendingRouteTasks.add(task);
    return task;
  };
  ownedRoutes.push({ page, matcher, handler: ownedHandler });
  await page.route(matcher, ownedHandler);
}

async function fetchProtected(route: Route) {
  const request = route.request();
  const requestUrl = new URL(request.url());
  const originalHeaders = await request.allHeaders();
  return route.fetch({ headers: { ...originalHeaders, Origin: requestUrl.origin, "Sec-Fetch-Site": "same-origin" } });
}

type DecisionInitiator = { module: string; functionName: string };
function createDecisionTrace(cdp: CDPSession, provider: "codex" | "gemini", approvalsPath: string, appOrigin: string) {
  const moduleName = provider === "codex" ? "codex-chat-decisions.ts" : "gemini-chat-decisions.ts";
  const expectedPathname = new URL("/@fs/" + join(process.cwd(), "apps", "desktop", "src", moduleName).split(String.fromCharCode(92)).join("/"), appOrigin).pathname;
  const frameSchema = z.object({ functionName: z.string(), url: z.string() }).passthrough();
  const stackSchema = z.object({ callFrames: z.array(frameSchema).max(64), parent: z.unknown().optional() }).passthrough();
  const phaseEvents: Array<{ method: string; pathname: string; search: string; initiator: DecisionInitiator | null }> = [];
  let active = false;
  let totalMatchingRequests = 0;
  let overflow = false;
  const close = () => { active = false; };
  ownedTraceClosers.push(close);
  cdp.on("Network.requestWillBeSent", (event) => {
    if (!active) return;
    const url = new URL(event.request.url);
    if (event.request.method !== "GET" || url.origin !== appOrigin || url.pathname !== approvalsPath || url.search !== "") return;
    totalMatchingRequests++;
    let stack: unknown = event.initiator.stack;
    let decisionFrame: DecisionInitiator | null = null;
    let depth = 0;
    while (stack && depth < 8) {
      const parsed = stackSchema.safeParse(stack);
      if (!parsed.success) { overflow = true; break; }
      for (const frame of parsed.data.callFrames) {
        const frameUrl = new URL(frame.url, appOrigin);
        if (frameUrl.origin === appOrigin && frameUrl.pathname === expectedPathname && frame.functionName === "decide")
          decisionFrame = { module: frameUrl.pathname, functionName: frame.functionName };
      }
      stack = parsed.data.parent;
      depth++;
    }
    if (stack) overflow = true;
    if (phaseEvents.length < 8) phaseEvents.push({ method: event.request.method, pathname: url.pathname, search: url.search, initiator: decisionFrame });
    else overflow = true;
  });
  return {
    phaseEvents,
    begin() { phaseEvents.length = 0; totalMatchingRequests = 0; overflow = false; active = true; },
    end() { active = false; },
    verify(heldRequest: Request, browserReads: number) {
      if (active) throw Error("Decision preflight trace must be sealed before verification.");
      if (overflow) throw Error("Decision preflight trace exceeded bounds and is inconclusive.");
      expect(totalMatchingRequests).toBe(1);
      expect(phaseEvents).toHaveLength(1);
      expect(phaseEvents[0]).toEqual({ method: "GET", pathname: approvalsPath, search: "", initiator: { module: expectedPathname, functionName: "decide" } });
      expect(browserReads).toBe(1);
      expect(heldRequest.method()).toBe("GET");
      const heldUrl = new URL(heldRequest.url());
      expect(heldUrl.origin).toBe(appOrigin);
      expect(heldUrl.pathname).toBe(approvalsPath);
      expect(heldUrl.search).toBe("");
    },
    detach() { close(); },
  };
}
async function openDecisionTrace(page: Page, provider: "codex" | "gemini", approvalsPath: string) {
  const cdp = await page.context().newCDPSession(page);
  ownedCdpSessions.push(cdp);
  await cdp.send("Debugger.enable");
  await cdp.send("Debugger.setAsyncCallStackDepth", { maxDepth: 16 });
  await cdp.send("Network.enable");
  return createDecisionTrace(cdp, provider, approvalsPath, new URL(page.url()).origin);
}

const writeJournalKey = "agent-forge.desktop-bead-writes.v1";
const writeJournalEntrySchema = z.object({ key: z.string(), projectId: z.string(), workspace: z.string(), action: z.string(), beadId: z.string(), title: z.string(), createdId: z.string().nullable(), stage: z.string(), phase: z.literal("unknown"), message: z.string() }).strict();
const writeJournalSchema = z.object({ version: z.literal(1), entries: z.array(writeJournalEntrySchema) }).strict();
const dispositionDirectoryPath = join(HEARTH_HOME, "inbox-dispositions");
const dispositionStatePath = join(dispositionDirectoryPath, "state.json");
const dispositionMarkerPath = join(HEARTH_HOME, "projects", "inbox-dispositions.initialized");
let priorDispositionDirectoryExisted: "absent" | "normal-directory" | "other" | null = null;
let dispositionSnapshotCaptured = false;
let sessionBaselineCaptured = false;
let codexControlSnapshotCaptured = false;
let fixtureMutationArmed = false;
type InboxRecoveryPhase = "document-navigation" | "case2-initial-navigation" | "case2-post504-public-refresh" | "case4-initial-navigation" | "codex-beta-snooze" | "gemini-explicit-refresh" | "unknown";
type InboxPhysicalEvent = {
  phase: InboxRecoveryPhase;
  time: number;
  event: "request-start" | "response" | "request-finished" | "request-failed";
  correlation: "unknown";
  status?: number;
};
let inboxRecoveryPhysical: InboxPhysicalEvent[] = [];
let inboxRecoveryOverflow = false;
type InboxBrowserEvent = { ordinal: number; phase: InboxRecoveryPhase; time: number; event: "phase" | "fetch-start" | "signal-abort" | "headers" | "fetch-rejection"; signalPresence?: "absent" | "null" | "present" | "unknown"; initialAborted?: boolean | null; signalReason?: "unknown"; status?: number; contentLength?: "missing" | "invalid" | "over-cap" | "declared-within-cap"; rejection?: "abort-error" | "unknown" };
const inboxBrowserEventSchema = z.object({ ordinal: z.number().int().nonnegative(), phase: z.enum(["document-navigation", "case2-initial-navigation", "case2-post504-public-refresh", "case4-initial-navigation", "codex-beta-snooze", "gemini-explicit-refresh", "unknown"]), time: z.number().finite(), event: z.enum(["phase", "fetch-start", "signal-abort", "headers", "fetch-rejection"]), signalPresence: z.enum(["absent", "null", "present", "unknown"]).optional(), initialAborted: z.boolean().nullable().optional(), signalReason: z.literal("unknown").optional(), status: z.number().int().optional(), contentLength: z.enum(["missing", "invalid", "over-cap", "declared-within-cap"]).optional(), rejection: z.enum(["abort-error", "unknown"]).optional() }).strict();
const inboxPhysicalEventSchema = z.object({ phase: z.enum(["document-navigation", "case2-initial-navigation", "case2-post504-public-refresh", "case4-initial-navigation", "codex-beta-snooze", "gemini-explicit-refresh", "unknown"]), time: z.number().finite(), event: z.enum(["request-start", "response", "request-finished", "request-failed"]), correlation: z.literal("unknown"), status: z.number().int().optional() }).strict();
let inboxRecoveryBrowserSnapshot: { state: "active" | "disabled" | "frozen" | "unknown"; events: unknown[]; overflow: boolean; instrumentationFailed: boolean; physical: InboxPhysicalEvent[]; physicalOverflow: boolean; windowOutcome: "normal-endpoint" | "cleanup-prefix" | "missing-document"; metadataMissing: boolean } | null = null;
let inboxFirstDocumentNavigationSeen = false;
let inboxPhysicalWindowOpen = false;
let inboxRecoveryPhase: InboxRecoveryPhase = "document-navigation";
function recordInboxPhysical(event: InboxPhysicalEvent) {
  if (!inboxPhysicalWindowOpen) return;
  if (inboxRecoveryPhysical.length >= 16) {
    inboxRecoveryOverflow = true;
    return;
  }
  inboxRecoveryPhysical.push(event);
}
type InitialRecoveryCapture = {
  qualify(): Promise<void>;
  close(): void;
};
function observeInitialRecovery(
  page: Page,
  phase: "case2-initial-navigation" | "case2-post504-public-refresh" | "case4-initial-navigation",
): InitialRecoveryCapture {
  inboxRecoveryPhase = phase;
  const started = new Set<Request>();
  const responses: Array<{ response: import("@playwright/test").Response; request: Request }> = [];
  const terminal = new Set<Request>();
  const failed = new Set<Request>();
  const matches = isInitialGlobalRecovery;
  const onStarted = (request: Request) => { if (matches(request)) started.add(request); };
  const onResponse = (response: import("@playwright/test").Response) => {
    if (matches(response.request())) responses.push({ response, request: response.request() });
  };
  const onFinished = (request: Request) => {
    if (matches(request)) terminal.add(request);
  };
  const onFailed = (request: Request) => {
    if (matches(request)) { terminal.add(request); failed.add(request); }
  };
  page.on("request", onStarted);
  page.on("response", onResponse);
  page.on("requestfinished", onFinished);
  page.on("requestfailed", onFailed);
  const close = () => {
    page.off("request", onStarted);
    page.off("response", onResponse);
    page.off("requestfinished", onFinished);
    page.off("requestfailed", onFailed);
  };
  ownedTraceClosers.push(close);
  return {
    close,
    async qualify() {
      close();
      const found = responses.filter((item) => terminal.has(item.request));
      if (started.size !== 1 || responses.length !== 1 || found.length !== 1 || terminal.size !== 1 || failed.size !== 0 || found[0]!.request !== [...started][0])
        throw Error("Initial global recovery did not have one exact started, responded, successful terminal request.");
      const response = found[0]!.response;
      if (response.status() !== 200)
        throw Error("Initial global recovery was not HTTP 200.");
      const parsed = z.object({
        ok: z.literal(true),
        data: inboxDispositionRecoverySchema,
        error: z.null(),
      }).strict().safeParse(await response.json());
      if (!parsed.success)
        throw Error("Initial global recovery did not contain the strict current schema.");
    },
  };
}
async function installInboxRecoveryObserver(page: Page) {
  await page.addInitScript(() => {
    type BrowserEvent = {
      ordinal: number;
      phase: InboxRecoveryPhase;
      time: number;
      event: "phase" | "fetch-start" | "signal-abort" | "headers" | "fetch-rejection";
      initialAborted?: boolean | null;
      signalPresence?: "absent" | "null" | "present" | "unknown";
      signalReason?: "unknown";
      status?: number;
      contentLength?: "missing" | "invalid" | "over-cap" | "declared-within-cap";
      rejection?: "abort-error" | "unknown";
    };
    type Host = Window & {
      __afInboxEvents?: BrowserEvent[];
      __afInboxOverflow?: boolean;
      __afInboxOrdinal?: number;
      __afInboxPhase?: InboxRecoveryPhase;
      __afInboxSetPhase?: (phase: InboxRecoveryPhase) => void;
      __afInboxRestore?: () => "restored" | "changed" | "mismatch";
      __afInboxWindowState?: "active" | "disabled" | "frozen" | "unknown";
      __afInboxFreeze?: () => void;
      __afInboxInstrumentationFailed?: boolean;
      __afInboxPreviousSnapshot?: unknown;
    };
    const host = window as Host;
    const original = window.fetch;
    const listenerScope = new AbortController();
    const events: BrowserEvent[] = [];
    let state: "active" | "disabled" | "frozen" | "unknown" = "active";
    let previousSnapshot: unknown = null;
    try {
      if (sessionStorage.getItem("__afInboxTraceClaimed") !== null) {
        state = "disabled";
        const saved = sessionStorage.getItem("__afInboxTraceSnapshot");
        if (saved === null || saved.length > 8192) state = "unknown";
        else previousSnapshot = JSON.parse(saved);
      } else {
        sessionStorage.setItem("__afInboxTraceClaimed", "1");
        sessionStorage.setItem("__afInboxTraceSnapshot", JSON.stringify({ events: [], overflow: false, instrumentationFailed: false }));
      }
    } catch { state = "unknown"; previousSnapshot = null; }
    host.__afInboxEvents = events;
    host.__afInboxOverflow = false;
    host.__afInboxOrdinal = 0;
    host.__afInboxPhase = "document-navigation";
    host.__afInboxWindowState = state;
    host.__afInboxInstrumentationFailed = state === "unknown";
    host.__afInboxPreviousSnapshot = previousSnapshot;
    const failObservation = () => { try { host.__afInboxInstrumentationFailed = true; sessionStorage.setItem("__afInboxTraceSnapshot", JSON.stringify({ events, overflow: host.__afInboxOverflow ?? true, instrumentationFailed: true })); } catch { try { sessionStorage.removeItem("__afInboxTraceSnapshot"); } catch { /* Missing prior snapshot remains inconclusive. */ } } };
    host.__afInboxFreeze = () => { if (host.__afInboxWindowState === "active") host.__afInboxWindowState = "frozen"; };
    const persistSnapshot = () => { try { sessionStorage.setItem("__afInboxTraceSnapshot", JSON.stringify({ events, overflow: host.__afInboxOverflow ?? true, instrumentationFailed: host.__afInboxInstrumentationFailed ?? true })); } catch { failObservation(); } };
    const record = (entry: BrowserEvent) => {
      if (host.__afInboxWindowState !== "active") return;
      if (events.length >= 16) { host.__afInboxOverflow = true; persistSnapshot(); return; }
      events.push(entry);
      persistSnapshot();
    };
    host.__afInboxSetPhase = (phase) => {
      host.__afInboxPhase = phase;
      record({ ordinal: host.__afInboxOrdinal ?? 0, phase, time: performance.now(), event: "phase" });
    };
    window.addEventListener("pagehide", () => host.__afInboxFreeze?.(), { once: true, signal: listenerScope.signal });
    const wrapped = new Proxy(original, {
      apply(target, thisArg, args: Parameters<typeof fetch>) {
        const input = args[0];
        const init = args[1];
        let match = false;
        let signal: AbortSignal | null | undefined;
        let signalPresence: "absent" | "null" | "present" | "unknown" = "absent";
        let initialAborted: boolean | null = null;
        try {
          const url = new URL(input instanceof Request ? input.url : input instanceof URL ? input.href : input, location.href);
          const method = init?.method ?? (input instanceof Request ? input.method : "GET");
          match = method.toUpperCase() === "GET" &&
            url.origin === location.origin &&
            url.pathname === "/__agent-forge/inbox-dispositions/recovery" &&
            url.search === "";
        } catch { /* Match failure must not change fetch behavior. */ }
        try {
          if (init?.signal === undefined) signal = input instanceof Request ? input.signal : undefined;
          else signal = init.signal;
          if (signal === undefined) signalPresence = "absent";
          else if (signal === null) signalPresence = "null";
          else { signalPresence = "present"; initialAborted = signal.aborted; }
        } catch { signalPresence = "unknown"; initialAborted = null; signal = undefined; }
        const promise = Reflect.apply(target, thisArg, args);
        if (!match || state !== "active") return promise;
        try {
          const ordinal = (host.__afInboxOrdinal ?? 0) + 1;
          host.__afInboxOrdinal = ordinal;
          const phase = host.__afInboxPhase ?? "unknown";
          record({ ordinal, phase, time: performance.now(), event: "fetch-start", signalPresence, initialAborted });
          signal?.addEventListener("abort", () => {
            try { record({ ordinal, phase, time: performance.now(), event: "signal-abort", signalReason: "unknown" }); } catch { failObservation(); }
          }, { once: true, signal: listenerScope.signal });
          void Promise.resolve(promise).then((response) => {
            try {
              const length = response.headers.get("content-length");
              const category = length === null ? "missing" : /^\d+$/.test(length) ? Number(length) > 4259840 ? "over-cap" : "declared-within-cap" : "invalid";
              record({ ordinal, phase, time: performance.now(), event: "headers", status: response.status, contentLength: category });
            } catch { failObservation(); }
          }, (error: unknown) => {
            try { record({ ordinal, phase, time: performance.now(), event: "fetch-rejection", rejection: error instanceof DOMException && error.name === "AbortError" ? "abort-error" : "unknown" }); } catch { failObservation(); }
          }).catch(() => { failObservation(); });
        } catch { failObservation(); }
        return promise;
      },
    });
    window.fetch = wrapped;
    host.__afInboxRestore = () => {
      listenerScope.abort();
      if (window.fetch === original) return "changed";
      if (window.fetch !== wrapped) return "mismatch";
      window.fetch = original;
      return "restored";
    };
  });
}
async function freezeInboxRecoveryWindow(page: Page) {
  if (page.isClosed()) return;
  const observed = await page.evaluate(() => { const host = window as Window & { __afInboxEvents?: unknown[]; __afInboxOverflow?: boolean; __afInboxWindowState?: "active" | "disabled" | "frozen" | "unknown"; __afInboxFreeze?: () => void; __afInboxInstrumentationFailed?: boolean }; host.__afInboxFreeze?.(); return { state: host.__afInboxWindowState ?? "unknown", events: host.__afInboxEvents ? host.__afInboxEvents.slice(0, 17) : null, overflow: host.__afInboxOverflow ?? null, instrumentationFailed: host.__afInboxInstrumentationFailed ?? true }; });
  inboxRecoveryBrowserSnapshot = { state: observed.state, events: observed.events ?? [], overflow: observed.overflow ?? true, instrumentationFailed: observed.instrumentationFailed, physical: inboxRecoveryPhysical.slice(0, 16), physicalOverflow: inboxRecoveryOverflow, windowOutcome: "normal-endpoint", metadataMissing: observed.events === null || !inboxFirstDocumentNavigationSeen };
}
async function markInboxRecoveryPhase(page: Page, phase: "case2-post504-public-refresh" | "codex-beta-snooze" | "gemini-explicit-refresh") {
  inboxRecoveryPhase = phase;
  await page.evaluate((value) => {
    const host = window as Window & { __afInboxSetPhase?: (tag: string) => void };
    if (typeof host.__afInboxSetPhase !== "function") throw Error("Inbox passive phase marker is missing.");
    host.__afInboxSetPhase(value);
  }, phase);
}
let priorDispositionState: Buffer | null = null;
let priorDispositionMarker: Buffer | null = null;
const sessionsPath = join(HEARTH_HOME, "sessions", "registry.json");
const codexControlPath = join(HEARTH_HOME, "codex-chat-fixture-mode.json");
let priorCodexControl: Buffer | null = null;
const geminiControlPath = join(
  HEARTH_HOME,
  "gemini-chat-fixture-calls.json.control",
);
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalPermissionItem(input: {
  provider: "codex" | "gemini";
  projectId: string;
  sessionId: string;
  turnRequestId: string;
  offerId: string;
  approval: unknown;
}) {
  const sourceIdentity = JSON.stringify([
    input.provider,
    input.sessionId,
    input.turnRequestId,
    input.offerId,
  ]);
  const stableItemId = `sha256:${sha256(
    JSON.stringify([
      workspaceKey(workspace),
      input.projectId,
      "permission",
      sourceIdentity,
    ]),
  )}`;
  const permissionApproval = { provider: input.provider, value: input.approval };
  const sourceRevision = `sha256:${sha256(
    JSON.stringify([
      "permission",
      JSON.stringify(permissionApproval),
    ]),
  )}`;
  return {
    sourceKind: "permission" as const,
    stableItemId,
    sourceRevision,
  };
}

function legacyPermissionStore(input: {
  projectId: string;
  item: ReturnType<typeof canonicalPermissionItem>;
  operation: "done" | "snooze-1h";
  hold?: boolean;
}) {
  const stamp = new Date();
  const reservedAt = new Date(stamp.getTime() - 2_000).toISOString();
  const settledAt = new Date(stamp.getTime() - 1_000).toISOString();
  const storedOriginal = {
    requestId: randomUUID(),
    expectedCatalogRevision: 1,
    workspace,
    item: input.item,
    expectedRevision: 0,
    operation: input.operation,
    projectId: input.projectId,
  };
  const snoozedUntil =
    input.operation === "snooze-1h"
      ? new Date(Date.parse(settledAt) + 60 * 60 * 1000).toISOString()
      : undefined;
  const receipt = inboxDispositionReceiptSchema.parse({
    original: storedOriginal,
    phase: "applied",
    reservedAt,
    settledAt,
    outcome: "applied",
    resultingRevision: 1,
    resultingValue: input.operation,
    ...(snoozedUntil ? { snoozedUntil } : {}),
  });
  const entry = inboxDispositionEntrySchema.parse({
    projectId: input.projectId,
    workspace,
    item: input.item,
    revision: 1,
    operation: input.operation,
    updatedAt: settledAt,
    ...(snoozedUntil ? { snoozedUntil } : {}),
  });
  const receipts = [receipt];
  if (input.hold) {
    const heldOriginal = {
      requestId: randomUUID(),
      expectedCatalogRevision: 1,
      workspace,
      item: input.item,
      expectedRevision: 1,
      operation: "snooze-1h" as const,
      projectId: input.projectId,
    };
    receipts.push(
      inboxDispositionReceiptSchema.parse({
        original: heldOriginal,
        phase: "reserved",
        reservedAt: stamp.toISOString(),
      }),
    );
  }
  return inboxDispositionStoreSchema.parse({
    version: 1,
    entries: [entry],
    receipts,
  });
}

function seedPrivateDispositionStore(store: unknown): void {
  const incoming = inboxDispositionStoreSchema.parse(store);
  const existing = existsSync(dispositionStatePath)
    ? inboxDispositionStoreSchema.parse(JSON.parse(readFileSync(dispositionStatePath, "utf8")))
    : { version: 1 as const, entries: [], receipts: [] };
  const checked = inboxDispositionStoreSchema.parse({
    version: 1,
    entries: [...existing.entries, ...incoming.entries],
    receipts: [...existing.receipts, ...incoming.receipts],
  });
  mkdirSync(dirname(dispositionStatePath), { recursive: true });
  writeFileSync(dispositionStatePath, `${JSON.stringify(checked, null, 2)}\n`);
}

function isPermissionDispositionRequest(body: unknown): boolean {
  if (
    typeof body !== "object" ||
    body === null ||
    !("item" in body) ||
    !("operation" in body)
  )
    return false;
  const item = body.item;
  return (
    typeof item === "object" &&
    item !== null &&
    "sourceKind" in item &&
    item.sourceKind === "permission" &&
    (body.operation === "done" || body.operation === "snooze-1h")
  );
}

test.beforeEach(async ({ page }) => {
  sessionBaselineCaptured = false;
  codexControlSnapshotCaptured = false;
  dispositionSnapshotCaptured = false;
  fixtureMutationArmed = false;
  priorSessions = new Set();
  priorCodexControl = null;
  priorDispositionState = null;
  priorDispositionMarker = null;
  priorDispositionDirectoryExisted = null;
  savedGeminiControl = null;
  geminiControlCaptured = false;
  inboxRecoveryBrowserSnapshot = null;
  inboxFirstDocumentNavigationSeen = false;
  inboxPhysicalWindowOpen = false;
  resetOwnedRouteFailure();
  if (ownedRelevantRequests.size || pendingResponseFinishes.size || completedRouteFailures.size || expectedRouteAborts.size || pendingCleanupObservers.size || cleanupOperationFailures.size) throw Error("Previous Inbox request, response, or route failure state did not settle.");
  watchRelevantRequests(page);
  inboxRecoveryPhysical = [];
  inboxRecoveryOverflow = false;
  inboxRecoveryPhase = "document-navigation";
  await installInboxRecoveryObserver(page);
  if (pendingRouteTasks.size) throw Error("Previous Inbox route work did not settle.");
  if (ownedCdpSessions.length) throw Error("Previous Inbox CDP session did not detach.");
  if (ownedRoutes.length) throw Error("Previous Inbox routes did not detach.");
  try {
    const registry = ownedCodingSessionSchema.array().parse(JSON.parse(readFileSync(sessionsPath, "utf8")).records);
    priorSessions = new Set(registry.map((session) => session.id));
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    priorSessions = new Set();
  }
  sessionBaselineCaptured = true;
  priorCodexControl = existsSync(codexControlPath) ? readFileSync(codexControlPath) : null;
  codexControlSnapshotCaptured = true;
  try {
    const priorDirectory = lstatSync(dispositionDirectoryPath);
    priorDispositionDirectoryExisted = priorDirectory.isDirectory() && !priorDirectory.isSymbolicLink() ? "normal-directory" : "other";
    if (priorDispositionDirectoryExisted === "other") throw Error("Prior Inbox disposition leaf has an invalid type; fixture writes are refused.");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") priorDispositionDirectoryExisted = "absent";
    else throw error;
  }
  priorDispositionState = existsSync(dispositionStatePath)
    ? readFileSync(dispositionStatePath)
    : null;
  priorDispositionMarker = existsSync(dispositionMarkerPath)
    ? readFileSync(dispositionMarkerPath)
    : null;
  dispositionSnapshotCaptured = true;
  fixtureMutationArmed = true;
  seedProjects();
  writeFileSync(
    join(HEARTH_HOME, "codex-chat-fixture-mode.json"),
    JSON.stringify("approval-command"),
  );
});
test.afterEach(async ({ page }, testInfo) => {
  const cleanupErrors = new Set<unknown>();
  const cleanupDeadline = performance.now() + 5_000;
  const captureAndAttach = async () => {
    let observed: { state: "active" | "disabled" | "frozen" | "unknown"; events: unknown[] | null; overflow: boolean | null; instrumentationFailed: boolean; windowOutcome: "cleanup-prefix" | "missing-document"; metadataMissing: boolean; restore: "restored" | "changed" | "mismatch" | null } | null = null;
    let captureUnavailable = false;
    if (!page.isClosed()) {
      try {
        observed = await page.evaluate((physicalAvailable) => {
          const host = window as Window & { __afInboxEvents?: unknown[]; __afInboxOverflow?: boolean; __afInboxRestore?: () => "restored" | "changed" | "mismatch"; __afInboxWindowState?: "active" | "disabled" | "frozen" | "unknown"; __afInboxFreeze?: () => void; __afInboxInstrumentationFailed?: boolean; __afInboxPreviousSnapshot?: unknown };
          const state = host.__afInboxWindowState ?? "unknown";
          const previous = host.__afInboxPreviousSnapshot;
          let previousEvents: unknown[] | null = null;
          let previousOverflow: boolean | null = null;
          let previousInstrumentationFailed: boolean | null = null;
          let previousShapeValid = false;
          if (typeof previous === "object" && previous !== null) {
            previousShapeValid = Object.keys(previous).sort().join(",") === "events,instrumentationFailed,overflow";
            if ("events" in previous && Array.isArray(previous.events)) previousEvents = previous.events.slice(0, 17);
            if ("overflow" in previous && typeof previous.overflow === "boolean") previousOverflow = previous.overflow;
            if ("instrumentationFailed" in previous && typeof previous.instrumentationFailed === "boolean") previousInstrumentationFailed = previous.instrumentationFailed;
          }
          const usingPreviousDocument = state === "disabled";
          if (!usingPreviousDocument) host.__afInboxFreeze?.();
          const events = usingPreviousDocument ? previousEvents : host.__afInboxEvents ? host.__afInboxEvents.slice(0, 17) : null;
          const overflow = usingPreviousDocument ? previousOverflow : host.__afInboxOverflow ?? null;
          const instrumentationFailed = usingPreviousDocument ? previousInstrumentationFailed : host.__afInboxInstrumentationFailed ?? true;
          const windowOutcome = usingPreviousDocument ? events === null ? "missing-document" : "cleanup-prefix" : physicalAvailable ? "cleanup-prefix" : "missing-document";
          const observedState = usingPreviousDocument && events !== null ? "frozen" : state;
          const restore = typeof host.__afInboxRestore === "function" ? host.__afInboxRestore() : null;
          return { state: observedState, events, overflow, instrumentationFailed: instrumentationFailed ?? true, windowOutcome, metadataMissing: events === null || overflow === null || instrumentationFailed === null || usingPreviousDocument && !previousShapeValid || !physicalAvailable, restore };
        }, inboxFirstDocumentNavigationSeen);
      } catch { captureUnavailable = true; }
    }
    if (!inboxRecoveryBrowserSnapshot && observed) inboxRecoveryBrowserSnapshot = { state: observed.state, events: observed.events ?? [], overflow: observed.overflow ?? true, instrumentationFailed: observed.instrumentationFailed, physical: inboxRecoveryPhysical.slice(0, 16), physicalOverflow: inboxRecoveryOverflow, windowOutcome: observed.windowOutcome, metadataMissing: observed.metadataMissing };
    if (!inboxRecoveryBrowserSnapshot) inboxRecoveryBrowserSnapshot = { state: "unknown", events: [], overflow: true, instrumentationFailed: true, physical: inboxRecoveryPhysical.slice(0, 16), physicalOverflow: inboxRecoveryOverflow, windowOutcome: "missing-document", metadataMissing: true };
    const restoreFailure = Boolean(observed && observed.restore !== "restored");
    const rawEvents = inboxRecoveryBrowserSnapshot.events;
    const parsedEvents = rawEvents.slice(0, 16).map((event) => inboxBrowserEventSchema.safeParse(event));
    const browserEvents = parsedEvents.every((result) => result.success) ? parsedEvents.map((result) => result.success ? result.data : null) : [];
    const rawPhysical = inboxRecoveryBrowserSnapshot.physical;
    const parsedPhysical = rawPhysical.slice(0, 16).map((event) => inboxPhysicalEventSchema.safeParse(event));
    const physicalEvents = parsedPhysical.every((result) => result.success) ? parsedPhysical.map((result) => result.success ? result.data : null) : [];
    const targetPhase = inboxRecoveryPhase === "codex-beta-snooze" || inboxRecoveryPhase === "gemini-explicit-refresh" ? inboxRecoveryPhase : null;
    const boundedAndValid = browserEvents.length === rawEvents.length && physicalEvents.length === rawPhysical.length && rawEvents.length <= 16 && rawPhysical.length <= 16;
    const noOverflow = !inboxRecoveryBrowserSnapshot.overflow && !inboxRecoveryBrowserSnapshot.physicalOverflow;
    const noInstrumentationFailure = !inboxRecoveryBrowserSnapshot.instrumentationFailed;
    const coverageComplete = inboxRecoveryBrowserSnapshot.windowOutcome === "normal-endpoint" && inboxRecoveryBrowserSnapshot.state === "frozen" && targetPhase !== null && browserEvents.some((event) => event?.event === "phase" && event.phase === targetPhase) && !inboxRecoveryBrowserSnapshot.metadataMissing && boundedAndValid && noOverflow && noInstrumentationFailure;
    const trace = { version: 1, window: "first injected document only; physical diagnostics stop at the next main-frame document request; later documents are not collected", expectedTargetPhase: targetPhase ?? "none", windowOutcome: inboxRecoveryBrowserSnapshot.windowOutcome, coverageComplete, state: inboxRecoveryBrowserSnapshot.state, browser: browserEvents, physical: physicalEvents, overflow: !noOverflow || rawEvents.length > 16 || rawPhysical.length > 16, metadataValid: boundedAndValid, metadataMissing: inboxRecoveryBrowserSnapshot.metadataMissing || !boundedAndValid, instrumentationFailed: !noInstrumentationFailure, wrapperOwnership: observed ? observed.restore ?? "missing" : "page-closed", correlation: "unknown", causalClassification: "inconclusive", abortsRemainFatal: true };
    if (testInfo.status !== testInfo.expectedStatus) await testInfo.attach("inbox-recovery-passive-trace.json", { body: Buffer.from(JSON.stringify(trace)), contentType: "application/json" });
    if (captureUnavailable) throw Error("Inbox trace document became unavailable during cleanup capture.");
    if (restoreFailure) throw Error("Inbox passive fetch wrapper ownership is missing or changed before cleanup.");
  };
  try { await withinCleanupDeadline(captureAndAttach(), cleanupDeadline, "Inbox trace capture, validation, restoration, and attachment"); } catch (error) { cleanupErrors.add(error); }
  let sessionChoiceInvalidated = true;
  let routeRemovalComplete = true;
  let cdpSessionsDetached = true;
  for (const close of ownedTraceClosers.splice(0)) { try { close(); } catch (error) { cleanupErrors.add(error); } }
  if (invalidateHeldChoiceSession) {
    try { await invalidateHeldChoiceSession(page, cleanupDeadline); }
    catch (error) { cleanupErrors.add(error); sessionChoiceInvalidated = false; }
    finally { invalidateHeldChoiceSession = null; }
  }
  try {
    releaseHeldDispositionRead?.();
  } catch (error) {
    cleanupErrors.add(error);
  }
  releaseHeldDispositionRead = null;
  for (const release of releaseHeldInboxRoutes.splice(0)) {
    try {
      release();
    } catch (error) {
      cleanupErrors.add(error);
    }
  }
  const drainRoutes = async () => {
    while (pendingRouteTasks.size || ownedRelevantRequests.size || pendingResponseFinishes.size) {
      const remaining = cleanupDeadline - performance.now();
      if (remaining <= 0) throw Error("Owned routes exceeded the shared cleanup deadline.");
      let timer: ReturnType<typeof setTimeout> | undefined;
      let pollTimer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<{ timeout: true }>((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), remaining); });
      const tasks = [...pendingRouteTasks, ...pendingResponseFinishes];
      const settled = tasks.length ? Promise.allSettled(tasks).then((results) => ({ timeout: false as const, results })) : new Promise<{ timeout: false; results: PromiseSettledResult<void>[] }>(() => {});
      const poll = new Promise<{ timeout: false; results: PromiseSettledResult<void>[] }>((resolve) => { pollTimer = setTimeout(() => resolve({ timeout: false, results: [] }), Math.min(25, remaining)); });
      const result = await Promise.race([timeout, settled, poll]);
      if (timer) clearTimeout(timer);
      if (pollTimer) clearTimeout(pollTimer);
      if (result.timeout) throw Error("Owned routes did not quiesce before cleanup deadline.");
      for (const item of result.results) if (item.status === "rejected") cleanupErrors.add(item.reason);
    }
  };
  try { await drainRoutes(); } catch (error) { cleanupErrors.add(error); }
  for (const owned of ownedRoutes.splice(0).reverse()) {
    try { await withinCleanupDeadline(owned.page.unroute(owned.matcher, owned.handler), cleanupDeadline, "Owned route removal"); }
    catch (error) { cleanupErrors.add(error); routeRemovalComplete = false; ownedRoutes.push(owned); }
  }
  try { await drainRoutes(); } catch (error) { cleanupErrors.add(error); }
  for (const session of ownedCdpSessions.splice(0)) {
    try { await withinCleanupDeadline(session.detach(), cleanupDeadline, "Owned CDP detach"); }
    catch (error) { cleanupErrors.add(error); cdpSessionsDetached = false; ownedCdpSessions.push(session); }
  }
  let sessionsSettled = fixtureMutationArmed && sessionBaselineCaptured;
  let newSessions: ReturnType<typeof sessions> = [];
  if (fixtureMutationArmed && sessionBaselineCaptured) {
    try {
      newSessions = ownedCodingSessionSchema
        .array()
        .parse(JSON.parse(readFileSync(sessionsPath, "utf8")).records)
        .filter((item) => !priorSessions.has(item.id));
    } catch (error) {
      sessionsSettled = false;
      cleanupErrors.add(error);
    }
  } else if (fixtureMutationArmed) cleanupErrors.add(Error("Provider cleanup skipped because the session baseline was not captured before fixture mutation."));
  for (const session of newSessions) {
    try {
      const active = savedSession(session.id).turns.find((turn) =>
        ["accepted", "running", "cancelling"].includes(turn.phase),
      );
      if (!active) continue;
      const token = await withinCleanupDeadline(pageToken(page), cleanupDeadline, "Provider stop token");
      const stopResult = await withinCleanupDeadline(page.evaluate(
        async ({ projectId, sessionId, requestId, token, header }) => {
          const response = await fetch(
            `/__agent-forge/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/stop`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json", [header]: token },
              body: JSON.stringify({ requestId }),
            },
          );
          return { status: response.status, body: await response.text() };
        },
        {
          projectId: session.projectId,
          sessionId: session.id,
          requestId: active.requestId,
          token,
          header: OPERATOR_HEADER,
        },
      ), cleanupDeadline, "Provider stop request");
      let stopBody: unknown = null;
      try { stopBody = JSON.parse(stopResult.body); } catch {}
      const stopEnvelope = z.object({ ok: z.literal(true), data: conversationReceiptSchema, error: z.null() }).strict().safeParse(stopBody);
      if (stopResult.status !== 200 || !stopEnvelope.success || stopEnvelope.data.data.conversationId !== session.id || stopEnvelope.data.data.turn.requestId !== active.requestId)
        throw Error("Provider Stop did not return its exact finite conversation receipt.");
      const remainingSessionTime = cleanupDeadline - performance.now();
      if (remainingSessionTime <= 0) throw Error("Provider session stop exceeded the shared cleanup deadline.");
      await expect
        .poll(
          () => savedSession(session.id).turns.some((turn) => ["accepted", "running", "cancelling"].includes(turn.phase)),
          { timeout: remainingSessionTime },
        )
        .toBe(false);
    } catch (error) {
      sessionsSettled = false;
      cleanupErrors.add(error);
    }
  }
  try { await drainRoutes(); } catch (error) { cleanupErrors.add(error); }
  for (const failure of completedRouteFailures) cleanupErrors.add(failure);
  completedRouteFailures.clear();
  for (const failure of cleanupOperationFailures) cleanupErrors.add(failure);
  const cleanupOperationsSettled = pendingCleanupObservers.size === 0;
  if (!cleanupOperationsSettled) cleanupErrors.add(Error("Started cleanup operations remain pending; timeout did not cancel them."));
  rejectPendingTerminalRoute = null;
  if (expectedRouteAborts.size) cleanupErrors.add(Error("An intentional route abort did not reach a terminal requestfailed event."));
  const routesQuiesced = pendingRouteTasks.size === 0 && ownedRelevantRequests.size === 0 && pendingResponseFinishes.size === 0 && expectedRouteAborts.size === 0 && sessionChoiceInvalidated && routeRemovalComplete && cdpSessionsDetached && ownedRoutes.length === 0 && ownedCdpSessions.length === 0 && cleanupOperationsSettled;
  if (!routesQuiesced) cleanupErrors.add(Error("Owned route/network work remains active; private fixture bytes will not be restored."));
  if (fixtureMutationArmed) {
    try {
      if (codexControlSnapshotCaptured && sessionsSettled && routesQuiesced) {
        if (priorCodexControl) writeFileSync(codexControlPath, priorCodexControl);
        else if (existsSync(codexControlPath)) unlinkSync(codexControlPath);
      } else cleanupErrors.add(Error("Codex private control restoration was skipped because its snapshot, route work, or session did not settle."));
    } catch (error) { cleanupErrors.add(error); }
  }
  priorCodexControl = null;
  codexControlSnapshotCaptured = false;
  try {
    if (geminiControlCaptured && fixtureMutationArmed && sessionsSettled && routesQuiesced) {
      if (savedGeminiControl)
        writeFileSync(geminiControlPath, savedGeminiControl);
      else if (existsSync(geminiControlPath)) unlinkSync(geminiControlPath);
    }
  } catch (error) {
    cleanupErrors.add(error);
  } finally {
    if (geminiControlCaptured && fixtureMutationArmed && (!sessionsSettled || !routesQuiesced)) cleanupErrors.add(Error("Gemini private control restoration was skipped because route work or its session did not settle."));
    savedGeminiControl = null;
    geminiControlCaptured = false;
  }
  const dispositionLeafWasCreatedByCase = dispositionSnapshotCaptured && priorDispositionDirectoryExisted === "absent";
  if (fixtureMutationArmed) {
    if (!dispositionSnapshotCaptured) cleanupErrors.add(Error("Inbox disposition restoration skipped because its complete prior snapshot was not captured; private bytes were preserved."));
    else if (routesQuiesced && sessionsSettled) {
      let currentLeafSafe = false;
      let currentLeafExists = false;
      try {
        if (relative(resolve(HEARTH_HOME), resolve(dispositionDirectoryPath)) !== "inbox-dispositions") throw Error("Inbox disposition leaf escaped the fixture home.");
        try {
          const leaf = lstatSync(dispositionDirectoryPath);
          if (!leaf.isDirectory() || leaf.isSymbolicLink()) throw Error("Current Inbox disposition leaf is not a normal non-reparse directory; private state traversal was refused.");
          currentLeafSafe = true;
          currentLeafExists = true;
        } catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "ENOENT" && priorDispositionDirectoryExisted === "absent") currentLeafSafe = true;
          else if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") throw Error("Previously existing Inbox disposition leaf is missing; private state traversal was refused.");
          else throw error;
        }
      } catch (error) { cleanupErrors.add(error); }
      let dispositionStateRestored = false;
      if (currentLeafSafe) {
        try {
          if (!currentLeafExists && priorDispositionState === null) dispositionStateRestored = true;
          else if (!currentLeafExists) throw Error("Inbox disposition state cannot be restored through a missing leaf.");
          else if (priorDispositionState !== null) { writeFileSync(dispositionStatePath, priorDispositionState); dispositionStateRestored = true; }
          else { if (existsSync(dispositionStatePath)) unlinkSync(dispositionStatePath); dispositionStateRestored = true; }
        } catch (error) { cleanupErrors.add(error); }
      }
      let dispositionMarkerRestored = false;
      try {
        if (priorDispositionMarker !== null) { mkdirSync(dirname(dispositionMarkerPath), { recursive: true }); writeFileSync(dispositionMarkerPath, priorDispositionMarker); }
        else if (existsSync(dispositionMarkerPath)) unlinkSync(dispositionMarkerPath);
        dispositionMarkerRestored = true;
      } catch (error) { cleanupErrors.add(error); }
      const dispositionFilesRestored = dispositionStateRestored && dispositionMarkerRestored;
      if (dispositionFilesRestored && dispositionLeafWasCreatedByCase && currentLeafExists) {
        try {
          const leaf = lstatSync(dispositionDirectoryPath);
          if (!leaf.isDirectory() || leaf.isSymbolicLink()) throw Error("New Inbox disposition leaf is not a normal non-reparse directory.");
          if (readdirSync(dispositionDirectoryPath).length !== 0) throw Error("New Inbox disposition leaf is not empty.");
          rmdirSync(dispositionDirectoryPath);
          try { lstatSync(dispositionDirectoryPath); throw Error("New Inbox disposition leaf remained after removal."); } catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
        } catch (error) { cleanupErrors.add(error); }
      }
    } else cleanupErrors.add(Error("Private fixture restoration was skipped because owned route or provider-session work remained active."));
  }
  priorDispositionState = null;
  priorDispositionMarker = null;
  priorDispositionDirectoryExisted = null;
  dispositionSnapshotCaptured = false;
  sessionBaselineCaptured = false;
  fixtureMutationArmed = false;
  priorSessions = new Set();
  inboxRecoveryBrowserSnapshot = null;
  observedExpectedRouteAborts.clear();
  if (cleanupOperationsSettled) cleanupOperationFailures.clear();
  if (cleanupErrors.size === 1) throw [...cleanupErrors][0];
  if (cleanupErrors.size > 1) throw new AggregateError([...cleanupErrors], "Inbox test cleanup failed.");
});
test("Inbox refuses a held Codex Sessions preflight while retaining generic writes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.addInitScript(
    ({ key, entries }) => {
      if (localStorage.getItem(key) === null)
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
          message:
            "Outcome unknown: check the bead before doing anything else. This write will not be repeated automatically.",
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
          message:
            "Outcome unknown: check the Beta bead before doing anything else. This write will not be repeated automatically.",
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
    .poll(
      () =>
        sessions().filter((session) => !priorSessions.has(session.id)).length,
    )
    .toBe(1);
  const session = sessions().find(
    (candidate) => !priorSessions.has(candidate.id),
  );
  if (!session)
    throw Error("The valid Inbox permission fixture session is absent.");

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
    throw Error(
      "The protected setup approvals read was not a valid 200 fixture.",
    );
  const originalPending = setupEnvelope.data.data.pending.filter((pending) => pending.turnRequestId === session.requestId && pending.approval.id === originalEvent.approval.id);
  expect(originalPending).toHaveLength(1);
  expect(originalPending[0]?.approval.availableDecisions).toContain("accept");

  let firstRecoveryRead = true;
  let markRecoveryReadStarted: () => void = () => {};
  const recoveryReadStarted = new Promise<void>((resolve) => {
    markRecoveryReadStarted = resolve;
  });
  let releaseRecoveryRead: () => void = () => {};
  const recoveryReadGate = new Promise<void>((resolve) => {
    releaseRecoveryRead = resolve;
  });
  let markRecoveryReadFinished: () => void = () => {};
  const recoveryReadFinished = new Promise<void>((resolve) => {
    markRecoveryReadFinished = resolve;
  });
  releaseHeldDispositionRead = releaseRecoveryRead;
  await ownRoute(page, "**/inbox-dispositions/recovery", async (route) => {
    if (firstRecoveryRead) {
      firstRecoveryRead = false;
      markRecoveryReadStarted();
      await recoveryReadGate;
      await route.continue();
      const completed = await route.request().response();
      if (!completed) throw Error("The owned route completed without a response.");
      expect(await completed.finished()).toBeNull();
      markRecoveryReadFinished();
      return;
    }
    await route.continue();
  });

  const approvalsPath = `/__agent-forge/projects/${alpha.id}/sessions/${session.id}/approvals`;
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
    if (
      request.method() === "GET" &&
      url.pathname.endsWith(`/sessions/${session.id}`) &&
      url.searchParams.has("requestId")
    )
      codexHistoryReads++;
    if (
      request.method() === "POST" &&
      url.pathname.endsWith("/approval-decisions")
    ) {
      decisionPosts++;
      decisionRequests.push({
        url: url.pathname,
        body: request.postDataJSON(),
      });
    }
    if (
      request.method() === "POST" &&
      url.pathname.includes("/inbox-dispositions")
    ) {
      dispositionWrites++;
      dispositionRequests.push({
        url: url.pathname,
        body: request.postDataJSON(),
      });
    }
  });
  page.on("response", (response) => {
    if (
      new URL(response.url()).pathname.endsWith("/inbox-dispositions/recovery")
    )
      recoveryResponses++;
  });
  const inboxIdentityBefore = await page.evaluate(
    (key) => localStorage.getItem(key),
    CODEX_CHAT_DECISION_IDENTITIES,
  );
  let heldPreflightCount = 0;
  let captureChoicePreflight = false;
  let heldRequest: Request | null = null;
  let markPreflightHeld: () => void = () => {};
  const preflightHeld = new Promise<void>((resolve) => { markPreflightHeld = resolve; });
  let releasePreflight: () => void = () => {};
  const preflightGate = new Promise<void>((resolve) => { releasePreflight = resolve; });
  releaseHeldInboxRoutes.push(releasePreflight);
  const trace = await openDecisionTrace(page, "codex", approvalsPath);
  const choicePreflightResponse = page.waitForResponse((response) => response.request() === heldRequest);
  await ownRoute(page, "**/sessions/" + session.id + "/approvals", async (route) => {
    const url = new URL(route.request().url());
    if (captureChoicePreflight && route.request().method() === "GET" && url.pathname === approvalsPath && url.search === "") {
      captureChoicePreflight = false;
      heldPreflightCount++;
      heldRequest = route.request();
      markPreflightHeld();
      await preflightGate;
    }
    await route.continue();
  });
  let choiceWindowReads = 0;
  let choicePhaseActive = false;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (choicePhaseActive && request.method() === "GET" && url.pathname === approvalsPath && url.search === "") choiceWindowReads++;
  });
  const actualChoicePreflight = page.waitForRequest((request) => request.method() === "GET" && new URL(request.url()).pathname === approvalsPath && new URL(request.url()).search === "");
  invalidateHeldChoiceSession = leaveSessionsForCleanup;
  trace.begin();
  choicePhaseActive = true;
  captureChoicePreflight = true;
  await conversation.getByRole("button", { name: "Allow once", exact: true }).click();
  const choiceRequest = await waitForRouteSignal(actualChoicePreflight);
  await waitForRouteSignal(preflightHeld);
  expect(heldPreflightCount).toBe(1);
  expect(heldRequest).toBe(choiceRequest);

  const nativeApprovalsDuringChoice = page.getByRole("region", { name: "Native Codex approvals", exact: true });
  await expect(nativeApprovalsDuringChoice.getByRole("status").filter({ hasText: "Recording the original decision intent…" })).toBeVisible();
  await expect(nativeApprovalsDuringChoice.getByRole("button", { name: "Allow once", exact: true })).toBeDisabled();
  trace.end();
  choicePhaseActive = false;
  trace.verify(choiceRequest, choiceWindowReads);
  inboxNavigationStarted = true;
  await page
    .getByRole("navigation", { name: "Global", exact: true })
    .getByRole("link", { name: "Inbox", exact: true })
    .click();
  invalidateHeldChoiceSession = null;
  await waitForRouteSignal(recoveryReadStarted);

  await expect(
    page
      .getByRole("region", { name: "Inbox", exact: true })
      .getByRole("heading", { name: "Inbox", exact: true }),
  ).toBeVisible();
  const inboxRegion = page.getByRole("region", { name: "Inbox", exact: true });
  releasePreflight();
  const choiceReply = await waitForRouteSignal(choicePreflightResponse);
  expect(choiceReply.request()).toBe(choiceRequest);
  expect(await choiceReply.finished()).toBeNull();
  expect(choiceReply.status()).toBe(200);
  const choiceReplyEnvelope = z
    .object({
      ok: z.literal(true),
      data: codexChatApprovalPageSchema,
      error: z.null(),
    })
    .strict()
    .safeParse(await choiceReply.json());
  if (!choiceReplyEnvelope.success)
    throw Error("The held Codex Sessions preflight did not release its strict original reply.");
  expect(choiceReplyEnvelope.data.data.pending).toEqual(originalPending);
  expect(heldPreflightCount).toBe(1);
  const alphaNotice = inboxRegion.locator(".af-inbox-notice").filter({
    has: page.getByRole("heading", {
      name: "Fixture unknown write",
      exact: true,
    }),
  });
  const betaNotice = inboxRegion.locator(".af-inbox-notice").filter({
    has: page.getByRole("heading", {
      name: "Fixture Beta unknown write",
      exact: true,
    }),
  });
  await expect(
    alphaNotice.getByText("Outcome unknown", { exact: true }),
  ).toBeVisible();
  await expect(
    betaNotice.getByText("Outcome unknown", { exact: true }),
  ).toBeVisible();
  const originalJournalBytes = await page.evaluate((key) => localStorage.getItem(key), writeJournalKey);
  const originalJournal = writeJournalSchema.safeParse(originalJournalBytes ? JSON.parse(originalJournalBytes) : null);
  expect(originalJournal.success).toBe(true);
  if (!originalJournal.success) throw Error("The absent-only unknown journal seed was invalid.");
  expect(originalJournal.data.entries).toHaveLength(2);
  expect(originalJournal.data.entries).toEqual(expect.arrayContaining([
    { key: "inbox-write-fixture", projectId: alpha.id, workspace, action: "comment", beadId: "alpha-epic", title: "Fixture unknown write", createdId: null, stage: "write", phase: "unknown", message: "Outcome unknown: check the bead before doing anything else. This write will not be repeated automatically." },
    { key: "inbox-beta-write-fixture", projectId: beta.id, workspace, action: "comment", beadId: "beta-epic", title: "Fixture Beta unknown write", createdId: null, stage: "write", phase: "unknown", message: "Outcome unknown: check the Beta bead before doing anything else. This write will not be repeated automatically." },
  ]));
  await expect(
    page.getByRole("link", { name: "Check alpha-epic", exact: true }),
  ).toBeVisible();
  expect(decisionPosts).toBe(0);

  await expect(
    page.getByRole("button", { name: "Allow once", exact: true }),
  ).toHaveCount(0);
  await expect.poll(() => appApprovalReads).toBeGreaterThan(0);
  expect(decisionPosts).toBe(0);
  expect(dispositionWrites).toBe(0);
  expect(
    await page.evaluate(
      (key) => localStorage.getItem(key),
      CODEX_CHAT_DECISION_IDENTITIES,
    ),
  ).toBe(inboxIdentityBefore);

  const codexPermissionCard = inboxRegion.locator(".af-inbox-card").filter({
    has: page.getByRole("heading", {
      name: "Command permission",
      exact: true,
    }),
  });
  await expect(codexPermissionCard.getByRole("button")).toHaveCount(0);
  await expect(
    codexPermissionCard.getByRole("link", { name: "Open session", exact: true }),
  ).toHaveAttribute(
    "href",
    `#/desktop/project/${encodeURIComponent(alpha.id)}/sessions?selectionKind=session&selectionId=${encodeURIComponent(session.id)}`,
  );
  releaseRecoveryRead();
  releaseHeldDispositionRead = null;
  await waitForRouteSignal(recoveryReadFinished);
  await codexPermissionCard.getByRole("link", { name: "Open session", exact: true }).click();
  const earlyReturnedConversation = page.getByRole("region", { name: "Session conversation", exact: true });
  const earlyNativeApprovals = page.getByRole("region", { name: "Native Codex approvals", exact: true });
  await expect(earlyNativeApprovals.getByRole("status").filter({ hasText: "Recording the original decision intent…" })).toHaveCount(0);
  await expect(earlyNativeApprovals.getByRole("button", { name: "Refresh native approvals", exact: true })).toBeEnabled();
  expect(decisionPosts).toBe(0);
  expect(dispositionRequests).toHaveLength(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), CODEX_CHAT_DECISION_IDENTITIES)).toBe(inboxIdentityBefore);
  await page.getByRole("navigation", { name: "Global", exact: true }).getByRole("link", { name: "Inbox", exact: true }).click();
  await expect(page.getByRole("region", { name: "Inbox", exact: true }).getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();

  const outcomeNotice = inboxRegion.getByRole("heading", {
    name: "Write outcomes to check",
    exact: true,
  });
  await expect(outcomeNotice).toBeVisible();
  const alphaProject = inboxRegion.locator(
    '.af-inbox-project[aria-label="Alpha"]',
  );
  const betaProject = inboxRegion.locator(
    '.af-inbox-project[aria-label="Beta"]',
  );
  const unknownAction = alphaProject.locator(".af-inbox-card").filter({
    has: page.getByRole("heading", {
      name: "Review comment outcome",
      exact: true,
    }),
  });
  await expect(
    unknownAction.getByRole("button", { name: "Snooze 1 hour", exact: true }),
  ).toBeVisible();
  const betaAction = betaProject.locator(".af-inbox-card").filter({
    has: page.getByRole("heading", {
      name: "Review comment outcome",
      exact: true,
    }),
  });
  const betaPostsBeforeSelection = dispositionRequests.filter((request) =>
    request.url.startsWith(`/__agent-forge/projects/${beta.id}/`),
  ).length;
  let releaseApply: () => void = () => {};
  const applyGate = new Promise<void>((resolve) => {
    releaseApply = resolve;
  });
  releaseHeldInboxRoutes.push(releaseApply);
  let markApplyStarted: () => void = () => {};
  const applyStarted = new Promise<void>((resolve) => {
    markApplyStarted = resolve;
  });
  let markApplyFinished: () => void = () => {};
  const applyFinished = new Promise<void>((resolve) => {
    markApplyFinished = resolve;
  });
  let holdBetaApply = true;
  let holdBetaCollection = false;
  let releaseCollection: () => void = () => {};
  const collectionGate = new Promise<void>((resolve) => {
    releaseCollection = resolve;
  });
  releaseHeldInboxRoutes.push(releaseCollection);
  let markCollectionCaptured: () => void = () => {};
  const collectionCaptured = new Promise<void>((resolve) => {
    markCollectionCaptured = resolve;
  });
  let markCollectionFinished: () => void = () => {};
  const collectionFinished = new Promise<void>((resolve) => {
    markCollectionFinished = resolve;
  });
  const heldBetaSnapshot: { value: ReturnType<typeof inboxDispositionStoreSchema.parse> | null } = { value: null };
  await ownRoute(page,
    `**/projects/${beta.id}/inbox-dispositions`,
    async (route) => {
      if (route.request().method() === "POST" && holdBetaApply) {
        markApplyStarted();
        await applyGate;
        await route.continue();
        const completed = await route.request().response();
        if (!completed) throw Error("The owned route completed without a response.");
      expect(await completed.finished()).toBeNull();
        holdBetaApply = false;
        markApplyFinished();
        return;
      }
      if (route.request().method() === "GET" && holdBetaCollection) {
        holdBetaCollection = false;
        const requestUrl = new URL(route.request().url());
        const response = await route.fetch({
          headers: {
            ...route.request().headers(),
            Origin: requestUrl.origin,
            "Sec-Fetch-Site": "same-origin",
          },
        });
        const collection = z
          .object({
            ok: z.literal(true),
            data: z
              .object({ entries: z.unknown(), receipts: z.unknown() })
              .strict(),
            error: z.null(),
          })
          .strict()
          .safeParse(await response.json());
        const collectionStore = collection.success
          ? inboxDispositionStoreSchema.safeParse({
              version: 1,
              entries: collection.data.data.entries,
              receipts: collection.data.data.receipts,
            })
          : null;
        if (
          response.status() !== 200 ||
          !collection.success ||
          !collectionStore?.success
        )
          throw Error(
            "The held Beta collection read was not a valid protected 200.",
          );
        heldBetaSnapshot.value = collectionStore.data;
        markCollectionCaptured();
        await collectionGate;
        await route.fulfill({ response });
        const completed = await route.request().response();
        if (!completed) throw Error("The owned route completed without a response.");
      expect(await completed.finished()).toBeNull();
        markCollectionFinished();
        return;
      }
      await route.continue();
    },
  );
  const betaReserveRequestPromise = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === `/__agent-forge/projects/${beta.id}/inbox-dispositions/requests`);
  const betaReserveResponsePromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/__agent-forge/projects/${beta.id}/inbox-dispositions/requests`);
  const betaApplyResponsePromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/__agent-forge/projects/${beta.id}/inbox-dispositions`);
  await markInboxRecoveryPhase(page, "codex-beta-snooze");
  await betaAction
    .getByRole("button", { name: "Snooze 1 hour", exact: true })
    .click();
  const betaReserveRequest = await waitForRouteSignal(betaReserveRequestPromise);
  const betaWire = inboxDispositionOriginalSchema.strict().safeParse(betaReserveRequest.postDataJSON());
  if (!betaWire.success) throw Error("The Beta reserve original was invalid.");
  expect(betaWire.data.workspace).toBe(workspace);
  expect(betaWire.data.operation).toBe("snooze-1h");
  const betaReserveReply = await waitForRouteSignal(betaReserveResponsePromise);
  expect(betaReserveReply.status()).toBe(200);
  const betaReserved = z.object({ ok: z.literal(true), data: z.object({ entry: inboxDispositionEntrySchema.nullable(), receipt: inboxDispositionReceiptSchema }).strict(), error: z.null() }).strict().safeParse(await betaReserveReply.json());
  if (!betaReserved.success) throw Error("The Beta reserved receipt was invalid.");
  expect(betaReserved.data.data.receipt).toMatchObject({ original: { ...betaWire.data, projectId: beta.id }, phase: "reserved" });
  expect(betaReserveReply.request()).toBe(betaReserveRequest);
  await waitForRouteSignal(applyStarted);
  await freezeInboxRecoveryWindow(page);
  let releaseScanRecovery: () => void = () => {};
  const scanRecoveryGate = new Promise<void>((resolve) => {
    releaseScanRecovery = resolve;
  });
  releaseHeldInboxRoutes.push(releaseScanRecovery);
  const heldRootSnapshot: { value: ReturnType<typeof inboxDispositionRecoverySchema.parse> | null } = { value: null };
  let holdScanRecovery = true;
  let markScanRecoveryCaptured: () => void = () => {};
  const scanRecoveryCaptured = new Promise<void>((resolve) => {
    markScanRecoveryCaptured = resolve;
  });
  await ownRoute(page, "**/inbox-dispositions/recovery", async (route) => {
    if (!holdScanRecovery) return route.continue();
    holdScanRecovery = false;
    const requestUrl = new URL(route.request().url());
    const response = await route.fetch({
      headers: {
        ...route.request().headers(),
        Origin: requestUrl.origin,
        "Sec-Fetch-Site": "same-origin",
      },
    });
    const recovery = z
      .object({
        ok: z.literal(true),
        data: inboxDispositionRecoverySchema,
        error: z.null(),
      })
      .strict()
      .safeParse(await response.json());
    if (response.status() !== 200 || !recovery.success)
      throw Error("The held recovery read was not a valid protected 200.");
    heldRootSnapshot.value = recovery.data.data;
    markScanRecoveryCaptured();
    await scanRecoveryGate;
    await route.fulfill({ response });
  });
  holdBetaCollection = true;
  await inboxRegion
    .getByRole("button", { name: "Refresh Inbox", exact: true })
    .click();
  await waitForRouteSignal(scanRecoveryCaptured);
  releaseScanRecovery();
  await waitForRouteSignal(collectionCaptured);
  releaseApply();
  await waitForRouteSignal(applyFinished);
  const betaAppliedReply = await waitForRouteSignal(betaApplyResponsePromise);
  expect(betaAppliedReply.status()).toBe(200);
  const betaApplied = z.object({ ok: z.literal(true), data: z.object({ entry: inboxDispositionEntrySchema, receipt: inboxDispositionReceiptSchema }).strict(), error: z.null() }).strict().safeParse(await betaAppliedReply.json());
  if (!betaApplied.success) throw Error("The actual Beta applied receipt was invalid.");
  expect(betaAppliedReply.request().postDataJSON()).toEqual(betaReserveRequest.postDataJSON());
  expect(betaApplied.data.data.receipt).toMatchObject({ original: { ...betaWire.data, projectId: beta.id }, phase: "applied", outcome: "applied", resultingRevision: betaWire.data.expectedRevision + 1 });
  expect(betaApplied.data.data.entry).toMatchObject({ projectId: beta.id, workspace, item: betaWire.data.item, revision: betaWire.data.expectedRevision + 1, operation: betaWire.data.operation });
  const rootSnapshot = heldRootSnapshot.value;
  const betaSnapshot = heldBetaSnapshot.value;
  if (!rootSnapshot || !betaSnapshot) throw Error("The held Beta preflight snapshots were not captured.");
  expect(rootSnapshot.receipts.filter((receipt) => receipt.original.requestId === betaWire.data.requestId)).toEqual([betaReserved.data.data.receipt]);
  expect(betaSnapshot.receipts.filter((receipt) => receipt.original.requestId === betaWire.data.requestId)).toEqual([betaReserved.data.data.receipt]);
  await expect(
    inboxRegion.getByText("Checking this Inbox action…", { exact: true }),
  ).toHaveCount(0);
  releaseCollection();
  await waitForRouteSignal(collectionFinished);
  await expect(
    inboxRegion.getByText("Refreshing saved Inbox dispositions…", {
      exact: true,
    }),
  ).toHaveCount(0);
  const buckets = inboxRegion.getByRole("group", {
    name: "Inbox bucket",
    exact: true,
  });
  await buckets.getByRole("button", { name: "Snoozed", exact: true }).click();
  await expect(
    betaProject.getByRole("heading", {
      name: "Review comment outcome",
      exact: true,
    }),
  ).toBeVisible();
  await buckets.getByRole("button", { name: "Needs you", exact: true }).click();
  await expect
    .poll(
      () =>
        dispositionRequests.filter((request) =>
          request.url.startsWith(`/__agent-forge/projects/${beta.id}/`),
        ).length,
    )
    .toBeGreaterThan(betaPostsBeforeSelection);
  await page.evaluate((projectId) => {
    location.hash = `/desktop/inbox?project=${encodeURIComponent(projectId)}`;
  }, beta.id);
  await expect(
    page.getByRole("link", { name: "Choose project: Beta", exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).hash).toBe(
    `#/desktop/inbox?project=${encodeURIComponent(beta.id)}`,
  );
  const recoveryRefreshPath = "/__agent-forge/inbox-dispositions/recovery";
  const alphaRefreshPath = `/__agent-forge/projects/${alpha.id}/inbox-dispositions`;
  const betaRefreshPath = `/__agent-forge/projects/${beta.id}/inbox-dispositions`;
  const rootRefreshRequestPromise = page.waitForRequest((request) => request.method() === "GET" && new URL(request.url()).pathname === recoveryRefreshPath);
  const alphaRefreshRequestPromise = page.waitForRequest((request) => request.method() === "GET" && new URL(request.url()).pathname === alphaRefreshPath);
  const betaRefreshRequestPromise = page.waitForRequest((request) => request.method() === "GET" && new URL(request.url()).pathname === betaRefreshPath);
  await inboxRegion.getByRole("button", { name: "Refresh Inbox", exact: true }).click();
  const [rootRefreshRequest, alphaRefreshRequest, betaRefreshRequest] = await Promise.all([waitForRouteSignal(rootRefreshRequestPromise), waitForRouteSignal(alphaRefreshRequestPromise), waitForRouteSignal(betaRefreshRequestPromise)]);
  const [refreshedRoot, refreshedAlpha, refreshedBeta] = await Promise.all([waitForRouteSignal(rootRefreshRequest.response()), waitForRouteSignal(alphaRefreshRequest.response()), waitForRouteSignal(betaRefreshRequest.response())]);
  if (!refreshedRoot || !refreshedAlpha || !refreshedBeta) throw Error("A current Inbox refresh request completed without its paired response.");
  for (const response of [refreshedRoot, refreshedAlpha, refreshedBeta]) { expect(response.status()).toBe(200); expect(await response.finished()).toBeNull(); }
  const currentRoot = z.object({ ok: z.literal(true), data: inboxDispositionRecoverySchema, error: z.null() }).strict().safeParse(await refreshedRoot.json());
  const scopedSchema = z.object({ ok: z.literal(true), data: z.object({ entries: z.array(inboxDispositionEntrySchema), receipts: z.array(inboxDispositionReceiptSchema) }).strict(), error: z.null() }).strict();
  const currentAlpha = scopedSchema.safeParse(await refreshedAlpha.json());
  const currentBeta = scopedSchema.safeParse(await refreshedBeta.json());
  if (!currentRoot.success || !currentAlpha.success || !currentBeta.success) throw Error("The refreshed current Inbox authority was invalid.");
  expect(currentRoot.data.data.receipts).toEqual([betaApplied.data.data.receipt]);
  expect(currentAlpha.data.data.entries).toEqual([]);
  expect(currentAlpha.data.data.receipts).toEqual([]);
  expect(currentBeta.data.data.entries).toEqual([betaApplied.data.data.entry]);
  expect(currentBeta.data.data.receipts).toEqual([betaApplied.data.data.receipt]);
  await expect(inboxRegion.getByRole("status", { name: "Loading Inbox sources", exact: true })).toHaveCount(0);
  await expect(inboxRegion.getByText("Refreshing saved Inbox dispositions…", { exact: true })).toHaveCount(0);
  await expect(inboxRegion.getByText("Checking this Inbox action…", { exact: true })).toHaveCount(0);
  await expect(unknownAction.getByRole("button", { name: "Snooze 1 hour", exact: true })).toBeEnabled();
  await expect(unknownAction.getByRole("button", { name: "Mark done · source unresolved", exact: true })).toBeDisabled();
  const betaPostsBeforeAlphaDecision = dispositionRequests.filter((request) =>
    request.url.startsWith(`/__agent-forge/projects/${beta.id}/`),
  ).length;
  const alphaPostsBeforeCrossScopeAction = dispositionRequests.filter(
    (request) => request.url.startsWith(`/__agent-forge/projects/${alpha.id}/`),
  ).length;
  const alphaReserveRequest = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname ===
        `/__agent-forge/projects/${alpha.id}/inbox-dispositions/requests`,
  );
  const alphaApplyResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname ===
        `/__agent-forge/projects/${alpha.id}/inbox-dispositions`,
  );
  await expect(unknownAction.getByRole("button", { name: "Mark done · source unresolved", exact: true })).toBeDisabled();
  await unknownAction
    .getByRole("button", { name: "Snooze 1 hour", exact: true })
    .click();
  const alphaReserve = await waitForRouteSignal(alphaReserveRequest);
  const alphaWire = inboxDispositionOriginalSchema.strict().safeParse(
    alphaReserve.postDataJSON(),
  );
  expect(alphaWire.success).toBe(true);
  if (!alphaWire.success) throw Error("The Alpha reserve original was invalid.");
  expect(Object.keys(alphaWire.data).sort()).toEqual(
    ["expectedCatalogRevision", "expectedRevision", "item", "operation", "requestId", "workspace"].sort(),
  );
  expect(alphaWire.data.workspace).toBe(workspace);
  expect(alphaWire.data.item.sourceKind).toBe("unknown-bead-write");
  expect(alphaWire.data.operation).toBe("snooze-1h");
  const alphaApply = await waitForRouteSignal(alphaApplyResponse);
  expect(alphaReserve.url()).toBe(new URL(alphaReserve.url()).origin + "/__agent-forge/projects/" + alpha.id + "/inbox-dispositions/requests");
  expect(alphaApply.url()).toBe(new URL(alphaApply.url()).origin + "/__agent-forge/projects/" + alpha.id + "/inbox-dispositions");
  expect(alphaApply.status()).toBe(200);
  const alphaRecord = z
    .object({
      ok: z.literal(true),
      data: z.object({ entry: inboxDispositionEntrySchema, receipt: inboxDispositionReceiptSchema }).strict(),
      error: z.null(),
    })
    .strict()
    .safeParse(await alphaApply.json());
  expect(alphaRecord.success).toBe(true);
  if (!alphaRecord.success) throw Error("The Alpha apply receipt was invalid.");
  expect(alphaApply.request().postDataJSON()).toEqual(alphaReserve.postDataJSON());
  expect(alphaRecord.data.data.receipt.original).toEqual({
    ...alphaWire.data,
    projectId: alpha.id,
  });
  expect(alphaRecord.data.data.entry).toMatchObject({
    projectId: alpha.id,
    workspace,
    item: alphaWire.data.item,
    revision: alphaWire.data.expectedRevision + 1,
    operation: "snooze-1h",
  });
  await expect(alphaNotice.getByText("Outcome unknown", { exact: true })).toBeVisible();
  expect(
    dispositionRequests.filter((request) =>
      request.url.startsWith(`/__agent-forge/projects/${beta.id}/`),
    ),
  ).toHaveLength(betaPostsBeforeAlphaDecision);
  expect(alphaPostsBeforeCrossScopeAction).toBe(0);
  expect(decisionPosts).toBe(0);
  expect(decisionRequests).toHaveLength(0);

  const reserveRequests: Array<{ requestId: unknown; body: unknown }> = [];
  let lostFirstReserveRequest: Request | null = null;
  let loseFirstReserve = true;
  const reservePattern = `**/projects/${alpha.id}/inbox-dispositions/requests`;
  const loseReserveOnce = async (route: import("@playwright/test").Route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = route.request().postDataJSON();
    const requestId =
      typeof body === "object" && body !== null && "requestId" in body
        ? body.requestId
        : null;
    reserveRequests.push({ requestId, body });
    if (loseFirstReserve) {
      lostFirstReserveRequest = route.request();
      loseFirstReserve = false;
      markExpectedRouteAbort(route.request());
      await route.abort();
      return;
    }
    await route.continue();
  };
  await ownRoute(page, reservePattern, loseReserveOnce);
  await buckets.getByRole("button", { name: "Snoozed", exact: true }).click();
  await expect(inboxRegion.getByText("Checking this Inbox action…", { exact: true })).toHaveCount(0);
  const postFirstRootRequestPromise = page.waitForRequest((request) => request.method() === "GET" && new URL(request.url()).pathname === recoveryRefreshPath);
  const postFirstAlphaRequestPromise = page.waitForRequest((request) => request.method() === "GET" && new URL(request.url()).pathname === alphaRefreshPath);
  const postFirstBetaRequestPromise = page.waitForRequest((request) => request.method() === "GET" && new URL(request.url()).pathname === betaRefreshPath);
  await inboxRegion.getByRole("button", { name: "Refresh Inbox", exact: true }).click();
  const [postFirstRootRequest, postFirstAlphaRequest, postFirstBetaRequest] = await Promise.all([waitForRouteSignal(postFirstRootRequestPromise), waitForRouteSignal(postFirstAlphaRequestPromise), waitForRouteSignal(postFirstBetaRequestPromise)]);
  const [postFirstRootResponse, postFirstAlphaResponse, postFirstBetaResponse] = await Promise.all([waitForRouteSignal(postFirstRootRequest.response()), waitForRouteSignal(postFirstAlphaRequest.response()), waitForRouteSignal(postFirstBetaRequest.response())]);
  if (!postFirstRootResponse || !postFirstAlphaResponse || !postFirstBetaResponse) throw Error("A refreshed Inbox request completed without its response.");
  for (const response of [postFirstRootResponse, postFirstAlphaResponse, postFirstBetaResponse]) { expect(response.status()).toBe(200); expect(await response.finished()).toBeNull(); }
  const postFirstRoot = z.object({ ok: z.literal(true), data: inboxDispositionRecoverySchema, error: z.null() }).strict().safeParse(await postFirstRootResponse.json());
  const postFirstAlpha = scopedSchema.safeParse(await postFirstAlphaResponse.json());
  const postFirstBeta = scopedSchema.safeParse(await postFirstBetaResponse.json());
  if (!postFirstRoot.success || !postFirstAlpha.success || !postFirstBeta.success) throw Error("The refreshed Inbox authority was invalid.");
  expect(postFirstRoot.data.data.receipts).toHaveLength(2);
  expect(postFirstRoot.data.data.receipts).toEqual(expect.arrayContaining([alphaRecord.data.data.receipt, betaApplied.data.data.receipt]));
  expect(postFirstAlpha.data.data.entries).toEqual([alphaRecord.data.data.entry]);
  expect(postFirstAlpha.data.data.receipts).toEqual([alphaRecord.data.data.receipt]);
  expect(postFirstBeta.data.data.entries).toEqual([betaApplied.data.data.entry]);
  expect(postFirstBeta.data.data.receipts).toEqual([betaApplied.data.data.receipt]);
  await expect(inboxRegion.getByRole("status", { name: "Loading Inbox sources", exact: true })).toHaveCount(0);
  await expect(inboxRegion.getByText("Refreshing saved Inbox dispositions…", { exact: true })).toHaveCount(0);
  await expect(inboxRegion.getByText("Checking this Inbox action…", { exact: true })).toHaveCount(0);
  await expect(unknownAction.getByRole("button", { name: "Snooze 1 hour", exact: true })).toBeEnabled();
  await expect(unknownAction.getByRole("button", { name: "Mark done · source unresolved", exact: true })).toBeDisabled();
  const lostReserveFailure = page.waitForEvent("requestfailed", (request) => request.method() === "POST" && new URL(request.url()).pathname === `/__agent-forge/projects/${alpha.id}/inbox-dispositions/requests`);
  await unknownAction
    .getByRole("button", { name: "Snooze 1 hour", exact: true })
    .click();
  const failedReserveRequest = await waitForRouteSignal(lostReserveFailure);
  if (!lostFirstReserveRequest) throw Error("The deliberately aborted reserve request was not captured.");
  expect(failedReserveRequest).toBe(lostFirstReserveRequest);
  expect(observedExpectedRouteAborts.has(failedReserveRequest)).toBe(true);
  const actionHistory = inboxRegion.getByRole("region", {
    name: "Inbox action history",
    exact: true,
  });
  await expect(
    actionHistory.getByRole("button", {
      name: "Review unconfirmed reservation",
      exact: true,
    }),
  ).toBeVisible();
  await actionHistory
    .getByRole("button", {
      name: "Review unconfirmed reservation",
      exact: true,
    })
    .click();
  await expect(
    inboxRegion.getByText(
      /A new Inbox acknowledgment may be reviewed separately\./,
    ),
  ).toBeVisible();
  await unknownAction
    .getByRole("button", { name: "Snooze 1 hour", exact: true })
    .click();
  await expect.poll(() => reserveRequests.length).toBe(2);
  expect(reserveRequests[0]?.requestId).not.toBe(reserveRequests[1]?.requestId);
  expect(
    z.string().uuid().safeParse(reserveRequests[1]?.requestId).success,
  ).toBe(true);
  await buckets.getByRole("button", { name: "Snoozed", exact: true }).click();
  await expect(
    alphaProject.getByRole("heading", {
      name: "Review comment outcome",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    alphaNotice.getByText("Outcome unknown", { exact: true }),
  ).toBeVisible();

  await page.emulateMedia({ reducedMotion: "reduce" });
  await buckets.getByRole("button", { name: "Snoozed", exact: true }).focus();
  await page.keyboard.press("Tab");
  const projectFilter = inboxRegion.getByRole("combobox", {
    name: "Filter Inbox by project",
    exact: true,
  });
  await expect(projectFilter).toBeFocused();
  expect(
    await projectFilter.evaluate(
      (element) => getComputedStyle(element).outlineWidth,
    ),
  ).toBe("2px");
  expect(
    await inboxRegion
      .locator(".af-inbox-card")
      .evaluateAll((elements) => elements.map((element) => getComputedStyle(element).transitionDuration)),
  ).toEqual(["0s", "0s"]);

  const globalNav = page.getByRole("navigation", {
    name: "Global",
    exact: true,
  });
  await globalNav.getByRole("link", { name: "Projects", exact: true }).click();
  const recoveryResponsesBeforeReturn = recoveryResponses;
  await globalNav.getByRole("link", { name: "Inbox", exact: true }).click();
  const returnedInbox = page.getByRole("region", {
    name: "Inbox",
    exact: true,
  });
  await expect(
    returnedInbox.getByRole("heading", { name: "Inbox", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => recoveryResponses)
    .toBeGreaterThan(recoveryResponsesBeforeReturn);
  await expect(
    returnedInbox.getByText("Refreshing saved Inbox dispositions…", {
      exact: true,
    }),
  ).toHaveCount(0);
  releaseRecoveryRead();
  releaseHeldDispositionRead = null;
  await waitForRouteSignal(recoveryReadFinished);
  const returnedBuckets = returnedInbox.getByRole("group", {
    name: "Inbox bucket",
    exact: true,
  });
  await returnedBuckets
    .getByRole("button", { name: "Snoozed", exact: true })
    .click();
  await expect(
    returnedInbox
      .locator('.af-inbox-project[aria-label="Alpha"]')
      .getByRole("heading", { name: "Review comment outcome", exact: true }),
  ).toBeVisible();
  await expect(
    returnedInbox.locator(".af-inbox-notice").filter({ has: page.getByRole("heading", { name: "Fixture unknown write", exact: true }) }).getByText("Outcome unknown", { exact: true }),
  ).toBeVisible();
  await returnedBuckets
    .getByRole("button", { name: "Needs you", exact: true })
    .click();

  await buckets.getByRole("button", { name: "Needs you", exact: true }).click();
  await expect(
    alphaProject.getByRole("heading", {
      name: "Review comment outcome",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    alphaNotice.getByText("Outcome unknown", { exact: true }),
  ).toBeVisible();
  await expect(
    inboxRegion.getByRole("link", { name: "Check alpha-epic", exact: true }),
  ).toBeVisible();
  expect(decisionPosts).toBe(0);
  await alphaNotice
    .getByRole("button", {
      name: "I checked this write · dismiss",
      exact: true,
    })
    .click();
  await expect(
    alphaNotice.getByText("Outcome unknown", { exact: true }),
  ).toHaveCount(0);
  const dismissedJournalBytes = await page.evaluate(
    (key) => localStorage.getItem(key),
    writeJournalKey,
  );
  const dismissedJournal = writeJournalSchema.safeParse(dismissedJournalBytes ? JSON.parse(dismissedJournalBytes) : null);
  expect(dismissedJournal.success).toBe(true);
  if (!dismissedJournal.success) throw Error("The dismissed write journal was invalid.");
  const retainedBetaJournal = dismissedJournal.data.entries.find((entry) => entry.key === "inbox-beta-write-fixture");
  expect(retainedBetaJournal).toEqual({ key: "inbox-beta-write-fixture", projectId: beta.id, workspace, action: "comment", beadId: "beta-epic", title: "Fixture Beta unknown write", createdId: null, stage: "write", phase: "unknown", message: "Outcome unknown: check the Beta bead before doing anything else. This write will not be repeated automatically." });
  expect(dismissedJournal.data.entries).toEqual([retainedBetaJournal]);
  const requestCountBeforeReload = dispositionRequests.length;
  await page.reload();
  const reloadedInbox = page.getByRole("region", { name: "Inbox", exact: true });
  await expect(reloadedInbox.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Choose project: Beta", exact: true })).toBeVisible();
  await expect(
    reloadedInbox.getByRole("heading", { name: "Fixture unknown write", exact: true }),
  ).toHaveCount(0);
  await expect(
    reloadedInbox.getByRole("heading", { name: "Fixture Beta unknown write", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate((key) => localStorage.getItem(key), writeJournalKey),
  ).toBe(dismissedJournalBytes);
  expect(dispositionRequests).toHaveLength(requestCountBeforeReload);

  await expect(codexPermissionCard.getByRole("button")).toHaveCount(0);
  expect(decisionPosts).toBe(0);
  const codexItem = canonicalPermissionItem({ provider: "codex", projectId: alpha.id, sessionId: session.id, turnRequestId: session.requestId, offerId: originalEvent.approval.id, approval: originalEvent.approval });
  const codexLegacyStore = legacyPermissionStore({ projectId: alpha.id, item: codexItem, operation: "done", hold: true });
  seedPrivateDispositionStore(codexLegacyStore);
  const codexHeldOriginal = codexLegacyStore.receipts.find((receipt) => receipt.phase === "reserved")?.original;
  const codexDoneReceipt = codexLegacyStore.receipts.find((receipt) => receipt.phase === "applied");
  if (!codexHeldOriginal || !codexDoneReceipt) throw Error("The canonical Codex legacy permission records were absent.");
  expect(codexDoneReceipt.original).toMatchObject({ projectId: alpha.id, workspace, item: codexItem, expectedRevision: 0, operation: "done" });
  expect(codexHeldOriginal).toMatchObject({ projectId: alpha.id, workspace, item: codexItem, expectedRevision: 1, operation: "snooze-1h" });
  const heldStoreBytes = readFileSync(dispositionStatePath);
  await page.evaluate((hash) => { location.hash = hash; }, "/desktop/inbox?project=" + encodeURIComponent(alpha.id));
  const alphaInbox = page.getByRole("region", { name: "Inbox", exact: true });
  await alphaInbox.getByRole("button", { name: "Refresh Inbox", exact: true }).click();
  const codexCard = alphaInbox.locator(".af-inbox-card").filter({ has: page.getByRole("heading", { name: "Command permission", exact: true }) });
  await expect(codexCard).toHaveCount(1);
  await expect(codexCard.getByRole("button")).toHaveCount(0);
  await expect(codexCard.getByRole("link", { name: "Open session", exact: true })).toHaveAttribute("href", "#/desktop/project/" + encodeURIComponent(alpha.id) + "/sessions?selectionKind=session&selectionId=" + encodeURIComponent(session.id));
  const alphaHistory = alphaInbox.getByRole("region", { name: "Inbox action history", exact: true });
  const codexHistoryRow = alphaHistory.locator("article").filter({ hasText: codexHeldOriginal.requestId });
  await expect(codexHistoryRow.getByText("Server receipt: reserved", { exact: true })).toBeVisible();
  await expect(codexHistoryRow.getByText("snooze-1h", { exact: false })).toBeVisible();
  await expect(codexHistoryRow.getByRole("button")).toHaveCount(0);
  const alphaBucket = alphaInbox.getByRole("group", { name: "Inbox bucket", exact: true });
  await alphaBucket.getByRole("button", { name: "Snoozed", exact: true }).click();
  await expect(codexCard).toHaveCount(0);
  await alphaBucket.getByRole("button", { name: "Needs you", exact: true }).click();
  await expect(codexCard).toHaveCount(1);
  await page.evaluate((hash) => { location.hash = hash; }, "/desktop/inbox?project=" + encodeURIComponent(beta.id));
  const betaInbox = page.getByRole("region", { name: "Inbox", exact: true });
  await betaInbox.getByRole("button", { name: "Refresh Inbox", exact: true }).click();
  const betaBucket = betaInbox.getByRole("group", { name: "Inbox bucket", exact: true });
  await betaBucket.getByRole("button", { name: "Snoozed", exact: true }).click();
  const betaHoldCard = betaInbox.locator('.af-inbox-project[aria-label="Beta"] .af-inbox-card').filter({ has: page.getByRole("heading", { name: "Review comment outcome", exact: true }) });
  await expect(betaHoldCard.getByRole("button", { name: "Snooze 1 hour", exact: true })).toBeEnabled();
  const dispositionPostsBeforeHeldAction = dispositionRequests.length;
  await expect(betaInbox.getByRole("alert")).toHaveCount(0);
  await betaHoldCard.getByRole("button", { name: "Snooze 1 hour", exact: true }).click();
  const globalHoldRefusal = betaInbox.getByRole("alert").filter({ hasText: "An unresolved Inbox original must be checked before another item can be acknowledged." });
  await expect(globalHoldRefusal).toHaveCount(1);
  await expect(globalHoldRefusal).toHaveText("An unresolved Inbox original must be checked before another item can be acknowledged. Source items remain visible.");
  expect(dispositionRequests).toHaveLength(dispositionPostsBeforeHeldAction);
  expect(dispositionRequests.some((request) => isPermissionDispositionRequest(request.body))).toBe(false);
  expect(readFileSync(dispositionStatePath).equals(heldStoreBytes)).toBe(true);
  expect(decisionPosts).toBe(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), CODEX_CHAT_DECISION_IDENTITIES)).toBe(inboxIdentityBefore);
  await page.evaluate((hash) => { location.hash = hash; }, "/desktop/inbox?project=" + encodeURIComponent(alpha.id));
  const returnedPermissionInbox = page.getByRole("region", { name: "Inbox", exact: true });
  await returnedPermissionInbox
    .getByRole("group", { name: "Inbox bucket", exact: true })
    .getByRole("button", { name: "Needs you", exact: true }).click();
  const returnedCodexCard = returnedPermissionInbox.locator(".af-inbox-card").filter({ has: page.getByRole("heading", { name: "Command permission", exact: true }) });
  await expect(returnedCodexCard).toHaveCount(1);
  await returnedCodexCard.getByRole("link", { name: "Open session", exact: true }).click();
  const returnedConversation = page.getByRole("region", { name: "Session conversation", exact: true });
  const returnedApprovals = page.getByRole("region", { name: "Native Codex approvals", exact: true });
  await expect(returnedApprovals.getByRole("status").filter({ hasText: "Recording the original decision intent…" })).toHaveCount(0);
  const refreshNative = returnedApprovals.getByRole("button", { name: "Refresh native approvals", exact: true });
  await expect(refreshNative).toBeEnabled();
  expect(decisionPosts).toBe(0);
  expect(dispositionRequests.some((request) => isPermissionDispositionRequest(request.body))).toBe(false);
  expect(await page.evaluate((key) => localStorage.getItem(key), CODEX_CHAT_DECISION_IDENTITIES)).toBe(inboxIdentityBefore);
  trace.detach();
  await page.unroute("**/sessions/" + session.id + "/approvals");
  const positiveRefresh = page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === approvalsPath && new URL(response.url()).search === "");
  await refreshNative.click();
  const positiveRead = await waitForRouteSignal(positiveRefresh);
  expect(positiveRead.status()).toBe(200);
  const positivePage = z.object({ ok: z.literal(true), data: codexChatApprovalPageSchema, error: z.null() }).strict().safeParse(await positiveRead.json());
  expect(positivePage.success).toBe(true);
  if (!positivePage.success) throw Error("The separately refreshed Codex original was invalid.");
  expect(positivePage.data.data.pending).toContainEqual({
    turnRequestId: session.requestId,
    actionable: true,
    detailsUnavailableReason: null,
    approval: {
      id: originalEvent.approval.id,
      kind: originalEvent.approval.kind,
      command: originalEvent.approval.command,
      cwd: originalEvent.approval.cwd,
      reason: originalEvent.approval.reason,
      availableDecisions: originalEvent.approval.availableDecisions,
    },
  });
  const sessionDecisionRequest = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/__agent-forge/projects/" + alpha.id + "/sessions/" + session.id + "/approval-decisions");
  const sessionDecision = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/__agent-forge/projects/" + alpha.id + "/sessions/" + session.id + "/approval-decisions");
  await returnedConversation.getByRole("button", { name: "Allow once", exact: true }).click();
  const actualDecisionRequest = await waitForRouteSignal(sessionDecisionRequest);
  const nativeDecisionWire = codexChatDecisionRequestSchema.strict().safeParse(actualDecisionRequest.postDataJSON());
  expect(nativeDecisionWire.success).toBe(true);
  if (!nativeDecisionWire.success) throw Error("The positive Codex request was invalid.");
  expect(nativeDecisionWire.data).toMatchObject({ turnRequestId: session.requestId, approvalId: originalEvent.approval.id, decision: "accept" });
  expect(nativeDecisionWire.data.requestId).not.toBe(session.requestId);
  expect(z.string().uuid().safeParse(nativeDecisionWire.data.requestId).success).toBe(true);
  const sessionDecisionReply = await waitForRouteSignal(sessionDecision);
  expect(sessionDecisionReply.request()).toBe(actualDecisionRequest);
  expect(sessionDecisionReply.status()).toBe(200);
  const sessionDecisionEnvelope = z.object({ ok: z.literal(true), data: codexChatDecisionReceiptSchema, error: z.null() }).strict().safeParse(await sessionDecisionReply.json());
  expect(sessionDecisionEnvelope.success).toBe(true);
  if (!sessionDecisionEnvelope.success) throw Error("The positive Codex receipt was invalid.");
  expect(sessionDecisionEnvelope.data.data).toEqual({ ...nativeDecisionWire.data, projectId: alpha.id, sessionId: session.id, state: "recorded", recordedAt: expect.any(String) });
  expect(decisionPosts).toBe(1);
  expect(decisionRequests[0]?.body).toEqual(nativeDecisionWire.data);
  expect(decisionRequests[0]?.url).toBe("/__agent-forge/projects/" + alpha.id + "/sessions/" + session.id + "/approval-decisions");
  // Consumer-only retained-identity fixture joined to the real R1 offer; it is not proof of native delivery.
  const heldCodexIdentity = codexChatDecisionRequestSchema.parse({ requestId: randomUUID(), turnRequestId: session.requestId, approvalId: originalEvent.approval.id, decision: "accept" });
  const heldCodexRecord = codexChatDecisionRequestSchema.extend({ projectId: z.string(), sessionId: z.string() }).strict().parse({ ...heldCodexIdentity, projectId: alpha.id, sessionId: session.id });
  const heldCodexBytes = JSON.stringify({ version: 1, records: [heldCodexRecord] });
  await page.evaluate(({ key, bytes }) => localStorage.setItem(key, bytes), { key: CODEX_CHAT_DECISION_IDENTITIES, bytes: heldCodexBytes });
  expect(await page.evaluate((key) => localStorage.getItem(key), CODEX_CHAT_DECISION_IDENTITIES)).toBe(heldCodexBytes);
  await page.evaluate((hash) => { location.hash = hash; }, "/desktop/inbox?project=" + encodeURIComponent(alpha.id));
  const heldInbox = page.getByRole("region", { name: "Inbox", exact: true });
  await heldInbox.getByRole("button", { name: "Refresh Inbox", exact: true }).click();
  const heldCodexCard = heldInbox.locator(".af-inbox-card").filter({ has: page.getByRole("heading", { name: "Original permission decision held", exact: true }) });
  await expect(heldCodexCard).toHaveCount(1);
  await expect(heldCodexCard.getByText("Original permission is held. No replacement decision will be sent.", { exact: true })).toBeVisible();
  await expect(heldCodexCard.getByRole("button")).toHaveCount(0);
  await expect(heldCodexCard.getByRole("link", { name: "Open session", exact: true })).toHaveAttribute("href", "#/desktop/project/" + encodeURIComponent(alpha.id) + "/sessions?selectionKind=session&selectionId=" + encodeURIComponent(session.id));
  expect(await page.evaluate((key) => localStorage.getItem(key), CODEX_CHAT_DECISION_IDENTITIES)).toBe(heldCodexBytes);
  await page.evaluate((hash) => { location.hash = hash; }, "/desktop/project/" + alpha.id + "/sessions");
  await page.getByRole("button", { name: "New session", exact: true }).click();
  const fileDialog = page.getByRole("dialog", { name: "New session · Alpha", exact: true });
  await fileDialog.getByRole("button", { name: /Cx · Codex/ }).click();
  await fileDialog.getByRole("combobox", { name: "Session mode", exact: true }).selectOption("chat");
  await expect(fileDialog.getByRole("combobox", { name: "Session smith", exact: true })).toHaveValue("codex-journeyman");
  await fileDialog.getByRole("combobox", { name: "Session effort", exact: true }).selectOption("");
  await fileDialog.getByRole("textbox", { name: "Session prompt", exact: true }).fill("Inbox Codex unavailable file permission fixture");
  await fileDialog.getByRole("button", { name: "Check supported options", exact: true }).click();
  await expect(fileDialog.getByRole("button", { name: "Start", exact: true })).toBeEnabled();
  writeFileSync(join(HEARTH_HOME, "codex-chat-fixture-mode.json"), JSON.stringify("approval-file"));
  await fileDialog.getByRole("button", { name: "Start", exact: true }).click();
  await expect.poll(() => sessions().filter((item) => !priorSessions.has(item.id)).length).toBe(2);
  const fileSession = sessions().find((item) => item.id !== session.id && !priorSessions.has(item.id));
  if (!fileSession) throw Error("The strict Codex file permission session was absent.");
  const fileSetup = await page.evaluate(async ({ projectId, sessionId, token, header }) => {
    const response = await fetch("/__agent-forge/projects/" + encodeURIComponent(projectId) + "/sessions/" + encodeURIComponent(sessionId) + "/approvals", { headers: { [header]: token } });
    let body: unknown; try { body = await response.json(); } catch { body = null; }
    return { status: response.status, body };
  }, { projectId: alpha.id, sessionId: fileSession.id, token: await pageToken(page), header: OPERATOR_HEADER });
  const filePage = z.object({ ok: z.literal(true), data: codexChatApprovalPageSchema, error: z.null() }).strict().safeParse(fileSetup.body);
  expect(fileSetup.status).toBe(200);
  expect(filePage.success).toBe(true);
  if (!filePage.success) throw Error("The Codex file approval response was not strict.");
  const fileOffer = filePage.data.data.pending.find((item) => item.turnRequestId === fileSession.requestId);
  expect(fileOffer).toBeDefined();
  if (!fileOffer) throw Error("The exact Codex file offer was missing.");
  expect(fileOffer.approval.kind).toBe("file-change");
  expect(fileOffer.detailsUnavailableReason).toBe(CODEX_FILE_DETAILS_UNAVAILABLE);
  expect(fileOffer.approval.availableDecisions).not.toContain("accept");
  const fileR1 = savedSession(fileSession.id).frames.find((frame) => frame.turnId === fileSession.requestId && frame.event.kind === "coding-chat" && frame.event.event.kind === "approval-request");
  expect(fileR1).toBeDefined();
  if (!fileR1 || fileR1.event.kind !== "coding-chat" || fileR1.event.event.kind !== "approval-request") throw Error("The exact Codex file R1 frame was absent.");
  expect(fileOffer.turnRequestId).toBe(fileSession.requestId);
  expect(fileOffer.approval).toEqual(fileR1.event.event.approval);
  await page.getByRole("navigation", { name: "Global", exact: true }).getByRole("link", { name: "Inbox", exact: true }).click();
  const fileInbox = page.getByRole("region", { name: "Inbox", exact: true });
  await fileInbox.getByRole("button", { name: "Refresh Inbox", exact: true }).click();
  const fileCard = fileInbox.locator(".af-inbox-card").filter({ has: page.getByRole("heading", { name: "File permission", exact: true }) });
  await expect(fileCard).toHaveCount(1);
  await expect(fileCard.getByRole("button")).toHaveCount(0);
  await expect(fileCard.getByRole("link", { name: "Open session", exact: true })).toHaveAttribute("href", "#/desktop/project/" + encodeURIComponent(alpha.id) + "/sessions?selectionKind=session&selectionId=" + encodeURIComponent(fileSession.id));
  await expect(fileCard.getByText("File permission", { exact: true })).toBeVisible();
  const fileApprovalsPath = "/__agent-forge/projects/" + alpha.id + "/sessions/" + fileSession.id + "/approvals";
  await ownRoute(page, "**/sessions/" + fileSession.id + "/approvals", async (route) => {
    if (route.request().method() === "GET" && new URL(route.request().url()).pathname === fileApprovalsPath && new URL(route.request().url()).search === "") await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, data: null, error: "Fixture source temporarily unavailable." }) });
    else await route.continue();
  });
  const fileStaleRead = page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === fileApprovalsPath && new URL(response.url()).search === "");
  await fileInbox.getByRole("button", { name: "Refresh Inbox", exact: true }).click();
  const fileStaleResponse = await waitForRouteSignal(fileStaleRead);
  expect(fileStaleResponse.status()).toBe(503);
  await expect(fileCard).toHaveCount(1);
  await expect(fileCard.locator(".af-inbox-card-meta")).toContainText("Check required");
  await expect(fileCard.getByRole("button")).toHaveCount(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), CODEX_CHAT_DECISION_IDENTITIES)).toBe(heldCodexBytes);
  expect(decisionPosts).toBe(1);
  expect(dispositionRequests.some((request) => isPermissionDispositionRequest(request.body))).toBe(false);

});

test("Inbox discards an exact reserved original after a pre-effect 504", async ({ page }) => {
  await page.addInitScript(
    ({ key, entry }) => {
      if (localStorage.getItem(key) === null)
        localStorage.setItem(key, JSON.stringify({ version: 1, entries: [entry] }));
    },
    {
      key: writeJournalKey,
      entry: {
        key: "pre-effect-unknown",
        projectId: alpha.id,
        workspace,
        action: "comment",
        beadId: "alpha-epic",
        title: "Pre-effect unknown write",
        createdId: null,
        stage: "write",
        phase: "unknown",
        message: "Outcome unknown; check before repeating.",
      },
    },
  );
  let applyPosts = 0;
  let reserveRequestBodies: unknown[] = [];
  let applyBody: unknown;
  const applyPath = "/__agent-forge/projects/" + alpha.id + "/inbox-dispositions";
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/__agent-forge/projects/" + alpha.id + "/inbox-dispositions/requests") reserveRequestBodies.push(request.postDataJSON());
  });
  await ownRoute(page, "**/projects/" + alpha.id + "/inbox-dispositions", async (route) => {
    if (route.request().method() !== "POST" || new URL(route.request().url()).pathname !== applyPath)
      return route.continue();
    applyPosts++;
    applyBody = route.request().postDataJSON();
    await route.fulfill({
      status: 504,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        data: null,
        error: "Fixture timeout before the apply reached the server.",
      }),
    });
  });
  const initialRecovery = observeInitialRecovery(page, "case2-initial-navigation");
  await openSettled(page, "/index.html#/desktop/inbox?project=" + encodeURIComponent(alpha.id));
  await initialRecovery.qualify(); initialRecovery.close();
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  const action = inbox.locator('.af-inbox-project[aria-label="Alpha"] .af-inbox-card').filter({
    has: page.getByRole("heading", { name: "Review comment outcome", exact: true }),
  });
  const reserveRequestPromise = page.waitForRequest((request) =>
    request.method() === "POST" &&
    new URL(request.url()).pathname === "/__agent-forge/projects/" + alpha.id + "/inbox-dispositions/requests",
  );
  const reserveResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    new URL(response.url()).pathname === "/__agent-forge/projects/" + alpha.id + "/inbox-dispositions/requests",
  );
  const applyResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === applyPath,
  );
  await action.getByRole("button", { name: "Snooze 1 hour", exact: true }).click();
  const reserveRequest = await waitForRouteSignal(reserveRequestPromise);
  const reserveWire = inboxDispositionOriginalSchema.strict().safeParse(reserveRequest.postDataJSON());
  expect(reserveWire.success).toBe(true);
  if (!reserveWire.success) throw Error("The pre-effect reserve original was invalid.");
  expect(reserveWire.data.item.sourceKind).toBe("unknown-bead-write");
  expect(reserveWire.data.operation).toBe("snooze-1h");
  const reserveResponse = await waitForRouteSignal(reserveResponsePromise);
  expect(reserveResponse.status()).toBe(200);
  const reserveEnvelope = z.object({
    ok: z.literal(true),
    data: z.object({ entry: inboxDispositionEntrySchema.nullable(), receipt: inboxDispositionReceiptSchema }).strict(),
    error: z.null(),
  }).strict().safeParse(await reserveResponse.json());
  expect(reserveEnvelope.success).toBe(true);
  if (!reserveEnvelope.success) throw Error("The exact reservation receipt was invalid.");
  expect(reserveEnvelope.data.data.receipt.phase).toBe("reserved");
  const applyResponse = await waitForRouteSignal(applyResponsePromise);
  expect(applyResponse.status()).toBe(504);
  expect(applyPosts).toBe(1);
  const applyWire = inboxDispositionOriginalSchema.strict().safeParse(applyBody);
  expect(applyWire.success).toBe(true);
  if (!applyWire.success) throw Error("The pre-effect apply body was invalid.");
  expect(applyWire.data).toEqual(reserveWire.data);
  await expect(inbox.getByText("Outcome unknown", { exact: true })).toBeVisible();
  expect(reserveRequestBodies).toHaveLength(1);
  expect(reserveRequestBodies[0]).toEqual(reserveWire.data);
  const heldStateBytes = readFileSync(dispositionStatePath);
  const heldState = inboxDispositionStoreSchema.strict().parse(JSON.parse(heldStateBytes.toString("utf8")));
  const heldReceipt = heldState.receipts.find((receipt) => receipt.original.requestId === reserveWire.data.requestId);
  expect(heldReceipt).toEqual(reserveEnvelope.data.data.receipt);
  expect(heldReceipt?.original).toEqual({ ...reserveWire.data, projectId: alpha.id });
  await expect(inbox.getByText("Checking this Inbox action…", { exact: true })).toHaveCount(0);
  await markInboxRecoveryPhase(page, "case2-post504-public-refresh");
  const post504Recovery = observeInitialRecovery(page, "case2-post504-public-refresh");
  const post504RecoveryResponse = page.waitForResponse((response) => isInitialGlobalRecovery(response.request()));
  const refreshInboxButton = inbox.getByRole("button", { name: "Refresh Inbox", exact: true });
  await refreshInboxButton.click();
  await waitForRouteSignal(post504RecoveryResponse);
  await expect(inbox.getByText("Refreshing saved Inbox dispositions…", { exact: true })).toHaveCount(0);
  await expect(inbox.getByRole("status", { name: "Loading Inbox sources", exact: true })).toHaveCount(0);
  await expect(inbox.getByText("Checking this Inbox action…", { exact: true })).toHaveCount(0);
  await expect(refreshInboxButton).toBeEnabled();
  await post504Recovery.qualify();
  post504Recovery.close();
  const recoveredOriginalRow = inbox.getByRole("region", { name: "Inbox action history", exact: true }).locator("article").filter({ hasText: reserveWire.data.requestId });
  await expect(recoveredOriginalRow.getByText("Server receipt: reserved", { exact: true })).toBeVisible();
  const heldActionButton = action.getByRole("button", { name: "Snooze 1 hour", exact: true });
  await expect(heldActionButton).toBeEnabled();
  await heldActionButton.click();
  const heldRefusal = inbox.getByRole("alert").filter({ hasText: "An unresolved Inbox original must be checked before another item can be acknowledged." });
  await expect(heldRefusal).toHaveText("An unresolved Inbox original must be checked before another item can be acknowledged. Source items remain visible.");
  expect(reserveRequestBodies).toHaveLength(1);
  expect(applyPosts).toBe(1);
  expect(readFileSync(dispositionStatePath).equals(heldStateBytes)).toBe(true);
  expect(inboxDispositionStoreSchema.strict().parse(JSON.parse(readFileSync(dispositionStatePath, "utf8"))).receipts.find((receipt) => receipt.original.requestId === reserveWire.data.requestId)).toEqual(heldReceipt);

  await page.reload();
  const reloadedInbox = page.getByRole("region", { name: "Inbox", exact: true });
  await expect(reloadedInbox.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
  const history = reloadedInbox.getByRole("region", { name: "Inbox action history", exact: true });
  const originalRow = history.locator("article").filter({ hasText: reserveWire.data.requestId });
  const originalRead = page.waitForResponse((response) =>
    response.request().method() === "GET" &&
    new URL(response.url()).pathname === "/__agent-forge/projects/" + alpha.id + "/inbox-dispositions/requests/" + reserveWire.data.requestId,
  );
  await originalRow.getByRole("button", { name: "Check exact original", exact: true }).click();
  const exactResponse = await waitForRouteSignal(originalRead);
  expect(exactResponse.status()).toBe(200);
  const exactEnvelope = z.object({
    ok: z.literal(true),
    data: z.object({ entry: inboxDispositionEntrySchema.nullable(), receipt: inboxDispositionReceiptSchema }).strict(),
    error: z.null(),
  }).strict().safeParse(await exactResponse.json());
  expect(exactEnvelope.success).toBe(true);
  if (!exactEnvelope.success) throw Error("The exact original read was invalid.");
  expect(exactEnvelope.data.data.receipt).toEqual(reserveEnvelope.data.data.receipt);
  expect(exactEnvelope.data.data.receipt.original).toEqual({ ...reserveWire.data, projectId: alpha.id });
  const discardPath = "/__agent-forge/projects/" + alpha.id + "/inbox-dispositions/requests/" + reserveWire.data.requestId + "/discard";
  const discardRequestPromise = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === discardPath);
  const discardResponsePromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === discardPath);
  await originalRow.getByRole("button", { name: "Discard checked reservation", exact: true }).click();
  const discardRequest = await waitForRouteSignal(discardRequestPromise);
  expect(discardRequest.postDataJSON()).toEqual(reserveWire.data);
  const discardResponse = await waitForRouteSignal(discardResponsePromise);
  expect(discardResponse.status()).toBe(200);
  const discardEnvelope = z.object({
    ok: z.literal(true),
    data: z.object({ entry: inboxDispositionEntrySchema.nullable(), receipt: inboxDispositionReceiptSchema }).strict(),
    error: z.null(),
  }).strict().safeParse(await discardResponse.json());
  expect(discardEnvelope.success).toBe(true);
  if (!discardEnvelope.success) throw Error("The discard receipt was invalid.");
  expect(discardEnvelope.data.data.receipt).toMatchObject({
    original: { ...reserveWire.data, projectId: alpha.id },
    phase: "refused",
    outcome: "refused",
    refusalCode: "discarded",
  });
  expect(applyPosts).toBe(1);
});

test("Inbox binds Gemini options to its exact offer and recovers a held original without resending", async ({
  page,
}) => {
  test.setTimeout(60_000);
  savedGeminiControl = existsSync(geminiControlPath)
    ? readFileSync(geminiControlPath)
    : null;
  geminiControlCaptured = true;
  writeFileSync(geminiControlPath, JSON.stringify({ mode: "permission-tree" }));
  await page.addInitScript(
    ({ key, projectId, workspace: root }) => {
      if (localStorage.getItem(key) === null)
        localStorage.setItem(key, JSON.stringify({ version: 1, entries: [{
          key: "beta-context-write", projectId, workspace: root, action: "comment",
          beadId: "beta-epic", title: "Beta context write", createdId: null,
          stage: "write", phase: "unknown", message: "Outcome unknown; check before repeating.",
        }] }));
    },
    { key: writeJournalKey, projectId: beta.id, workspace },
  );
  await ownRoute(page, "**/__agent-forge/smiths", async (route) => {
    const request = route.request();
    const response = await route.fetch({
      headers: {
        ...(await request.allHeaders()),
        Origin: new URL(request.url()).origin,
        "Sec-Fetch-Site": "same-origin",
      },
    });
    const parsed = z
      .object({
        ok: z.literal(true),
        data: z.record(z.string(), z.unknown()),
        error: z.null(),
      })
      .passthrough()
      .safeParse(await response.json());
    if (!parsed.success || !Array.isArray(parsed.data.data.smiths))
      throw Error("The protected fixture smith index was not verified.");
    const smiths = parsed.data.data.smiths.filter((item) => {
      const row = z.object({ name: z.string() }).passthrough().safeParse(item);
      return !row.success || row.data.name !== "gemini-example";
    });
    await route.fulfill({
      response,
      json: {
        ...parsed.data,
        data: {
          ...parsed.data.data,
          smiths: [
            ...smiths,
            {
              name: "gemini-example",
              provider: "gemini",
              model: "configured-example",
              effort: "default",
              enabled: true,
              tags: [],
            },
          ],
        },
      },
    });
  });
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/sessions`);
  await page.getByRole("button", { name: "New session", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "New session · Alpha",
    exact: true,
  });
  await dialog.getByRole("button", { name: /Gm · Gemini/ }).click();
  await dialog
    .getByRole("combobox", { name: "Session mode", exact: true })
    .selectOption("chat");
  await expect(
    dialog.getByRole("combobox", { name: "Session smith", exact: true }),
  ).toHaveValue("gemini-example");
  await dialog
    .getByRole("combobox", { name: "Where the session runs", exact: true })
    .selectOption("main");
  await dialog
    .getByRole("textbox", { name: "Session bead", exact: true })
    .fill("alpha-epic");
  await dialog
    .getByRole("textbox", { name: "Session prompt", exact: true })
    .fill("Inbox Gemini permission fixture");
  await dialog
    .getByRole("button", { name: "Check supported options", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  await expect
    .poll(
      () =>
        sessions().filter(
          (item) => !priorSessions.has(item.id) && item.provider === "gemini",
        ).length,
    )
    .toBe(1);
  const session = sessions().find(
    (item) => !priorSessions.has(item.id) && item.provider === "gemini",
  );
  if (!session)
    throw Error("The valid Gemini Inbox fixture session is absent.");
  const sessionConversation = page.getByRole("region", {
    name: "Session conversation",
    exact: true,
  });
  await expect(
    sessionConversation.getByRole("button", {
      name: "Allow once",
      exact: true,
    }),
  ).toBeVisible({ timeout: 10_000 });
  const savedConversationPath = join(
    HEARTH_HOME,
    "conversations",
    `${session.id}.json`,
  );
  await expect.poll(() => existsSync(savedConversationPath)).toBe(true);
  const savedGemini = savedSession(session.id);
  expect(savedGemini.projectId).toBe(session.projectId);
  expect(savedGemini.conversationId).toBe(session.id);
  expect(savedGemini.turns[0]?.requestId).toBe(session.requestId);
  const r1Frames = savedGemini.frames.filter(
    (frame) => frame.turnId === session.requestId,
  );
  const savedPermissionFrame = r1Frames.find(
    (frame) =>
      frame.event.kind === "coding-gemini-chat" &&
      frame.event.event.kind === "permission",
  );
  const savedOfferFrame = r1Frames.find(
    (frame) =>
      frame.event.kind === "coding-gemini-chat" &&
      frame.event.event.kind === "approval-offer",
  );
  const savedPermissionEvent = savedPermissionFrame?.event;
  const savedOfferEvent = savedOfferFrame?.event;
  if (
    savedPermissionFrame === undefined ||
    savedOfferFrame === undefined ||
    savedPermissionEvent?.kind !== "coding-gemini-chat" ||
    savedPermissionEvent.event.kind !== "permission" ||
    savedOfferEvent?.kind !== "coding-gemini-chat" ||
    savedOfferEvent.event.kind !== "approval-offer"
  )
    throw Error("The durable Gemini R1 permission offer pair is absent.");
  const savedPermission = savedPermissionEvent.event;
  const savedOffer = savedOfferEvent.event;
  if (
    savedPermission.requestId !== session.requestId ||
    savedOffer.requestId !== session.requestId ||
    savedPermissionFrame.seq >= savedOfferFrame.seq ||
    savedPermission.rpcId !== savedOffer.rpcId ||
    savedPermission.toolCallId !== savedOffer.toolCallId
  )
    throw Error("The durable Gemini R1 permission offer pair did not match.");
  const token = await pageToken(page);
  const setup = await page.evaluate(
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
      data: geminiChatApprovalPageSchema,
      error: z.null(),
    })
    .strict()
    .safeParse(setup.body);
  if (setup.status !== 200 || !setupEnvelope.success)
    throw Error("The protected Gemini setup read was not a valid 200 fixture.");
  const offer = setupEnvelope.data.data.pending.find(
    (item) =>
      item.turnRequestId === session.requestId &&
      item.approval.id === savedOffer.id,
  );
  if (!offer || offer.approval.options.length === 0)
    throw Error("The protected Gemini fixture had no exact offered option.");
  expect(offer.approval).toEqual({
    id: savedOffer.id,
    detail: savedPermission.detail,
    detailsComplete: savedPermission.detailsComplete,
    options: savedPermission.options,
  });

  const item = canonicalPermissionItem({
    provider: "gemini",
    projectId: alpha.id,
    sessionId: session.id,
    turnRequestId: session.requestId,
    offerId: offer.approval.id,
    approval: offer.approval,
  });
  const geminiLegacyStore = legacyPermissionStore({ projectId: alpha.id, item, operation: "snooze-1h", hold: true });
  seedPrivateDispositionStore(geminiLegacyStore);
  const geminiDoneReceipt = geminiLegacyStore.receipts.find((receipt) => receipt.phase === "applied");
  const geminiHeldReceipt = geminiLegacyStore.receipts.find((receipt) => receipt.phase === "reserved");
  expect(geminiDoneReceipt?.original).toMatchObject({ projectId: alpha.id, workspace, item, expectedRevision: 0, operation: "snooze-1h" });
  expect(geminiHeldReceipt?.original).toMatchObject({ projectId: alpha.id, workspace, item, expectedRevision: 1, operation: "snooze-1h" });
  if (!geminiHeldReceipt) throw Error("The canonical Gemini held receipt was absent.");
  let nativeDecisionPosts = 0;
  let permissionDispositionPosts = 0;
  const requests: Array<{ url: string; body: unknown }> = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname.endsWith("/approval-decisions")) {
      nativeDecisionPosts++;
      requests.push({ url: url.pathname, body: request.postDataJSON() });
    }
    if (request.method() === "POST" && url.pathname.includes("/inbox-dispositions"))
      permissionDispositionPosts++;
  });
  const identityBytesBefore = await page.evaluate(
    (key) => localStorage.getItem(key),
    GEMINI_CHAT_DECISION_IDENTITIES,
  );
  const approvalsPath = "/__agent-forge/projects/" + alpha.id + "/sessions/" + session.id + "/approvals";
  let captureChoicePreflight = false;
  let heldPreflightCount = 0;
  let heldRequest: Request | null = null;
  let markPreflightHeld: () => void = () => {};
  const preflightHeld = new Promise<void>((resolve) => { markPreflightHeld = resolve; });
  let releasePreflight: () => void = () => {};
  const preflightGate = new Promise<void>((resolve) => { releasePreflight = resolve; });
  releaseHeldInboxRoutes.push(releasePreflight);
  const trace = await openDecisionTrace(page, "gemini", approvalsPath);
  const choiceReplyPromise = page.waitForResponse((response) => response.request() === heldRequest);
  await ownRoute(page, "**/sessions/" + session.id + "/approvals", async (route) => {
    const url = new URL(route.request().url());
    if (captureChoicePreflight && route.request().method() === "GET" && url.pathname === approvalsPath && url.search === "") {
      captureChoicePreflight = false;
      heldPreflightCount++;
      heldRequest = route.request();
      markPreflightHeld();
      await preflightGate;
    }
    await route.continue();
  });
  let choiceWindowReads = 0;
  let choicePhaseActive = false;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (choicePhaseActive && request.method() === "GET" && url.pathname === approvalsPath && url.search === "") choiceWindowReads++;
  });
  const actualChoicePreflight = page.waitForRequest((request) => request.method() === "GET" && new URL(request.url()).pathname === approvalsPath && new URL(request.url()).search === "");
  invalidateHeldChoiceSession = leaveSessionsForCleanup;
  trace.begin();
  choicePhaseActive = true;
  captureChoicePreflight = true;
  await sessionConversation.getByRole("button", { name: "Allow once", exact: true }).click();
  const choiceRequest = await waitForRouteSignal(actualChoicePreflight);
  await waitForRouteSignal(preflightHeld);
  expect(heldPreflightCount).toBe(1);
  expect(heldRequest).toBe(choiceRequest);
  const nativePermissionsDuringChoice = page.getByRole("region", { name: "Native Gemini permissions", exact: true });
  await expect(nativePermissionsDuringChoice.getByRole("status").filter({ hasText: "Recording the original decision intent…" })).toBeVisible();
  await expect(nativePermissionsDuringChoice.getByRole("button", { name: "Allow once", exact: true })).toBeDisabled();
  trace.end();
  choicePhaseActive = false;
  trace.verify(choiceRequest, choiceWindowReads);
  await page
    .getByRole("navigation", { name: "Global", exact: true })
    .getByRole("link", { name: "Inbox", exact: true })
    .click();
  invalidateHeldChoiceSession = null;
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  await expect(inbox.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
  releasePreflight();
  const choiceReply = await waitForRouteSignal(choiceReplyPromise);
  expect(choiceReply.request()).toBe(choiceRequest);
  expect(await choiceReply.finished()).toBeNull();
  expect(choiceReply.status()).toBe(200);
  const choiceEnvelope = z.object({
    ok: z.literal(true),
    data: geminiChatApprovalPageSchema,
    error: z.null(),
  }).strict().safeParse(await choiceReply.json());
  expect(choiceEnvelope.success).toBe(true);
  if (!choiceEnvelope.success) throw Error("The held Gemini preflight reply was invalid.");
  expect(choiceEnvelope.data.data.pending).toEqual([offer]);
  expect(heldPreflightCount).toBe(1);
  const geminiCard = inbox.locator(".af-inbox-card").filter({
    has: page.getByRole("heading", { name: "Gemini permission", exact: true }),
  });
  await expect(geminiCard).toHaveCount(1);
  await expect(geminiCard.getByRole("button")).toHaveCount(0);
  await expect(geminiCard.getByRole("link", { name: "Open session", exact: true })).toHaveAttribute(
    "href",
    "#/desktop/project/" + encodeURIComponent(alpha.id) + "/sessions?selectionKind=session&selectionId=" + encodeURIComponent(session.id),
  );
  const geminiDisclosure = geminiCard.locator("details").filter({ hasText: "Review native permission details" });
  await expect(geminiDisclosure.locator("summary")).toBeVisible();
  await expect(geminiDisclosure).not.toHaveAttribute("open", "");
  const history = inbox.getByRole("region", { name: "Inbox action history", exact: true });
  const geminiHeldRow = history.locator("article").filter({ hasText: geminiHeldReceipt.original.requestId });
  await expect(geminiHeldRow.getByText("Server receipt: reserved", { exact: true })).toBeVisible();
  await expect(geminiHeldRow.getByRole("button")).toHaveCount(0);
  await expect(history.getByText("This original permission record remains retained and read-only.", { exact: true })).toBeVisible();
  await expect(history.getByRole("button")).toHaveCount(0);
  const needsYouCount = await inbox.locator(".af-inbox-queue .af-inbox-section-heading p").innerText();
  const bucket = inbox.getByRole("group", { name: "Inbox bucket", exact: true });
  await bucket.getByRole("button", { name: "Snoozed", exact: true }).click();
  await expect(geminiCard).toHaveCount(0);
  await bucket.getByRole("button", { name: "Needs you", exact: true }).click();
  await expect(geminiCard).toHaveCount(1);
  expect(await inbox.locator(".af-inbox-queue .af-inbox-section-heading p").innerText()).toBe(needsYouCount);
  expect(nativeDecisionPosts).toBe(0);
  expect(requests).toHaveLength(0);
  expect(permissionDispositionPosts).toBe(0);
  expect(
    await page.evaluate((key) => localStorage.getItem(key), GEMINI_CHAT_DECISION_IDENTITIES),
  ).toBe(identityBytesBefore);

  const staleReadPath = approvalsPath;
  let makeSourceStale = true;
  await ownRoute(page, "**/sessions/" + session.id + "/approvals", async (route) => {
    const url = new URL(route.request().url());
    if (makeSourceStale && route.request().method() === "GET" && url.pathname === staleReadPath && url.search === "") {
      makeSourceStale = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, data: null, error: "Fixture source temporarily unavailable." }),
      });
      return;
    }
    await route.continue();
  });
  const staleRead = page.waitForResponse((response) =>
    response.request().method() === "GET" && new URL(response.url()).pathname === staleReadPath && new URL(response.url()).search === "",
  );
  await markInboxRecoveryPhase(page, "gemini-explicit-refresh");
  await inbox.getByRole("button", { name: "Refresh Inbox", exact: true }).click();
  const staleResponse = await waitForRouteSignal(staleRead);
  await freezeInboxRecoveryWindow(page);
  expect(staleResponse.status()).toBe(503);
  await expect(geminiCard).toHaveCount(1);
  await expect(geminiCard.locator(".af-inbox-card-meta")).toContainText("Check required");
  await expect(geminiCard.getByRole("button")).toHaveCount(0);
  await expect(history.getByText("This original permission record remains retained and read-only.", { exact: true })).toBeVisible();
  expect(nativeDecisionPosts).toBe(0);
  expect(permissionDispositionPosts).toBe(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), GEMINI_CHAT_DECISION_IDENTITIES)).toBe(identityBytesBefore);
  await page.unroute("**/sessions/" + session.id + "/approvals");
  await ownRoute(page, "**/sessions/" + session.id + "/approvals", async (route) => {
    const response = await fetchProtected(route);
    let raw: unknown;
    try { raw = await response.json(); } catch { raw = null; }
    const current = z.object({ ok: z.literal(true), data: geminiChatApprovalPageSchema, error: z.null() }).strict().safeParse(raw);
    if (response.status() !== 200 || !current.success) throw Error("The incomplete-state fixture did not start from a strict current R1 response.");
    const sourceOffer = current.data.data.pending.find((item) => item.turnRequestId === session.requestId && item.approval.id === offer.approval.id);
    if (!sourceOffer) throw Error("The incomplete-state projection lost the exact R1 offer.");
    const incompleteOffer = { ...sourceOffer, approval: { ...sourceOffer.approval, detailsComplete: false, options: sourceOffer.approval.options.filter((option) => option.kind !== "allow_once") } };
    const projected = geminiChatApprovalPageSchema.safeParse({ pending: [incompleteOffer], receipt: null });
    if (!projected.success) throw Error("The incomplete-state projection was not a legal strict provider page.");
    await route.fulfill({ response, body: JSON.stringify({ ok: true, data: projected.data, error: null }) });
  });
  const incompleteRead = page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === approvalsPath && new URL(response.url()).search === "");
  await inbox.getByRole("button", { name: "Refresh Inbox", exact: true }).click();
  const incompleteReply = await waitForRouteSignal(incompleteRead);
  expect(incompleteReply.status()).toBe(200);
  const incompleteEnvelope = z.object({ ok: z.literal(true), data: geminiChatApprovalPageSchema, error: z.null() }).strict().safeParse(await incompleteReply.json());
  expect(incompleteEnvelope.success).toBe(true);
  if (!incompleteEnvelope.success) throw Error("The incomplete Gemini response did not match its strict protocol.");
  expect(incompleteEnvelope.data.data.pending).toEqual([{ ...offer, approval: { ...offer.approval, detailsComplete: false, options: offer.approval.options.filter((option) => option.kind !== "allow_once") } }]);
  await geminiDisclosure.locator("summary").click();
  await expect(geminiDisclosure).toHaveAttribute("open", "");
  await expect(geminiDisclosure.getByText("Complete details are unavailable. This permission item remains read-only.", { exact: true })).toBeVisible();
  await expect(geminiCard.getByRole("button")).toHaveCount(0);
  expect(nativeDecisionPosts).toBe(0);
  expect(permissionDispositionPosts).toBe(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), GEMINI_CHAT_DECISION_IDENTITIES)).toBe(identityBytesBefore);
  await geminiCard.getByRole("link", { name: "Open session", exact: true }).click();
  const returnedConversation = page.getByRole("region", { name: "Session conversation", exact: true });
  const nativePermissions = page.getByRole("region", { name: "Native Gemini permissions", exact: true });
  await expect(nativePermissions.getByRole("status").filter({ hasText: "Recording the original decision intent…" })).toHaveCount(0);
  const refreshNative = nativePermissions.getByRole("button", { name: "Refresh native permissions", exact: true });
  await expect(refreshNative).toBeEnabled();
  expect(nativeDecisionPosts).toBe(0);
  expect(permissionDispositionPosts).toBe(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), GEMINI_CHAT_DECISION_IDENTITIES)).toBe(identityBytesBefore);
  trace.detach();
  await page.unroute("**/sessions/" + session.id + "/approvals");
  const positiveRefresh = page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === approvalsPath && new URL(response.url()).search === "");
  await refreshNative.click();
  const positiveRead = await waitForRouteSignal(positiveRefresh);
  expect(positiveRead.status()).toBe(200);
  const positivePage = z.object({ ok: z.literal(true), data: geminiChatApprovalPageSchema, error: z.null() }).strict().safeParse(await positiveRead.json());
  expect(positivePage.success).toBe(true);
  if (!positivePage.success) throw Error("The separately refreshed Gemini original was invalid.");
  expect(positivePage.data.data.pending).toEqual([offer]);
  const allowOption = offer.approval.options.find((option) => option.kind === "allow_once");
  if (!allowOption) throw Error("The exact R1 offer has no allow_once option.");
  const nativeDecisionRequest = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/__agent-forge/projects/" + alpha.id + "/sessions/" + session.id + "/approval-decisions");
  const nativeDecision = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/__agent-forge/projects/" + alpha.id + "/sessions/" + session.id + "/approval-decisions");
  await returnedConversation.getByRole("button", { name: "Allow once", exact: true }).click();
  const actualDecisionRequest = await waitForRouteSignal(nativeDecisionRequest);
  const nativeWire = geminiChatDecisionRequestSchema.strict().safeParse(actualDecisionRequest.postDataJSON());
  expect(nativeWire.success).toBe(true);
  if (!nativeWire.success) throw Error("The positive Gemini request was invalid.");
  expect(nativeWire.data).toMatchObject({ turnRequestId: session.requestId, approvalId: offer.approval.id, optionId: allowOption.optionId });
  expect(nativeWire.data.requestId).not.toBe(session.requestId);
  expect(z.string().uuid().safeParse(nativeWire.data.requestId).success).toBe(true);
  const nativeReply = await waitForRouteSignal(nativeDecision);
  expect(nativeReply.request()).toBe(actualDecisionRequest);
  expect(nativeReply.status()).toBe(200);
  const nativeEnvelope = z.object({ ok: z.literal(true), data: geminiChatDecisionReceiptSchema, error: z.null() }).strict().safeParse(await nativeReply.json());
  expect(nativeEnvelope.success).toBe(true);
  if (!nativeEnvelope.success) throw Error("The positive Gemini receipt was invalid.");
  expect(nativeEnvelope.data.data).toEqual({ ...nativeWire.data, projectId: alpha.id, sessionId: session.id, state: "recorded", recordedAt: expect.any(String) });
  expect(nativeDecisionPosts).toBe(1);
  expect(requests[0]?.body).toEqual(nativeWire.data);
  expect(permissionDispositionPosts).toBe(0);
  // Consumer-only retained-identity fixture joined to the real R1 offer; it is not proof of native delivery.
  const heldIdentity = geminiChatDecisionRequestSchema.extend({ projectId: z.string(), sessionId: z.string() }).strict().parse({ ...nativeWire.data, requestId: randomUUID(), projectId: alpha.id, sessionId: session.id });
  const heldIdentityBytes = JSON.stringify({ version: 1, records: [heldIdentity] });
  await page.evaluate(({ key, bytes }) => localStorage.setItem(key, bytes), { key: GEMINI_CHAT_DECISION_IDENTITIES, bytes: heldIdentityBytes });
  expect(await page.evaluate((key) => localStorage.getItem(key), GEMINI_CHAT_DECISION_IDENTITIES)).toBe(heldIdentityBytes);
  await page.evaluate((hash) => { location.hash = hash; }, "/desktop/inbox?project=" + encodeURIComponent(alpha.id));
  const heldInbox = page.getByRole("region", { name: "Inbox", exact: true });
  await heldInbox.getByRole("button", { name: "Refresh Inbox", exact: true }).click();
  const heldCard = heldInbox.locator(".af-inbox-card").filter({ has: page.getByRole("heading", { name: "Original permission decision held", exact: true }) });
  await expect(heldCard).toHaveCount(1);
  await expect(heldCard.getByText("Original permission is held. No replacement decision will be sent.", { exact: true })).toBeVisible();
  await expect(heldCard.getByRole("button")).toHaveCount(0);
  await expect(heldCard.getByRole("link", { name: "Open session", exact: true })).toHaveAttribute("href", "#/desktop/project/" + encodeURIComponent(alpha.id) + "/sessions?selectionKind=session&selectionId=" + encodeURIComponent(session.id));
  const heldBucket = heldInbox.getByRole("group", { name: "Inbox bucket", exact: true });
  const heldCount = await heldInbox.locator(".af-inbox-queue .af-inbox-section-heading p").innerText();
  await heldBucket.getByRole("button", { name: "Snoozed", exact: true }).click();
  await expect(heldCard).toHaveCount(0);
  await heldBucket.getByRole("button", { name: "Needs you", exact: true }).click();
  await expect(heldCard).toHaveCount(1);
  expect(await heldInbox.locator(".af-inbox-queue .af-inbox-section-heading p").innerText()).toBe(heldCount);
  expect(await page.evaluate((key) => localStorage.getItem(key), GEMINI_CHAT_DECISION_IDENTITIES)).toBe(heldIdentityBytes);
  expect(nativeDecisionPosts).toBe(1);
  expect(permissionDispositionPosts).toBe(0);

});

test("Inbox resolves a real persisted apply after the page loses its reply", async ({ page }) => {
  await page.addInitScript(
    ({ key, entries }) => {
      if (localStorage.getItem(key) === null)
        localStorage.setItem(key, JSON.stringify({ version: 1, entries }));
    },
    {
      key: writeJournalKey,
      entries: [
        {
          key: "terminal-alpha-unknown",
          projectId: alpha.id,
          workspace,
          action: "comment",
          beadId: "alpha-epic",
          title: "Terminal Alpha unknown write",
          createdId: null,
          stage: "write",
          phase: "unknown",
          message: "Outcome unknown; check before repeating.",
        },
        {
          key: "terminal-beta-unknown",
          projectId: beta.id,
          workspace,
          action: "comment",
          beadId: "beta-epic",
          title: "Terminal Beta unknown write",
          createdId: null,
          stage: "write",
          phase: "unknown",
          message: "Outcome unknown; check before repeating.",
        },
      ],
    },
  );
  let alphaApplyPosts = 0;
  let betaPosts = 0;
  let alphaReservePosts = 0;
  type TerminalApplyCapture = { status: number; body: unknown; text: string; applyBody: unknown; headers: Record<string, string>; forwardedHeaders: Record<string, string> };
  const terminalCapture: { value: TerminalApplyCapture | null } = { value: null };
  let reserveBody: unknown = null;
  let markPersisted: () => void = () => {};
  const persisted = new Promise<void>((resolve, reject) => {
    markPersisted = resolve;
    rejectPendingTerminalRoute = reject;
  });
  void persisted.catch(() => {});
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/__agent-forge/projects/" + alpha.id + "/inbox-dispositions/requests") {
      alphaReservePosts++;
      reserveBody = request.postDataJSON();
    }
    if (request.method() === "POST" && url.pathname === "/__agent-forge/projects/" + alpha.id + "/inbox-dispositions")
      alphaApplyPosts++;
    if (request.method() === "POST" && url.pathname.startsWith("/__agent-forge/projects/" + beta.id + "/inbox-dispositions"))
      betaPosts++;
  });
  const applyPath = "/__agent-forge/projects/" + alpha.id + "/inbox-dispositions";
  await ownRoute(page, "**/projects/" + alpha.id + "/inbox-dispositions", async (route) => {
    if (route.request().method() !== "POST" || new URL(route.request().url()).pathname !== applyPath) return route.continue();
    const request = route.request();
    const url = new URL(request.url());
    const originalHeaders = await request.allHeaders();
    const forwardedHeaders = { ...originalHeaders, origin: url.origin, "sec-fetch-site": "same-origin" };
    const response = await route.fetch({ headers: forwardedHeaders });
    const text = await response.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = null; }
    const envelope = z.object({ ok: z.literal(true), data: z.object({ entry: inboxDispositionEntrySchema, receipt: inboxDispositionReceiptSchema }).strict(), error: z.null() }).strict().safeParse(body);
    const wire = inboxDispositionOriginalSchema.strict().safeParse(request.postDataJSON());
    if (response.status() !== 200 || !envelope.success || !wire.success || envelope.data.data.receipt.phase !== "applied" || JSON.stringify(envelope.data.data.receipt.original) !== JSON.stringify({ ...wire.data, projectId: alpha.id }))
      throw Error("The protected apply did not persist the exact paired terminal200 before reply loss.");
    expect(envelope.data.data.receipt).toMatchObject({ outcome: "applied", resultingValue: wire.data.operation, resultingRevision: wire.data.expectedRevision + 1 });
    expect(envelope.data.data.entry).toMatchObject({ projectId: alpha.id, workspace, item: wire.data.item, revision: wire.data.expectedRevision + 1, operation: wire.data.operation });
    const storedTerminal = inboxDispositionStoreSchema.strict().safeParse(JSON.parse(readFileSync(dispositionStatePath, "utf8")));
    if (!storedTerminal.success) throw Error("The private disposition file was not strictly persisted before reply loss.");
    expect(JSON.stringify(storedTerminal.data.receipts.find((receipt) => receipt.original.requestId === wire.data.requestId))).toBe(JSON.stringify(envelope.data.data.receipt));
    expect(JSON.stringify(storedTerminal.data.entries.find((entry) => entry.item.stableItemId === wire.data.item.stableItemId && entry.item.sourceRevision === wire.data.item.sourceRevision))).toBe(JSON.stringify(envelope.data.data.entry));
    terminalCapture.value = { status: response.status(), body, text, applyBody: request.postDataJSON(), headers: originalHeaders, forwardedHeaders };
    markPersisted();
    markExpectedRouteAbort(route.request());
    await route.abort();
  });
  const initialRecovery = observeInitialRecovery(page, "case4-initial-navigation");
  await openSettled(page, "/index.html#/desktop/inbox?project=" + encodeURIComponent(beta.id));
  await initialRecovery.qualify(); initialRecovery.close();
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  const alphaProject = inbox.locator('.af-inbox-project[aria-label="Alpha"]');
  const betaProject = inbox.locator('.af-inbox-project[aria-label="Beta"]');
  const alphaCard = alphaProject.locator(".af-inbox-card").filter({
    has: page.getByRole("heading", { name: "Review comment outcome", exact: true }),
  });
  const betaCard = betaProject.locator(".af-inbox-card").filter({
    has: page.getByRole("heading", { name: "Review comment outcome", exact: true }),
  });
  const reservePromise = page.waitForRequest((request) =>
    request.method() === "POST" && new URL(request.url()).pathname === "/__agent-forge/projects/" + alpha.id + "/inbox-dispositions/requests",
  );
  const reserveReplyPromise = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/__agent-forge/projects/" + alpha.id + "/inbox-dispositions/requests",
  );
  const applyPromise = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === applyPath);
  const lostApplyReplyPromise = page.waitForEvent("requestfailed", (request) => request.method() === "POST" && new URL(request.url()).pathname === applyPath);
  await alphaCard.getByRole("button", { name: "Snooze 1 hour", exact: true }).click();
  const reserveRequest = await waitForRouteSignal(reservePromise);
  reserveBody = reserveRequest.postDataJSON();
  const reserveWire = inboxDispositionOriginalSchema.strict().safeParse(reserveBody);
  expect(reserveWire.success).toBe(true);
  if (!reserveWire.success) throw Error("The real terminal reserve body was invalid.");
  expect(reserveWire.data.item.sourceKind).toBe("unknown-bead-write");
  expect(reserveWire.data.operation).toBe("snooze-1h");
  const reserveReply = await waitForRouteSignal(reserveReplyPromise);
  expect(reserveReply.status()).toBe(200);
  const reserveEnvelope = z.object({
    ok: z.literal(true),
    data: z.object({ entry: inboxDispositionEntrySchema.nullable(), receipt: inboxDispositionReceiptSchema }).strict(),
    error: z.null(),
  }).strict().safeParse(await reserveReply.json());
  expect(reserveEnvelope.success).toBe(true);
  if (!reserveEnvelope.success) throw Error("The real terminal reservation receipt was invalid.");
  const applyRequest = await waitForRouteSignal(applyPromise);
  expect(applyRequest.postDataJSON()).toEqual(reserveRequest.postDataJSON());
  await waitForRouteSignal(persisted);
  const lostApplyReply = await waitForRouteSignal(lostApplyReplyPromise);
  expect(lostApplyReply).toBe(applyRequest);
  expect(observedExpectedRouteAborts.has(lostApplyReply)).toBe(true);
  rejectPendingTerminalRoute = null;
  const settled = terminalCapture.value;
  if (!settled) throw Error("The original apply did not reach the protected endpoint.");
  expect(settled.status).toBe(200);
  expect(settled.headers.origin).toBe(new URL(applyRequest.url()).origin);
  if (settled.headers["sec-fetch-site"] !== undefined) expect(settled.headers["sec-fetch-site"]).toBe("same-origin");
  expect(settled.forwardedHeaders["sec-fetch-site"]).toBe("same-origin");
  const terminalEnvelope = z.object({
    ok: z.literal(true),
    data: z.object({ entry: inboxDispositionEntrySchema, receipt: inboxDispositionReceiptSchema }).strict(),
    error: z.null(),
  }).strict().safeParse(settled.body);
  expect(terminalEnvelope.success).toBe(true);
  if (!terminalEnvelope.success) throw Error("The actual terminal receipt was invalid.");
  expect(terminalEnvelope.data.data.receipt.phase).toBe("applied");
  expect(terminalEnvelope.data.data.receipt.original).toEqual({ ...reserveWire.data, projectId: alpha.id });
  expect(terminalEnvelope.data.data.entry).toMatchObject({
    projectId: alpha.id,
    workspace,
    item: reserveWire.data.item,
    revision: reserveWire.data.expectedRevision + 1,
    operation: "snooze-1h",
  });
  expect(terminalEnvelope.data.data.receipt).toMatchObject({
    outcome: "applied",
    resultingValue: "snooze-1h",
    resultingRevision: reserveWire.data.expectedRevision + 1,
  });
  expect(settled.text).toContain('"phase":"applied"');
  expect(alphaApplyPosts).toBe(1);
  expect(betaPosts).toBe(0);
  const alphaNotice = inbox.locator(".af-inbox-notice").filter({ has: page.getByRole("heading", { name: "Terminal Alpha unknown write", exact: true }) });
  const betaNotice = inbox.locator(".af-inbox-notice").filter({ has: page.getByRole("heading", { name: "Terminal Beta unknown write", exact: true }) });
  const sourceJournalBytes = await page.evaluate((key) => localStorage.getItem(key), writeJournalKey);
  const strictSourceJournal = writeJournalSchema.safeParse(sourceJournalBytes ? JSON.parse(sourceJournalBytes) : null);
  expect(strictSourceJournal.success).toBe(true);
  if (!strictSourceJournal.success) throw Error("The terminal unknown-write journal was invalid.");
  await expect(alphaNotice.getByText("Outcome unknown", { exact: true })).toBeVisible();
  await expect(betaNotice.getByText("Outcome unknown", { exact: true })).toBeVisible();
  await expect(alphaCard.getByRole("button", { name: "Mark done · source unresolved", exact: true })).toBeDisabled();
  await expect(betaCard.getByRole("button", { name: "Mark done · source unresolved", exact: true })).toBeDisabled();
  const recoveryPath = "/__agent-forge/inbox-dispositions/recovery";
  type AuthorityCapture = { request: Request; response: Awaited<ReturnType<typeof fetchProtected>>; data: unknown };
  let releaseInitialRecovery: () => void = () => {};
  let releaseCallbackRecovery: () => void = () => {};
  let markRecoveryHeld: () => void = () => {};
  const initialRecoveryGate = new Promise<void>((resolve) => { releaseInitialRecovery = resolve; });
  const callbackRecoveryGate = new Promise<void>((resolve) => { releaseCallbackRecovery = resolve; });
  const recoveryHeld = new Promise<void>((resolve) => { markRecoveryHeld = resolve; });
  releaseHeldInboxRoutes.push(() => { releaseInitialRecovery(); releaseCallbackRecovery(); });
  const rootInventoryCaptures: Array<AuthorityCapture | null> = [null, null];
  let recoveryReadsWhileHeld = 0;
  let markCallbackRecoveryHeld: () => void = () => {};
  const callbackRecoveryHeld = new Promise<void>((resolve) => { markCallbackRecoveryHeld = resolve; });
  await ownRoute(page, "**/inbox-dispositions/recovery", async (route) => {
    const response = await fetchProtected(route);
    const raw = await response.json();
    const parsed = z.object({ ok: z.literal(true), data: inboxDispositionRecoverySchema, error: z.null() }).strict().safeParse(raw);
    if (response.status() !== 200 || !parsed.success) throw Error("The actual root inventory response was not strict current authority.");
    const ordinal = ++recoveryReadsWhileHeld;
    if (ordinal === 1) {
      rootInventoryCaptures[0] = { request: route.request(), response, data: parsed.data.data };
      markRecoveryHeld();
      await initialRecoveryGate;
    } else if (ordinal === 2) {
      rootInventoryCaptures[1] = { request: route.request(), response, data: parsed.data.data };
      markCallbackRecoveryHeld();
      await callbackRecoveryGate;
    }
    await route.fulfill({ response, body: JSON.stringify(raw) });
  });
  const betaCollectionPath = "/__agent-forge/projects/" + beta.id + "/inbox-dispositions";
  let releaseCollection: () => void = () => {};
  let markCollectionHeld: () => void = () => {};
  const collectionGate = new Promise<void>((resolve) => { releaseCollection = resolve; });
  const collectionHeld = new Promise<void>((resolve) => { markCollectionHeld = resolve; });
  releaseHeldInboxRoutes.push(releaseCollection);
  let betaCollectionReads = 0;
  const betaCollectionCapture: { value: AuthorityCapture | null } = { value: null };
  await ownRoute(page, "**/projects/" + beta.id + "/inbox-dispositions", async (route) => {
    if (route.request().method() !== "GET" || new URL(route.request().url()).pathname !== betaCollectionPath) return route.continue();
    const response = await fetchProtected(route);
    const raw = await response.json();
    const parsed = z.object({ ok: z.literal(true), data: z.object({ entries: z.array(inboxDispositionEntrySchema), receipts: z.array(inboxDispositionReceiptSchema) }).strict(), error: z.null() }).strict().safeParse(raw);
    if (response.status() !== 200 || !parsed.success) throw Error("The actual scoped collection was not strict current authority.");
    betaCollectionReads++;
    if (betaCollectionReads === 1) {
      betaCollectionCapture.value = { request: route.request(), response, data: parsed.data.data };
      markCollectionHeld();
      await collectionGate;
    }
    await route.fulfill({ response, body: JSON.stringify(raw) });
  });
  const betaCollectionResponse = page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === betaCollectionPath);
  const betaReservePromise = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/__agent-forge/projects/" + beta.id + "/inbox-dispositions/requests");
  const betaReserveResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/__agent-forge/projects/" + beta.id + "/inbox-dispositions/requests");
  const betaApplyPromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/__agent-forge/projects/" + beta.id + "/inbox-dispositions");
  const recoveryResponse = page.waitForResponse((response) => response.request() === rootInventoryCaptures[0]?.request);
  const callbackRecoveryResponse = page.waitForResponse((response) => response.request() === rootInventoryCaptures[1]?.request);
  await page.reload();
  const reloadedInbox = page.getByRole("region", { name: "Inbox", exact: true });
  await expect(reloadedInbox.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
  await waitForRouteSignal(recoveryHeld);
  const pendingBeta = reloadedInbox.locator('.af-inbox-project[aria-label="Beta"] .af-inbox-card').filter({ has: page.getByRole("heading", { name: "Review comment outcome", exact: true }) });
  expect(alphaApplyPosts).toBe(1);
  expect(alphaReservePosts).toBe(1);
  expect(betaPosts).toBe(0);
  const sameIntentBetaAction = pendingBeta.getByRole("button", { name: "Snooze 1 hour", exact: true });
  await expect(sameIntentBetaAction).toBeEnabled();
  await sameIntentBetaAction.click();
  await expect(reloadedInbox.getByRole("status").filter({ hasText: "Checking this Inbox action…" })).toBeVisible();
  await waitForRouteSignal(callbackRecoveryHeld);
  await expect(sameIntentBetaAction).toBeDisabled();
  expect(alphaApplyPosts).toBe(1);
  expect(alphaReservePosts).toBe(1);
  expect(betaPosts).toBe(0);
  const initialRootCapture = rootInventoryCaptures[0];
  const callbackRootCapture = rootInventoryCaptures[1];
  if (!initialRootCapture || !callbackRootCapture) throw Error("The two initial current root responses were not captured.");
  expect(recoveryReadsWhileHeld).toBe(2);
  for (const capture of [initialRootCapture, callbackRootCapture]) {
    expect(capture.request.method()).toBe("GET");
    expect(new URL(capture.request.url()).pathname).toBe(recoveryPath);
    expect(capture.response.status()).toBe(200);
  }
  const rootInventoryProofBytes = [JSON.stringify(initialRootCapture.data), JSON.stringify(callbackRootCapture.data)];
  expect(rootInventoryProofBytes[1]).toBe(rootInventoryProofBytes[0]);
  for (const capture of [initialRootCapture, callbackRootCapture]) {
    const inventory = inboxDispositionRecoverySchema.strict().safeParse(capture.data);
    expect(inventory.success).toBe(true);
    if (!inventory.success) throw Error("A frozen global inventory did not match the strict recovery schema.");
    const alphaReceipts = inventory.data.receipts.filter((receipt) => receipt.original.requestId === reserveWire.data.requestId);
    expect(alphaReceipts).toHaveLength(1);
    expect(alphaReceipts[0]).toEqual(terminalEnvelope.data.data.receipt);
  }
  expect(alphaApplyPosts).toBe(1);
  expect(alphaReservePosts).toBe(1);
  expect(betaPosts).toBe(0);
  releaseInitialRecovery();
  releaseCallbackRecovery();
  await waitForRouteSignal(collectionHeld);
  expect(betaCollectionReads).toBe(1);
  const heldBetaCollection = betaCollectionCapture.value;
  if (!heldBetaCollection) throw Error("The actual Beta callback collection response was not captured.");
  expect(heldBetaCollection.request.method()).toBe("GET");
  expect(heldBetaCollection.request.url()).toContain(betaCollectionPath);
  expect(new URL(heldBetaCollection.request.url()).pathname).toBe(betaCollectionPath);
  expect(heldBetaCollection.response.status()).toBe(200);
  const betaCollectionProofBytes = JSON.stringify(heldBetaCollection.data);
  expect(alphaApplyPosts).toBe(1);
  expect(alphaReservePosts).toBe(1);
  expect(betaPosts).toBe(0);
  releaseCollection();
  const betaCollectionReply = await waitForRouteSignal(betaCollectionResponse);
  expect(betaCollectionReply.request()).toBe(heldBetaCollection.request);
  expect(betaCollectionReply.status()).toBe(200);
  expect(await betaCollectionReply.finished()).toBeNull();
  const betaCollectionEnvelope = z.object({ ok: z.literal(true), data: z.object({ entries: z.array(inboxDispositionEntrySchema), receipts: z.array(inboxDispositionReceiptSchema) }).strict(), error: z.null() }).strict().safeParse(await betaCollectionReply.json());
  expect(betaCollectionEnvelope.success).toBe(true);
  if (!betaCollectionEnvelope.success) throw Error("The actual Beta scoped collection was invalid.");
  expect(JSON.stringify(betaCollectionEnvelope.data.data)).toBe(betaCollectionProofBytes);
  const recoveryReply = await waitForRouteSignal(recoveryResponse);
  expect(recoveryReply.request()).toBe(initialRootCapture.request);
  expect(recoveryReply.status()).toBe(200);
  expect(await recoveryReply.finished()).toBeNull();
  const rootEnvelope = z.object({ ok: z.literal(true), data: inboxDispositionRecoverySchema, error: z.null() }).strict().safeParse(await recoveryReply.json());
  expect(rootEnvelope.success).toBe(true);
  if (!rootEnvelope.success) throw Error("The actual root inventory did not parse.");
  expect(JSON.stringify(rootEnvelope.data.data)).toBe(rootInventoryProofBytes[0]);
  const callbackRecoveryReply = await waitForRouteSignal(callbackRecoveryResponse);
  expect(callbackRecoveryReply.request()).toBe(callbackRootCapture.request);
  expect(callbackRecoveryReply.status()).toBe(200);
  expect(await callbackRecoveryReply.finished()).toBeNull();
  const callbackRootEnvelope = z.object({ ok: z.literal(true), data: inboxDispositionRecoverySchema, error: z.null() }).strict().safeParse(await callbackRecoveryReply.json());
  expect(callbackRootEnvelope.success).toBe(true);
  if (!callbackRootEnvelope.success) throw Error("The actual callback root inventory did not parse.");
  expect(JSON.stringify(callbackRootEnvelope.data.data)).toBe(rootInventoryProofBytes[1]);
  expect(alphaApplyPosts).toBe(1);
  expect(alphaReservePosts).toBe(1);
  const betaReserve = await waitForRouteSignal(betaReservePromise);
  const betaWire = inboxDispositionOriginalSchema.strict().safeParse(betaReserve.postDataJSON());
  expect(betaWire.success).toBe(true);
  if (!betaWire.success) throw Error("The same-intent Beta original was invalid.");
  expect(betaWire.data.item.sourceKind).toBe("unknown-bead-write");
  expect(new URL(betaReserve.url()).pathname).toBe("/__agent-forge/projects/" + beta.id + "/inbox-dispositions/requests");
  expect(betaWire.data.workspace).toBe(workspace);
  expect(betaWire.data.operation).toBe("snooze-1h");
  expect(z.string().uuid().safeParse(betaWire.data.requestId).success).toBe(true);
  expect(betaWire.data.requestId).not.toBe(reserveWire.data.requestId);
  const betaReserveReply = await waitForRouteSignal(betaReserveResponse);
  expect(betaReserveReply.request()).toBe(betaReserve);
  expect(betaReserveReply.status()).toBe(200);
  const betaReservedEnvelope = z.object({ ok: z.literal(true), data: z.object({ entry: inboxDispositionEntrySchema.nullable(), receipt: inboxDispositionReceiptSchema }).strict(), error: z.null() }).strict().safeParse(await betaReserveReply.json());
  expect(betaReservedEnvelope.success).toBe(true);
  if (!betaReservedEnvelope.success) throw Error("The same-intent Beta reservation receipt was invalid.");
  expect(betaReservedEnvelope.data.data.receipt.phase).toBe("reserved");
  expect(betaReservedEnvelope.data.data.receipt.original).toEqual({ ...betaWire.data, projectId: beta.id });
  const betaApply = await waitForRouteSignal(betaApplyPromise);
  expect(new URL(betaApply.url()).pathname).toBe("/__agent-forge/projects/" + beta.id + "/inbox-dispositions");
  expect(betaApply.status()).toBe(200);
  await expect(reloadedInbox.getByRole("status").filter({ hasText: "Checking this Inbox action…" })).toHaveCount(0);
  expect(betaApply.request().postDataJSON()).toEqual(betaReserve.postDataJSON());
  const betaApplyEnvelope = z.object({ ok: z.literal(true), data: z.object({ entry: inboxDispositionEntrySchema, receipt: inboxDispositionReceiptSchema }).strict(), error: z.null() }).strict().safeParse(await betaApply.json());
  expect(betaApplyEnvelope.success).toBe(true);
  if (!betaApplyEnvelope.success) throw Error("The same-intent Beta terminal receipt was invalid.");
  expect(betaApplyEnvelope.data.data.receipt).toMatchObject({ outcome: "applied", resultingValue: betaWire.data.operation, resultingRevision: betaWire.data.expectedRevision + 1 });
  expect(betaApplyEnvelope.data.data.receipt.phase).toBe("applied");
  expect(betaApplyEnvelope.data.data.receipt.original).toEqual({ ...betaWire.data, projectId: beta.id });
  expect(betaApplyEnvelope.data.data.entry).toMatchObject({ projectId: beta.id, workspace, item: betaWire.data.item, revision: betaWire.data.expectedRevision + 1, operation: betaWire.data.operation });
  expect(betaPosts).toBe(2);
  expect(alphaApplyPosts).toBe(1);
  expect(alphaReservePosts).toBe(1);
  const alphaCollectionResponse = page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === "/__agent-forge/projects/" + alpha.id + "/inbox-dispositions");
  await page.evaluate((hash) => { location.hash = hash; }, "/desktop/inbox?project=" + encodeURIComponent(alpha.id));
  const alphaInbox = page.getByRole("region", { name: "Inbox", exact: true });
  await expect(alphaInbox.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
  await alphaInbox.getByRole("button", { name: "Refresh Inbox", exact: true }).click();
  const alphaCollectionReply = await waitForRouteSignal(alphaCollectionResponse);
  expect(alphaCollectionReply.request().method()).toBe("GET");
  expect(alphaCollectionReply.status()).toBe(200);
  const collectionEnvelope = z.object({ ok: z.literal(true), data: z.object({ entries: z.array(inboxDispositionEntrySchema), receipts: z.array(inboxDispositionReceiptSchema) }).strict(), error: z.null() }).strict().safeParse(await alphaCollectionReply.json());
  expect(collectionEnvelope.success).toBe(true);
  if (!collectionEnvelope.success) throw Error("The exact Alpha collection read was invalid.");
  const persistedEntry = collectionEnvelope.data.data.entries.find((entry) => entry.item.stableItemId === reserveWire.data.item.stableItemId && entry.item.sourceRevision === reserveWire.data.item.sourceRevision);
  expect(persistedEntry).toBeDefined();
  if (!persistedEntry) throw Error("The Alpha collection omitted the applied entry.");
  expect(JSON.stringify(persistedEntry)).toBe(JSON.stringify(terminalEnvelope.data.data.entry));
  expect(JSON.stringify(collectionEnvelope.data.data.receipts.find((receipt) => receipt.original.requestId === reserveWire.data.requestId))).toBe(JSON.stringify(terminalEnvelope.data.data.receipt));
  expect(await page.evaluate((key) => localStorage.getItem(key), writeJournalKey)).toBe(sourceJournalBytes);
  expect(alphaApplyPosts).toBe(1);
  expect(alphaReservePosts).toBe(1);
  expect(betaPosts).toBe(2);

  await expect(alphaNotice.getByText("Outcome unknown", { exact: true })).toBeVisible();
  await expect(betaNotice.getByText("Outcome unknown", { exact: true })).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), writeJournalKey)).toBe(sourceJournalBytes);
});
