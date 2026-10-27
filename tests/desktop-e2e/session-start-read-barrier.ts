import type { Page, Route } from "@playwright/test";
import { z } from "zod";
import { sessionStartIdentityPageSchema } from "../../scripts/sessions/identity-protocol";

export async function verifiedIdentityReadBarrier(
  page: Page,
  options: {
    projectId: string;
    workspace: string;
    shouldHold?: () => boolean;
  },
) {
  const path = `/__agent-forge/projects/${encodeURIComponent(options.projectId)}/session-start-identities`;
  const matcher = `**${path}`;
  let armed = false;
  let held = false;
  let heldReadCount = 0;
  let pendingHeldReads = 0;
  let releaseRead: () => void = () => {};
  let settleHeldReads: () => void = () => {};
  let released = Promise.resolve();
  let heldReadsSettled = Promise.resolve();

  const handler = async (route: Route) => {
    const request = route.request();
    if (request.method() !== "GET") {
      await route.continue();
      return;
    }

    const requestUrl = new URL(request.url());
    let frameUrl: URL;
    try {
      const frame = request.frame();
      if (frame !== page.mainFrame()) {
        await route.continue();
        return;
      }
      frameUrl = new URL(frame.url());
    } catch {
      await route.continue();
      return;
    }
    if (
      requestUrl.pathname !== path ||
      requestUrl.search !== "" ||
      frameUrl.origin !== requestUrl.origin
    ) {
      await route.continue();
      return;
    }

    const holdThisRead = armed && (options.shouldHold?.() ?? true);
    const response = await route.fetch({
      headers: {
        ...(await request.allHeaders()),
        Origin: requestUrl.origin,
        "Sec-Fetch-Site": "same-origin",
      },
    });
    let responseUrl: URL;
    try {
      responseUrl = new URL(response.url());
    } catch {
      throw new Error("The Session Start identity response URL was invalid.");
    }
    if (
      responseUrl.origin !== requestUrl.origin ||
      responseUrl.pathname !== path ||
      responseUrl.search !== ""
    )
      throw new Error("The Session Start identity response was redirected.");
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw Error("The Session Start identity read was not valid JSON.");
    }
    const envelope = z
      .object({
        ok: z.literal(true),
        data: sessionStartIdentityPageSchema,
        error: z.null(),
      })
      .strict()
      .safeParse(payload);
    if (
      response.status() !== 200 ||
      !envelope.success ||
      envelope.data.data.scope.projectId !== options.projectId ||
      envelope.data.data.scope.workspace !== options.workspace
    )
      throw Error(
        "The real Session Start identity page could not be verified.",
      );

    if (holdThisRead) {
      held = true;
      heldReadCount++;
      pendingHeldReads++;
      await released;
      try {
        await route.fulfill({ response });
      } finally {
        pendingHeldReads--;
        if (!armed && pendingHeldReads === 0) settleHeldReads();
      }
      return;
    }
    await route.fulfill({ response });
  };
  await page.route(matcher, handler);

  return {
    arm() {
      held = false;
      heldReadCount = 0;
      pendingHeldReads = 0;
      armed = true;
      released = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      heldReadsSettled = new Promise<void>((resolve) => {
        settleHeldReads = resolve;
      });
    },
    held: () => held,
    heldReadCount: () => heldReadCount,
    release() {
      armed = false;
      releaseRead();
      if (pendingHeldReads === 0) settleHeldReads();
      return heldReadsSettled;
    },
    settled: () => heldReadsSettled,
    dispose: () => page.unroute(matcher, handler),
  };
}

export type VerifiedIdentityReadBarrier = Awaited<
  ReturnType<typeof verifiedIdentityReadBarrier>
>;
