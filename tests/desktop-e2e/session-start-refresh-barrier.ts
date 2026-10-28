import type { Page, Request, Route } from "@playwright/test";
import { z } from "zod";
import { sessionStartIdentityPageSchema } from "../../scripts/sessions/identity-protocol";

const successEnvelope = z
  .object({
    ok: z.literal(true),
    data: sessionStartIdentityPageSchema,
    error: z.null(),
  })
  .strict();

/** Observe, and optionally hold, one real identity read emitted after preview. */
export async function observePreviewIdentityRefresh(
  page: Page,
  projectId: string,
  workspace: string,
  options: { holdResponse?: boolean } = {},
) {
  let previewRequested = false;
  let held = false;
  let observed = false;
  let release: () => void = () => {};
  let markSettled: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const settledRead = new Promise<void>((resolve) => {
    markSettled = resolve;
  });
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname ===
        `/__agent-forge/projects/${projectId}/sessions/preview`
    )
      previewRequested = true;
  });
  await page.route(
    `**/__agent-forge/projects/${projectId}/session-start-identities`,
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      const startedAfterPreview = previewRequested;
      const response = await route.fetch({
        headers: {
          ...(await route.request().allHeaders()),
          Origin: new URL(route.request().url()).origin,
          "Sec-Fetch-Site": "same-origin",
        },
      });
      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        throw Error("The actual Start identity response was not valid JSON.");
      }
      const envelope = successEnvelope.safeParse(raw);
      if (
        response.status() !== 200 ||
        !envelope.success ||
        envelope.data.data.scope.projectId !== projectId ||
        envelope.data.data.scope.workspace !== workspace
      )
        throw Error(
          "The actual Start identity response could not be verified.",
        );

      let isObservedRefresh = false;
      if (startedAfterPreview && !observed) {
        observed = true;
        isObservedRefresh = true;
        if (options.holdResponse) {
          held = true;
          await released;
        }
      }
      await route.fulfill({ response });
      if (isObservedRefresh) markSettled();
    },
  );
  return {
    settledRead,
    get isHeld() {
      return held;
    },
    get isObserved() {
      return observed;
    },
    release() {
      release();
    },
  };
}

/** Hold Alpha's real identity read after an explicit preview in a sibling project. */
export async function observeSiblingPreviewIdentityRefresh(
  alphaPage: Page,
  betaPage: Page,
  alphaProjectId: string,
  betaProjectId: string,
  workspace: string,
  expected: { requestId: string; requestHash: string },
) {
  let previewRequested = false;
  let observedReads = 0;
  let pendingReads = 0;
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const idleWaiters: Array<() => void> = [];
  const onBetaRequest = (request: Request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname ===
        `/__agent-forge/projects/${betaProjectId}/sessions/preview`
    )
      previewRequested = true;
  };
  betaPage.on("request", onBetaRequest);
  const identityUrl =
    `**/__agent-forge/projects/${alphaProjectId}/session-start-identities`;
  const onAlphaIdentityRead = async (route: Route) => {
    if (route.request().method() !== "GET" || !previewRequested) {
      await route.continue();
      return;
    }
    pendingReads++;
    try {
      const response = await route.fetch();
      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        throw Error("The actual Alpha Start identity response was not valid JSON.");
      }
      const envelope = successEnvelope.safeParse(raw);
      const identity = envelope.success
        ? envelope.data.data.identities.find(
            (item) => item.requestId === expected.requestId,
          )
        : undefined;
      if (
        response.status() !== 200 ||
        !envelope.success ||
        envelope.data.data.scope.projectId !== alphaProjectId ||
        envelope.data.data.scope.workspace !== workspace ||
        !identity ||
        identity.requestHash !== expected.requestHash ||
        identity.provider !== "codex" ||
        identity.mode !== "task" ||
        identity.state !== "reserved"
      )
        throw Error(
          "The actual Alpha identity read did not contain the reserved original.",
        );
      observedReads++;
      await released;
      await route.fulfill({ response });
    } finally {
      pendingReads--;
      if (pendingReads === 0)
        for (const resolve of idleWaiters.splice(0)) resolve();
    }
  };
  await alphaPage.route(identityUrl, onAlphaIdentityRead);
  return {
    get isObserved() {
      return observedReads > 0;
    },
    get observedReads() {
      return observedReads;
    },
    release() {
      release();
      betaPage.off("request", onBetaRequest);
    },
    async settleHeldReads() {
      release();
      betaPage.off("request", onBetaRequest);
      if (pendingReads > 0)
        await new Promise<void>((resolve) => idleWaiters.push(resolve));
    },
    async dispose() {
      betaPage.off("request", onBetaRequest);
      await alphaPage.unroute(identityUrl, onAlphaIdentityRead);
    },
  };
}
