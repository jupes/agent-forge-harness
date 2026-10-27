import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { expect, type Page, test } from "@playwright/test";
import { SMITH_CREATE_IDENTITIES } from "../../apps/desktop/src/smith-create-identities";
import {
  canonicalSmithConfigCreateRequest,
  smithConfigCreateReceiptSchema,
  smithConfigCreateRequestSchema,
  smithCreateIdentityIndexSchema,
} from "../../scripts/config/smith-create-protocol";
import { tokenPath } from "../../scripts/hearth/home";
import { ensurePrivateHome } from "../../scripts/hearth/home-guard";
import { OPERATOR_HEADER, SESSION_ROUTE } from "../../scripts/hearth/paths";
import { readToken } from "../../scripts/hearth/token";
import { resolveCheckout } from "../../scripts/ledger/workspace";
import { workspaceKey } from "../../scripts/projects/scope";
import { projectCatalogFixture } from "../../scripts/projects/testing";
import type { SmithConfigCreateReceipt } from "../../types/smith-config-create";
import { bunPath, HEARTH_HOME } from "../e2e/servers";
import { ASSETS, fixtureEnvironment, ROOT } from "./environment";

type FixtureReply =
  | {
      ok: true;
      data: { helperPid: number; owner: string; url: string };
      error: null;
    }
  | { ok: true; data: { closed: true; helperPid: number }; error: null };

type HostFact = { dashboardPort: number; hearthPid: number };

async function trustedHostPid(page: Page): Promise<number> {
  const health: unknown = await page.evaluate(async () => {
    const response = await fetch("/__agent-forge/health");
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new Error("The isolated hearth health response was not JSON.");
    }
    if (
      !response.ok ||
      !value ||
      typeof value !== "object" ||
      !("ok" in value) ||
      value.ok !== true ||
      !("data" in value) ||
      !value.data ||
      typeof value.data !== "object" ||
      !("pid" in value.data) ||
      typeof value.data.pid !== "number" ||
      !Number.isSafeInteger(value.data.pid) ||
      value.data.pid <= 0 ||
      !("root" in value.data) ||
      typeof value.data.root !== "string"
    )
      throw new Error("The isolated hearth health identity was invalid.");
    return { pid: value.data.pid, root: value.data.root };
  });
  if (
    !health ||
    typeof health !== "object" ||
    !("pid" in health) ||
    typeof health.pid !== "number" ||
    !("root" in health) ||
    typeof health.root !== "string" ||
    workspaceKey(health.root) !== workspaceKey(resolveCheckout(ROOT).workspace)
  )
    throw new Error(
      "The host health identity did not match the served checkout.",
    );
  return health.pid;
}

function publishHostProof(
  hearthPort: number,
  fixtureHelperPid: number,
  hosts: HostFact[],
): void {
  if (hosts.length !== 3)
    throw new Error(
      "The origin replacement proof requires exactly three hosts.",
    );
  const path = join(HEARTH_HOME, "smith-origin-replacement-proof.json");
  if (existsSync(path))
    throw new Error("A prior Smith origin replacement proof is still present.");
  writeFileSync(
    path,
    `${JSON.stringify({ version: 1, hearthPort, fixtureHelperPid, hosts })}\n`,
    { mode: 0o600, flag: "wx" },
  );
}

function replyShape(value: unknown): FixtureReply {
  if (
    !value ||
    typeof value !== "object" ||
    !("ok" in value) ||
    value.ok !== true ||
    !("data" in value) ||
    !value.data ||
    typeof value.data !== "object" ||
    !("error" in value) ||
    value.error !== null
  )
    throw new Error("The owned Smith origin host returned an invalid reply.");
  if (
    "url" in value.data &&
    typeof value.data.url === "string" &&
    "owner" in value.data &&
    typeof value.data.owner === "string" &&
    "helperPid" in value.data &&
    typeof value.data.helperPid === "number" &&
    Number.isSafeInteger(value.data.helperPid) &&
    value.data.helperPid > 0
  )
    return value as FixtureReply;
  if (
    "closed" in value.data &&
    value.data.closed === true &&
    "helperPid" in value.data &&
    typeof value.data.helperPid === "number" &&
    Number.isSafeInteger(value.data.helperPid) &&
    value.data.helperPid > 0
  )
    return value as FixtureReply;
  throw new Error("The owned Smith origin host returned an invalid reply.");
}

