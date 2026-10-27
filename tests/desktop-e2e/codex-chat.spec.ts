import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  expect,
  type Locator,
  type Page,
  type Request,
  type Route,
  type TestInfo,
  test,
} from "@playwright/test";
import { z } from "zod";
import { OPERATOR_HEADER } from "../../scripts/hearth/paths";
import { serializeCodexChat } from "../../scripts/sessions/codex-app-server-protocol";
import { codexChatForkSourcePageSchema } from "../../scripts/sessions/codex-chat-fork-review-protocol";
import { codexChatApprovalPageSchema } from "../../scripts/sessions/codex-chat-owned-protocol";
import {
  ownedCodingPageSchema,
  ownedCodingStateSchema,
} from "../../scripts/sessions/codex-owned-journal";
import { ownedCodingSessionSchema } from "../../scripts/sessions/codex-owned-wire-protocol";
import { sessionStartIdentityPageSchema } from "../../scripts/sessions/identity-protocol";
import { sessionTranscriptExportSchema } from "../../scripts/sessions/library-protocol";
import { sessionOperationIdentityPageSchema } from "../../scripts/sessions/session-operation-identities-protocol";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import { pageToken } from "../e2e/launch-link";
import { HEARTH_HOME } from "../e2e/servers";
import {
  alpha,
  beta,
  catalog,
  catalogFile,
  seedProjects,
  workspace,
} from "./project-fixtures";

function records() {
  try {
    return ownedCodingSessionSchema
      .array()
      .parse(
        JSON.parse(
          readFileSync(join(HEARTH_HOME, "sessions", "registry.json"), "utf8"),
        ).records,
      );
  } catch {
    return [];
  }
}
function saved(id: string) {
  return ownedCodingStateSchema.parse(
    JSON.parse(
      readFileSync(join(HEARTH_HOME, "conversations", `${id}.json`), "utf8"),
    ),
  );
}
function calls(): Array<{
  kind: string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  pid?: number;
  childPid?: number;
  fixtureMode?: unknown;
  threadId?: unknown;
  turnId?: unknown;
}> {
  const path = join(HEARTH_HOME, "codex-chat-fixture-calls.jsonl");
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    throw Error("Invalid complete native Chat fixture log");
  }
}
function mode(value: string) {
  writeFileSync(
    join(HEARTH_HOME, "codex-chat-fixture-mode.json"),
    JSON.stringify(value),
  );
}
async function attachForkChildApprovalDiagnostic(info: TestInfo) {
  const allowedId = (value: unknown) =>
    typeof value === "string" && /^[0-9a-f-]{1,64}$/i.test(value)
      ? value
      : null;
  let fixtureRows: ReturnType<typeof calls> = [];
  let logReadError: string | null = null;
  try {
    fixtureRows = calls();
  } catch (error) {
    logReadError = error instanceof Error ? error.name.slice(0, 80) : "unknown";
  }
  const nativeFacts = fixtureRows.slice(-96).map((row) => {
    if (typeof row !== "object" || row === null)
      return { kind: "malformed-row" };
    const params = row.params;
    const result = row.result;
    const thread =
      typeof result === "object" && result !== null && "thread" in result
        ? (result as { thread?: unknown }).thread
        : null;
    const threadObject =
      typeof thread === "object" && thread !== null
        ? (thread as Record<string, unknown>)
        : null;
    const eventThread =
      params && typeof params === "object" && "thread" in params
        ? (params as Record<string, unknown>).thread
        : null;
    const eventThreadObject =
      typeof eventThread === "object" && eventThread !== null
        ? (eventThread as Record<string, unknown>)
        : null;
    const status = threadObject?.status;
    const threadStatus =
      typeof status === "object" && status !== null
        ? (status as Record<string, unknown>).type
        : null;
    const safeKind =
      typeof row.kind === "string" && /^[a-zA-Z0-9/._-]{1,80}$/.test(row.kind)
        ? row.kind
        : "other";
    const safeMethod =
      typeof row.method === "string" &&
      /^[a-zA-Z0-9/._-]{1,80}$/.test(row.method)
        ? row.method
        : null;
    const safeParams =
      typeof params === "object" && params !== null
        ? (params as Record<string, unknown>)
        : null;
    return {
      kind: safeKind,
      ...(safeMethod ? { method: safeMethod } : {}),
      ...(safeKind === "process" &&
      row.fixtureMode === "fork-service-tier-null-child-approval"
        ? { fixtureMode: row.fixtureMode }
        : {}),
      ...(safeParams
        ? {
            threadId: allowedId(safeParams.threadId),
            turnId: allowedId(safeParams.turnId),
            requestId: allowedId(safeParams.requestId),
            lastTurnId: allowedId(safeParams.lastTurnId),
          }
        : {}),
      ...(safeKind === "approval-offer"
        ? {
            threadId: allowedId(row.threadId),
            turnId: allowedId(row.turnId),
          }
        : {}),
      ...(eventThreadObject
        ? { eventThreadId: allowedId(eventThreadObject.id) }
        : {}),
      ...(threadObject
        ? {
            resultThreadId: allowedId(threadObject.id),
            resultParentId: allowedId(threadObject.forkedFromId),
            resultState:
              typeof threadStatus === "string" &&
              /^[a-zA-Z0-9_-]{1,32}$/.test(threadStatus)
                ? threadStatus
                : null,
          }
        : {}),
    };
  });
  const payload = {
    capturePhase: "approval-assertion-finally",
    ...(logReadError ? { logReadError } : {}),
    truncated: fixtureRows.length > 96 || forkJourneyHttpFacts.length > 96,
    nativeFacts,
    httpFacts: forkJourneyHttpFacts.slice(-96),
  };
  const body = Buffer.from(JSON.stringify(payload));
  const boundedBody =
    body.length <= 256 * 1024
      ? body
      : Buffer.from(
          JSON.stringify({
            capturePhase: payload.capturePhase,
            truncated: true,
            fixtureRows: fixtureRows.length,
            httpFactCount: forkJourneyHttpFacts.length,
          }),
        );
  try {
    await info.attach("fork-child-approval-diagnostic.json", {
      contentType: "application/json",
      body: boundedBody,
    });
  } catch (error) {
    const errorName =
      error instanceof Error ? error.name.slice(0, 80) : "unknown";
    const fallback = Buffer.from(
      JSON.stringify({
        ...payload,
        attachment: "failed",
        attachmentError: errorName,
      }),
    );
    if (fallback.length <= 256 * 1024) {
      try {
        const output = info.outputPath("fork-child-approval-diagnostic.json");
        mkdirSync(dirname(output), { recursive: true });
        writeFileSync(output, fallback);
        await info.attach("fork-child-approval-diagnostic.json", {
          contentType: "application/json",
          path: output,
        });
      } catch {
        // The existing assertion remains the primary outcome.
      }
    }
  }
}
async function verifiedIdentityReadBarrier(page: Page) {
  let armed = false,
    held = false,
    releaseRead: () => void = () => {},
    released = Promise.resolve();
  await page.route(
    `**/__agent-forge/projects/${alpha.id}/session-start-identities`,
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
        envelope.data.data.scope.projectId !== alpha.id ||
        envelope.data.data.scope.workspace !== workspace
      )
        throw Error(
          "The real Session Start identity page could not be verified.",
        );
      if (armed) {
        armed = false;
        held = true;
        await released;
      }
      await route.fulfill({ response });
    },
  );
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
async function startedChat(page: Page) {
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/sessions`);
  const dialog = await composer(page);
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  const pane = page.getByRole("region", {
    name: "Session conversation",
    exact: true,
  });
  await expect(pane).toBeVisible();
  await expect
    .poll(() => records().filter((row) => !previous.has(row.id)).length)
    .toBe(1);
  const record = records().find((row) => !previous.has(row.id));
  if (!record) throw Error("No accepted Chat record");
  return { pane, record };
}
async function completeForkSourceTurn(
  page: Page,
  pane: Locator,
  sessionId: string,
): Promise<string> {
  const priorIds = new Set(
    saved(sessionId).turns.map((turn) => turn.requestId),
  );
  const message = page.getByRole("textbox", {
    name: "Session reply prompt",
    exact: true,
  });
  await message.fill("PRIVATE_FORK_SOURCE_PROMPT");
  await pane
    .getByRole("button", { name: "Send session message", exact: true })
    .click();
  let selectedRequestId: string | null = null;
  await expect
    .poll(() => {
      const selected = saved(sessionId).turns.find(
        (turn) => !priorIds.has(turn.requestId),
      );
      if (!selected) return null;
      selectedRequestId = selected.requestId;
      return selected.phase;
    })
    .toBe("completed");
  if (!selectedRequestId)
    throw Error("The new Fork source turn was not recorded");
  return selectedRequestId;
}
let previous = new Set<string>();
let forkJourneyHttpFacts: Array<{
  method: string;
  path: string;
  status: number | null;
}> = [];
test.beforeEach(() => {
  seedProjects();
  for (const name of [
    "codex-chat-outcome-held.json",
    "codex-chat-outcome-release",
  ]) {
    const file = join(HEARTH_HOME, name);
    if (existsSync(file)) unlinkSync(file);
  }
  previous = new Set(records().map((record) => record.id));
  forkJourneyHttpFacts = [];
  mode("approval-command");
});
test.afterEach(async ({ page }) => {
  const info = test.info();
  if (
    info.title ===
      "native Chat web-search reports retain literal snapshots through export and reload without retrying the turn" &&
    info.status !== info.expectedStatus
  ) {
    try {
      const allCreated = records().filter((record) => !previous.has(record.id));
      let fixtureRows: ReturnType<typeof calls> = [];
      try {
        fixtureRows = calls();
      } catch {
        // The bounded attachment is best effort; never replace the test result.
      }
      const safeMethod = (method: unknown) =>
        typeof method === "string" && /^[a-zA-Z0-9/._-]{1,80}$/.test(method)
          ? method
          : "other";
      const created = allCreated.slice(0, 6);
      const callLimit = 32;
      const turnLimit = 8;
      const frameLimit = 48;
      let turnsTruncated = false;
      let framesTruncated = false;
      const journals = created.map((record) => {
        try {
          const state = saved(record.id);
          const turns = state.turns.slice(0, turnLimit);
          const frames = state.frames.slice(0, frameLimit);
          turnsTruncated ||= state.turns.length > turns.length;
          framesTruncated ||= state.frames.length > frames.length;
          return {
            readable: true,
            turns: turns.map((turn) => ({
              phase: turn.phase,
              reasonClass:
                turn.reason === null
                  ? null
                  : turn.reason === "The private Chat writer failed."
                    ? "private-writer-rejected"
                    : turn.reason ===
                        "The private Chat writer exceeded its deadline."
                      ? "private-writer-deadline"
                      : turn.reason ===
                          "The private Chat writer exceeded its queue bound."
                        ? "private-writer-queue-bound"
                        : "other",
            })),
            frames: frames.map(({ event }) =>
              event.kind === "coding-chat"
                ? {
                    family: event.kind,
                    nativeKind: event.event.kind,
                    source:
                      "source" in event.event
                        ? safeMethod(event.event.source)
                        : null,
                  }
                : { family: event.kind },
            ),
            truncated: {
              turns: state.turns.length > turns.length,
              frames: state.frames.length > frames.length,
            },
          };
        } catch {
          return { readable: false };
        }
      });
      const payload = {
        truncated: {
          sessions: allCreated.length > created.length,
          calls: fixtureRows.length > callLimit,
          turns: turnsTruncated,
          frames: framesTruncated,
        },
        createdSessionCount: allCreated.length,
        nativeFixtureCalls: fixtureRows.slice(0, callLimit).map((row) => ({
          kind: safeMethod(row.kind),
          ...(row.kind === "rpc" ? { method: safeMethod(row.method) } : {}),
        })),
        journals,
      };
      await info.attach("native-chat-web-search-failure-facts.json", {
        contentType: "application/json",
        body: Buffer.from(JSON.stringify(payload)),
      });
    } catch {
      // Diagnostic collection and attachment must not alter the primary result.
    }
  }
  await page.unrouteAll({ behavior: "ignoreErrors" });
  for (const record of records().filter((item) => !previous.has(item.id))) {
    try {
      const active = saved(record.id).turns.find((turn) =>
        ["accepted", "running", "cancelling"].includes(turn.phase),
      );
      if (!active) continue;
      const token = await pageToken(page);
      await page.evaluate(
        async ({ project, id, requestId, token, header }) => {
          await fetch(
            `/__agent-forge/projects/${project}/sessions/${id}/stop`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json", [header]: token },
              body: JSON.stringify({ requestId }),
            },
          );
        },
        {
          project: record.projectId,
          id: record.id,
          requestId: active.requestId,
          token,
          header: OPERATOR_HEADER,
        },
      );
      await expect
        .poll(() =>
          saved(record.id).turns.some((turn) =>
            ["accepted", "running", "cancelling"].includes(turn.phase),
          ),
        )
        .toBe(false);
    } catch {
      // Keep attempting Stop for other fixture sessions if one journal vanished.
    }
  }
});
async function composer(page: Page, capture = false, alreadyOpen = false) {
  if (!alreadyOpen)
    await page
      .getByRole("button", { name: "New session", exact: true })
      .click();
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
    .fill("PRIVATE native Chat first question");
  await dialog
    .getByRole("button", { name: "Check supported options", exact: true })
    .click();
  await expect(
    dialog.getByRole("region", {
      name: "Equivalent session command",
      exact: true,
    }),
  ).toContainText("app-server");
  await expect(
    dialog.getByRole("region", {
      name: "Equivalent session command",
      exact: true,
    }),
  ).not.toContainText("PRIVATE");
  await expect(
    dialog.getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
  if (capture && process.env.CODEX_CHAT_SHOTS) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({
      path: join(process.env.CODEX_CHAT_SHOTS, "codex-chat-composer.png"),
      fullPage: true,
      maskColor: "#1c1d24",
      mask: [
        dialog.getByRole("combobox", {
          name: "Session repository",
          exact: true,
        }),
        dialog.getByRole("textbox", { name: "Session prompt", exact: true }),
      ],
    });
    await page.setViewportSize({ width: 1100, height: 700 });
  }
  return dialog;
}

test("native Chat file snapshots remain literal and read-only through keyboard inspection, complete export and saved reload", async ({
  page,
}) => {
  mode("file-changes");
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const starts = calls().filter(
      (row) => row.kind === "rpc" && row.method === "turn/start",
    ).length,
    answers = calls().filter((row) => row.kind === "answer").length,
    posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST") posts.push(request.url());
  });
  const { pane, record } = await startedChat(page);
  await expect.poll(() => saved(record.id).turns[0]?.phase).toBe("completed");
  const activity = pane.getByRole("region", {
      name: "Reported session activity",
      exact: true,
    }),
    reports = activity.locator("details"),
    main = reports.filter({ hasText: "Item: reported-files-a" }),
    heading = main.locator("summary"),
    postMark = posts.length;
  await expect(reports).toHaveCount(4);
  await expect(main).not.toHaveAttribute("open");
  await expect(heading).toHaveText("File changes · Reported completed");
  await heading.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(heading).toBeFocused();
  await expect(heading).toHaveCSS("outline-width", "2px");
  await page.keyboard.press("Enter");
  await expect(main).toContainText("Latest full snapshot in this view");
  await expect(main.locator("li")).toHaveCount(2);
  await expect(main).toContainText("FILE_REPORT_MUST_NOT_CREATE.txt");
  await expect(main).toContainText("inert/<script>.ts");
  await expect(main).toContainText("Provider reported an empty diff");
  await expect(main).not.toContainText("superseded.ts");
  const patch = main.getByRole("region", {
    name: "Reported native diff",
    exact: true,
  });
  await expect(patch).toHaveText(
    "-old native line\n+<script>native patch stays text</script>",
  );
  await page.keyboard.press("Tab");
  await expect(patch).toBeFocused();
  await expect(patch).toHaveCSS("outline-width", "2px");
  await expect(main).toContainText(
    "Native turn reported completed. Item status is reported independently",
  );
  await expect(main).toContainText("app-server turn/completed");
  const failed = reports.filter({ hasText: "Item: reported-files-failed" }),
    declined = reports.filter({ hasText: "Item: reported-files-declined" }),
    clipped = reports.filter({ hasText: "Item: reported-files-clipped" });
  await failed.locator("summary").click();
  await expect(failed.locator("summary")).toHaveText(
    "File changes · Reported failed",
  );
  await expect(failed).toContainText("-reported failed patch");
  await declined.locator("summary").click();
  await expect(declined.locator("summary")).toHaveText(
    "File changes · Reported declined",
  );
  await expect(declined).toContainText("+reported declined patch");
  await clipped.locator("summary").click();
  await expect(clipped).toContainText("Snapshot truncated");
  await expect(clipped).toContainText("Diff text truncated");
  await expect(
    activity.locator("a, button, script, iframe, img, form"),
  ).toHaveCount(0);
  await expect(
    pane.getByRole("button", { name: "Allow once", exact: true }),
  ).toHaveCount(0);
  expect(existsSync(join(workspace, "FILE_REPORT_MUST_NOT_CREATE.txt"))).toBe(
    false,
  );
  const beforeReload = saved(record.id).frames,
    files = beforeReload.filter(
      (frame) =>
        frame.event.kind === "coding-chat" &&
        frame.event.event.kind === "file-change",
    );
  expect(files).toHaveLength(15);
  expect(files[2]?.event).toMatchObject({ event: { changes: [] } });
  await pane
    .getByRole("button", { name: "Session actions", exact: true })
    .click();
  const download = page.waitForEvent("download");
  await page
    .getByRole("dialog", { name: "Session actions", exact: true })
    .getByRole("button", { name: "Export saved transcript", exact: true })
    .click();
  const path = await (await download).path();
  if (!path) throw Error("No complete private native-file transcript download");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw Error("Invalid complete native-file transcript");
  }
  expect(sessionTranscriptExportSchema.parse(raw).conversation.frames).toEqual(
    beforeReload,
  );
  await reloadSettled(page);
  await expect(main).not.toHaveAttribute("open");
  await heading.click();
  await expect(patch).toHaveText(
    "-old native line\n+<script>native patch stays text</script>",
  );
  await expect(main).not.toContainText("superseded.ts");
  expect(saved(record.id).frames).toEqual(beforeReload);
  expect(posts).toHaveLength(postMark);
  expect(
    calls().filter((row) => row.kind === "rpc" && row.method === "turn/start"),
  ).toHaveLength(starts + 1);
  expect(calls().filter((row) => row.kind === "answer")).toHaveLength(answers);
  if (process.env.CODEX_CHAT_FILE_SHOTS) {
    await page.setViewportSize({ width: 1280, height: 1100 });
    await main.evaluate((node) => node.scrollIntoView({ block: "center" }));
    await expect
      .poll(() =>
        main.evaluate((node) => {
          const outer = node
              .closest(".af-owned-transcript")
              ?.getBoundingClientRect(),
            inner = node.getBoundingClientRect();
          return Boolean(
            outer && inner.top >= outer.top && inner.bottom <= outer.bottom,
          );
        }),
      )
      .toBe(true);
    await main.screenshot({
      path: join(
        process.env.CODEX_CHAT_FILE_SHOTS,
        "native-chat-file-changes.png",
      ),
      mask: [main.locator(".af-session-report-source")],
      maskColor: "#1c1d24",
    });
    await page.setViewportSize({ width: 1100, height: 700 });
  }
  await openSettled(
    page,
    `/index.html#/desktop/project/${beta.id}/sessions?selectionKind=session&selectionId=${record.id}`,
  );
  await expect(
    page.getByRole("region", {
      name: "Reported session activity",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByText("FILE_REPORT_MUST_NOT_CREATE.txt", { exact: true }),
  ).toHaveCount(0);
  expect(posts).toHaveLength(postMark);
  expect(existsSync(join(workspace, "FILE_REPORT_MUST_NOT_CREATE.txt"))).toBe(
    false,
  );
});

