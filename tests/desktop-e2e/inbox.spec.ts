import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { OPERATOR_HEADER } from "../../scripts/hearth/paths";
import { codexChatApprovalPageSchema } from "../../scripts/sessions/codex-chat-owned-protocol";
import { ownedCodingStateSchema } from "../../scripts/sessions/codex-owned-journal";
import { ownedCodingSessionSchema } from "../../scripts/sessions/codex-owned-wire-protocol";
import { openSettled } from "../e2e/fixtures";
import { pageToken } from "../e2e/launch-link";
import { HEARTH_HOME } from "../e2e/servers";
import { alpha, seedProjects, workspace } from "./project-fixtures";

const writeJournalKey = "agent-forge.desktop-bead-writes.v1";
const sessionsPath = join(HEARTH_HOME, "sessions", "registry.json");

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

test.beforeEach(() => {
  seedProjects();
  writeFileSync(
    join(HEARTH_HOME, "codex-chat-fixture-mode.json"),
    JSON.stringify("approval-command"),
  );
});

test("Inbox offers the current permission inline beside retained unknown writes", async ({
  page,
}) => {
  const priorSessions = new Set(sessions().map((session) => session.id));
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.addInitScript(
    ({ key, entry }) => {
      localStorage.setItem(key, JSON.stringify({ version: 1, entries: [entry] }));
    },
    {
      key: writeJournalKey,
      entry: {
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

  const approvalsPath =
    `/__agent-forge/projects/${alpha.id}/sessions/${session.id}/approvals`;
  let inboxNavigationStarted = false;
  let appApprovalReads = 0;
  let decisionPosts = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      inboxNavigationStarted &&
      request.method() === "GET" &&
      url.pathname === approvalsPath
    )
      appApprovalReads++;
    if (
      request.method() === "POST" &&
      url.pathname.endsWith("/approval-decisions")
    )
      decisionPosts++;
  });
  inboxNavigationStarted = true;
  await page
    .getByRole("navigation", { name: "Global", exact: true })
    .getByRole("link", { name: "Inbox", exact: true })
    .click();

  await expect(
    page
      .getByRole("region", { name: "Bead write outcomes", exact: true })
      .getByRole("heading", { name: "Inbox", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Outcome unknown", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Check alpha-epic", exact: true }),
  ).toBeVisible();
  expect(decisionPosts).toBe(0);

  // Causal RED: setup above proved the original offered choice is current and readable.
  // The current Inbox route has no inline permission action yet.
  await expect(
    page.getByRole("button", { name: "Allow once", exact: true }),
  ).toBeVisible();

  // Once the Inbox UI exists, prove its own discovery consumed the source read too.
  await expect.poll(() => appApprovalReads).toBeGreaterThan(0);
  expect(decisionPosts).toBe(0);
});
