import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { SESSION_START_IDENTITIES } from "../../apps/desktop/src/session-start-identities";
import {
  OPERATOR_HEADER,
  SESSION_KEY_STORAGE,
  SESSION_ROUTE,
} from "../../scripts/hearth/paths";
import { ownedCodingPageSchema } from "../../scripts/sessions/codex-owned-journal";
import { canonicalOwnedSessionStart } from "../../scripts/sessions/codex-owned-protocol";
import { sessionStartIdentityPageSchema } from "../../scripts/sessions/identity-protocol";
import { sessionStartReceiptSchema } from "../../scripts/sessions/protocol";
import { sessionStartSchema } from "../../scripts/sessions/request-protocol";
import type { SessionStartRequest } from "../../types/session-requests";
import { pageToken } from "../e2e/launch-link";
import { HEARTH_HOME } from "../e2e/servers";
import { alpha, ROOT } from "./environment";

const FIXTURE_CONTROL_PATH = "/__desktop-restart-fixture/restart-host";
const FIXTURE_CONTROL_HEADER = "x-agent-forge-fixture-secret";
const INITIAL_STORAGE_OBSERVATION = "__restart_origin_initial_storage__";

function lineCount(file: string): number {
  try {
    return readFileSync(join(HEARTH_HOME, file), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean).length;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return 0;
    throw error;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseFixtureJson(value: string, description: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`The owned desktop ${description} was invalid.`);
  }
}