test("private native MCP snapshots reload as collapsed, literal, inert reports", async ({
  page,
}) => {
  mode("mcp-tool-calls");
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { pane, record } = await startedChat(page);
  await expect.poll(() => saved(record.id).turns[0]?.phase).toBe("completed");
  const inspectionPosts: string[] = [];
  const onInspectionRequest = (request: Request) => {
    if (request.method() === "POST") inspectionPosts.push(request.url());
  };
  page.on("request", onInspectionRequest);
  try {
    const before = saved(record.id),
      serialized = JSON.stringify(before.frames),
      reports = before.frames.filter(
        (frame) =>
          frame.event.kind === "coding-chat" &&
          frame.event.event.kind === "mcp-tool-call",
      );
    expect(reports).toHaveLength(9);
    expect(serialized).not.toContain("MCP_HINT_");
    expect(serialized).not.toContain("MCP_META_MUST_NOT_PERSIST");

    const activity = pane.getByRole("region", {
        name: "Reported session activity",
        exact: true,
      }),
      calls = activity.locator("details").filter({
        has: page.locator("summary", { hasText: /^MCP tool call/ }),
      });
    await expect(activity).toBeVisible();
    await expect(calls).toHaveCount(4);
    const main = calls.filter({
      has: page.locator("summary", { hasText: "inspect_result" }),
    });
    await expect(main).not.toHaveAttribute("open", "");
    await main.locator("summary").focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(main.locator("summary")).toBeFocused();
    await expect(main.locator("summary")).toHaveCSS("outline-width", "2px");
    await main.locator("summary").press("Enter");
    await expect(main).toContainText("MCP_ARGUMENT_LITERAL");
    await expect(main).toContainText("MCP_RESULT_LITERAL");
    await expect(main).toContainText("MCP_RESULT_URI_IS_LITERAL");
    await expect(main).toContainText("Reported duration: 27 ms");
    const argumentsReport = main.getByRole("region", {
      name: "Arguments report",
      exact: true,
    });
    await argumentsReport.focus();
    await expect(argumentsReport).toBeFocused();
    await expect(argumentsReport).toHaveCSS("outline-width", "2px");
    await expect(
      main.locator("a, img, script, iframe, button, form"),
    ).toHaveCount(0);

    const failed = calls.filter({
        has: page.locator("summary", { hasText: "report_failure" }),
      }),
      empty = calls.filter({
        has: page.locator("summary", { hasText: "report_empty" }),
      }),
      clipped = calls.filter({
        has: page.locator("summary", { hasText: "report_clipped" }),
      });
    await failed.locator("summary").click();
    await expect(failed).toContainText("MCP_ERROR_TEXT_SENTINEL");
    await expect(failed).toContainText(
      "Result not reported (native result was null)",
    );
    await empty.locator("summary").click();
    await expect(empty).toContainText("[]");
    await expect(empty).toContainText("Structured content not reported");
    await clipped.locator("summary").click();
    await expect(clipped).toContainText("Arguments truncated (size limit)");
    await expect(activity).not.toContainText("MCP_HINT_");
    await expect(activity).not.toContainText("MCP_META_MUST_NOT_PERSIST");

    await reloadSettled(page);
    await expect(page.locator("[data-session-state]")).toHaveAttribute(
      "data-session-state",
      "idle",
    );
    expect(saved(record.id).frames).toEqual(before.frames);
    const reopened = page
      .getByRole("region", { name: "Reported session activity", exact: true })
      .locator("details")
      .filter({ has: page.locator("summary", { hasText: /^MCP tool call/ }) });
    await expect(reopened).toHaveCount(4);
    for (const disclosure of await reopened.all())
      await expect(disclosure).not.toHaveAttribute("open", "");
    if (process.env.CODEX_CHAT_MCP_SHOTS) {
      const screenshotMain = reopened.filter({
        has: page.locator("summary", { hasText: "inspect_result" }),
      });
      await screenshotMain.locator("summary").press("Enter");
      await expect(screenshotMain).toContainText("MCP_ARGUMENT_LITERAL");
      const viewport = page.viewportSize();
      try {
        await page.setViewportSize({ width: 1280, height: 900 });
        await screenshotMain.scrollIntoViewIfNeeded();
        await screenshotMain.screenshot({
          path: join(
            process.env.CODEX_CHAT_MCP_SHOTS,
            "native-chat-mcp-tool-calls.png",
          ),
          mask: [screenshotMain.locator(".af-session-report-source")],
          maskColor: "#1c1d24",
        });
      } finally {
        if (viewport) await page.setViewportSize(viewport);
        if ((await screenshotMain.getAttribute("open")) !== null)
          await screenshotMain.locator("summary").press("Enter");
      }
    }
  } finally {
    page.off("request", onInspectionRequest);
  }
  expect(inspectionPosts).toEqual([]);
});

test("native Chat web-search reports retain literal snapshots through export and reload without retrying the turn", async ({
  page,
}) => {
  mode("web-search");
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const starts = calls().filter(
      (row) => row.kind === "rpc" && row.method === "turn/start",
    ).length,
    { pane, record } = await startedChat(page);
  await expect.poll(() => saved(record.id).turns[0]?.phase).toBe("completed");
  const inspectionPosts: string[] = [],
    onInspectionRequest = (request: Request) => {
      if (request.method() === "POST") inspectionPosts.push(request.url());
    };
  page.on("request", onInspectionRequest);
  try {
    const before = saved(record.id),
      serialized = JSON.stringify(before.frames),
      reports = before.frames.filter(
        (frame) =>
          frame.event.kind === "coding-chat" &&
          frame.event.event.kind === "web-search",
      );
    expect(reports).toHaveLength(12);
    expect(serialized).not.toContain("WEB_SEARCH_HINT_");
    expect(serialized).not.toContain("WEB_SEARCH_META_");

    const activity = pane.getByRole("region", {
        name: "Reported session activity",
        exact: true,
      }),
      searches = activity.locator("details").filter({
        has: page.locator("summary", { hasText: /^Web search/ }),
      }),
      main = searches.filter({ hasText: "Item: reported-web-search-main" });
    await expect(activity).toBeVisible();
    await expect(searches).toHaveCount(4);
    await expect(main).not.toHaveAttribute("open", "");
    const summary = main.locator("summary");
    await summary.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(summary).toBeFocused();
    await expect(summary).toHaveCSS("outline-width", "2px");
    await page.keyboard.press("Enter");
    await expect(main).toContainText("WEB_SEARCH_QUERY_LITERAL");
    await expect(main).toContainText("WEB_SEARCH_ACTION_QUERY_LITERAL");
    await expect(main).toContainText("WEB_SEARCH_RESULT_LITERAL");
    await expect(main).toContainText("WEB_SEARCH_URL_IS_LITERAL");
    await expect(main).toContainText("Reported closure: turn-ended");
    await expect(main).toContainText("Native turn reported completed");
    const result = main.getByRole("region", {
      name: "Reported results report",
      exact: true,
    });
    await result.focus();
    await expect(result).toBeFocused();
    await expect(result).toHaveCSS("outline-width", "2px");

    const empty = searches.filter({
        hasText: "Item: reported-web-search-empty",
      }),
      absent = searches.filter({
        hasText: "Item: reported-web-search-absent",
      }),
      clipped = searches.filter({
        hasText: "Item: reported-web-search-clipped",
      });
    await expect(empty).toContainText("Empty query text reported");
    await expect(empty).toContainText("[]");
    await expect(empty).toContainText("Action not reported");
    await expect(absent).toContainText("Results not reported");
    await expect(absent).toContainText("Action not reported");
    await expect(clipped).toContainText("Reported query truncated");
    await expect(clipped).toContainText("Reported results truncated");
    await expect(
      activity.locator("a, img, script, iframe, button, form"),
    ).toHaveCount(0);

    const beforeExport = saved(record.id).frames;
    expect(beforeExport).toEqual(before.frames);
    await pane
      .getByRole("button", { name: "Session actions", exact: true })
      .click();
    const download = page.waitForEvent("download");
    await page
      .getByRole("dialog", { name: "Session actions", exact: true })
      .getByRole("button", { name: "Export saved transcript", exact: true })
      .click();
    const path = await (await download).path();
    if (!path) throw Error("No complete private WebSearch transcript download");
    const exported = sessionTranscriptExportSchema.parse(
      JSON.parse(readFileSync(path, "utf8")),
    ).conversation;
    expect(exported.frames).toEqual(beforeExport);

    await reloadSettled(page);
    await expect(page.locator("[data-session-state]")).toHaveAttribute(
      "data-session-state",
      "idle",
    );
    expect(saved(record.id).frames).toEqual(beforeExport);
    const reopened = page
      .getByRole("region", { name: "Reported session activity", exact: true })
      .locator("details")
      .filter({ has: page.locator("summary", { hasText: /^Web search/ }) });
    await expect(reopened).toHaveCount(4);
    for (const disclosure of await reopened.all())
      await expect(disclosure).not.toHaveAttribute("open", "");
    expect(
      calls().filter(
        (row) => row.kind === "rpc" && row.method === "turn/start",
      ),
    ).toHaveLength(starts + 1);
    if (process.env.CODEX_CHAT_WEB_SEARCH_SHOTS) {
      const screenshotMain = reopened.filter({
        hasText: "Item: reported-web-search-main",
      });
      await screenshotMain.locator("summary").press("Enter");
      await expect(screenshotMain).toContainText("WEB_SEARCH_RESULT_LITERAL");
      const viewport = page.viewportSize();
      try {
        await page.setViewportSize({ width: 1280, height: 1400 });
        const finalNote = screenshotMain.locator(".af-session-note").last();
        await finalNote.scrollIntoViewIfNeeded();
        const noteFullyVisible = await finalNote.evaluate((note) => {
          const bounds = note.getBoundingClientRect();
          if (
            bounds.height <= 0 ||
            bounds.top < 0 ||
            bounds.bottom > window.innerHeight
          )
            return false;
          for (
            let parent = note.parentElement;
            parent;
            parent = parent.parentElement
          ) {
            const style = getComputedStyle(parent);
            if (!["auto", "scroll", "hidden", "clip"].includes(style.overflowY))
              continue;
            const clip = parent.getBoundingClientRect(),
              top = clip.top + parent.clientTop,
              bottom = top + parent.clientHeight;
            if (bounds.top < top || bounds.bottom > bottom) return false;
          }
          return true;
        });
        expect(noteFullyVisible).toBe(true);
        await screenshotMain.screenshot({
          path: join(
            process.env.CODEX_CHAT_WEB_SEARCH_SHOTS,
            "native-chat-web-search.png",
          ),
          mask: [screenshotMain.locator(".af-session-report-source")],
          maskColor: "#1c1d24",
        });
      } finally {
        if (viewport) await page.setViewportSize(viewport);
        if ((await screenshotMain.getAttribute("open")) !== null)
          await screenshotMain.locator("summary").press("Enter");
      }
    }
  } finally {
    page.off("request", onInspectionRequest);
  }
  expect(inspectionPosts).toEqual([]);
});

