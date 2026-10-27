import type { Page } from "@playwright/test";
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
  let armed = false;
  let held = false;
  let releaseRead: () => void = () => {};
  let released = Promise.resolve();

  await page.route(`**${path}`, async (route) => {
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

    const response = await route.fetch({
      headers: {
        ...(await request.allHeaders()),
        Origin: requestUrl.origin,
        "Sec-Fetch-Site": "same-origin",
      },
    });
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

    if (armed && (options.shouldHold?.() ?? true)) {
      armed = false;
      held = true;
      await released;
    }
    await route.fulfill({ response });
  });

  return {
    arm() {
      held = false;
      armed = true;
      released = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
    },
    held: () => held,
    release: () => releaseRead(),
  };
}