async function restartOwnedDesktopHost(): Promise<string> {
  const manifest = record(
    parseFixtureJson(
      readFileSync(join(HEARTH_HOME, "restart-fixture.json"), "utf8"),
      "restart manifest",
    ),
  );
  const control = record(manifest?.["fixtureControl"]);
  const controlPort = control?.["port"],
    controlSecret = control?.["secret"];
  if (
    manifest?.["root"] !== ROOT ||
    typeof controlPort !== "number" ||
    !Number.isSafeInteger(controlPort) ||
    controlPort < 1 ||
    typeof controlSecret !== "string" ||
    !/^[a-f0-9]{64}$/.test(controlSecret)
  )
    throw new Error("The owned desktop restart control was not verified.");

  const answer = await new Promise<{ status: number; body: string }>(
    (resolve, reject) => {
      let deadline: ReturnType<typeof setTimeout>;
      const request = httpRequest(
        {
          host: "127.0.0.1",
          port: controlPort,
          path: FIXTURE_CONTROL_PATH,
          method: "POST",
          headers: {
            [FIXTURE_CONTROL_HEADER]: controlSecret,
            "Content-Length": "0",
          },
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            body += chunk;
            if (body.length > 8192) response.destroy();
          });
          response.on("end", () => {
            clearTimeout(deadline);
            resolve({ status: response.statusCode ?? 0, body });
          });
          response.on("error", (error) => {
            clearTimeout(deadline);
            reject(error);
          });
        },
      );
      deadline = setTimeout(
        () =>
          request.destroy(
            new Error("The owned desktop restart exceeded its bound."),
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
  const envelope = record(parseFixtureJson(answer.body, "restart reply"));
  if (answer.status !== 200 || envelope?.["ok"] !== true)
    throw new Error("The owned desktop host could not be restarted.");
  const data = record(envelope["data"]);
  if (typeof data?.["url"] !== "string" || typeof data["owner"] !== "string")
    throw new Error("The owned desktop host could not be restarted.");
  return data["url"];
}

test("a fresh trusted desktop origin discovers and inspects an admitted Start without writing", async ({
  page,
}) => {
  test.setTimeout(90000);
  const providerEffectsBefore = lineCount("coding-fixture-starts.jsonl");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/index.html#/desktop/project/${alpha.id}/sessions`);
  const firstOrigin = new URL(page.url()).origin;
  await page.getByRole("button", { name: "New session", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "New session · Alpha",
    exact: true,
  });
  await dialog
    .getByRole("textbox", { name: "Session prompt", exact: true })
    .fill("Changed origin must inspect the original admitted Start");
  await dialog
    .getByRole("combobox", { name: "Session effort", exact: true })
    .selectOption("");
  await dialog
    .getByRole("button", { name: "Check supported options", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();

  const originalStarts: SessionStartRequest[] = [];
  let effectApplied: () => void = () => {};
  let releaseReply: () => void = () => {};
  let replyAborted: () => void = () => {};
  const effect = new Promise<void>((resolve) => {
      effectApplied = resolve;
    }),
    heldReply = new Promise<void>((resolve) => {
      releaseReply = resolve;
    }),
    aborted = new Promise<void>((resolve) => {
      replyAborted = resolve;
    });
  let identityReservePosts = 0,
    startPosts = 0,
    newOriginIdentityGets = 0,
    newOriginIdentityWrites = 0,
    newOriginStartPosts = 0,
    originalReadIds: string[] = [],
    newOrigin: string | null = null,
    originalSessionId: string | null = null;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === newOrigin) {
      const identityPath = `/__agent-forge/projects/${alpha.id}/session-start-identities`;
      if (
        request.method() === "GET" &&
        url.pathname ===
          `/__agent-forge/projects/${alpha.id}/session-start-identities`
      )
        newOriginIdentityGets++;
      if (
        request.method() === "POST" &&
        (url.pathname === identityPath ||
          url.pathname.startsWith(`${identityPath}/`))
      )
        newOriginIdentityWrites++;
      if (
        request.method() === "POST" &&
        url.pathname === `/__agent-forge/projects/${alpha.id}/sessions`
      )
        newOriginStartPosts++;
      if (
        request.method() === "GET" &&
        url.pathname.startsWith(`/__agent-forge/projects/${alpha.id}/sessions/`)
      ) {
        const requestId = url.searchParams.get("requestId");
        if (requestId) originalReadIds.push(requestId);
      }
    }
    if (url.origin === firstOrigin) {
      if (
        request.method() === "POST" &&
        url.pathname.endsWith(`/projects/${alpha.id}/session-start-identities`)
      )
        identityReservePosts++;
      if (
        request.method() === "POST" &&
        url.pathname === `/__agent-forge/projects/${alpha.id}/sessions`
      )
        startPosts++;
    }
  });
  await page.route(
    `**/__agent-forge/projects/${alpha.id}/sessions`,
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      const input = sessionStartSchema.parse(route.request().postDataJSON());
      originalStarts.push(input);
      const response = await route.fetch({
        headers: {
          ...(await route.request().allHeaders()),
          Origin: new URL(route.request().url()).origin,
          "Sec-Fetch-Site": "same-origin",
        },
      });
      if (!response.ok())
        throw new Error(
          `The original Start effect returned ${response.status()}.`,
        );
      const receipt = sessionStartReceiptSchema.parse(
        (await response.json()).data,
      );
      if (
        receipt.session.requestId !== input.requestId ||
        receipt.session.requestHash !==
          createHash("sha256")
            .update(canonicalOwnedSessionStart(input))
            .digest("hex")
      )
        throw new Error(
          "The admitted receipt did not match the original Start.",
        );
      originalSessionId = receipt.session.id;
      effectApplied();
      await heldReply;
      await route.abort("connectionfailed").catch(() => {});
      replyAborted();
    },
  );

  try {
    await dialog.getByRole("button", { name: "Start", exact: true }).click();
    await effect;
    const original = originalStarts[0];
    if (!original)
      throw new Error("The browser did not send the original Start.");
    const originalHash = createHash("sha256")
      .update(canonicalOwnedSessionStart(original))
      .digest("hex");
    expect(identityReservePosts).toBe(1);
    expect(startPosts).toBe(1);
    const operatorToken = await pageToken(page);
    await expect
      .poll(
        async () => {
          if (
            lineCount("coding-fixture-starts.jsonl") !==
              providerEffectsBefore + 1 ||
            originalSessionId === null
          )
            return false;
          const response = await page.evaluate(
            async ({ path, header, token }) => {
              const result = await fetch(path, {
                headers: { [header]: token },
              });
              return { status: result.status, body: await result.text() };
            },
            {
              path: `/__agent-forge/projects/${alpha.id}/sessions/${encodeURIComponent(originalSessionId)}?requestId=${encodeURIComponent(original.requestId)}`,
              header: OPERATOR_HEADER,
              token: operatorToken,
            },
          );
          if (response.status !== 200) return false;
          const envelope = record(
            parseFixtureJson(response.body, "original session read"),
          );
          const conversation = ownedCodingPageSchema.safeParse(
            envelope?.["data"],
          );
          const replyText = conversation.success
            ? conversation.data.frames
                .filter(
                  (frame) =>
                    frame.turnId === original.requestId &&
                    frame.event.kind === "text",
                )
                .sort((left, right) => left.seq - right.seq)
                .map((frame) =>
                  frame.event.kind === "text" ? frame.event.text : "",
                )
                .join("")
            : null;
          return (
            conversation.success &&
            conversation.data.projectId === alpha.id &&
            conversation.data.conversationId === originalSessionId &&
            conversation.data.request?.requestId === original.requestId &&
            conversation.data.request.phase === "completed" &&
            replyText === "Coding reply 🌱"
          );
        },
        { timeout: 45_000 },
      )
      .toBe(true);
    const oldLocalHints = await page.evaluate(
      (key) => localStorage.getItem(key),
      SESSION_START_IDENTITIES,
    );
    expect(oldLocalHints ?? "").not.toContain(original.launch.prompt);

    const newHostUrl = await restartOwnedDesktopHost();
    newOrigin = new URL(newHostUrl).origin;
    expect(newOrigin).not.toBe(firstOrigin);
    releaseReply();
    await aborted;
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
        observationKey: INITIAL_STORAGE_OBSERVATION,
      },
    );
    const exchanged = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).origin === newOrigin &&
        new URL(response.url()).pathname === SESSION_ROUTE,
    );
    const identityPath = `/__agent-forge/projects/${alpha.id}/session-start-identities`;
    const browserIdentityRead = page.waitForResponse((response) => {
      try {
        const request = response.request(),
          frame = request.frame();
        return (
          request.method() === "GET" &&
          !request.isNavigationRequest() &&
          frame === page.mainFrame() &&
          new URL(response.url()).origin === newOrigin &&
          new URL(frame.url()).origin === newOrigin &&
          new URL(response.url()).pathname === identityPath
        );
      } catch {
        return false;
      }
    });
    await page.goto(newHostUrl);
    expect((await exchanged).status()).toBe(200);
    const sessionKey = await page.evaluate(
      (key) => localStorage.getItem(key),
      SESSION_KEY_STORAGE,
    );
    expect(sessionKey).toMatch(/^[a-f0-9]{64}$/);
    // The fresh host URL performs the trusted-origin key exchange. Navigate
    // the already loaded app to the selected project with a hash change, then
    // correlate the browser's real identity GET to that new main-frame origin.
    await page.evaluate((hash) => {
      window.location.hash = hash;
    }, `#/desktop/project/${alpha.id}/sessions`);
    const browserIdentityResponse = await browserIdentityRead;
    expect(browserIdentityResponse.status()).toBe(200);
    const identityToken = await pageToken(page);
    const identityResponse = await page.request.get(
      new URL(identityPath, newOrigin).toString(),
      {
        headers: {
          [OPERATOR_HEADER]: identityToken,
          Origin: newOrigin,
          "Sec-Fetch-Site": "same-origin",
        },
      },
    );
    expect(identityResponse.status()).toBe(200);
    const identityPage = sessionStartIdentityPageSchema.parse(
      record(
        parseFixtureJson(await identityResponse.text(), "identity page read"),
      )?.["data"],
    );
    const observation = record(
      parseFixtureJson(
        (await page.evaluate(
          (key) => sessionStorage.getItem(key),
          INITIAL_STORAGE_OBSERVATION,
        )) ?? "null",
        "initial storage observation",
      ),
    );
    expect(observation?.identity).toBeNull();
    expect(observation?.sessionKey).toBeNull();
    expect(identityPage.identities).toContainEqual({
      version: 1,
      requestId: original.requestId,
      requestHash: originalHash,
      provider: "claude",
      mode: original.launch.mode,
      state: "admitted",
    });
    expect(identityPage.scope).toEqual({
      family: "owned-session-start",
      projectId: alpha.id,
      workspace: alpha.workspaces[0]?.root,
    });
    expect(newOriginIdentityGets).toBeGreaterThan(0);
    await expect(
      page.getByRole("button", { name: "New session", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    const reopened = page.getByRole("dialog", {
      name: "New session · Alpha",
      exact: true,
    });
    const identityRow = reopened
      .locator(".af-start-identities-list li")
      .filter({ hasText: original.requestId });
    await expect(identityRow).toContainText(
      `claude ${original.launch.mode} · admitted`,
    );
    await expect(identityRow.locator("code").nth(0)).toHaveText(
      original.requestId,
    );
    await expect(identityRow.locator("code").nth(1)).toHaveText(originalHash);
    await expect(
      reopened.getByRole("button", {
        name: "Retry exact original",
        exact: true,
      }),
    ).toHaveCount(0);
    await identityRow
      .getByRole("button", { name: "Inspect original", exact: true })
      .click();
    await expect(
      identityRow.getByRole("link", {
        name: "Open original session",
        exact: true,
      }),
    ).toBeVisible();
    await identityRow
      .getByRole("link", { name: "Open original session", exact: true })
      .click();
    await expect(reopened).toBeHidden();
    await expect(
      page.getByRole("article", { name: "Session reply", exact: true }),
    ).toContainText("Coding reply 🌱");
    expect(originalStarts).toHaveLength(1);
    expect(identityReservePosts).toBe(1);
    expect(startPosts).toBe(1);
    expect(newOriginIdentityWrites).toBe(0);
    expect(newOriginStartPosts).toBe(0);
    expect(originalReadIds.length).toBeGreaterThan(0);
    expect(new Set(originalReadIds)).toEqual(new Set([original.requestId]));
    expect(lineCount("coding-fixture-starts.jsonl")).toBe(
      providerEffectsBefore + 1,
    );
    await expect
      .poll(async () =>
        page.evaluate(
          (key) => localStorage.getItem(key),
          SESSION_START_IDENTITIES,
        ),
      )
      .toBeNull();
  } finally {
    releaseReply();
    await Promise.race([
      aborted,
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
});