test("actual Stop preserves a partial native WebSearch snapshot without inventing turn completion", async ({
  page,
}) => {
  mode("web-search-held");
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const starts = calls().filter(
      (row) => row.kind === "rpc" && row.method === "turn/start",
    ).length,
    answers = calls().filter((row) => row.kind === "answer").length,
    callMark = calls().length,
    { pane, record } = await startedChat(page),
    activity = pane.getByRole("region", {
      name: "Reported session activity",
      exact: true,
    }),
    report = activity
      .locator("details")
      .filter({ hasText: "Item: reported-web-search-main" });
  await expect
    .poll(() =>
      saved(record.id).frames.filter(
        (frame) =>
          frame.event.kind === "coding-chat" &&
          frame.event.event.kind === "web-search",
      ),
    )
    .toHaveLength(1);
  await expect
    .poll(
      () =>
        calls()
          .slice(callMark)
          .filter((row) => row.kind === "tree").length,
    )
    .toBe(1);
  await report.locator("summary").click();
  await expect(report.locator("summary")).toContainText("Partial report");
  await expect(report).toContainText("WEB_SEARCH_QUERY_LITERAL");
  await expect(report).toContainText("Reported closure: open");
  await expect(report).not.toContainText("Native turn reported");
  await expect(
    activity.locator("a, img, script, iframe, button, form"),
  ).toHaveCount(0);
  const stop = pane.getByRole("button", { name: "Stop session", exact: true });
  await stop.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(stop).toBeFocused();
  await expect(stop).toHaveCSS("outline-width", "2px");
  await page.keyboard.press("Enter");
  await expect.poll(() => saved(record.id).turns[0]?.phase).toBe("cancelled");
  await expect(pane.locator("[data-session-state]")).toHaveAttribute(
    "data-session-state",
    "stopped",
  );
  const final = saved(record.id),
    tree = calls()
      .slice(callMark)
      .find((row) => row.kind === "tree");
  expect(
    final.frames.filter(
      (frame) =>
        frame.event.kind === "coding-chat" &&
        frame.event.event.kind === "web-search",
    ),
  ).toHaveLength(1);
  for (const pid of [tree?.pid, tree?.childPid]) {
    if (typeof pid !== "number")
      throw Error("Missing witnessed stopped WebSearch process PID");
    let alive = false;
    try {
      const zombie =
        process.platform === "linux" &&
        /\) Z(?: |$)/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
      if (!zombie) {
        process.kill(pid, 0);
        alive = true;
      }
    } catch {
      /* No live owned process. */
    }
    expect(alive).toBe(false);
  }
  await reloadSettled(page);
  await report.locator("summary").click();
  await expect(report).toContainText("Partial report");
  await expect(report).not.toContainText("Native turn reported");
  expect(saved(record.id).frames).toEqual(final.frames);
  expect(
    calls().filter((row) => row.kind === "rpc" && row.method === "turn/start"),
  ).toHaveLength(starts + 1);
  expect(calls().filter((row) => row.kind === "answer")).toHaveLength(answers);
});

test("actual Stop retains the exact intended private native file snapshots and ends the provider/helper without inventing completion", async ({
  page,
}) => {
  mode("file-changes-held");
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const callMark = calls().length,
    starts = calls().filter(
      (row) => row.kind === "rpc" && row.method === "turn/start",
    ).length,
    answers = calls().filter((row) => row.kind === "answer").length,
    { pane, record } = await startedChat(page),
    activity = pane.getByRole("region", {
      name: "Reported session activity",
      exact: true,
    }),
    main = activity
      .locator("details")
      .filter({ hasText: "Item: reported-files-a" });
  await expect
    .poll(() => {
      const state = saved(record.id),
        files = state.frames.flatMap((frame) =>
          frame.event.kind === "coding-chat" &&
          frame.event.event.kind === "file-change"
            ? [frame.event.event]
            : [],
        );
      return files.map((report) => ({
        source: report.source,
        item: report.itemId,
        status: report.status,
        partial: report.partial,
        paths: report.changes.map((change) => change.path.text),
      }));
    })
    .toEqual([
      {
        source: "item/started",
        item: "reported-files-a",
        status: "inProgress",
        partial: true,
        paths: ["FILE_REPORT_MUST_NOT_CREATE.txt", "empty-native.ts"],
      },
      {
        source: "item/fileChange/patchUpdated",
        item: "reported-files-a",
        status: "inProgress",
        partial: true,
        paths: ["superseded.ts"],
      },
      {
        source: "item/fileChange/patchUpdated",
        item: "reported-files-a",
        status: "inProgress",
        partial: true,
        paths: [],
      },
      {
        source: "item/fileChange/patchUpdated",
        item: "reported-files-a",
        status: "inProgress",
        partial: true,
        paths: ["FILE_REPORT_MUST_NOT_CREATE.txt", "empty-native.ts"],
      },
    ]);
  await expect
    .poll(
      () =>
        calls()
          .slice(callMark)
          .filter((row) => row.kind === "tree").length,
    )
    .toBe(1);
  await main.locator("summary").click();
  await expect(main.locator("summary")).toHaveText(
    "File changes · Reported in progress · Partial report",
  );
  await expect(
    main.getByRole("region", { name: "Reported native diff", exact: true }),
  ).toHaveText("-old native line\n+<script>native patch stays text</script>");
  await expect(main).toContainText("last observed item status");
  await expect(main).not.toContainText("superseded.ts");
  await expect(
    activity.locator("a, button, script, iframe, img, form"),
  ).toHaveCount(0);
  const stop = pane.getByRole("button", { name: "Stop session", exact: true });
  await stop.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(stop).toBeFocused();
  await expect(stop).toHaveCSS("outline-width", "2px");
  await page.keyboard.press("Enter");
  await expect.poll(() => saved(record.id).turns[0]?.phase).toBe("cancelled");
  await expect(pane.locator("[data-session-state]")).toHaveAttribute(
    "data-session-state",
    "stopped",
  );
  const state = saved(record.id),
    tree = calls()
      .slice(callMark)
      .find((row) => row.kind === "tree");
  expect(
    state.frames.filter(
      (frame) =>
        frame.event.kind === "coding-chat" &&
        frame.event.event.kind === "file-change",
    ),
  ).toHaveLength(4);
  for (const pid of [tree?.pid, tree?.childPid]) {
    if (typeof pid !== "number")
      throw Error("Missing witnessed stopped native-file PID");
    let alive = false;
    try {
      const zombie =
        process.platform === "linux" &&
        /\) Z(?: |$)/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
      if (!zombie) {
        process.kill(pid, 0);
        alive = true;
      }
    } catch {
      /* No live owned process. */
    }
    expect(alive).toBe(false);
  }
  await reloadSettled(page);
  await main.locator("summary").click();
  await expect(main).toContainText("Partial report");
  await expect(main).not.toContainText("Native turn reported completed");
  expect(saved(record.id).frames).toEqual(state.frames);
  expect(
    calls().filter((row) => row.kind === "rpc" && row.method === "turn/start"),
  ).toHaveLength(starts + 1);
  expect(calls().filter((row) => row.kind === "answer")).toHaveLength(answers);
  expect(existsSync(join(workspace, "FILE_REPORT_MUST_NOT_CREATE.txt"))).toBe(
    false,
  );
});

test("an inspectable native file diff still cannot grant Allow or turn inspection into a permission decision", async ({
  page,
}) => {
  mode("file-changes-approval");
  const answers = calls().filter((row) => row.kind === "answer").length,
    { pane, record } = await startedChat(page),
    activity = pane.getByRole("region", {
      name: "Reported session activity",
      exact: true,
    }),
    main = activity
      .locator("details")
      .filter({ hasText: "Item: reported-files-a" });
  await expect
    .poll(
      () =>
        saved(record.id).frames.filter(
          (frame) =>
            frame.event.kind === "coding-chat" &&
            frame.event.event.kind === "file-change",
        ).length,
    )
    .toBe(4);
  await main.locator("summary").click();
  await expect(
    main.getByRole("region", { name: "Reported native diff", exact: true }),
  ).toHaveText("-old native line\n+<script>native patch stays text</script>");
  const approval = pane.getByRole("article", {
    name: "Native file approval",
    exact: true,
  });
  await expect(approval).toBeVisible();
  await expect(approval).toContainText(
    "Actual file-change details are unavailable. Allow is disabled.",
  );
  await expect(
    approval.getByRole("button", { name: "Allow once", exact: true }),
  ).toHaveCount(0);
  await expect(
    approval.getByRole("button", {
      name: "Allow once · unavailable",
      exact: true,
    }),
  ).toBeDisabled();
  expect(calls().filter((row) => row.kind === "answer")).toHaveLength(answers);
  await approval.getByRole("button", { name: "Decline", exact: true }).click();
  await expect.poll(() => saved(record.id).turns[0]?.phase).toBe("completed");
  await expect(main.locator("summary")).toHaveText(
    "File changes · Reported declined",
  );
  expect(calls().filter((row) => row.kind === "answer")).toHaveLength(
    answers + 1,
  );
  expect(
    calls()
      .filter((row) => row.kind === "answer")
      .at(-1)?.result,
  ).toEqual({ decision: "decline" });
  expect(existsSync(join(workspace, "FILE_REPORT_MUST_NOT_CREATE.txt"))).toBe(
    false,
  );
});

