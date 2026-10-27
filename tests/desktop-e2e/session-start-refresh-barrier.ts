import type { Page } from "@playwright/test";
import { z } from "zod";
import { sessionStartIdentityPageSchema } from "../../scripts/sessions/identity-protocol";

const successEnvelope = z
  .object({
    ok: z.literal(true),
    data: sessionStartIdentityPageSchema,
    error: z.null(),
  })
  .strict();

/** Hold one real identity read emitted after the preview audit event. */
export async function holdPreviewIdentityRefresh(
  page: Page,
  projectId: string,
  workspace: string,
) {
  let previewRequested = false;
  let held = false;
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
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

      if (previewRequested && !held) {
        held = true;
        await released;
      }
      await route.fulfill({ response });
    },
  );
  return {
    get isHeld() {
      return held;
    },
    release() {
      release();
    },
  };
}
