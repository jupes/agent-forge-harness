import { existsSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { expect, type Page, type Route, test } from "@playwright/test";
import { SESSION_START_IDENTITIES } from "../../apps/desktop/src/session-start-identities";
import {
  OPERATOR_HEADER,
  SESSION_KEY_STORAGE,
  SESSION_ROUTE,
} from "../../scripts/hearth/paths";
import { ownedCodingStateSchema } from "../../scripts/sessions/codex-owned-journal";
import { ownedCodingSessionSchema } from "../../scripts/sessions/codex-owned-wire-protocol";
import {
  codexChatForkIdentityMetadataSchema,
  sessionOperationIdentityPageSchema,
} from "../../scripts/sessions/session-operation-identities-protocol";
import { pageToken } from "../e2e/launch-link";
import { HEARTH_HOME } from "../e2e/servers";
import { alpha } from "./environment";

const FORK_RESTART_PATH = "/__desktop-restart-fixture/restart-host-fork";
const CONTROL_HEADER = "x-agent-forge-fixture-secret";
const INITIAL_STORAGE_KEY = "__fork_restart_initial_storage__";

type SessionRow = ReturnType<typeof ownedCodingSessionSchema.parse>;
type FixtureCall = {
  kind: string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
};

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
  return readFileSync(path, "utf8")
    .split("\n")
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
    }));
}

function rpcCount(method: string): number {
  return calls().filter((row) => row.kind === "rpc" && row.method === method)
    .length;
}

async function openNewSession(page: Page, url: string): Promise<SessionRow> {
  if (
    page.url() === "about:blank" ||
    new URL(page.url()).origin !== new URL(url).origin
  )
    await page.goto(url);
  await page.getByRole("button", { name: "New session", exact: true }).click();
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
  await dialog
    .getByRole("button", { name: "Check supported options", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
  const before = new Set(rows().map((item) => item.id));
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
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
  await expect(pane).toContainText("Hello world");
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
  return origin;
}

async function selectSession(page: Page, origin: string, sessionId: string) {
  await page.evaluate(
    (hash) => {
      window.location.hash = hash;
    },
    `#/desktop/project/${alpha.id}/sessions?selectionKind=session&selectionId=${encodeURIComponent(sessionId)}`,
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
      path: `/__agent-forge/projects/${alpha.id}/session-operation-identities`,
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
      path: `/__agent-forge/projects/${alpha.id}/codex-chat-forks/${encodeURIComponent(requestId)}`,
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
    const headers = await route.request().allHeaders();
    const origin = new URL(route.request().url()).origin;
    const response = await route.fetch({
      headers: { ...headers, Origin: origin, "Sec-Fetch-Site": "same-origin" },
    });
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
  await page.route((url) => matcher(url), handler);
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
      await page.unroute((url) => matcher(url), handler);
    },
  };
}

async function operationRows(page: Page, origin: string) {
  return (await readIdentityPage(page, origin)).operations.filter(
    (item) => item.family === "codex-chat-fork",
  );
}

test("two actual host replacements recover the exact Fork original before and after native effect", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const startWrites: string[] = [];
  const identityWrites: string[] = [];
  const forkBodies: Array<{ path: string; body: unknown }> = [];
  const forksBefore = rpcCount("thread/fork");
  const startsBefore = rpcCount("thread/start");
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const url = new URL(request.url());
    if (url.pathname === `/__agent-forge/projects/${alpha.id}/sessions`)
      startWrites.push(url.pathname);
    if (
      url.pathname.startsWith(
        `/__agent-forge/projects/${alpha.id}/sessions/`,
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
  let beforeFirstReplacement = { starts: 0, writes: 0, forks: 0 };

  const firstParent = await openNewSession(page, currentUrl);
  let first = await createCompletedSourceTurn(page, firstParent, "A");
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
    beforeFirstReplacement = {
      starts: startWrites.length,
      writes: identityWrites.length,
      forks: rpcCount("thread/fork"),
    };
    const firstRestart = await issueRestart();
    currentUrl = firstRestart.url;
    currentOrigin = await authenticateNewHost(page, currentUrl, 1);
  } finally {
    await firstReservation.release();
  }
  await selectSession(page, currentOrigin, first.parent.id);
  expect(startWrites).toHaveLength(beforeFirstReplacement.starts);
  expect(identityWrites).toHaveLength(beforeFirstReplacement.writes);
  expect(rpcCount("thread/fork")).toBe(beforeFirstReplacement.forks);
  const firstPage = await readIdentityPage(page, currentOrigin);
  expect(firstPage.scope).toEqual({
    projectId: alpha.id,
    workspace: alpha.workspaces[0]?.root,
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
  const firstLinkedResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "POST" &&
      url.pathname.endsWith(`/sessions/${first.parent.id}/forks`)
    );
  });
  await reviewA
    .getByRole("button", {
      name: "Create the native child thread once",
      exact: true,
    })
    .click();
  const firstLinkedHttp = await firstLinkedResponse;
  expect(firstLinkedHttp.status()).toBe(200);
  const firstLinkedEnvelope = record(
    parseJson(await firstLinkedHttp.text(), "linked Fork response"),
  );
  if (firstLinkedEnvelope?.["ok"] !== true)
    throw new Error("The first native Fork response was invalid.");
  const firstLinked = codexChatForkIdentityMetadataSchema.parse(
    firstLinkedEnvelope["data"],
  );
  expect(firstLinked).toMatchObject({
    requestId: firstReservation.metadata()!.requestId,
    requestHash: firstReservation.metadata()!.requestHash,
    parentSessionId: first.parent.id,
    throughTurnRequestId: first.turnId,
    state: "linked",
  });
  await expect.poll(() => rpcCount("thread/fork")).toBe(forksBefore + 1);
  expect(forkBodies).toHaveLength(2);
  expect(forkBodies[0]?.body).toEqual(forkBodies[1]?.body);
  expect(forkBodies[0]?.body).toMatchObject({
    requestId: firstIdentityBefore[0]?.requestId,
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

  const secondParent = await openNewSession(page, currentUrl);
  const second = await createCompletedSourceTurn(page, secondParent, "B");
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
    await expect.poll(() => rpcCount("thread/fork")).toBe(forksBefore + 2);
    beforeSecondReplacement = {
      forks: rpcCount("thread/fork"),
      starts: startWrites.length,
      writes: identityWrites.length,
    };
    const secondRestart = await issueRestart();
    currentUrl = secondRestart.url;
    currentOrigin = await authenticateNewHost(page, currentUrl, 2);
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
  for (const identity of [firstLinked, secondReservation.metadata()])
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
  const recoveredSecond = await readForkOriginal(
    page,
    currentOrigin,
    secondReservation.metadata()!.requestId,
  );
  expect((await readIdentityPage(page, currentOrigin)).scope).toEqual({
    projectId: alpha.id,
    workspace: alpha.workspaces[0]?.root,
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
  expect(forkBodies).toHaveLength(4);
  expect(forkBodies[2]?.body).toEqual(forkBodies[3]?.body);
  expect(forkBodies[2]?.body).toMatchObject({
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