test("native Chat turn plans keep only the latest supplied snapshot through keyboard inspection, complete export and saved reload", async ({
  page,
}) => {
  mode("turn-plan");
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const starts = calls().filter(
      (row) => row.kind === "rpc" && row.method === "turn/start",
    ).length,
    answers = calls().filter((row) => row.kind === "answer").length,
    { pane, record } = await startedChat(page);
  await expect.poll(() => saved(record.id).turns[0]?.phase).toBe("completed");
  const activity = pane.getByRole("region", {
      name: "Reported session activity",
      exact: true,
    }),
    disclosure = activity.locator("details"),
    heading = disclosure.locator("summary");
  await expect(disclosure).toHaveCount(1);
  await expect(heading).toHaveText("Reported turn plan");
  await expect(disclosure).not.toHaveAttribute("open");
  await heading.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(heading).toBeFocused();
  await expect(heading).toHaveCSS("outline-width", "2px");
  await page.keyboard.press("Enter");
  await expect(activity).toContainText("Latest reported snapshot in this view");
  await expect(activity).toContainText(
    "The provider revised its supplied plan.",
  );
  await expect(activity.locator("li")).toHaveCount(2);
  await expect(activity.locator("li").nth(0)).toContainText(
    "Inspect the supplied context",
  );
  await expect(activity.locator("li").nth(0)).toContainText("Completed");
  await expect(activity.locator("li").nth(1)).toContainText(
    "Check the revised result",
  );
  await expect(activity.locator("li").nth(1)).toContainText("In progress");
  await expect(activity).not.toContainText("Check the result");
  await expect(activity).toContainText(
    "Step status does not confirm that the chat turn has finished",
  );
  await expect(activity).toContainText("app-server turn/plan/updated");
  await expect(activity.locator("a, button, script, iframe, img")).toHaveCount(
    0,
  );
  await expect(
    pane.getByRole("article", { name: "Native command approval", exact: true }),
  ).toHaveCount(0);
  const beforeReload = saved(record.id).frames,
    plans = beforeReload.filter(
      (frame) =>
        frame.event.kind === "coding-chat" &&
        frame.event.event.kind === "turn-plan",
    );
  expect(plans).toHaveLength(3);
  expect(plans[0]?.event).toEqual(plans[1]?.event);
  expect(plans[2]?.event).not.toEqual(plans[0]?.event);
  await pane
    .getByRole("button", { name: "Session actions", exact: true })
    .click();
  const download = page.waitForEvent("download");
  await page
    .getByRole("dialog", { name: "Session actions", exact: true })
    .getByRole("button", { name: "Export saved transcript", exact: true })
    .click();
  const path = await (await download).path();
  if (!path) throw Error("No complete private turn-plan transcript download");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw Error("Invalid complete turn-plan transcript");
  }
  expect(sessionTranscriptExportSchema.parse(raw).conversation.frames).toEqual(
    beforeReload,
  );
  await reloadSettled(page);
  await heading.click();
  await expect(activity).toContainText("Check the revised result");
  await expect(activity.locator("li")).toHaveCount(2);
  expect(saved(record.id).frames).toEqual(beforeReload);
  expect(
    calls().filter((row) => row.kind === "rpc" && row.method === "turn/start"),
  ).toHaveLength(starts + 1);
  expect(calls().filter((row) => row.kind === "answer")).toHaveLength(answers);
  await openSettled(
    page,
    `/index.html#/desktop/project/${beta.id}/sessions?selectionKind=session&selectionId=${record.id}`,
  );
  await expect(
    page.getByRole("region", {
      name: "Reported session activity",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Check the revised result", { exact: true }),
  ).toHaveCount(0);
  if (process.env.CODEX_CHAT_PLAN_SHOTS) {
    // Keep every functional assertion at1100×700; the optional review capture
    // is taken afterward with enough height for the entire inert disclosure.
    await openSettled(
      page,
      `/index.html#/desktop/project/${alpha.id}/sessions?selectionKind=session&selectionId=${record.id}`,
    );
    await expect(disclosure).not.toHaveAttribute("open");
    await heading.click();
    await expect(activity).toContainText("Check the revised result");
    await page.setViewportSize({ width: 1280, height: 1100 });
    await activity.evaluate((node) => node.scrollIntoView({ block: "center" }));
    await expect
      .poll(() =>
        activity.evaluate((node) => {
          const outer = node
              .closest(".af-owned-transcript")
              ?.getBoundingClientRect(),
            inner = node.getBoundingClientRect();
          return Boolean(
            outer && inner.top >= outer.top && inner.bottom <= outer.bottom,
          );
        }),
      )
      .toBe(true);
    await activity.screenshot({
      path: join(
        process.env.CODEX_CHAT_PLAN_SHOTS,
        "native-chat-turn-plan.png",
      ),
      maskColor: "#1c1d24",
    });
    await page.setViewportSize({ width: 1100, height: 700 });
    expect(saved(record.id).frames).toEqual(beforeReload);
    expect(
      calls().filter(
        (row) => row.kind === "rpc" && row.method === "turn/start",
      ),
    ).toHaveLength(starts + 1);
  }
});

test("actual Stop retains completed native plan steps without treating their status as chat completion or granting an action", async ({
  page,
}) => {
  mode("turn-plan-held");
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const starts = calls().filter(
      (row) => row.kind === "rpc" && row.method === "turn/start",
    ).length,
    answers = calls().filter((row) => row.kind === "answer").length,
    { pane, record } = await startedChat(page),
    activity = pane.getByRole("region", {
      name: "Reported session activity",
      exact: true,
    }),
    heading = activity.locator("summary", { hasText: "Reported turn plan" });
  await heading.click();
  await expect(activity).toContainText("Check the revised result");
  await expect(activity.locator("li")).toHaveCount(2);
  await expect(activity.locator("li").nth(0)).toContainText("Completed");
  await expect(activity.locator("li").nth(1)).toContainText("Completed");
  await expect(pane.locator("[data-session-state]")).toHaveAttribute(
    "data-session-state",
    "running",
  );
  expect(saved(record.id).turns[0]?.phase).toBe("running");
  await expect(activity.locator("a, button, script, iframe, img")).toHaveCount(
    0,
  );
  await expect(
    pane.getByRole("button", { name: "Allow once", exact: true }),
  ).toHaveCount(0);
  const stop = pane.getByRole("button", { name: "Stop session", exact: true });
  await stop.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(stop).toBeFocused();
  await expect(stop).toHaveCSS("outline-width", "2px");
  await page.keyboard.press("Enter");
  await expect.poll(() => saved(record.id).turns[0]?.phase).toBe("cancelled");
  await expect(pane.locator("[data-session-state]")).toHaveAttribute(
    "data-session-state",
    "stopped",
  );
  const state = saved(record.id),
    plans = state.frames.filter(
      (frame) =>
        frame.event.kind === "coding-chat" &&
        frame.event.event.kind === "turn-plan",
    ),
    tree = calls()
      .filter((row) => row.kind === "tree")
      .at(-1);
  expect(plans).toHaveLength(3);
  if (typeof tree?.pid !== "number" || typeof tree.childPid !== "number")
    throw Error("Missing actual stopped plan fixture tree");
  const providerPid = tree.pid,
    childPid = tree.childPid;
  expect(() => process.kill(providerPid, 0)).toThrow();
  expect(() => process.kill(childPid, 0)).toThrow();
  await reloadSettled(page);
  await heading.click();
  await expect(activity).toContainText("Check the revised result");
  await expect(activity.locator("li").nth(1)).toContainText("Completed");
  await expect(pane.locator("[data-session-state]")).toHaveAttribute(
    "data-session-state",
    "stopped",
  );
  expect(saved(record.id).frames).toEqual(state.frames);
  expect(
    calls().filter((row) => row.kind === "rpc" && row.method === "turn/start"),
  ).toHaveLength(starts + 1);
  expect(calls().filter((row) => row.kind === "answer")).toHaveLength(answers);
});

test("native Chat reasoning summaries remain explicit, inert and independently indexed through keyboard inspection, complete export and saved reload", async ({
  page,
}) => {
  mode("reasoning-summary");
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const starts = calls().filter(
      (row) => row.kind === "rpc" && row.method === "turn/start",
    ).length,
    answers = calls().filter((row) => row.kind === "answer").length;
  const { pane, record } = await startedChat(page);
  await expect.poll(() => saved(record.id).turns[0]?.phase).toBe("completed");
  const activity = pane.getByRole("region", {
      name: "Reported session activity",
      exact: true,
    }),
    disclosure = activity.locator("details"),
    heading = disclosure.locator("summary");
  await expect(disclosure).toHaveCount(1);
  await expect(heading).toHaveText("Reported reasoning summary");
  await expect(disclosure).not.toHaveAttribute("open");
  await heading.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(heading).toBeFocused();
  await expect(heading).toHaveCSS("outline-width", "2px");
  await page.keyboard.press("Enter");
  const first = activity.getByRole("region", {
    name: "Streamed summary · Native index 0 report",
    exact: true,
  });
  await expect(first).toHaveText("Visible summary one.");
  await expect(
    activity.getByRole("region", {
      name: "Streamed summary · Native index 1 report",
      exact: true,
    }),
  ).toHaveText("Visible summary two.");
  await expect(
    activity.getByRole("region", {
      name: "Final reported snapshot · Part 1 report",
      exact: true,
    }),
  ).toHaveText("Visible summary one.");
  await expect(
    activity.getByRole("region", {
      name: "Final reported snapshot · Part 2 report",
      exact: true,
    }),
  ).toHaveText("Visible summary two.");
  await expect(activity).toContainText(
    "No summary text was reported in this snapshot",
  );
  await expect(activity).toContainText(
    "Reported native turn status: completed",
  );
  await expect(activity).not.toContainText("RAW_REASONING_MUST_NOT_PERSIST");
  await expect(activity.locator("a, button, script, iframe, img")).toHaveCount(
    0,
  );
  await expect(
    pane.getByRole("article", { name: "Native command approval", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(first).toBeFocused();
  await expect(first).toHaveCSS("outline-width", "2px");
  const beforeReload = saved(record.id).frames;
  expect(JSON.stringify(beforeReload)).not.toContain(
    "RAW_REASONING_MUST_NOT_PERSIST",
  );
  await pane
    .getByRole("button", { name: "Session actions", exact: true })
    .click();
  const download = page.waitForEvent("download");
  await page
    .getByRole("dialog", { name: "Session actions", exact: true })
    .getByRole("button", { name: "Export saved transcript", exact: true })
    .click();
  const path = await (await download).path();
  if (!path) throw Error("No complete private summary transcript download");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw Error("Invalid complete summary transcript");
  }
  const exported = sessionTranscriptExportSchema.parse(raw).conversation;
  expect(exported.frames).toEqual(beforeReload);
  expect(JSON.stringify(exported)).not.toContain(
    "RAW_REASONING_MUST_NOT_PERSIST",
  );
  await reloadSettled(page);
  await heading.click();
  await expect(first).toHaveText("Visible summary one.");
  await expect(activity).toContainText(
    "Reported native turn status: completed",
  );
  expect(saved(record.id).frames).toEqual(beforeReload);
  expect(
    calls().filter((row) => row.kind === "rpc" && row.method === "turn/start"),
  ).toHaveLength(starts + 1);
  expect(calls().filter((row) => row.kind === "answer")).toHaveLength(answers);
  await openSettled(
    page,
    `/index.html#/desktop/project/${beta.id}/sessions?selectionKind=session&selectionId=${record.id}`,
  );
  await expect(
    page.getByRole("region", {
      name: "Reported session activity",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Visible summary one.", { exact: true }),
  ).toHaveCount(0);
  if (process.env.CODEX_CHAT_REASONING_SHOTS) {
    // All functional checks above use the minimum desktop size. Capture this
    // longer disclosure afterward in a taller review-only viewport.
    await openSettled(
      page,
      `/index.html#/desktop/project/${alpha.id}/sessions?selectionKind=session&selectionId=${record.id}`,
    );
    await expect(disclosure).not.toHaveAttribute("open");
    await heading.click();
    await expect(first).toHaveText("Visible summary one.");
    await page.setViewportSize({ width: 1280, height: 1600 });
    await activity.evaluate((node) => node.scrollIntoView({ block: "center" }));
    await expect
      .poll(() =>
        activity.evaluate((node) => {
          const outer = node
              .closest(".af-owned-transcript")
              ?.getBoundingClientRect(),
            inner = node.getBoundingClientRect();
          return Boolean(
            outer && inner.top >= outer.top && inner.bottom <= outer.bottom,
          );
        }),
      )
      .toBe(true);
    await activity.screenshot({
      path: join(
        process.env.CODEX_CHAT_REASONING_SHOTS,
        "native-chat-reasoning-summary.png",
      ),
      maskColor: "#1c1d24",
    });
    await page.setViewportSize({ width: 1100, height: 700 });
    expect(saved(record.id).frames).toEqual(beforeReload);
    expect(
      calls().filter(
        (row) => row.kind === "rpc" && row.method === "turn/start",
      ),
    ).toHaveLength(starts + 1);
  }
});

test("actual Stop preserves a partial native reasoning summary without inventing a final snapshot, reply or permission authority", async ({
  page,
}) => {
  mode("reasoning-summary-held");
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const starts = calls().filter(
      (row) => row.kind === "rpc" && row.method === "turn/start",
    ).length,
    answers = calls().filter((row) => row.kind === "answer").length;
  const { pane, record } = await startedChat(page);
  const activity = pane.getByRole("region", {
      name: "Reported session activity",
      exact: true,
    }),
    heading = activity.locator("summary", {
      hasText: "Reported reasoning summary · Partial report",
    });
  await heading.click();
  await expect(
    activity.getByRole("region", {
      name: "Streamed summary · Native index 0 report",
      exact: true,
    }),
  ).toHaveText("Visible summary one.");
  await expect(
    activity.getByRole("region", {
      name: "Streamed summary · Native index 1 report",
      exact: true,
    }),
  ).toHaveText("Visible summary two.");
  await expect(activity).not.toContainText("Final reported snapshot");
  await expect(
    pane.getByRole("button", { name: "Allow once", exact: true }),
  ).toHaveCount(0);
  await pane.getByRole("button", { name: "Stop session", exact: true }).click();
  await expect.poll(() => saved(record.id).turns[0]?.phase).toBe("cancelled");
  await expect(pane.locator("[data-session-state]")).toHaveAttribute(
    "data-session-state",
    "stopped",
  );
  const state = saved(record.id),
    summaries = state.frames.filter(
      (frame) =>
        frame.event.kind === "coding-chat" &&
        frame.event.event.kind === "reasoning-summary",
    );
  expect(summaries).toHaveLength(6);
  expect(
    summaries.every(
      (frame) =>
        frame.event.kind === "coding-chat" &&
        frame.event.event.kind === "reasoning-summary" &&
        frame.event.event.partial,
    ),
  ).toBe(true);
  expect(JSON.stringify(state)).not.toContain("RAW_REASONING_MUST_NOT_PERSIST");
  const tree = calls()
    .filter((row) => row.kind === "tree")
    .at(-1);
  if (typeof tree?.pid !== "number" || typeof tree.childPid !== "number")
    throw Error("Missing actual stopped native fixture tree");
  expect(() => process.kill(tree.pid!, 0)).toThrow();
  expect(() => process.kill(tree.childPid!, 0)).toThrow();
  await reloadSettled(page);
  await heading.click();
  await expect(
    activity.getByRole("region", {
      name: "Streamed summary · Native index 0 report",
      exact: true,
    }),
  ).toHaveText("Visible summary one.");
  await expect(activity).not.toContainText("Final reported snapshot");
  await expect(pane.locator("[data-session-state]")).toHaveAttribute(
    "data-session-state",
    "stopped",
  );
  expect(saved(record.id).frames).toEqual(state.frames);
  expect(
    calls().filter((row) => row.kind === "rpc" && row.method === "turn/start"),
  ).toHaveLength(starts + 1);
  expect(calls().filter((row) => row.kind === "answer")).toHaveLength(answers);
});

test("native Chat command reports show inert streamed and aggregate output with exact completion after saved reload", async ({
  page,
}) => {
  mode("command-activity");
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const starts = calls().filter(
    (row) => row.kind === "rpc" && row.method === "turn/start",
  ).length;
  const answers = calls().filter((row) => row.kind === "answer").length;
  const { pane, record } = await startedChat(page);
  await expect.poll(() => saved(record.id).turns[0]?.phase).toBe("completed");
  const activity = pane.getByRole("region", {
    name: "Reported session activity",
    exact: true,
  });
  const summary = activity.locator("summary", {
    hasText: "Command · Reported completed",
  });
  await expect(summary).toBeVisible();
  await summary.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(summary).toBeFocused();
  await expect(summary).toHaveCSS("outline-width", "2px");
  await page.keyboard.press("Enter");
  await expect(
    activity.getByRole("region", { name: "Command report", exact: true }),
  ).toHaveText("inert command <script> stays text");
  await expect(
    activity.getByRole("region", {
      name: "Streamed output report",
      exact: true,
    }),
  ).toHaveText("Reported line one\n");
  await expect(
    activity.getByRole("region", {
      name: "Reported aggregate output report",
      exact: true,
    }),
  ).toHaveText("Reported line one\nReported line two\n");
  await expect(activity).toContainText("Reported exit code: 0");
  await expect(activity).toContainText("Reported duration: 12 ms");
  await expect(activity).toContainText("app-server item/completed");
  await expect(activity.locator("script, iframe, img, a, button")).toHaveCount(
    0,
  );
  await expect(
    pane.getByRole("article", { name: "Native command approval", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(
    activity.getByRole("region", { name: "Command report", exact: true }),
  ).toBeFocused();
  await expect(
    activity.getByRole("region", { name: "Command report", exact: true }),
  ).toHaveCSS("outline-width", "2px");
  if (process.env.CODEX_CHAT_COMMAND_SHOTS) {
    // The live1100px assertions above remain the behavior check. Capture the
    // entire inert report in a taller review viewport, outside the reply bar.
    await page.setViewportSize({ width: 1280, height: 1100 });
    await activity.evaluate((node) => node.scrollIntoView({ block: "center" }));
    await expect
      .poll(() =>
        activity.evaluate((node) => {
          const outer = node
            .closest(".af-owned-transcript")
            ?.getBoundingClientRect();
          const inner = node.getBoundingClientRect();
          return Boolean(
            outer && inner.top >= outer.top && inner.bottom <= outer.bottom,
          );
        }),
      )
      .toBe(true);
    await activity.screenshot({
      path: join(
        process.env.CODEX_CHAT_COMMAND_SHOTS,
        "native-chat-command.png",
      ),
      maskColor: "#1c1d24",
      mask: [
        activity.locator(".af-session-note", {
          hasText: "Reported working directory:",
        }),
      ],
    });
    await page.setViewportSize({ width: 1100, height: 700 });
  }
  const beforeReload = saved(record.id).frames;
  await reloadSettled(page);
  await activity
    .locator("summary", { hasText: "Command · Reported completed" })
    .click();
  await expect(activity).toContainText("Reported exit code: 0");
  await expect(
    activity.getByRole("region", {
      name: "Streamed output report",
      exact: true,
    }),
  ).toHaveText("Reported line one\n");
  expect(saved(record.id).frames).toEqual(beforeReload);
  expect(
    calls().filter((row) => row.kind === "rpc" && row.method === "turn/start"),
  ).toHaveLength(starts + 1);
  expect(calls().filter((row) => row.kind === "answer")).toHaveLength(answers);
  await openSettled(
    page,
    `/index.html#/desktop/project/${beta.id}/sessions?selectionKind=session&selectionId=${record.id}`,
  );
  await expect(
    page.getByRole("region", {
      name: "Reported session activity",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByText("inert command <script> stays text", { exact: true }),
  ).toHaveCount(0);
});

test("actual Stop retains a partial native command stream without inventing completion or permission authority", async ({
  page,
}) => {
  mode("command-activity-held");
  const starts = calls().filter(
    (row) => row.kind === "rpc" && row.method === "turn/start",
  ).length;
  const answers = calls().filter((row) => row.kind === "answer").length;
  const { pane, record } = await startedChat(page);
  const activity = pane.getByRole("region", {
    name: "Reported session activity",
    exact: true,
  });
  await activity
    .locator("summary", {
      hasText: "Command · Reported in progress · Partial report",
    })
    .click();
  await expect(
    activity.getByRole("region", {
      name: "Streamed output report",
      exact: true,
    }),
  ).toHaveText("Reported line one\n");
  await expect(activity).toContainText("Exit code not reported");
  await expect(activity).toContainText("Final aggregate output not reported");
  await expect(
    pane.getByRole("button", { name: "Allow once", exact: true }),
  ).toHaveCount(0);
  await pane.getByRole("button", { name: "Stop session", exact: true }).click();
  await expect.poll(() => saved(record.id).turns[0]?.phase).toBe("cancelled");
  await expect(pane.locator("[data-session-state]")).toHaveAttribute(
    "data-session-state",
    "stopped",
  );
  await expect(activity.locator("summary")).toContainText("Partial report");
  const commands = saved(record.id).frames.filter(
    (frame) =>
      frame.event.kind === "coding-chat" &&
      frame.event.event.kind === "command",
  );
  expect(commands).toHaveLength(2);
  expect(commands.at(-1)?.event).toMatchObject({
    event: {
      source: "item/commandExecution/outputDelta",
      status: "inProgress",
      partial: true,
      exitCode: null,
    },
  });
  await reloadSettled(page);
  await activity
    .locator("summary", {
      hasText: "Command · Reported in progress · Partial report",
    })
    .click();
  await expect(
    activity.getByRole("region", {
      name: "Streamed output report",
      exact: true,
    }),
  ).toHaveText("Reported line one\n");
  await expect(activity).toContainText("Exit code not reported");
  await expect(pane.locator("[data-session-state]")).toHaveAttribute(
    "data-session-state",
    "stopped",
  );
  expect(
    calls().filter((row) => row.kind === "rpc" && row.method === "turn/start"),
  ).toHaveLength(starts + 1);
  expect(calls().filter((row) => row.kind === "answer")).toHaveLength(answers);
});

test("Codex Chat reviews native options, allows one actual command and resumes its exact saved thread after reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSettled(
    page,
    `/index.html#/desktop/project/${alpha.id}/beads?selectionKind=bead&selectionId=alpha-epic`,
  );
  await page
    .getByRole("button", { name: "Show inspector", exact: true })
    .click();
  await page
    .getByRole("region", { name: "Bead alpha-epic", exact: true })
    .getByRole("button", { name: "Start session", exact: true })
    .click();
  const before = calls().filter((row) => row.kind === "answer").length,
    dialog = await composer(page, true, true);
  await expect(
    dialog.getByRole("textbox", { name: "Session bead", exact: true }),
  ).toHaveValue("alpha-epic");
  await dialog
    .getByRole("textbox", { name: "Session prompt", exact: true })
    .fill("PRIVATE edited native Chat question");
  await expect(
    dialog.getByRole("button", { name: "Start", exact: true }),
  ).toBeDisabled();
  const identityRead = await verifiedIdentityReadBarrier(page),
    checkingIdentity = dialog
      .getByRole("region", { name: "Original Start requests", exact: true })
      .getByRole("status");
  identityRead.arm();
  try {
    await dialog
      .getByRole("button", { name: "Check supported options", exact: true })
      .click();
    await expect.poll(identityRead.held).toBe(true);
    await expect(checkingIdentity).toContainText(
      "Checking the server-owned identity page",
    );
    await expect(
      dialog.getByRole("button", { name: "Start", exact: true }),
    ).toBeDisabled();
  } finally {
    identityRead.release();
  }
  await expect(checkingIdentity).toBeHidden();
  await expect(
    dialog.getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
  await dialog
    .getByRole("textbox", { name: "Session prompt", exact: true })
    .press("Control+Enter");
  const pane = page.getByRole("region", {
      name: "Session conversation",
      exact: true,
    }),
    approval = pane.getByRole("article", {
      name: "Native command approval",
      exact: true,
    });
  await expect(approval).toContainText("inert example");
  await expect(pane.locator("[data-session-state]")).toHaveAttribute(
    "data-session-state",
    "needs-permission",
  );
  await expect
    .poll(() =>
      pane.locator("header").evaluate((header) => {
        const heading = header.querySelector("h2");
        if (!heading) return false;
        const outer = header.getBoundingClientRect(),
          inner = heading.getBoundingClientRect();
        return inner.top >= outer.top && inner.bottom <= outer.bottom;
      }),
    )
    .toBe(true);
  const actions = pane.getByRole("button", {
    name: "Session actions",
    exact: true,
  });
  await actions.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(actions).toBeFocused();
  await expect(actions).toHaveCSS("outline-width", "2px");
  await page.keyboard.press("Enter");
  const support = page.getByRole("dialog", {
    name: "Session actions",
    exact: true,
  });
  await expect(support).toContainText(
    "Review the inline native permission cards",
  );
  await expect(
    support.getByRole("button", { name: "Continue this Chat", exact: true }),
  ).toBeDisabled();
  await expect(
    support.getByRole("button", { name: "Fork session", exact: true }),
  ).toBeDisabled();
  await expect(
    support.getByRole("button", {
      name: "Open session in terminal",
      exact: true,
    }),
  ).toBeDisabled();
  const review = support.getByRole("button", {
    name: "Review native permissions",
    exact: true,
  });
  await expect(review).toBeEnabled();
  await review.focus();
  if (process.env.CODEX_CHAT_SHOTS)
    await support.screenshot({
      path: join(process.env.CODEX_CHAT_SHOTS, "native-chat-actions.png"),
    });
  await page.keyboard.press("Enter");
  const refresh = pane.getByRole("button", {
    name: "Refresh native approvals",
    exact: true,
  });
  await expect(refresh).toBeFocused();
  await expect(refresh).toHaveCSS("outline-width", "2px");
  expect(calls().filter((row) => row.kind === "answer")).toHaveLength(before);
  if (process.env.CODEX_CHAT_SHOTS) {
    await page
      .getByRole("button", { name: "Hide inspector", exact: true })
      .click();
    await page.setViewportSize({ width: 1280, height: 1000 });
    await approval.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(process.env.CODEX_CHAT_SHOTS, "codex-chat-approval.png"),
      fullPage: true,
      maskColor: "#1c1d24",
      style:
        '.af-owned-session code, .af-owned-session-header details, [aria-label="Your session message"] { visibility: hidden !important; }',
      mask: [
        page.getByRole("complementary", { name: "Inspector", exact: true }),
        pane
          .locator(".af-session-note")
          .filter({ hasText: /[A-Z]:[\\/]|\/Users\/|\/home\// }),
      ],
    });
    await page.setViewportSize({ width: 1100, height: 700 });
  }
  await expect(
    approval.getByRole("button", { name: "Allow once", exact: true }),
  ).toBeEnabled();
  await approval
    .getByRole("button", { name: "Allow once", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(() => calls().filter((row) => row.kind === "answer").length)
    .toBe(before + 1);
  await expect(pane.getByText("Hello world", { exact: true })).toBeVisible();
  const record = records().find((row) => !previous.has(row.id));
  if (!record) throw Error("No accepted Chat record");
  expect(record.beadId).toBe("alpha-epic");
  expect(realpathSync.native(record.worktree)).toBe(
    realpathSync.native(workspace),
  );
  expect(
    saved(record.id).frames.find((frame) => frame.event.kind === "user")?.event,
  ).toMatchObject({
    kind: "user",
    codexChat: {
      launch: {
        context: { beadId: "alpha-epic", worktree: record.worktree },
      },
    },
  });
  await expect.poll(() => saved(record.id).turns[0]?.phase).toBe("completed");
  await expect(pane.locator("[data-session-state]")).toHaveAttribute(
    "data-session-state",
    "idle",
  );
  const usage = pane.getByRole("region", {
    name: "Native Chat usage",
    exact: true,
  });
  await expect(usage).toContainText("Latest native response");
  await expect(usage).toContainText("Native thread total");
  await expect(
    usage.getByRole("row", { name: "Input 9 19", exact: true }),
  ).toBeVisible();
  expect(saved(record.id).binding?.sessionId).toBe(
    "0199a213-81c0-7800-8aa1-bbab2a035a53",
  );
  mode("normal");
  await reloadSettled(page);
  await expect(pane.getByText("Hello world", { exact: true })).toBeVisible();
  await pane
    .getByRole("button", { name: "Session actions", exact: true })
    .click();
  const continued = page.getByRole("dialog", {
    name: "Session actions",
    exact: true,
  });
  await expect(continued).not.toContainText("Native Chat is not connected");
  await expect(
    continued.getByRole("button", { name: "Continue this Chat", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          document.body.dataset.copiedCli = value;
        },
      },
    }),
  );
  await continued
    .getByRole("button", { name: "Copy original CLI preview", exact: true })
    .click();
  const original = saved(record.id).frames.find(
    (frame) => frame.event.kind === "user",
  )?.event;
  if (
    original?.kind !== "user" ||
    !("codexChat" in original) ||
    !original.codexChat
  )
    throw Error("Missing original native Chat snapshot");
  const serialized = serializeCodexChat(
    original.codexChat.launch,
    original.codexChat.capabilities,
  );
  await expect
    .poll(() => page.evaluate(() => document.body.dataset.copiedCli))
    .toBe(`${serialized.equivalentCommand}\n\n${serialized.stdinNote}`);
  const startsBeforeContinue = calls().filter(
    (row) =>
      row.kind === "rpc" &&
      ["thread/start", "thread/resume"].includes(row.method ?? ""),
  ).length;
  await continued
    .getByRole("button", { name: "Continue this Chat", exact: true })
    .click();
  const message = pane.getByRole("textbox", {
    name: "Session reply prompt",
    exact: true,
  });
  await expect(message).toBeFocused();
  expect(saved(record.id).turns).toHaveLength(1);
  expect(
    calls().filter(
      (row) =>
        row.kind === "rpc" &&
        ["thread/start", "thread/resume"].includes(row.method ?? ""),
    ).length,
  ).toBe(startsBeforeContinue);
  await message.fill("PRIVATE second explicit Chat turn");
  await pane
    .getByRole("button", { name: "Send session message", exact: true })
    .click();
  await expect
    .poll(() => saved(record.id).turns.map((turn) => turn.phase))
    .toEqual(["completed", "completed"]);
  expect(
    calls()
      .filter((row) => row.kind === "rpc" && row.method === "thread/resume")
      .at(-1)?.params,
  ).toMatchObject({
    threadId: saved(record.id).binding?.sessionId,
    excludeTurns: true,
  });
  expect(
    saved(record.id).frames.filter((frame) => frame.event.kind === "model"),
  ).toEqual([]);
});

test("native Chat keeps both turns' response and thread usage across follow-up, reload and complete export", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  mode("scoped-usage");
  const startsBefore = calls().filter(
      (row) => row.method === "turn/start",
    ).length,
    resumesBefore = calls().filter(
      (row) => row.method === "thread/resume",
    ).length;
  const { pane, record } = await startedChat(page);
  await expect.poll(() => saved(record.id).turns[0]?.phase).toBe("completed");
  const firstUsage = pane
    .locator(".af-owned-turn")
    .first()
    .getByRole("region", { name: "Native Chat usage", exact: true });
  await expect(
    firstUsage
      .getByRole("row")
      .filter({ hasText: /^Input/ })
      .getByRole("cell"),
  ).toHaveText(["9", "19"]);
  const reply = pane.getByRole("textbox", {
    name: "Session reply prompt",
    exact: true,
  });
  await reply.fill("Explicit follow-up for distinct reported usage scopes");
  const send = pane.getByRole("button", {
    name: "Send session message",
    exact: true,
  });
  await expect(send).toBeEnabled();
  await send.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(send).toBeFocused();
  await expect(send).toHaveCSS("outline-width", "2px");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => saved(record.id).turns.map((turn) => turn.phase))
    .toEqual(["completed", "completed"]);
  const assertScopes = async () => {
    const turns = pane.locator(".af-owned-turn");
    await expect(turns).toHaveCount(2);
    const older = turns
        .nth(0)
        .getByRole("region", { name: "Native Chat usage", exact: true }),
      newer = turns
        .nth(1)
        .getByRole("region", { name: "Native Chat usage", exact: true });
    await expect(
      pane.getByRole("region", { name: "Native Chat usage", exact: true }),
    ).toHaveCount(2);
    await expect(
      older
        .getByRole("row")
        .filter({ hasText: /^Input/ })
        .getByRole("cell"),
    ).toHaveText(["9", "19"]);
    await expect(
      newer
        .getByRole("row")
        .filter({ hasText: /^Input/ })
        .getByRole("cell"),
    ).toHaveText(["0", "42"]);
    await expect(
      newer
        .getByRole("row")
        .filter({ hasText: /^Output/ })
        .getByRole("cell"),
    ).toHaveText(["2", "8"]);
    await expect(newer).toContainText("Observed model");
    await expect(
      newer.getByRole("columnheader", {
        name: "Latest native response",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      newer.getByRole("columnheader", {
        name: "Native thread total",
        exact: true,
      }),
    ).toBeVisible();
  };
  await assertScopes();
  await reloadSettled(page);
  await assertScopes();
  if (process.env.CODEX_CHAT_USAGE_SHOTS) {
    // The minimum-desktop assertions above use the actual scrollable pane.
    // Give its full neutral usage card room for a legible review capture.
    await page.setViewportSize({ width: 1280, height: 1100 });
    const capture = pane
      .locator(".af-owned-turn")
      .nth(1)
      .getByRole("region", { name: "Native Chat usage", exact: true });
    await capture.evaluate((element) =>
      element.scrollIntoView({ block: "center", inline: "nearest" }),
    );
    await capture.screenshot({
      path: join(
        process.env.CODEX_CHAT_USAGE_SHOTS,
        "native-chat-turn-usage.png",
      ),
    });
    await page.setViewportSize({ width: 1100, height: 700 });
  }
  await pane
    .getByRole("button", { name: "Session actions", exact: true })
    .click();
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("dialog", { name: "Session actions", exact: true })
    .getByRole("button", { name: "Export saved transcript", exact: true })
    .click();
  const file = await (await downloading).path();
  if (!file) throw Error("Missing complete native usage transcript");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw Error("Invalid complete native usage transcript");
  }
  const exported = sessionTranscriptExportSchema.parse(raw).conversation,
    accepted = saved(record.id).turns.map((turn) => turn.requestId);
  expect(exported.turns.map((turn) => turn.requestId)).toEqual(accepted);
  expect(
    exported.frames
      .filter(
        (frame) =>
          frame.event.kind === "coding-chat" &&
          frame.event.event.kind === "usage",
      )
      .map((frame) => ({ turnId: frame.turnId, event: frame.event })),
  ).toMatchObject([
    {
      turnId: accepted[0],
      event: {
        event: {
          kind: "usage",
          usage: {
            lastResponse: { inputTokens: 9 },
            threadTotal: { inputTokens: 19 },
          },
        },
      },
    },
    {
      turnId: accepted[1],
      event: {
        event: {
          kind: "usage",
          usage: {
            lastResponse: { inputTokens: 0 },
            threadTotal: { inputTokens: 42 },
          },
        },
      },
    },
  ]);
  expect(calls().filter((row) => row.method === "turn/start")).toHaveLength(
    startsBefore + 2,
  );
  expect(calls().filter((row) => row.method === "thread/resume")).toHaveLength(
    resumesBefore + 1,
  );
});

test("native permission state cannot cross project scope or survive an interrupted feed and actual Stop", async ({
  page,
}) => {
  const before = calls().filter((row) => row.kind === "answer").length;
  const { pane, record } = await startedChat(page);
  const state = pane.locator("[data-session-state]");
  await expect(state).toHaveAttribute("data-session-state", "needs-permission");
  await page.route("**/sessions/*/events*", (route) =>
    route.abort("connectionreset"),
  );
  await reloadSettled(page);
  await expect(state).toHaveAttribute("data-session-state", "stale");
  await expect(
    pane.getByRole("button", { name: "Allow once", exact: true }),
  ).toHaveCount(0);
  expect(saved(record.id).turns[0]?.phase).toBe("running");
  await openSettled(
    page,
    `/index.html#/desktop/project/${beta.id}/sessions?selectionKind=session&selectionId=${record.id}`,
  );
  await expect(
    page.getByRole("region", { name: "Session conversation", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-session-state="needs-permission"]'),
  ).toHaveCount(0);
  await page.unroute("**/sessions/*/events*");
  await openSettled(
    page,
    `/index.html#/desktop/project/${alpha.id}/sessions?selectionKind=session&selectionId=${record.id}`,
  );
  await expect(state).toHaveAttribute("data-session-state", "needs-permission");
  await pane.getByRole("button", { name: "Stop session", exact: true }).click();
  await expect.poll(() => saved(record.id).turns[0]?.phase).toBe("cancelled");
  await expect(state).toHaveAttribute("data-session-state", "stopped");
  await expect(
    pane.getByRole("button", { name: "Allow once", exact: true }),
  ).toHaveCount(0);
  await reloadSettled(page);
  await expect(state).toHaveAttribute("data-session-state", "stopped");
  expect(calls().filter((row) => row.kind === "answer")).toHaveLength(before);
  expect(saved(record.id).turns).toHaveLength(1);
});

test("a decision held before native admission survives reload and checks only its original recorded intent", async ({
  page,
}) => {
  const before = calls().filter((row) => row.kind === "answer").length,
    { pane, record } = await startedChat(page);
  const approval = pane.getByRole("article", {
    name: "Native command approval",
    exact: true,
  });
  await expect(approval).toBeVisible();
  let release = () => {},
    received = () => {},
    completed = () => {},
    posts = 0;
  const held = new Promise<void>((resolve) => {
      received = resolve;
    }),
    delivery = new Promise<void>((resolve) => {
      release = resolve;
    }),
    delivered = new Promise<void>((resolve) => {
      completed = resolve;
    });
  const originals: unknown[] = [];
  await page.route(
    `**/projects/${alpha.id}/sessions/${record.id}/approval-decisions`,
    async (route) => {
      posts++;
      originals.push(route.request().postDataJSON());
      received();
      await delivery;
      try {
        await route.fetch({
          headers: {
            ...(await route.request().allHeaders()),
            Origin: new URL(route.request().url()).origin,
            "Sec-Fetch-Site": "same-origin",
          },
        });
        await route.abort("failed").catch(() => {});
      } finally {
        completed();
      }
    },
  );
  await approval
    .getByRole("button", { name: "Allow once", exact: true })
    .click();
  await held;
  try {
    expect(calls().filter((row) => row.kind === "answer")).toHaveLength(before);
    const metadata = await page.evaluate(() =>
      localStorage.getItem("agent-forge.codex-chat-decision-identities.v1"),
    );
    expect(metadata).not.toContain("PRIVATE");
    expect(metadata).not.toContain("inert example");
    expect(metadata).not.toContain(record.worktree);
    expect(metadata).not.toContain("nativeRequestId");
    await reloadSettled(page);
    await expect(
      pane.getByRole("button", {
        name: "Check original decision",
        exact: true,
      }),
    ).toBeVisible();
    await pane
      .getByRole("button", { name: "Check original decision", exact: true })
      .click();
    await expect(
      pane.getByText(
        "The original decision is not confirmed. It remains held; it was not resent.",
        { exact: true },
      ),
    ).toBeVisible();
    const allow = pane.getByRole("button", { name: "Allow once", exact: true });
    if (await allow.count()) await expect(allow).toBeDisabled();
    expect(posts).toBe(1);
    expect(calls().filter((row) => row.kind === "answer")).toHaveLength(before);
  } finally {
    release();
    await delivered;
  }
  await expect
    .poll(() => calls().filter((row) => row.kind === "answer").length)
    .toBe(before + 1);
  await pane
    .getByRole("button", { name: "Check original decision", exact: true })
    .click();
  await expect(
    pane.getByText(
      "The original decision intent is recorded. This does not confirm native delivery or execution.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(posts).toBe(1);
  expect(originals).toHaveLength(1);
  expect(
    await page.evaluate(() =>
      localStorage.getItem("agent-forge.codex-chat-decision-identities.v1"),
    ),
  ).toBe('{"version":1,"records":[]}');
});

for (const selected of ["decline", "cancel"] as const)
  test(`native command ${selected} uses one offered choice and cannot grant a session-wide allowance`, async ({
    page,
  }) => {
    const before = calls().filter((row) => row.kind === "answer").length,
      { pane, record } = await startedChat(page),
      approval = pane.getByRole("article", {
        name: "Native command approval",
        exact: true,
      });
    await expect(approval).toBeVisible();
    await expect(
      approval.getByRole("button", { name: /for this session/i }),
    ).toHaveCount(0);
    await approval
      .getByRole("button", {
        name: selected === "decline" ? "Decline" : "Cancel native request",
        exact: true,
      })
      .click();
    await expect
      .poll(() => calls().filter((row) => row.kind === "answer").length)
      .toBe(before + 1);
    expect(
      calls()
        .filter((row) => row.kind === "answer")
        .at(-1)?.result,
    ).toEqual({ decision: selected });
    await expect
      .poll(() => saved(record.id).turns[0]?.phase)
      .toBe(selected === "cancel" ? "failed" : "completed");
    await expect(approval).toHaveCount(0);
  });

test("file Allow stays unavailable without actual diffs and decline is still native", async ({
  page,
}) => {
  mode("approval-file");
  const before = calls().filter((row) => row.kind === "answer").length,
    { pane, record } = await startedChat(page),
    approval = pane.getByRole("article", {
      name: "Native file approval",
      exact: true,
    });
  await expect(approval).toContainText(
    "Actual file-change details are unavailable. Allow is disabled.",
  );
  await expect(
    approval.getByRole("button", {
      name: "Allow once · unavailable",
      exact: true,
    }),
  ).toBeDisabled();
  await approval.getByRole("button", { name: "Decline", exact: true }).click();
  await expect
    .poll(() => calls().filter((row) => row.kind === "answer").length)
    .toBe(before + 1);
  expect(
    calls()
      .filter((row) => row.kind === "answer")
      .at(-1)?.result,
  ).toEqual({ decision: "decline" });
  await expect.poll(() => saved(record.id).turns[0]?.phase).toBe("completed");
});

test("a synchronous draft edit before the next paint cannot dispatch an unreviewed Chat", async ({
  page,
}) => {
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/sessions`);
  const dialog = await composer(page);
  const identityRead = await verifiedIdentityReadBarrier(page);
  try {
    identityRead.arm();
    await dialog
      .getByRole("button", { name: "Check supported options", exact: true })
      .click();
    await expect.poll(identityRead.held).toBe(true);
    await expect(
      dialog
        .getByRole("region", { name: "Original Start requests", exact: true })
        .getByRole("status"),
    ).toContainText("Checking the server-owned identity page");
    await expect(
      dialog.getByRole("button", { name: "Start", exact: true }),
    ).toBeDisabled();
  } finally {
    identityRead.release();
  }
  await expect(
    dialog
      .getByRole("region", { name: "Original Start requests", exact: true })
      .getByRole("status"),
  ).toBeHidden();
  await expect(
    dialog.getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
  const before = records().length;
  let starts = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname ===
        `/__agent-forge/projects/${alpha.id}/sessions`
    )
      starts++;
  });
  await dialog.evaluate(async (element) => {
    const prompt = element.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Session prompt"]',
      ),
      start = [...element.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Start",
      );
    if (!prompt || !start || start.disabled)
      throw Error("No checked enabled Start");
    prompt.value = "PRIVATE unreviewed same-event-loop edit";
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
    start.click();
    // A rejected Start has no reservation; an accepted original completes its
    // lock transaction before this lock can observe the durable journal.
    await navigator.locks.request(
      "agent-forge.owned-session-start-identities.v1",
      () => {},
    );
  });
  await expect(
    dialog.getByRole("button", { name: "Start", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByText(
      "The Chat selection changed. Check supported options again before Start.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(starts).toBe(0);
  expect(records()).toHaveLength(before);
});

test("a background native approval read retains keyboard focus and dispatches no decision", async ({
  page,
}) => {
  const { pane, record } = await startedChat(page),
    allow = pane.getByRole("button", { name: "Allow once", exact: true });
  await expect(allow).toBeEnabled();
  await allow.focus();
  let release = () => {},
    received = () => {},
    once = false,
    decisions = 0;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    held = new Promise<void>((resolve) => {
      received = resolve;
    });
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/approval-decisions")
    )
      decisions++;
  });
  await page.route(
    `**/projects/${alpha.id}/sessions/${record.id}/approvals`,
    async (route) => {
      if (!once) {
        once = true;
        received();
        await gate;
      }
      await route.continue();
    },
  );
  try {
    await held;
    await expect(allow).toBeFocused();
    await expect(allow).toBeEnabled();
    expect(decisions).toBe(0);
  } finally {
    release();
  }
  await expect(allow).toBeFocused();
  await expect(allow).toBeEnabled();
  expect(decisions).toBe(0);
  await page.keyboard.press("Enter");
  await expect.poll(() => saved(record.id).turns[0]?.phase).toBe("completed");
  expect(decisions).toBe(1);
});

test("explicit Chat Stop waits for the actual native provider and helper to exit", async ({
  page,
}) => {
  mode("hang-text");
  const { pane, record } = await startedChat(page);
  await expect(
    pane.getByRole("article", { name: "Session reply", exact: true }),
  ).toContainText("private pending text");
  const process = calls()
    .filter((row) => row.kind === "tree")
    .at(-1);
  if (!process?.pid || !process.childPid)
    throw Error("No actual native process tree");
  const alive = (pid: number) => {
    try {
      if (
        processPlatform === "linux" &&
        /\) Z(?: |$)/.test(readFileSync(`/proc/${pid}/stat`, "utf8"))
      )
        return false;
      globalThis.process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const processPlatform = globalThis.process.platform;
  expect(alive(process.pid) && alive(process.childPid)).toBe(true);
  await pane.getByRole("button", { name: "Stop session", exact: true }).click();
  await expect.poll(() => saved(record.id).turns[0]?.phase).toBe("cancelled");
  await expect
    .poll(() => alive(process.pid ?? 0) || alive(process.childPid ?? 0))
    .toBe(false);
  await expect(
    pane.getByRole("button", { name: "Allow once", exact: true }),
  ).toHaveCount(0);
  await reloadSettled(page);
  await expect(pane.locator("[data-session-state]")).toHaveAttribute(
    "data-session-state",
    "stopped",
  );
  const outcome = pane.getByRole("region", {
    name: "Native Chat outcome",
    exact: true,
  });
  await expect(outcome).toContainText("Supervisor stopped the process");
  expect(
    saved(record.id).frames.some(
      (frame) =>
        frame.event.kind === "coding-chat" &&
        frame.event.event.kind === "outcome" &&
        frame.event.event.outcome.stopped,
    ),
  ).toBe(true);
});

test("Chat option checks show loading and failure without accepting a turn, then recover through a fresh native preview", async ({
  page,
}) => {
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/sessions`);
  let releaseChoices = () => {};
  const choicesGate = new Promise<void>((resolve) => {
    releaseChoices = resolve;
  });
  await page.route("**/__agent-forge/smiths", async (route) => {
    await choicesGate;
    await route.continue();
  });
  await page.getByRole("button", { name: "New session", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "New session · Alpha",
    exact: true,
  });
  await dialog.getByRole("button", { name: /Cx · Codex/ }).click();
  await dialog
    .getByRole("combobox", { name: "Session mode", exact: true })
    .selectOption("chat");
  try {
    await expect(
      dialog.getByRole("textbox", { name: "Session model", exact: true }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("combobox", { name: "Session effort", exact: true }),
    ).toBeDisabled();
  } finally {
    releaseChoices();
  }
  await expect(
    dialog.getByRole("combobox", { name: "Session smith", exact: true }),
  ).toHaveValue("codex-journeyman");
  await page.unroute("**/__agent-forge/smiths");
  await dialog
    .getByRole("textbox", { name: "Session prompt", exact: true })
    .fill("PRIVATE checked later");
  await dialog
    .getByRole("combobox", { name: "Session effort", exact: true })
    .selectOption("");
  let release = () => {},
    seen = () => {};
  const held = new Promise<void>((resolve) => {
      seen = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  const path = `**/projects/${alpha.id}/sessions/preview`;
  await page.route(path, async (route) => {
    seen();
    await gate;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        data: null,
        error:
          "Native capability check is unavailable. No conversation was started.",
      }),
    });
  });
  await dialog
    .getByRole("button", { name: "Check supported options", exact: true })
    .click();
  await held;
  try {
    await expect(
      dialog.getByRole("button", {
        name: "Checking supported options…",
        exact: true,
      }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Start", exact: true }),
    ).toBeDisabled();
    expect(records().filter((row) => !previous.has(row.id))).toEqual([]);
  } finally {
    release();
  }
  await expect(
    dialog.getByText(
      "Native capability check is unavailable. No conversation was started.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.unroute(path);
  await dialog
    .getByRole("button", { name: "Check supported options", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
  expect(records().filter((row) => !previous.has(row.id))).toEqual([]);
});

test("archived and foreign projects cannot advertise or answer an existing live Chat callback", async ({
  page,
}) => {
  const before = calls().filter((row) => row.kind === "answer").length,
    { pane, record } = await startedChat(page);
  await expect(
    pane.getByRole("button", { name: "Allow once", exact: true }),
  ).toBeEnabled();
  const pending = saved(record.id).frames.find(
    (frame) =>
      frame.event.kind === "coding-chat" &&
      frame.event.event.kind === "approval-request",
  )?.event;
  if (
    pending?.kind !== "coding-chat" ||
    pending.event.kind !== "approval-request"
  )
    throw Error("No saved native offer");
  const token = await pageToken(page);
  const foreign = await page.evaluate(
    async ({ project, id, token, header, approvalId, turnRequestId }) => {
      const base = `/__agent-forge/projects/${project}/sessions/${id}`,
        headers = { [header]: token, "Content-Type": "application/json" };
      const read = await fetch(`${base}/approvals`, { headers }),
        write = await fetch(`${base}/approval-decisions`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            turnRequestId,
            approvalId,
            decision: "accept",
          }),
        });
      return { read: read.status, write: write.status };
    },
    {
      project: beta.id,
      id: record.id,
      token,
      header: OPERATOR_HEADER,
      approvalId: pending.event.approval.id,
      turnRequestId: saved(record.id).turns[0]?.requestId,
    },
  );
  expect(foreign).toEqual({ read: 409, write: 409 });
  try {
    writeFileSync(
      catalogFile,
      JSON.stringify({
        ...catalog,
        revision: catalog.revision + 1,
        projects: catalog.projects.map((project) =>
          project.id === alpha.id ? { ...project, archived: true } : project,
        ),
      }),
    );
    await reloadSettled(page);
    await expect(
      pane.getByRole("button", { name: "Allow once", exact: true }),
    ).toHaveCount(0);
    await expect(
      pane.getByRole("button", {
        name: "Refresh native approvals",
        exact: true,
      }),
    ).toBeDisabled();
    const archived = await page.evaluate(
      async ({ project, id, token, header }) => {
        const response = await fetch(
          `/__agent-forge/projects/${project}/sessions/${id}/approvals`,
          { headers: { [header]: token } },
        );
        return response.status;
      },
      { project: alpha.id, id: record.id, token, header: OPERATOR_HEADER },
    );
    expect(archived).toBe(409);
    expect(calls().filter((row) => row.kind === "answer")).toHaveLength(before);
  } finally {
    writeFileSync(catalogFile, JSON.stringify(catalog));
  }
});

test("a native Chat provider failure stays failed and never reports an observed execution model", async ({
  page,
}) => {
  mode("provider-error");
  const { pane, record } = await startedChat(page);
  await expect.poll(() => saved(record.id).turns[0]?.phase).toBe("failed");
  await expect(pane.locator("[data-session-state]")).toHaveAttribute(
    "data-session-state",
    "error",
  );
  await expect(pane).toContainText(
    "The execution model is not reported by this native Chat protocol.",
  );
  expect(
    saved(record.id).frames.filter((frame) => frame.event.kind === "model"),
  ).toEqual([]);
  await expect(
    pane.getByRole("button", { name: "Allow once", exact: true }),
  ).toHaveCount(0);
});

test("the native approval deadline removes stale choices without answering the request", async ({
  page,
}) => {
  mode("approval-timeout");
  const before = calls().filter((row) => row.kind === "answer").length,
    { pane, record } = await startedChat(page),
    allow = pane.getByRole("button", { name: "Allow once", exact: true });
  await expect(allow).toBeEnabled();
  await expect.poll(() => saved(record.id).turns[0]?.phase).toBe("unknown");
  await expect(allow).toHaveCount(0);
  expect(calls().filter((row) => row.kind === "answer")).toHaveLength(before);
  await expect(
    pane.getByRole("button", { name: "Refresh native approvals", exact: true }),
  ).toBeDisabled();
});

test("a saved native timeout withdraws old choices before final metadata settles, and reload/export never revive or resend them", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  mode("outcome-held");
  const before = calls().filter((row) => row.method === "turn/start").length;
  const { pane, record } = await startedChat(page);
  const allow = pane.getByRole("button", { name: "Allow once", exact: true });
  await expect(allow).toBeEnabled();
  let releaseRead = () => {},
    received = () => {},
    rejectHeld = (_error: unknown) => {},
    consumed = () => {},
    heldOnce = false,
    decisions = 0;
  let fixtureFailure: unknown = null;
  const gate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const held = new Promise<void>((resolve, reject) => {
    received = resolve;
    rejectHeld = reject;
  });
  const releasedResponse = new Promise<void>((resolve) => {
    consumed = resolve;
  });
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/approval-decisions")
    )
      decisions++;
  });
  await page.route(
    `**/projects/${alpha.id}/sessions/${record.id}/approvals`,
    async (route) => {
      try {
        if (heldOnce) {
          await route.continue();
          return;
        }
        heldOnce = true;
        const response = await route.fetch({
          headers: {
            ...route.request().headers(),
            origin: new URL(route.request().url()).origin,
          },
        });
        if (response.status() !== 200)
          throw Error(
            `Protected approval fixture read refused: ${response.status()}`,
          );
        const body = await response.text();
        let raw: unknown;
        try {
          raw = JSON.parse(body);
        } catch {
          throw Error("Malformed protected approval fixture read");
        }
        const originalOffer = z
          .object({
            ok: z.literal(true),
            data: codexChatApprovalPageSchema,
            error: z.null(),
          })
          .strict()
          .parse(raw).data;
        const offered = saved(record.id).frames.find(
          (frame) =>
            frame.turnId === record.requestId &&
            frame.event.kind === "coding-chat" &&
            frame.event.event.kind === "approval-request",
        )?.event;
        if (
          offered?.kind !== "coding-chat" ||
          offered.event.kind !== "approval-request"
        )
          throw Error("No original native approval witness");
        expect(originalOffer.pending).toHaveLength(1);
        expect(originalOffer.pending[0]).toMatchObject({
          turnRequestId: record.requestId,
          actionable: true,
          approval: { id: offered.event.approval.id },
        });
        received();
        await gate;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body,
        });
        consumed();
      } catch (error) {
        fixtureFailure = error;
        rejectHeld(error);
        consumed();
        await route.abort().catch(() => {});
      }
    },
  );
  try {
    await pane
      .getByRole("button", { name: "Refresh native approvals", exact: true })
      .click();
    await held;
    await expect
      .poll(() => existsSync(join(HEARTH_HOME, "codex-chat-outcome-held.json")))
      .toBe(true);
    expect(saved(record.id).turns[0]?.phase).toBe("running");
    await expect(pane.locator("[data-session-state]")).toHaveAttribute(
      "data-session-state",
      "timed-out",
    );
    await expect(
      pane.getByRole("button", { name: "Stop session", exact: true }),
    ).toHaveCount(0);
    await expect(allow).toHaveCount(0);
    releaseRead();
    await releasedResponse;
    if (fixtureFailure) throw fixtureFailure;
    // Wait through the fetch/body and Preact effect/render boundary before
    // asserting that this genuinely actionable old response cannot revive UI.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(allow).toHaveCount(0);
    expect(decisions).toBe(0);
    await pane
      .getByRole("button", { name: "Session actions", exact: true })
      .click();
    const actions = page.getByRole("dialog", {
      name: "Session actions",
      exact: true,
    });
    await expect(
      actions.getByRole("button", {
        name: "Review native permissions",
        exact: true,
      }),
    ).toBeDisabled();
    await expect(
      actions.getByRole("button", { name: "Continue this Chat", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
  } finally {
    releaseRead();
    writeFileSync(
      join(HEARTH_HOME, "codex-chat-outcome-release"),
      "release this closed fixture only",
    );
  }
  await expect.poll(() => saved(record.id).turns[0]?.phase).toBe("unknown");
  await reloadSettled(page);
  await expect(pane.locator("[data-session-state]")).toHaveAttribute(
    "data-session-state",
    "timed-out",
  );
  const outcome = pane.getByRole("region", {
    name: "Native Chat outcome",
    exact: true,
  });
  await expect(outcome).toContainText("Time limit reached");
  await expect(outcome).toContainText("Supervisor stopped the process");
  if (process.env.CODEX_CHAT_OUTCOME_SHOTS) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await outcome.scrollIntoViewIfNeeded();
    await expect(outcome).toBeInViewport({ ratio: 1 });
    await outcome.screenshot({
      path: join(
        process.env.CODEX_CHAT_OUTCOME_SHOTS,
        "native-chat-outcome.png",
      ),
    });
    await page.setViewportSize({ width: 1100, height: 700 });
  }
  const tree = calls()
    .filter((row) => row.kind === "process")
    .at(-1);
  if (typeof tree?.pid !== "number")
    throw Error("No actual native process witness");
  expect(() => globalThis.process.kill(tree.pid!, 0)).toThrow();
  await pane
    .getByRole("button", { name: "Session actions", exact: true })
    .click();
  const download = page.waitForEvent("download");
  await page
    .getByRole("dialog", { name: "Session actions", exact: true })
    .getByRole("button", { name: "Export saved transcript", exact: true })
    .click();
  const exportedPath = await (await download).path();
  if (!exportedPath) throw Error("No complete transcript download");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(exportedPath, "utf8"));
  } catch {
    throw Error("Malformed complete transcript download");
  }
  const exported = sessionTranscriptExportSchema.parse(raw).conversation;
  expect(
    exported.frames.some(
      (frame) =>
        frame.event.kind === "coding-chat" &&
        frame.event.event.kind === "outcome" &&
        frame.event.event.outcome.timedOut,
    ),
  ).toBe(true);
  expect(calls().filter((row) => row.method === "turn/start")).toHaveLength(
    before + 1,
  );
  expect(decisions).toBe(0);
});

test("a delayed older Fork review cannot replace a newer selection", async ({
  page,
}) => {
  mode("fork-service-tier-null");
  const { pane, record } = await startedChat(page);
  const selectedRequestId = await completeForkSourceTurn(page, pane, record.id);
  const completed = saved(record.id).turns.filter(
    (row) => row.phase === "completed",
  );
  const selected = completed.find((row) => row.requestId === selectedRequestId);
  const earlier = completed.find((row) => row.requestId !== selectedRequestId);
  if (!selected || !earlier)
    throw Error("The stale-review case needs two completed parent turns");
  const opener = (requestId: string) =>
    pane.getByRole("button", {
      name: `Review Fork through ${requestId.slice(0, 8)}`,
      exact: true,
    });
  const dialog = page.getByRole("dialog", {
    name: "Review native Codex Fork",
    exact: true,
  });
  const posts: Array<{ path: string; body: unknown }> = [];
  const capturePost = (request: Request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() === "POST" &&
      (path.endsWith("/fork-reservations") || path.endsWith("/forks"))
    )
      posts.push({ path, body: request.postDataJSON() });
  };
  page.on("request", capturePost);
  await opener(earlier.requestId).click();
  await expect(dialog).toContainText("PRIVATE native Chat first question");
  await dialog
    .getByRole("button", { name: "Reserve this exact Fork", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", {
      name: "Create the native child thread once",
      exact: true,
    }),
  ).toBeEnabled();
  expect(posts).toHaveLength(1);
  expect(posts[0]?.path).toBe(
    `/__agent-forge/projects/${record.projectId}/sessions/${record.id}/fork-reservations`,
  );
  const originalBody = posts[0]?.body as
    | {
        requestId?: unknown;
        throughTurnRequestId?: unknown;
      }
    | undefined;
  expect(typeof originalBody?.requestId).toBe("string");
  expect(originalBody).toMatchObject({
    throughTurnRequestId: earlier.requestId,
  });
  const originalRequestId = originalBody?.requestId as string;
  const identityToken = await pageToken(page);
  const rawIdentity: unknown = await page.evaluate(
    async ({ project, token, header }) => {
      const response = await fetch(
        `/__agent-forge/projects/${project}/session-operation-identities`,
        { headers: { [header]: token } },
      );
      return response.json();
    },
    {
      project: record.projectId,
      token: identityToken,
      header: OPERATOR_HEADER,
    },
  );
  const identityEnvelope =
    typeof rawIdentity === "object" &&
    rawIdentity !== null &&
    "data" in rawIdentity
      ? (rawIdentity as { data: unknown }).data
      : null;
  const identityPage =
    sessionOperationIdentityPageSchema.parse(identityEnvelope);
  const persistedOriginal = identityPage.operations.find(
    (row) =>
      row.family === "codex-chat-fork" && row.requestId === originalRequestId,
  );
  expect(persistedOriginal).toMatchObject({
    requestId: originalRequestId,
    parentSessionId: record.id,
    throughTurnRequestId: earlier.requestId,
    state: "reserved",
  });
  expect(persistedOriginal?.requestHash).toMatch(/^[a-f0-9]{64}$/);
  const nativeForksBefore = calls().filter(
    (row) => row.kind === "rpc" && row.method === "thread/fork",
  ).length;
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();

  let staleReviewStarted!: () => void;
  let releaseStaleReview!: () => void;
  const staleReviewEntered = new Promise<void>((resolve) => {
    staleReviewStarted = resolve;
  });
  const staleReviewBarrier = new Promise<void>((resolve) => {
    releaseStaleReview = resolve;
  });
  let finishStaleReview!: () => void;
  let staleReviewHandlerStarted = false;
  const staleReviewFinished = new Promise<void>((resolve) => {
    finishStaleReview = resolve;
  });
  const staleReviewMatcher = (url: URL) =>
    url.pathname.endsWith(`/sessions/${record.id}/fork-review`) &&
    url.searchParams.get("throughTurnRequestId") === earlier.requestId;
  let staleResponseVerified = false;
  const delayedStaleReview = async (route: Route) => {
    try {
      staleReviewHandlerStarted = true;
      const requestHeaders = await route.request().allHeaders();
      const origin = new URL(route.request().url()).origin;
      const response = await route.fetch({
        headers: {
          ...requestHeaders,
          Origin: origin,
          "Sec-Fetch-Site": "same-origin",
        },
      });
      const body = await response.body();
      try {
        const raw: unknown = JSON.parse(body.toString("utf8"));
        const envelope = z
          .object({ ok: z.literal(true), data: z.unknown(), error: z.null() })
          .safeParse(raw);
        const source = envelope.success
          ? codexChatForkSourcePageSchema.safeParse(envelope.data.data)
          : null;
        staleResponseVerified =
          response.status() === 200 &&
          source?.success === true &&
          source.data.projectId === record.projectId &&
          source.data.parentSessionId === record.id &&
          source.data.requestId === null &&
          source.data.throughTurnRequestId === earlier.requestId;
      } catch {
        staleResponseVerified = false;
      }
      staleReviewStarted();
      await staleReviewBarrier;
      await route.fulfill({ response, body });
    } finally {
      finishStaleReview();
    }
  };
  await page.route(staleReviewMatcher, delayedStaleReview);
  try {
    await opener(earlier.requestId).click();
    await staleReviewEntered;
    expect(staleResponseVerified).toBe(true);
    await dialog
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await opener(selected.requestId).click();
    await expect(dialog).toContainText("PRIVATE_FORK_SOURCE_PROMPT");
    const staleResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "GET" && staleReviewMatcher(url);
    });
    releaseStaleReview();
    await staleResponse;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(dialog).toContainText("PRIVATE_FORK_SOURCE_PROMPT");
    await expect(dialog).not.toContainText(originalRequestId);
    await expect(
      dialog.getByRole("button", {
        name: "Reserve this exact Fork",
        exact: true,
      }),
    ).toBeEnabled();
    expect(posts).toHaveLength(1);
    expect(
      calls().filter(
        (row) => row.kind === "rpc" && row.method === "thread/fork",
      ),
    ).toHaveLength(nativeForksBefore);
  } finally {
    releaseStaleReview();
    if (staleReviewHandlerStarted) await staleReviewFinished;
    await page.unroute(staleReviewMatcher, delayedStaleReview);
    page.off("request", capturePost);
  }
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
});

test("Codex Chat explicitly reviews, forks, reloads and controls only the linked child", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  forkJourneyHttpFacts = [];
  const tracked = new Map<Request, (typeof forkJourneyHttpFacts)[number]>();
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      !/\/(?:fork-review|fork-reservations|forks|fork-turns|fork-approvals)(?:\/|$)/.test(
        url.pathname,
      )
    )
      return;
    if (forkJourneyHttpFacts.length >= 96) return;
    const fact = {
      method: request.method(),
      path: url.pathname,
      status: null,
    };
    forkJourneyHttpFacts.push(fact);
    tracked.set(request, fact);
  });
  page.on("response", (response) => {
    const fact = tracked.get(response.request());
    if (fact) fact.status = response.status();
  });
  mode("fork-service-tier-null-child-approval");
  const { pane, record } = await startedChat(page);
  const selectedTurnRequestId = await completeForkSourceTurn(
    page,
    pane,
    record.id,
  );
  const turn = saved(record.id).turns.find(
    (row) => row.requestId === selectedTurnRequestId,
  );
  if (!turn || turn.phase !== "completed")
    throw Error("No completed Fork source turn");
  const parentNativeId = saved(record.id).binding?.sessionId;
  if (!parentNativeId)
    throw Error("The parent native Chat identity is missing");

  const opener = pane.getByRole("button", {
    name: `Review Fork through ${turn.requestId.slice(0, 8)}`,
    exact: true,
  });
  await opener.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", {
    name: "Review native Codex Fork",
    exact: true,
  });
  await expect(dialog).toContainText("Captured settings");
  await expect(dialog).toContainText("Explicitly unset");
  await expect(dialog).toContainText("PRIVATE_FORK_SOURCE_PROMPT");
  await expect(dialog).toContainText("Saved completed parent turn");
  await expect(dialog).not.toContainText(parentNativeId);
  const forkCallsBeforeReview = calls().filter(
    (row) => row.kind === "rpc" && row.method === "thread/fork",
  ).length;
  const forkPosts: Array<{ path: string; body: unknown }> = [];
  const captureForkPost = (request: Request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() !== "POST" ||
      !(path.endsWith("/fork-reservations") || path.endsWith("/forks"))
    )
      return;
    forkPosts.push({
      path,
      body: request.postDataJSON(),
    });
  };
  page.on("request", captureForkPost);
  expect(forkCallsBeforeReview).toBe(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  await opener.click();
  await expect(dialog).toContainText("PRIVATE_FORK_SOURCE_PROMPT");
  await dialog
    .getByRole("button", { name: "Reserve this exact Fork", exact: true })
    .click();
  const reserve = dialog.getByRole("button", {
    name: "Create the native child thread once",
    exact: true,
  });
  await expect(reserve).toBeEnabled();
  expect(
    calls().filter((row) => row.kind === "rpc" && row.method === "thread/fork"),
  ).toHaveLength(0);
  expect(forkPosts.map((post) => post.path)).toEqual([
    `/__agent-forge/projects/${record.projectId}/sessions/${record.id}/fork-reservations`,
  ]);
  expect(forkPosts[0]?.body).toMatchObject({
    requestId: expect.any(String),
    throughTurnRequestId: turn.requestId,
  });
  const savedIdentity = forkPosts[0]?.body as { requestId: string };
  const identityToken = await pageToken(page);
  const rawIdentity: unknown = await page.evaluate(
    async ({ project, token, header }) => {
      const response = await fetch(
        `/__agent-forge/projects/${project}/session-operation-identities`,
        { headers: { [header]: token } },
      );
      return response.json();
    },
    {
      project: record.projectId,
      token: identityToken,
      header: OPERATOR_HEADER,
    },
  );
  const identityEnvelope =
    typeof rawIdentity === "object" &&
    rawIdentity !== null &&
    "data" in rawIdentity
      ? (rawIdentity as { data: unknown }).data
      : null;
  const identityPage =
      sessionOperationIdentityPageSchema.parse(identityEnvelope),
    savedOperation = identityPage.operations.find(
      (row) =>
        row.family === "codex-chat-fork" &&
        row.requestId === savedIdentity.requestId,
    );
  expect(savedOperation).toMatchObject({
    family: "codex-chat-fork",
    requestId: savedIdentity.requestId,
    state: "reserved",
  });
  expect(JSON.stringify(savedOperation)).not.toContain(
    "PRIVATE_FORK_SOURCE_PROMPT",
  );

  await reserve.click();
  await expect
    .poll(
      () =>
        calls().filter(
          (row) => row.kind === "rpc" && row.method === "thread/fork",
        ).length,
    )
    .toBe(1);
  const nativeFork = calls().find(
    (row) => row.kind === "rpc" && row.method === "thread/fork",
  );
  const originalFrame = saved(record.id).frames.find(
    (frame) =>
      frame.event.kind === "user" &&
      "codexChat" in frame.event &&
      frame.event.codexChat,
  );
  if (
    originalFrame?.event.kind !== "user" ||
    !("codexChat" in originalFrame.event) ||
    !originalFrame.event.codexChat
  )
    throw Error("The saved parent configuration is unavailable");
  expect(nativeFork?.params).toMatchObject({
    threadId: parentNativeId,
    lastTurnId: "0199a213-81c0-7800-8aa1-bbab2a035a55",
    model: originalFrame.event.codexChat.launch.model,
    modelProvider: "openai",
    serviceTier: null,
    approvalPolicy: "on-request",
  });
  await expect(
    dialog.getByText("Child conversation", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText("PRIVATE_FORK_SOURCE_PROMPT")).toBeVisible();
  await expect(dialog).toContainText("Native child session");
  expect(savedIdentity.requestId).toBeTruthy();

  const postsBeforeReload = forkPosts.length;
  const child = records().find(
    (row) =>
      row.id !== record.id &&
      "origin" in row &&
      row.origin?.kind === "codex-chat-fork" &&
      row.origin.parentSessionId === record.id,
  );
  if (!child) throw Error("The linked Fork child was not registered");
  await reloadSettled(page);
  const recoveredOpener = pane.getByRole("button", {
    name: `Review Fork through ${turn.requestId.slice(0, 8)}`,
    exact: true,
  });
  let childReadStarted!: () => void;
  let releaseChildRead!: () => void;
  const childReadEntered = new Promise<void>((resolve) => {
    childReadStarted = resolve;
  });
  const childReadBarrier = new Promise<void>((resolve) => {
    releaseChildRead = resolve;
  });
  let finishChildRead!: () => void;
  let childReadHandlerStarted = false;
  const childReadFinished = new Promise<void>((resolve) => {
    finishChildRead = resolve;
  });
  let childResponseVerified = false;
  const childPageRoute = async (route: Route) => {
    try {
      childReadHandlerStarted = true;
      const requestHeaders = await route.request().allHeaders();
      const origin = new URL(route.request().url()).origin;
      const response = await route.fetch({
        headers: {
          ...requestHeaders,
          Origin: origin,
          "Sec-Fetch-Site": "same-origin",
        },
      });
      const body = await response.body();
      try {
        const raw: unknown = JSON.parse(body.toString("utf8"));
        const envelope = z
          .object({ ok: z.literal(true), data: z.unknown(), error: z.null() })
          .safeParse(raw);
        const childPage = envelope.success
          ? ownedCodingPageSchema.safeParse(envelope.data.data)
          : null;
        childResponseVerified =
          response.status() === 200 &&
          childPage?.success === true &&
          childPage.data.projectId === record.projectId &&
          childPage.data.conversationId === child.id &&
          childPage.data.binding?.provider === "codex";
      } catch {
        childResponseVerified = false;
      }
      childReadStarted();
      await childReadBarrier;
      await route.fulfill({ response, body });
    } finally {
      finishChildRead();
    }
  };
  const childPageUrl = (url: URL) =>
    url.pathname.endsWith(
      `/sessions/${encodeURIComponent(child.id)}/fork-turns`,
    ) && url.searchParams.get("requestId") === savedIdentity.requestId;
  const childPageRouteMatcher = (url: URL) => childPageUrl(url);
  await page.route(childPageRouteMatcher, childPageRoute);
  try {
    await recoveredOpener.click();
    await childReadEntered;
    expect(childResponseVerified).toBe(true);
    const recoveredDialog = page.getByRole("dialog", {
      name: "Review native Codex Fork",
      exact: true,
    });
    await expect(recoveredDialog).toContainText(savedIdentity.requestId);
    await expect(
      recoveredDialog.getByText("Child conversation", { exact: true }),
    ).toBeVisible();
    await recoveredDialog
      .getByRole("textbox", { name: "Continue this child" })
      .fill("PRIVATE_CHILD_APPROVAL_PROMPT");
    await expect(
      recoveredDialog.getByRole("button", {
        name: "Send child turn",
        exact: true,
      }),
    ).toBeDisabled({ timeout: 250 });
    const childResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "GET" && childPageUrl(url);
    });
    releaseChildRead();
    await childResponse;
  } finally {
    releaseChildRead();
    if (childReadHandlerStarted) await childReadFinished;
    await page.unroute(childPageRouteMatcher, childPageRoute);
  }
  const recoveredDialog = page.getByRole("dialog", {
    name: "Review native Codex Fork",
    exact: true,
  });
  await expect(recoveredDialog).toContainText(savedIdentity.requestId);
  await expect(
    recoveredDialog.getByText("Child conversation", { exact: true }),
  ).toBeVisible();
  expect(
    calls().filter((row) => row.kind === "rpc" && row.method === "thread/fork"),
  ).toHaveLength(1);
  expect(forkPosts).toHaveLength(postsBeforeReload);
  page.off("request", captureForkPost);
  await expect(
    recoveredDialog.getByRole("button", {
      name: "Send child turn",
      exact: true,
    }),
  ).toBeEnabled();
  await recoveredDialog
    .getByRole("button", { name: "Send child turn", exact: true })
    .click();
  const approvalDecisionPosts: string[] = [];
  const captureApprovalDecision = (request: Request) => {
    const url = new URL(request.url());
    if (
      request.method() === "POST" &&
      url.pathname.includes("/fork-approvals/") &&
      url.pathname.endsWith("/decision")
    )
      approvalDecisionPosts.push(url.pathname);
  };
  page.on("request", captureApprovalDecision);
  const childNativeId = saved(child.id).binding?.sessionId;
  if (!childNativeId)
    throw Error("The linked child native identity is missing");
  await expect
    .poll(() =>
      calls().some(
        (row) =>
          row.kind === "approval-offer" &&
          row.threadId === childNativeId &&
          typeof row.turnId === "string",
      ),
    )
    .toBe(true);
  expect(approvalDecisionPosts).toHaveLength(0);
  await recoveredDialog
    .getByRole("button", {
      name: "Refresh child transcript and permissions",
      exact: true,
    })
    .click();
  const commandApproval = recoveredDialog.getByText(
    "Permission request · command",
    { exact: true },
  );
  try {
    await expect(commandApproval).toBeVisible();
  } finally {
    await attachForkChildApprovalDiagnostic(test.info());
  }
  await recoveredDialog
    .getByRole("button", { name: "accept", exact: true })
    .click();
  await expect.poll(() => approvalDecisionPosts.length).toBe(1);
  await expect(
    recoveredDialog.getByText("Hello world", { exact: true }),
  ).toBeVisible();

  mode("fork-child-lost-turn-reply");
  await recoveredDialog
    .getByRole("textbox", { name: "Continue this child" })
    .fill("PRIVATE_CHILD_STOP_PROMPT");
  await recoveredDialog
    .getByRole("button", { name: "Send child turn", exact: true })
    .click();
  await expect(
    recoveredDialog.getByRole("button", {
      name: "Stop this Fork child",
      exact: true,
    }),
  ).toBeEnabled();
  await recoveredDialog
    .getByRole("button", { name: "Stop this Fork child", exact: true })
    .click();
  await expect
    .poll(() =>
      saved(child.id).turns.some((turn) =>
        ["accepted", "running", "cancelling"].includes(turn.phase),
      ),
    )
    .toBe(false);
  page.off("request", captureForkPost);
  page.off("request", captureApprovalDecision);
});