function fixtureProcessEnvironment(home: string, hearthPort: number) {
  const environment = fixtureEnvironment();
  Object.assign(environment, {
    AGENT_FORGE_HOME: home,
    AGENT_FORGE_E2E_HOME: home,
    HOME: join(home, "user"),
    USERPROFILE: join(home, "user"),
    APPDATA: join(home, "user", "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "user", "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, "user", "config"),
    HEARTH_PORT: String(hearthPort),
    E2E_HEARTH_PORT: String(hearthPort),
  });
  return environment;
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not allocate an isolated hearth port.");
  const port = address.port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

function spawnOwnedHost(home: string, hearthPort: number) {
  const child = spawn(
    bunPath(),
    [
      resolve("tests/desktop-restart-e2e/smith-create-origin-host.ts"),
      ROOT,
      home,
      ASSETS,
    ],
    {
      env: fixtureProcessEnvironment(home, hearthPort),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  ) as ChildProcessWithoutNullStreams;
  const output = createInterface({ input: child.stdout });
  const pending: ((line: string) => void)[] = [];
  output.on("line", (line) => pending.shift()?.(line));
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000);
  });
  async function nextReply(): Promise<FixtureReply> {
    const line = await new Promise<string>((resolveLine, reject) => {
      const timer = setTimeout(
        () => reject(new Error("The owned Smith host reply timed out.")),
        20_000,
      );
      pending.push((value) => {
        clearTimeout(timer);
        resolveLine(value);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(
          new Error(
            `The owned Smith host exited before replying (${code}): ${stderr}`,
          ),
        );
      });
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error("The owned Smith host returned malformed JSON.");
    }
    return replyShape(parsed);
  }
  function command(action: "close" | "start" | "quit"): Promise<FixtureReply> {
    child.stdin.write(`${JSON.stringify({ action })}\n`);
    return nextReply();
  }
  return { child, command, nextReply };
}

async function launched(page: Page, url: string): Promise<void> {
  const exchanged = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === SESSION_ROUTE,
  );
  const document = await page.goto(url);
  expect(document?.status()).toBe(200);
  expect((await exchanged).status()).toBe(200);
}

async function protectedData(
  page: Page,
  origin: string,
  token: string,
  path: string,
): Promise<unknown> {
  const response = await page.context().request.get(`${origin}${path}`, {
    headers: { Origin: origin, [OPERATOR_HEADER]: token },
  });
  if (response.status() !== 200)
    throw new Error(
      `The protected Smith original read returned ${response.status()}.`,
    );
  const value: unknown = await response.json();
  if (
    !value ||
    typeof value !== "object" ||
    !("ok" in value) ||
    value.ok !== true ||
    !("data" in value)
  )
    throw new Error(
      "The protected Smith original read had an invalid envelope.",
    );
  return value.data;
}

async function holdPort(
  port: number,
): Promise<ReturnType<typeof createServer>> {
  const server = createServer((_request, response) => {
    response.writeHead(410, { "content-type": "text/plain" });
    response.end();
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolveListen());
  });
  return server;
}

async function releasePort(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
}