test("an undispatched Fork original can be explicitly retired after reload", async ({
  page,
}) => {
  const nativeForksBefore = calls().filter(
    (row) => row.kind === "rpc" && row.method === "thread/fork",
  ).length;
  mode("fork-service-tier-null");
  const { pane, record } = await startedChat(page);
  const selectedTurnRequestId = await completeForkSourceTurn(
    page,
    pane,
    record.id,
  );
  const turn = saved(record.id).turns.find(
    (row) => row.requestId === selectedTurnRequestId,
  );
  if (!turn || turn.phase !== "completed")
    throw Error("No completed Fork source turn");
  const forkPosts: Array<{ path: string; body: unknown }> = [];
  const captureForkPost = (request: Request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() === "POST" &&
      (path.endsWith("/fork-reservations") ||
        path.includes("/fork-reservations/") ||
        path.endsWith("/forks"))
    )
      forkPosts.push({ path, body: request.postDataJSON() });
  };
  page.on("request", captureForkPost);

  const opener = () =>
    pane.getByRole("button", {
      name: `Review Fork through ${turn.requestId.slice(0, 8)}`,
      exact: true,
    });
  await opener().click();
  const dialog = () =>
    page.getByRole("dialog", {
      name: "Review native Codex Fork",
      exact: true,
    });
  const review = dialog();
  await expect(review).toContainText("Captured settings");
  await review
    .getByRole("button", { name: "Reserve this exact Fork", exact: true })
    .click();
  const reserve = review.getByRole("button", {
    name: "Create the native child thread once",
    exact: true,
  });
  await expect(reserve).toBeEnabled();
  const retire = review.getByRole("button", {
    name: "Retire verified not-sent original",
    exact: true,
  });
  await expect(retire).toBeEnabled();
  expect(forkPosts).toHaveLength(1);
  const identity = forkPosts[0]?.body as {
    requestId: string;
    throughTurnRequestId: string;
  };
  expect(identity).toMatchObject({ throughTurnRequestId: turn.requestId });
  expect(
    calls().filter((row) => row.kind === "rpc" && row.method === "thread/fork"),
  ).toHaveLength(nativeForksBefore);

  await reloadSettled(page);
  await opener().click();
  const recovered = dialog();
  await expect(recovered).toContainText(identity.requestId);
  const recoveredRetire = recovered.getByRole("button", {
    name: "Retire verified not-sent original",
    exact: true,
  });
  await expect(recoveredRetire).toBeEnabled();
  await recoveredRetire.click();
  await expect(recovered).toContainText("its reservation was retired");
  await expect(recovered).toContainText("retired");
  expect(forkPosts).toHaveLength(2);
  expect(forkPosts[1]?.path).toBe(
    `/__agent-forge/projects/${record.projectId}/sessions/${record.id}/fork-reservations/${identity.requestId}/retire`,
  );
  expect(forkPosts[1]?.body).toMatchObject({ requestHash: expect.any(String) });
  expect(forkPosts.some((post) => post.path.endsWith("/forks"))).toBe(false);
  expect(
    calls().filter((row) => row.kind === "rpc" && row.method === "thread/fork"),
  ).toHaveLength(nativeForksBefore);
  page.off("request", captureForkPost);
});

test("lost native Fork reply remains held across reload without another Fork POST", async ({
  page,
}) => {
  mode("fork-service-tier-null");
  const { pane, record } = await startedChat(page);
  const selectedTurnRequestId = await completeForkSourceTurn(
    page,
    pane,
    record.id,
  );
  const turn = saved(record.id).turns.find(
    (row) => row.requestId === selectedTurnRequestId,
  );
  if (!turn) throw Error("No completed source turn");
  const opener = pane.getByRole("button", {
    name: `Review Fork through ${turn.requestId.slice(0, 8)}`,
    exact: true,
  });
  await opener.click();
  const dialog = page.getByRole("dialog", {
    name: "Review native Codex Fork",
    exact: true,
  });
  const forkPosts: string[] = [],
    originalGets: string[] = [];
  let reservedRequestId: string | null = null;
  const captureForkPost = (request: Request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() === "POST" &&
      (path.endsWith("/fork-reservations") || path.endsWith("/forks"))
    ) {
      forkPosts.push(path);
      if (path.endsWith("/fork-reservations")) {
        const body: unknown = request.postDataJSON();
        if (
          typeof body === "object" &&
          body !== null &&
          "requestId" in body &&
          typeof body.requestId === "string"
        )
          reservedRequestId = body.requestId;
      }
    }
    if (request.method() === "GET" && path.includes("/codex-chat-forks/"))
      originalGets.push(path);
  };
  page.on("request", captureForkPost);
  await dialog
    .getByRole("button", { name: "Reserve this exact Fork", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", {
      name: "Create the native child thread once",
      exact: true,
    }),
  ).toBeEnabled();
  expect(reservedRequestId).toMatch(/^[0-9a-f-]{36}$/);
  mode("fork-lost-response-eof");
  await dialog
    .getByRole("button", {
      name: "Create the native child thread once",
      exact: true,
    })
    .click();
  await expect(dialog).toContainText("native outcome is not confirmed");
  expect(
    calls().filter((row) => row.kind === "fork-created-without-response"),
  ).toHaveLength(1);
  expect(forkPosts).toEqual([
    `/__agent-forge/projects/${record.projectId}/sessions/${record.id}/fork-reservations`,
    `/__agent-forge/projects/${record.projectId}/sessions/${record.id}/forks`,
  ]);
  const heldRequestCount = forkPosts.length;
  await reloadSettled(page);
  const recovered = pane.getByRole("button", {
    name: `Review Fork through ${turn.requestId.slice(0, 8)}`,
    exact: true,
  });
  await recovered.click();
  const recoveredDialog = page.getByRole("dialog", {
    name: "Review native Codex Fork",
    exact: true,
  });
  await expect(recoveredDialog).toContainText("held");
  await expect(recoveredDialog).not.toContainText(
    "Create the native child thread once",
  );
  expect(originalGets).toContain(
    `/__agent-forge/projects/${record.projectId}/codex-chat-forks/${reservedRequestId}`,
  );
  expect(
    calls().filter((row) => row.kind === "fork-created-without-response"),
  ).toHaveLength(1);
  expect(forkPosts).toHaveLength(heldRequestCount);
  page.off("request", captureForkPost);
});