test("pre-effect reservation and post-effect confirmation recover across two fresh desktop origins", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const home = join(HEARTH_HOME, `smith-create-origin-${randomUUID()}`),
    configFile = join(home, "config.toml"),
    projectFile = join(home, "projects", "catalog.json"),
    workspaceFile = join(ROOT, "agent-forge.toml"),
    beforeWorkspace = existsSync(workspaceFile)
      ? readFileSync(workspaceFile)
      : null,
    basisName = `origin-basis-${randomUUID().replaceAll("-", "").slice(0, 10)}`,
    name = `origin-created-${randomUUID().replaceAll("-", "").slice(0, 10)}`,
    hearthPort = await unusedPort();
  let owner: ReturnType<typeof spawnOwnedHost> | null = null,
    portGuard: ReturnType<typeof createServer> | null = null;
  const reservation: {
    value: { requestId: string; inputHash: string } | null;
  } = { value: null };
  let completeCapture: (() => void) | undefined;
  const captured = new Promise<void>((resolveCaptured) => {
    completeCapture = resolveCaptured;
  });
  let release: (() => void) | undefined;
  const heldReply = new Promise<void>((resolveHeld) => {
    release = resolveHeld;
  });
  let completePublication: (() => void) | undefined,
    releasePublication: (() => void) | undefined;
  const publicationCaptured = new Promise<void>((resolveCaptured) => {
      completePublication = resolveCaptured;
    }),
    heldPublicationReply = new Promise<void>((resolveHeld) => {
      releasePublication = resolveHeld;
    });
  const apiPosts: Array<{ origin: string; path: string; body: unknown }> = [];
  const hostFacts: HostFact[] = [];
  let fixtureHelperPid: number | null = null;
  const apiReads: Array<{ origin: string; path: string }> = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() === "GET" &&
      path.startsWith("/__agent-forge/smiths/creates")
    )
      apiReads.push({ origin: new URL(request.url()).origin, path });
    if (
      request.method() === "POST" &&
      path.startsWith("/__agent-forge/config/smiths/creates")
    )
      apiPosts.push({
        origin: new URL(request.url()).origin,
        path,
        body: request.postDataJSON(),
      });
  });
  try {
    ensurePrivateHome(home);
    ensurePrivateHome(join(home, "projects"));
    writeFileSync(projectFile, JSON.stringify(projectCatalogFixture(ROOT)), {
      mode: 0o600,
    });
    writeFileSync(
      configFile,
      `[smiths.${basisName}]\nprovider = "codex"\nmodel = "origin-basis-model"\neffort = "high"\nenabled = true\n`,
      { mode: 0o600 },
    );
    const savedUserConfig = readFileSync(configFile);
    writeFileSync(workspaceFile, "# Smith create origin replacement fixture\n");
    owner = spawnOwnedHost(home, hearthPort);
    const oldReply = await owner.nextReply();
    if (!("url" in oldReply.data))
      throw new Error("The original Smith host did not start.");
    const oldOrigin = new URL(oldReply.data.url).origin;
    fixtureHelperPid = oldReply.data.helperPid;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await launched(page, oldReply.data.url);
    hostFacts.push({
      dashboardPort: Number(new URL(oldReply.data.url).port),
      hearthPid: await trustedHostPid(page),
    });
    const originalPage = await page.goto(
      `${oldOrigin}/index.html#/desktop/smiths`,
    );
    expect(originalPage?.status()).toBe(200);
    await expect(
      page.getByRole("button", {
        name: `Edit configuration for ${basisName}`,
        exact: true,
      }),
    ).toBeVisible();
    expect(readFileSync(workspaceFile, "utf8")).not.toContain(
      `[smiths.${name}]`,
    );
    expect(savedUserConfig.toString("utf8")).toContain(`[smiths.${basisName}]`);
    await page.getByRole("button", { name: "New smith", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Create a Smith" });
    await dialog.getByLabel("Smith name").fill(name);
    await dialog.getByLabel("Provider").fill("codex");
    await dialog.getByLabel("Model").fill("origin-restart-model");
    await dialog.getByLabel("Effort").fill("high");
    await dialog.getByRole("button", { name: "Review candidate" }).click();
    await expect(
      dialog.getByRole("region", { name: "Candidate review" }),
    ).toBeVisible();

    await page.route("**/config/smiths/creates/reserve", async (route) => {
      const response = await route.fetch({
          headers: {
            ...route.request().headers(),
            Origin: new URL(route.request().url()).origin,
          },
        }),
        value: unknown = await response.json();
      const envelope =
        value && typeof value === "object" && "data" in value
          ? value.data
          : null;
      const checked = smithConfigCreateReceiptSchema.parse(envelope);
      const request = smithConfigCreateRequestSchema.parse(
        route.request().postDataJSON(),
      );
      if (
        response.status() !== 200 ||
        checked.requestId !== request.requestId ||
        canonicalSmithConfigCreateRequest(checked.original) !==
          canonicalSmithConfigCreateRequest(request) ||
        checked.result.phase !== "held" ||
        checked.result.stage !== "reserved"
      )
        throw new Error("The original host did not reserve the exact request.");
      reservation.value = {
        requestId: checked.requestId,
        inputHash: checked.inputHash,
      };
      completeCapture?.();
      await heldReply;
      await route.abort("connectionfailed").catch(() => {});
    });
    const createClick = page
      .getByRole("button", { name: "Create Smith" })
      .click();
    await captured;
    await expect
      .poll(() => reservation.value?.requestId ?? null)
      .not.toBeNull();
    const firstRequest = reservation.value;
    if (!firstRequest) throw new Error("Missing server reservation identity.");
    const reserveCall = apiPosts.find(
      (item) => item.path === "/__agent-forge/config/smiths/creates/reserve",
    );
    if (!reserveCall)
      throw new Error("The reservation request was not observed.");
    const exactRequest = smithConfigCreateRequestSchema.parse(reserveCall.body);
    expect(firstRequest.inputHash).toBe(
      createHash("sha256")
        .update(canonicalSmithConfigCreateRequest(exactRequest))
        .digest("hex"),
    );
    expect(apiPosts.map((item) => item.path)).toEqual([
      "/__agent-forge/config/smiths/creates/reserve",
    ]);
    expect(
      await page.evaluate(
        (key) => localStorage.getItem(key),
        SMITH_CREATE_IDENTITIES,
      ),
    ).toBeNull();

    const oldDashboardPort = Number(new URL(oldReply.data.url).port);
    expect((await owner.command("close")).data).toEqual({ closed: true });
    portGuard = await holdPort(oldDashboardPort);
    const newReply = await owner.command("start");
    if (!("url" in newReply.data))
      throw new Error("The replacement Smith host did not start.");
    const newOrigin = new URL(newReply.data.url).origin;
    expect(newReply.data.helperPid).toBe(fixtureHelperPid);
    expect(newOrigin).not.toBe(oldOrigin);
    release?.();
    await createClick;
    await releasePort(portGuard);
    portGuard = null;
    await page.unroute("**/config/smiths/creates/reserve");

    apiPosts.length = 0;
    await launched(page, newReply.data.url);
    hostFacts.push({
      dashboardPort: Number(new URL(newReply.data.url).port),
      hearthPid: await trustedHostPid(page),
    });
    expect(new Set(hostFacts.map((host) => host.dashboardPort)).size).toBe(2);
    expect(new Set(hostFacts.map((host) => host.hearthPid)).size).toBe(2);
    expect(new URL(page.url()).origin).toBe(newOrigin);
    expect(
      await page.evaluate(
        (key) => localStorage.getItem(key),
        SMITH_CREATE_IDENTITIES,
      ),
    ).toBeNull();

    const replacementToken = readToken(tokenPath(home, ROOT));
    if (!replacementToken)
      throw new Error(
        "The replacement hearth did not publish its trusted token.",
      );
    const index = smithCreateIdentityIndexSchema.parse(
        await protectedData(
          page,
          newOrigin,
          replacementToken,
          "/__agent-forge/smiths/creates",
        ),
      ),
      original = smithConfigCreateReceiptSchema.parse(
        await protectedData(
          page,
          newOrigin,
          replacementToken,
          `/__agent-forge/smiths/creates/${firstRequest.requestId}`,
        ),
      );
    expect(index.entries).toContainEqual({
      requestId: exactRequest.requestId,
      ownerScopeHash: original.ownerScopeHash,
      inputHash: firstRequest.inputHash,
      target: "workspace",
      state: "reserved",
      stage: "reserved",
      createdAt: original.createdAt,
    });
    expect(original.original).toEqual(exactRequest);
    expect(original.inputHash).toBe(firstRequest.inputHash);
    const smithsPage = await page.goto(
      `${newOrigin}/index.html#/desktop/smiths`,
    );
    expect(smithsPage?.status()).toBe(200);
    await expect(
      page.getByRole("region", { name: "Original Smith create receipts" }),
    ).toContainText(name);
    await expect(
      page.getByRole("region", { name: "Original Smith create receipts" }),
    ).toContainText("Reserved");
    await expect(
      page.getByRole("button", { name: "Continue this exact saved original" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Retire this reservation" }),
    ).toBeVisible();
    expect(apiReads).toContainEqual({
      origin: newOrigin,
      path: "/__agent-forge/smiths/creates",
    });
    expect(apiReads).toContainEqual({
      origin: newOrigin,
      path: `/__agent-forge/smiths/creates/${firstRequest.requestId}`,
    });
    expect(apiPosts).toEqual([]);

    const publication: { receipt: SmithConfigCreateReceipt | null } = {
      receipt: null,
    };
    await page.route("**/config/smiths/creates", async (route) => {
      const response = await route.fetch({
          headers: {
            ...route.request().headers(),
            Origin: new URL(route.request().url()).origin,
          },
        }),
        value: unknown = await response.json(),
        data =
          value && typeof value === "object" && "data" in value
            ? value.data
            : null;
      const checked = smithConfigCreateReceiptSchema.parse(data),
        request = smithConfigCreateRequestSchema.parse(
          route.request().postDataJSON(),
        );
      if (
        response.status() !== 200 ||
        checked.requestId !== firstRequest.requestId ||
        checked.inputHash !== firstRequest.inputHash ||
        canonicalSmithConfigCreateRequest(checked.original) !==
          canonicalSmithConfigCreateRequest(exactRequest) ||
        canonicalSmithConfigCreateRequest(request) !==
          canonicalSmithConfigCreateRequest(exactRequest) ||
        checked.result.phase !== "confirmed"
      )
        throw new Error(
          "The replacement host did not publish the exact original.",
        );
      publication.receipt = checked;
      completePublication?.();
      await heldPublicationReply;
      await route.abort("connectionfailed").catch(() => {});
    });
    const continueClick = page
      .getByRole("button", { name: "Continue this exact saved original" })
      .click();
    await publicationCaptured;
    const published = publication.receipt;
    if (!published) throw new Error("The exact create was not confirmed.");
    expect(published.original).toEqual(exactRequest);
    expect(apiPosts.map((item) => item.path)).toEqual([
      "/__agent-forge/config/smiths/creates",
    ]);
    expect(readFileSync(workspaceFile, "utf8")).toContain(`[smiths.${name}]`);
    const writtenConfig = readFileSync(workspaceFile, "utf8");
    expect([
      ...writtenConfig.matchAll(new RegExp(`\\[smiths\\.${name}\\]`, "g")),
    ]).toHaveLength(1);
    expect(writtenConfig).toContain(
      "# Smith create origin replacement fixture",
    );
    expect(readFileSync(configFile)).toEqual(savedUserConfig);

    const replacementPort = Number(new URL(newReply.data.url).port);
    expect((await owner.command("close")).data).toEqual({ closed: true });
    portGuard = await holdPort(replacementPort);
    const finalReply = await owner.command("start");
    if (!("url" in finalReply.data))
      throw new Error("The post-effect replacement host did not start.");
    const finalOrigin = new URL(finalReply.data.url).origin;
    expect(finalReply.data.helperPid).toBe(fixtureHelperPid);
    expect(finalOrigin).not.toBe(newOrigin);
    releasePublication?.();
    await continueClick;
    await releasePort(portGuard);
    portGuard = null;
    await page.unroute("**/config/smiths/creates");

    apiPosts.length = 0;
    apiReads.length = 0;
    await launched(page, finalReply.data.url);
    hostFacts.push({
      dashboardPort: Number(new URL(finalReply.data.url).port),
      hearthPid: await trustedHostPid(page),
    });
    expect(new Set(hostFacts.map((host) => host.dashboardPort)).size).toBe(3);
    expect(new Set(hostFacts.map((host) => host.hearthPid)).size).toBe(3);
    expect(new URL(page.url()).origin).toBe(finalOrigin);
    expect(
      await page.evaluate(
        (key) => localStorage.getItem(key),
        SMITH_CREATE_IDENTITIES,
      ),
    ).toBeNull();
    const finalToken = readToken(tokenPath(home, ROOT));
    if (!finalToken)
      throw new Error("The final hearth did not publish its trusted token.");
    const finalIndex = smithCreateIdentityIndexSchema.parse(
        await protectedData(
          page,
          finalOrigin,
          finalToken,
          "/__agent-forge/smiths/creates",
        ),
      ),
      finalOriginal = smithConfigCreateReceiptSchema.parse(
        await protectedData(
          page,
          finalOrigin,
          finalToken,
          `/__agent-forge/smiths/creates/${firstRequest.requestId}`,
        ),
      );
    expect(finalIndex.entries).toContainEqual({
      requestId: exactRequest.requestId,
      ownerScopeHash: finalOriginal.ownerScopeHash,
      inputHash: firstRequest.inputHash,
      target: "workspace",
      state: "confirmed",
      stage: "terminal",
      createdAt: finalOriginal.createdAt,
    });
    expect(finalOriginal.original).toEqual(exactRequest);
    expect(finalOriginal.inputHash).toBe(firstRequest.inputHash);
    expect(finalOriginal.result.phase).toBe("confirmed");
    const finalPage = await page.goto(
      `${finalOrigin}/index.html#/desktop/smiths`,
    );
    expect(finalPage?.status()).toBe(200);
    await expect(
      page.getByRole("region", { name: "Original Smith create receipts" }),
    ).toContainText("Confirmed");
    await expect(
      page.getByRole("region", { name: "Original Smith create receipts" }),
    ).toContainText(name);
    expect(apiReads).toContainEqual({
      origin: finalOrigin,
      path: "/__agent-forge/smiths/creates",
    });
    expect(apiReads).toContainEqual({
      origin: finalOrigin,
      path: `/__agent-forge/smiths/creates/${firstRequest.requestId}`,
    });
    expect(apiPosts).toEqual([]);
    expect(readFileSync(workspaceFile, "utf8")).toContain(`[smiths.${name}]`);
    expect([
      ...readFileSync(workspaceFile, "utf8").matchAll(
        new RegExp(`\\[smiths\\.${name}\\]`, "g"),
      ),
    ]).toHaveLength(1);
    expect(readFileSync(configFile)).toEqual(savedUserConfig);
    const continuedCall = apiPosts.filter(
      (item) => item.path === "/__agent-forge/config/smiths/creates",
    );
    expect(continuedCall).toEqual([]);
    if (fixtureHelperPid === null)
      throw new Error("The owned fixture helper identity was unavailable.");
    publishHostProof(hearthPort, fixtureHelperPid, hostFacts);
  } finally {
    release?.();
    releasePublication?.();
    if (owner) {
      await owner.command("quit").catch(() => {});
      owner.child.stdin.end();
      await new Promise<void>((resolveExit) => {
        if (owner!.child.exitCode !== null) resolveExit();
        else owner!.child.once("exit", () => resolveExit());
      });
    }
    if (portGuard?.listening) await releasePort(portGuard);
    await page.unrouteAll({ behavior: "wait" }).catch(() => {});
    if (beforeWorkspace === null) {
      if (existsSync(workspaceFile)) unlinkSync(workspaceFile);
    } else writeFileSync(workspaceFile, beforeWorkspace);
  }
});
