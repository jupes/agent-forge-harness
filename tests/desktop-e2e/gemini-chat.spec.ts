import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  expect,
  type Locator,
  type Page,
  type Request,
  test,
} from "@playwright/test";
import { z } from "zod";
import { OPERATOR_HEADER } from "../../scripts/hearth/paths";
import { ownedCodingStateSchema } from "../../scripts/sessions/codex-owned-journal";
import { ownedCodingSessionSchema } from "../../scripts/sessions/codex-owned-wire-protocol";
import {
  geminiChatApprovalPageSchema,
  geminiChatStartSchema,
} from "../../scripts/sessions/gemini-chat-owned-protocol";
import { geminiChatPreviewReceiptSchema } from "../../scripts/sessions/gemini-chat-preview-protocol";
import { sessionTranscriptExportSchema } from "../../scripts/sessions/library-protocol";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import { pageToken } from "../e2e/launch-link";
import { HEARTH_HOME } from "../e2e/servers";
import { verifiedIdentityReadBarrier } from "./session-start-read-barrier";
import {
  parseBoundedGeminiDiagnosticJson,
  withGeminiChatFailureFacts,
} from "./gemini-chat-failure-facts";
import { alpha, seedProjects, workspace } from "./project-fixtures";

// Two actual native process lifetimes, protected reads and complete export share one bounded journey.
test.setTimeout(60_000);
test.use({ viewport: { width: 1100, height: 700 }, reducedMotion: "reduce" });
const log = join(HEARTH_HOME, "gemini-chat-fixture-calls.json"),
  nativeId = "11111111-1111-4111-8111-111111111111";
const markdown =
  "**ACP answer 🌱**\n\n`safe_code`\n\n<script>DO_NOT_RUN</script>";
const rowSchema = z
  .object({
    kind: z.string(),
    pid: z.number().optional(),
    argv: z.array(z.string()).optional(),
    value: z
      .object({
        method: z.string().optional(),
        id: z.union([z.number(), z.string()]).optional(),
        params: z.record(z.string(), z.unknown()).optional(),
        result: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
const failureStateMaxBytes = 8 * 1024 * 1024,
  failureCallsMaxBytes = 256 * 1024;
function boundedDiagnosticFile(
  path: string,
  maxBytes: number,
): {
  state: "ok" | "missing" | "oversize" | "invalid" | "unavailable";
  value?: unknown;
} {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    return {
      state:
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
          ? "missing"
          : "unavailable",
    };
  }
  try {
    if (!fstatSync(fd).isFile()) return { state: "invalid" };
    if (fstatSync(fd).size > maxBytes) return { state: "oversize" };
    const bytes = Buffer.alloc(maxBytes + 1);
    const count = readSync(fd, bytes, 0, maxBytes + 1, 0);
    if (count > maxBytes) return { state: "oversize" };
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, count),
      );
    } catch {
      return { state: "invalid" };
    }
    const parsed = parseBoundedGeminiDiagnosticJson(text, maxBytes);
    return parsed.ok
      ? { state: "ok", value: parsed.value }
      : { state: parsed.reason };
  } catch {
    return { state: "unavailable" };
  } finally {
    closeSync(fd);
  }
}
function collectGeminiChatFailureFacts(
  record: ReturnType<typeof records>[number],
) {
  const stateFile = boundedDiagnosticFile(
      join(HEARTH_HOME, "conversations", `${record.id}.json`),
      failureStateMaxBytes,
    ),
    callsFile = boundedDiagnosticFile(log, failureCallsMaxBytes);
  const state =
    stateFile.state === "ok"
      ? ownedCodingStateSchema.safeParse(stateFile.value)
      : null;
  const callRows =
    callsFile.state === "ok"
      ? z.array(rowSchema).safeParse(callsFile.value)
      : null;
  const turns = state?.success
    ? state.data.frames.filter((frame) => frame.turnId === record.requestId)
    : null;
  const nativeOutcomes = turns?.flatMap((frame) =>
    frame.event.kind === "coding-gemini-chat" &&
    frame.event.event.kind === "outcome"
      ? [frame.event.event]
      : [],
  );
  const offers =
      turns?.filter(
        (frame) =>
          frame.event.kind === "coding-gemini-chat" &&
          frame.event.event.kind === "approval-offer",
      ).length ?? null,
    intents =
      turns?.filter(
        (frame) =>
          frame.event.kind === "coding-gemini-chat" &&
          frame.event.event.kind === "permission-intent",
      ).length ?? null;
  const methods = new Map<string, number>();
  for (const row of callRows?.success ? callRows.data : []) {
    const method = row.value?.method;
    if (
      method === "initialize" ||
      method === "session/new" ||
      method === "session/load" ||
      method === "session/prompt" ||
      method === "session/cancel"
    )
      methods.set(method, (methods.get(method) ?? 0) + 1);
  }
  const providerPid = callRows?.success
      ? callRows.data.filter((row) => row.kind === "start").at(-1)?.pid
      : undefined,
    helperPid = callRows?.success
      ? callRows.data.filter((row) => row.kind === "helper").at(-1)?.pid
      : undefined;
  let providerAlive: boolean | null = null,
    helperAlive: boolean | null = null;
  try {
    if (typeof providerPid === "number") providerAlive = running(providerPid);
    if (typeof helperPid === "number") helperAlive = running(helperPid);
  } catch {
    // A best-effort liveness observation is unavailable; never expose process identifiers.
  }
  const native = nativeOutcomes?.at(-1);
  return {
    stateRead:
      stateFile.state === "ok" && !state?.success ? "invalid" : stateFile.state,
    callsRead:
      callsFile.state === "ok" && !callRows?.success
        ? "invalid"
        : callsFile.state,
    turnPhase: state?.success
      ? state.data.turns.find((turn) => turn.requestId === record.requestId)
          ?.phase
      : undefined,
    turnReason: state?.success
      ? state.data.turns.find((turn) => turn.requestId === record.requestId)
          ?.reason
      : undefined,
    outcome: native
      ? {
          phase: native.outcome.phase,
          reason: native.outcome.reason,
          stopReason: native.outcome.stopReason,
          exitCode: native.exitCode,
          stopped: native.stopped,
          timedOut: native.timedOut,
        }
      : null,
    hasBinding: state?.success ? state.data.binding !== null : null,
    nativeOutcomeCount: nativeOutcomes?.length ?? null,
    approvalOffers: offers,
    permissionIntents: intents,
    methodCounts: Object.fromEntries(methods),
    permissionResponses: callRows?.success
      ? callRows.data.filter(
          (row) => row.value?.id === 41 && row.value.result !== undefined,
        ).length
      : null,
    providerAlive,
    helperAlive,
  };
}
function calls() {
  if (!existsSync(log)) return [];
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(log, "utf8"));
  } catch {
    throw Error("Invalid atomic inert ACP recording");
  }
  return z.array(rowSchema).parse(value);
}
function records() {
  const file = join(HEARTH_HOME, "sessions", "registry.json");
  if (!existsSync(file)) return [];
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw Error("Invalid complete owned registry");
  }
  return z
    .object({ records: z.array(ownedCodingSessionSchema) })
    .passthrough()
    .parse(value).records;
}
function saved(id: string) {
  let value: unknown;
  try {
    value = JSON.parse(
      readFileSync(join(HEARTH_HOME, "conversations", `${id}.json`), "utf8"),
    );
  } catch {
    throw Error("Invalid complete private ACP state");
  }
  return ownedCodingStateSchema.parse(value);
}
const promptCount = () =>
  calls().filter((row) => row.value?.method === "session/prompt").length;
const answerCount = () =>
  calls().filter(
    (row) => row.value?.id === 41 && row.value.result !== undefined,
  ).length;
function mode(value: string, extra: Record<string, unknown> = {}) {
  writeFileSync(
    `${log}.control`,
    JSON.stringify({ mode: value, replyText: markdown, ...extra }),
  );
}
function running(pid: number) {
  try {
    if (
      process.platform === "linux" &&
      /\) Z(?: |$)/.test(readFileSync(`/proc/${pid}/stat`, "utf8"))
    )
      return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function expectLatestTreeDead() {
  const processCall = calls()
      .filter((row) => row.kind === "start")
      .at(-1),
    helper = calls()
      .filter((row) => row.kind === "helper")
      .at(-1);
  if (!processCall?.pid || !helper?.pid)
    throw Error("No actual inert ACP tree witness");
  expect(running(processCall.pid)).toBe(false);
  expect(running(helper.pid)).toBe(false);
}
function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const pane = (page: Page) =>
  page.getByRole("region", { name: "Session conversation", exact: true });
const approvals = (page: Page) =>
  pane(page).getByRole("region", {
    name: "Native Gemini permissions",
    exact: true,
  });
const sessions = `/index.html#/desktop/project/${alpha.id}/sessions`;
let previous = new Set<string>();
test.beforeEach(async ({ page }) => {
  seedProjects();
  previous = new Set(records().map((item) => item.id));
  mode("permission-tree");
  for (const name of [
    "gemini-chat-outcome-held.json",
    "gemini-chat-outcome-release",
  ]) {
    const file = join(HEARTH_HOME, name);
    if (existsSync(file)) unlinkSync(file);
  }
  // This exact smith is already configured for the trusted native runtime, as in the Task fixture.
  await page.route("**/__agent-forge/smiths", async (route) => {
    const response = await route.fetch({
      headers: {
        ...(await route.request().allHeaders()),
        Origin: new URL(route.request().url()).origin,
        "Sec-Fetch-Site": "same-origin",
      },
    });
    const body = await response.json();
    if (!body.ok || !Array.isArray(body.data?.smiths))
      throw Error("The protected fixture smith index was not verified");
    await route.fulfill({
      response,
      json: {
        ...body,
        data: {
          ...body.data,
          smiths: [
            ...body.data.smiths.filter(
              (item: { name: string }) => item.name !== "gemini-example",
            ),
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
});
test.afterEach(async ({ page }) => {
  writeFileSync(
    join(HEARTH_HOME, "gemini-chat-outcome-release"),
    "release only the inert metadata hold",
  );
  await page.unrouteAll({ behavior: "ignoreErrors" });
  for (const record of records().filter((item) => !previous.has(item.id))) {
    const active = saved(record.id).turns.find((turn) =>
      ["accepted", "running", "cancelling"].includes(turn.phase),
    );
    if (!active) continue;
    const token = await pageToken(page);
    await page.evaluate(
      async ({ project, id, requestId, token, header }) => {
        await fetch(`/__agent-forge/projects/${project}/sessions/${id}/stop`, {
          method: "POST",
          headers: { "Content-Type": "application/json", [header]: token },
          body: JSON.stringify({ requestId }),
        });
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
  }
});
async function openComposer(page: Page, fill = true, fromBead = false) {
  await openSettled(
    page,
    fromBead
      ? `/index.html#/desktop/project/${alpha.id}/beads?selectionKind=bead&selectionId=alpha-epic`
      : sessions,
  );
  if (fromBead) {
    const show = page.getByRole("button", {
      name: "Show inspector",
      exact: true,
    });
    if (await show.isVisible()) await show.click();
    await page
      .getByRole("region", { name: "Bead alpha-epic", exact: true })
      .getByRole("button", { name: "Start session", exact: true })
      .click();
  } else
    await page
      .getByRole("button", { name: "New session", exact: true })
      .click();
  const dialog = page.getByRole("dialog", {
    name: "New session · Alpha",
    exact: true,
  });
  if (fromBead) {
    // Bead prefill and explicit About selection are separate shared draft facts.
    await dialog
      .getByRole("textbox", { name: "Session prompt", exact: true })
      .fill("@bead:alpha-epic");
    await dialog
      .getByRole("group", { name: "Mention suggestions", exact: true })
      .getByRole("button", { name: /bead alpha-epic/ })
      .click();
    await expect(dialog.getByText("About bead alpha-epic")).toBeVisible();
  }
  await dialog.getByRole("button", { name: /Gm · Gemini/ }).click();
  await dialog
    .getByRole("combobox", { name: "Session mode", exact: true })
    .selectOption("chat");
  if (fromBead)
    await expect(dialog.getByText("About bead alpha-epic")).toBeVisible();
  await expect(
    dialog.getByRole("combobox", { name: "Session smith", exact: true }),
  ).toHaveValue("gemini-example");
  await expect(
    dialog.getByRole("textbox", { name: "Session model", exact: true }),
  ).toBeEnabled();
  if (fill) {
    await dialog
      .getByRole("combobox", { name: "Where the session runs", exact: true })
      .selectOption("main");
    await dialog
      .getByRole("textbox", { name: "Session bead", exact: true })
      .fill("alpha-epic");
    await dialog
      .getByRole("textbox", { name: "Session prompt", exact: true })
      .fill("PRIVATE ACP FIRST QUESTION");
  }
  return dialog;
}
async function check(dialog: Locator) {
  await dialog
    .getByRole("button", { name: "Check supported options", exact: true })
    .click();
  await expect(
    dialog.getByRole("region", {
      name: "Equivalent session command",
      exact: true,
    }),
  ).toContainText("--acp");
  await expect(
    dialog.getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
}
async function accepted() {
  await expect
    .poll(() => records().filter((item) => !previous.has(item.id)).length)
    .toBe(1);
  const record = records().find((item) => !previous.has(item.id));
  if (!record || record.provider !== "gemini" || record.mode !== "chat")
    throw Error("No exact accepted Gemini Chat original");
  // Registry reservation precedes the private original. Retry only absence;
  // malformed or foreign saved bytes still fail the strict reader below.
  await expect
    .poll(() =>
      existsSync(join(HEARTH_HOME, "conversations", `${record.id}.json`)),
    )
    .toBe(true);
  const state = saved(record.id);
  expect(state.projectId).toBe(record.projectId);
  expect(state.conversationId).toBe(record.id);
  expect(state.turns[0]?.requestId).toBe(record.requestId);
  return record;
}
async function keyboardFocus(page: Page, target: Locator) {
  await target.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(target).toBeFocused();
  expect(
    await target.evaluate((node) => getComputedStyle(node).outlineWidth),
  ).toBe("2px");
}
async function exportSaved(page: Page) {
  await pane(page)
    .getByRole("button", { name: "Session actions", exact: true })
    .click();
  const actions = page.getByRole("dialog", {
      name: "Session actions",
      exact: true,
    }),
    download = page.waitForEvent("download");
  await actions
    .getByRole("button", { name: "Export saved transcript", exact: true })
    .click();
  const file = await (await download).path();
  if (!file) throw Error("No complete private ACP export");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw Error("Malformed complete ACP export");
  }
  return { actions, exported: sessionTranscriptExportSchema.parse(value) };
}
async function capture(page: Page, name: string, dialog?: Locator) {
  const directory = process.env.GEMINI_CHAT_SHOTS;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  const hide = page.getByRole("button", {
    name: "Hide inspector",
    exact: true,
  });
  // An open modal intentionally blocks the underlying inspector toggle.
  if (!dialog && (await hide.isVisible())) await hide.click();
  await page.setViewportSize({ width: 1280, height: 1000 });
  if (dialog)
    await dialog
      .getByRole("region", { name: "Equivalent session command", exact: true })
      .scrollIntoViewIfNeeded();
  else await approvals(page).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(directory, name),
    style:
      '[aria-label="Session prompt"], [aria-label="Session repository"], [aria-label="Registered session worktree"], .af-owned-question, .af-owned-reply, .af-session-native-history pre, .af-session-approval pre, .af-owned-session-header>p:last-of-type, .af-owned-session-header details pre {visibility:hidden!important;}',
  });
  await page.setViewportSize({ width: 1100, height: 700 });
}

test("Gemini ACP composer keyboard-starts two explicit native turns with once choices, exact resume, scoped replay and complete export", async ({
  page,
}) => {
  const before = promptCount(),
    answers = answerCount(),
    newBefore = calls().filter(
      (row) => row.value?.method === "session/new",
    ).length,
    loadBefore = calls().filter(
      (row) => row.value?.method === "session/load",
    ).length,
    startBodies: unknown[] = [],
    decisionBodies: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const path = new URL(request.url()).pathname;
    if (path.endsWith(`/projects/${alpha.id}/sessions`))
      startBodies.push(request.postDataJSON());
    if (path.endsWith("/approval-decisions"))
      decisionBodies.push(request.postDataJSON());
  });
  const dialog = await openComposer(page, true, true);
  await expect(
    dialog.getByRole("textbox", { name: "Session model", exact: true }),
  ).toHaveValue("");
  await expect(
    dialog.getByRole("combobox", { name: "Session approvals", exact: true }),
  ).toHaveValue("");
  await expect(
    dialog.getByRole("combobox", { name: "Session sandbox", exact: true }),
  ).toHaveValue("");
  await expect(dialog.locator('option[value="yolo"]')).toHaveJSProperty(
    "disabled",
    true,
  );
  await expect(dialog.locator('option[value="disabled"]')).toHaveJSProperty(
    "disabled",
    true,
  );
  await dialog.getByLabel("Attach text", { exact: true }).setInputFiles({
    name: "private-context.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("PRIVATE ACP INLINE CONTEXT"),
  });
  const identityRegion = dialog.getByRole("region", {
    name: "Original Start requests",
    exact: true,
  });
  await expect(
    identityRegion.getByRole("button", { name: "Check server", exact: true }),
  ).toBeEnabled();
  const identityRead = await verifiedIdentityReadBarrier(page, {
    projectId: alpha.id,
    workspace,
  });
  const checkingIdentity = identityRegion.getByRole("status");
  identityRead.arm();
  let checked: z.infer<typeof geminiChatPreviewReceiptSchema>;
  try {
    const previewResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/projects/${alpha.id}/sessions/preview`),
    );
    await dialog
      .getByRole("button", { name: "Check supported options", exact: true })
      .click();
    await expect(
      dialog.getByRole("region", {
        name: "Equivalent session command",
        exact: true,
      }),
    ).toContainText("--acp");
    const response = await previewResponse;
    let rawPreview: unknown;
    try {
      rawPreview = await response.json();
    } catch {
      throw Error("Actual protected ACP preview was not valid JSON");
    }
    const envelope = z
      .object({
        ok: z.literal(true),
        data: geminiChatPreviewReceiptSchema,
        error: z.null(),
      })
      .strict()
      .safeParse(rawPreview);
    if (!envelope.success)
      throw Error("Actual protected ACP preview was refused");
    checked = envelope.data.data;
    expect(checked.serialized.argv).toEqual(["--acp"]);
    expect(checked.serialized.stdin).toContain("PRIVATE ACP INLINE CONTEXT");
    expect(promptCount()).toBe(before);
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
  const start = dialog.getByRole("button", { name: "Start", exact: true });
  await expect(start).toBeEnabled();
  await capture(page, "gemini-acp-composer.png", dialog);
  await keyboardFocus(page, start);
  await page.keyboard.press("Enter");
  const record = await accepted(),
    view = pane(page);
  await expect(view).toBeVisible();
  await expect(view.locator(".af-owned-reply strong")).toHaveText(
    "ACP answer 🌱",
  );
  expect(await view.locator("script").count()).toBe(0);
  const allow = approvals(page).getByRole("button", {
    name: "Allow once",
    exact: true,
  });
  await expect(allow).toBeEnabled();
  await expect(
    approvals(page).getByRole("button", { name: "Always", exact: true }),
  ).toHaveCount(0);
  // Check the exact API argument before the Windows clipboard converts LF to CRLF.
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          document.body.dataset.geminiAcpCopied = value;
        },
      },
    }),
  );
  await view
    .getByRole("button", { name: "Copy session reply", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => document.body.dataset.geminiAcpCopied))
    .toBe(markdown);
  await keyboardFocus(page, allow);
  const background = await page.waitForResponse(
    (answer) =>
      answer.request().method() === "GET" &&
      new URL(answer.url()).pathname.endsWith(
        `/sessions/${record.id}/approvals`,
      ) &&
      !new URL(answer.url()).search,
    { timeout: 8000 },
  );
  expect(background.status()).toBe(200);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(allow).toBeFocused();
  expect(decisionBodies).toHaveLength(0);
  await capture(page, "gemini-acp-permission.png");
  let dropped = false,
    decisionFailure: unknown;
  await page.route(
    `**/sessions/${record.id}/approval-decisions`,
    async (route) => {
      if (dropped) {
        await route.continue();
        return;
      }
      dropped = true;
      try {
        const answer = await route.fetch({
          headers: {
            ...(await route.request().allHeaders()),
            Origin: new URL(route.request().url()).origin,
            "Sec-Fetch-Site": "same-origin",
          },
        });
        expect(answer.status()).toBe(200);
        await route.abort("failed");
      } catch (error) {
        decisionFailure = error;
        await route.abort().catch(() => {});
      }
    },
  );
  await keyboardFocus(page, allow);
  await page.keyboard.press("Enter");
  await withGeminiChatFailureFacts({
    operation: () =>
      expect.poll(() => saved(record.id).turns[0]?.phase).toBe("completed"),
    collect: () => collectGeminiChatFailureFacts(record),
    attach: async (body) => {
      await test.info().attach("gemini-chat-outcome-failure-facts.json", {
        contentType: "application/json",
        body: Buffer.from(body),
      });
    },
  });
  expectLatestTreeDead();
  if (decisionFailure) throw decisionFailure;
  expect(startBodies).toHaveLength(1);
  const original = geminiChatStartSchema.parse(startBodies[0]);
  expect(original.launch).toEqual({
    route: "gemini-cli",
    mode: "chat",
    prompt: "PRIVATE ACP FIRST QUESTION",
    attachments: [
      {
        kind: "text",
        name: "private-context.txt",
        text: "PRIVATE ACP INLINE CONTEXT",
      },
    ],
  });
  expect(original.repository).toBe(workspace);
  expect(original.beadId).toBe("alpha-epic");
  expect(original.about).toEqual([{ kind: "bead", id: "alpha-epic" }]);
  expect(record.requestedModel).toBeNull();
  expect(
    calls()
      .filter((row) => row.kind === "start")
      .at(-1)?.argv,
  ).toEqual(["--acp"]);
  expect(
    JSON.stringify(
      calls()
        .filter((row) => row.value?.method === "session/prompt")
        .at(-1)?.value?.params,
    ),
  ).toContain("PRIVATE ACP INLINE CONTEXT");
  const initial = saved(record.id);
  expect(initial.binding?.sessionId).toBe(nativeId);
  expect(initial.frames.some((frame) => frame.event.kind === "model")).toBe(
    false,
  );
  await reloadSettled(page);
  expect(promptCount()).toBe(before + 1);
  await approvals(page)
    .getByRole("button", { name: "Check original decision", exact: true })
    .click();
  await expect(
    approvals(page).getByRole("button", {
      name: "Check original decision",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(answerCount()).toBe(answers + 1);
  expect(decisionBodies).toHaveLength(1);
  const reply = view.getByRole("textbox", {
    name: "Session reply prompt",
    exact: true,
  });
  await reply.fill("PRIVATE ACP EXPLICIT SECOND QUESTION");
  await reply.focus();
  await page.keyboard.press("Control+Enter");
  await expect(
    view
      .getByRole("region", { name: "Native session history", exact: true })
      .filter({ hasText: "Historical before load reply" }),
  ).toBeVisible();
  await expect(
    view
      .getByRole("region", { name: "Native session history", exact: true })
      .filter({ hasText: "Historical after new prompt" }),
  ).toBeVisible();
  await expect(
    view.locator(".af-owned-turn").last().locator(".af-owned-reply"),
  ).toHaveCount(0);
  await expect(
    approvals(page).getByRole("button", { name: "Reject once", exact: true }),
  ).toBeEnabled();
  await approvals(page)
    .getByRole("button", { name: "Reject once", exact: true })
    .click();
  await expect.poll(() => saved(record.id).turns[1]?.phase).toBe("completed");
  expectLatestTreeDead();
  expect(promptCount()).toBe(before + 2);
  expect(answerCount()).toBe(answers + 2);
  expect(decisionBodies).toHaveLength(2);
  const newCalls = calls().filter((row) => row.value?.method === "session/new"),
    loadCalls = calls().filter((row) => row.value?.method === "session/load");
  expect(newCalls).toHaveLength(newBefore + 1);
  expect(loadCalls).toHaveLength(loadBefore + 1);
  expect(loadCalls.at(-1)?.value?.params?.sessionId).toBe(nativeId);
  const { actions, exported } = await exportSaved(page);
  expect(exported.session).toMatchObject({ provider: "gemini", mode: "chat" });
  expect(exported.conversation.turns).toHaveLength(2);
  expect(
    exported.conversation.frames.find(
      (frame) =>
        frame.turnId === record.requestId && frame.event.kind === "user",
    )?.event,
  ).toMatchObject({
    kind: "user",
    about: [{ kind: "bead", id: "alpha-epic" }],
  });
  expect(
    exported.conversation.frames.filter(
      (frame) => frame.event.kind === "coding-gemini-chat-decision",
    ),
  ).toHaveLength(2);
  const second = exported.conversation.turns[1]?.requestId;
  expect(
    exported.conversation.frames
      .filter(
        (frame) =>
          frame.turnId === second &&
          frame.event.kind === "coding-gemini-chat" &&
          frame.event.event.kind === "text",
      )
      .every(
        (frame) =>
          frame.event.kind === "coding-gemini-chat" &&
          frame.event.event.kind === "text" &&
          frame.event.event.scope === "native-session" &&
          frame.event.event.requestId === null,
      ),
  ).toBe(true);
  await actions
    .getByRole("button", { name: "Archive session", exact: true })
    .click();
  await expect(
    actions.getByRole("button", { name: "Restore session", exact: true }),
  ).toBeEnabled();
  await actions
    .getByRole("button", { name: "Restore session", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await reloadSettled(page);
  expect(promptCount()).toBe(before + 2);
  expect(answerCount()).toBe(answers + 2);
});

test("a fresh synchronous edit after Chat preview cannot reserve or dispatch an unreviewed Start", async ({
  page,
}) => {
  mode("normal");
  const before = promptCount(),
    dialog = await openComposer(page);
  let posts = 0,
    identityPosts = 0,
    startBodies: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const url = new URL(request.url());
    if (url.pathname.endsWith("/session-start-identities")) identityPosts++;
    if (url.pathname.endsWith(`/projects/${alpha.id}/sessions`)) {
      posts++;
      try {
        startBodies.push(request.postDataJSON());
      } catch {
        throw Error("The actual session Start body was not valid JSON.");
      }
    }
  });
  const identityRead = await verifiedIdentityReadBarrier(page, {
    projectId: alpha.id,
    workspace,
  });
  const checkingIdentity = dialog
    .getByRole("region", { name: "Original Start requests", exact: true })
    .getByRole("status");
  const start = dialog.getByRole("button", { name: "Start", exact: true });
  identityRead.arm();
  try {
    const previewResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/projects/${alpha.id}/sessions/preview`),
    );
    await dialog
      .getByRole("button", { name: "Check supported options", exact: true })
      .click();
    await expect(
      dialog.getByRole("region", {
        name: "Equivalent session command",
        exact: true,
      }),
    ).toContainText("--acp");
    const response = await previewResponse;
    expect(response.status()).toBe(200);
    await expect.poll(identityRead.held).toBe(true);
    await expect(checkingIdentity).toContainText(
      "Checking the server-owned identity page",
    );
    await expect(start).toBeDisabled();
    expect(posts).toBe(0);
    expect(identityPosts).toBe(0);
    expect(promptCount()).toBe(before);
  } finally {
    identityRead.release();
  }
  await expect(checkingIdentity).toBeHidden();
  await expect(start).toBeEnabled();
  await dialog.evaluate((element) => {
    const input = element.querySelector<HTMLTextAreaElement>(
        '[aria-label="Session prompt"]',
      ),
      start = [...element.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Start",
      );
    if (!input || !start) throw Error("No checked Chat controls");
    if (start.disabled) throw Error("Start was not enabled before the edit.");
    input.value = "PRIVATE ACP SYNCHRONOUS EDIT";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    start.click();
  });
  await expect(
    dialog.getByText(
      "The Chat selection changed. Check supported options again before Start.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(posts).toBe(0);
  expect(identityPosts).toBe(0);
  expect(promptCount()).toBe(before);
  await check(dialog);
  await start.click();
  const record = await accepted();
  await expect.poll(() => saved(record.id).turns[0]?.phase).toBe("completed");
  expect(posts).toBe(1);
  expect(identityPosts).toBe(1);
  expect(startBodies).toHaveLength(1);
  const reviewed = geminiChatStartSchema.parse(startBodies[0]);
  expect(reviewed.launch.prompt).toBe("PRIVATE ACP SYNCHRONOUS EDIT");
  expect(promptCount()).toBe(before + 1);
});

test("an ACP Start held before admission survives reload as one original without storing or resending its private body", async ({
  page,
}) => {
  mode("normal");
  const dialog = await openComposer(page);
  await check(dialog);
  const before = promptCount(),
    entered = deferred(),
    gate = deferred(),
    finished = deferred();
  let posts = 0,
    startBody: Record<string, unknown> | null = null,
    identityWrites = 0,
    startPosts = 0,
    protectedOriginalReads = 0,
    fixtureError: unknown;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      request.method() === "POST" &&
      url.pathname.endsWith("/session-start-identities")
    )
      identityWrites++;
    if (
      request.method() === "POST" &&
      url.pathname === `/__agent-forge/projects/${alpha.id}/sessions`
    )
      startPosts++;
    if (
      request.method() === "GET" &&
      url.searchParams.has("requestId") &&
      url.pathname.includes(`/projects/${alpha.id}/sessions/`)
    )
      protectedOriginalReads++;
  });
  await page.route(
    `**/__agent-forge/projects/${alpha.id}/sessions`,
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      posts++;
      startBody = route.request().postDataJSON() as Record<string, unknown>;
      entered.release();
      await gate.promise;
      try {
        await route.fetch({
          headers: {
            ...(await route.request().allHeaders()),
            Origin: new URL(route.request().url()).origin,
            "Sec-Fetch-Site": "same-origin",
          },
        });
        await route.abort("failed").catch(() => {});
      } catch (error) {
        fixtureError = error;
      } finally {
        finished.release();
      }
    },
  );
  try {
    await dialog.getByRole("button", { name: "Start", exact: true }).click();
    await entered.promise;
    expect(promptCount()).toBe(before);
    await reloadSettled(page);
    const reopened = await openComposer(page, false);
    const identityRegion = reopened.getByRole("region", {
      name: "Original Start requests",
      exact: true,
    });
    await expect(identityRegion).toBeVisible();
    await identityRegion
      .getByRole("button", { name: "Check server", exact: true })
      .click();
    const original = geminiChatStartSchema.parse(startBody);
    const identityRow = identityRegion
      .locator(".af-start-identities-list li")
      .filter({ hasText: original.requestId });
    await expect(identityRow).toContainText("gemini chat · reserved");
    const listedRequestId = await identityRow
      .locator("code")
      .nth(0)
      .textContent();
    const listedRequestHash = await identityRow
      .locator("code")
      .nth(1)
      .textContent();
    expect(listedRequestId).toBe(original.requestId);
    expect(listedRequestHash).toMatch(/^[0-9a-f]{64}$/);
    const continueOriginal = identityRow.getByRole("button", {
      name: "Continue exact original",
      exact: true,
    });
    await expect(continueOriginal).toBeDisabled();
    await expect(
      reopened.getByRole("button", { name: "Start", exact: true }),
    ).toBeDisabled();
    expect(
      await page.evaluate(() =>
        JSON.stringify({
          local: Object.entries(localStorage),
          session: Object.entries(sessionStorage),
        }),
      ),
    ).not.toContain("PRIVATE ACP FIRST QUESTION");
    await reopened
      .getByRole("combobox", { name: "Where the session runs", exact: true })
      .selectOption("main");
    await reopened
      .getByRole("textbox", { name: "Session bead", exact: true })
      .fill("alpha-epic");
    await reopened
      .getByRole("textbox", { name: "Session prompt", exact: true })
      .fill("PRIVATE ACP FIRST QUESTION");
    await expect(continueOriginal).toBeEnabled();
    await reopened.getByRole("button", { name: /Cl · Claude/ }).click();
    await expect(
      reopened.getByRole("button", { name: "Start", exact: true }),
    ).toBeDisabled();
    await reopened.getByRole("button", { name: /Gm · Gemini/ }).click();
    await expect(continueOriginal).toBeEnabled();
    await expect(
      reopened.getByRole("button", { name: "Start", exact: true }),
    ).toBeDisabled();
    expect(identityWrites).toBe(1);
    expect(startPosts).toBe(1);
    expect(posts).toBe(1);
    gate.release();
    await finished.promise;
    if (fixtureError) throw fixtureError;
    await expect.poll(promptCount).toBe(before + 1);
    const record = await accepted();
    await expect.poll(() => saved(record.id).turns[0]?.phase).toBe("completed");
    await expect(reopened).toBeVisible();
    await identityRegion
      .getByRole("button", { name: "Check server", exact: true })
      .click();
    await expect(identityRow).toContainText("gemini chat · admitted");
    expect(await identityRow.locator("code").nth(0).textContent()).toBe(
      listedRequestId,
    );
    expect(await identityRow.locator("code").nth(1).textContent()).toBe(
      listedRequestHash,
    );
    await identityRow
      .getByRole("button", { name: "Inspect original", exact: true })
      .click();
    await expect(
      identityRow.getByRole("link", { name: "Open original session" }),
    ).toBeVisible();
    await expect.poll(() => protectedOriginalReads).toBeGreaterThan(0);
    await identityRow
      .getByRole("link", { name: "Open original session" })
      .click();
    await expect(reopened).toBeHidden();
    const originalPane = pane(page);
    await expect(originalPane).toBeVisible();
    await expect(originalPane.locator(".af-owned-reply strong")).toHaveText(
      "ACP answer 🌱",
    );
    expect(identityWrites).toBe(1);
    expect(startPosts).toBe(1);
    expect(posts).toBe(1);
  } finally {
    gate.release();
    await finished.promise;
  }
});

test("keyboard Stop withdraws a held native choice and old live read, kills the actual helper, and reload never reanswers", async ({
  page,
}) => {
  const before = promptCount(),
    answers = answerCount(),
    dialog = await openComposer(page);
  await check(dialog);
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  const record = await accepted();
  const allow = approvals(page).getByRole("button", {
    name: "Allow once",
    exact: true,
  });
  await expect(allow).toBeEnabled();
  const readEntered = deferred(),
    readGate = deferred(),
    readDone = deferred(),
    postEntered = deferred(),
    postGate = deferred(),
    postDone = deferred();
  let heldRead = false,
    decisionPosts = 0,
    fixtureError: unknown,
    decisionStatus: number | null = null;
  await page.route(`**/sessions/${record.id}/approvals`, async (route) => {
    if (heldRead) {
      await route.continue();
      return;
    }
    heldRead = true;
    try {
      const response = await route.fetch({
          headers: {
            ...(await route.request().allHeaders()),
            Origin: new URL(route.request().url()).origin,
            "Sec-Fetch-Site": "same-origin",
          },
        }),
        body = await response.json();
      if (!body.ok) throw Error("No protected live ACP offer");
      expect(
        geminiChatApprovalPageSchema.parse(body.data).pending,
      ).toHaveLength(1);
      readEntered.release();
      await readGate.promise;
      await route.fulfill({ response, json: body });
    } catch (error) {
      fixtureError = error;
      readEntered.release();
      await route.abort().catch(() => {});
    } finally {
      readDone.release();
    }
  });
  await page.route(
    `**/sessions/${record.id}/approval-decisions`,
    async (route) => {
      decisionPosts++;
      postEntered.release();
      await postGate.promise;
      try {
        const response = await route.fetch({
          headers: {
            ...(await route.request().allHeaders()),
            Origin: new URL(route.request().url()).origin,
            "Sec-Fetch-Site": "same-origin",
          },
        });
        decisionStatus = response.status();
        await route.fulfill({ response });
      } catch (error) {
        fixtureError = error;
        await route.abort().catch(() => {});
      } finally {
        postDone.release();
      }
    },
  );
  try {
    await approvals(page)
      .getByRole("button", { name: "Refresh native permissions", exact: true })
      .evaluate((button: HTMLButtonElement) => button.click());
    await readEntered.promise;
    if (fixtureError) throw fixtureError;
    await allow.click();
    await postEntered.promise;
    const stop = pane(page).getByRole("button", {
      name: "Stop session",
      exact: true,
    });
    await keyboardFocus(page, stop);
    await page.keyboard.press("Enter");
    await expect.poll(() => saved(record.id).turns[0]?.phase).toBe("cancelled");
    const processCall = calls()
        .filter((row) => row.kind === "start")
        .at(-1),
      helper = calls()
        .filter((row) => row.kind === "helper")
        .at(-1);
    if (!processCall?.pid || !helper?.pid)
      throw Error("No actual inert ACP tree witness");
    expect(running(processCall.pid)).toBe(false);
    expect(running(helper.pid)).toBe(false);
    readGate.release();
    postGate.release();
    await Promise.all([readDone.promise, postDone.promise]);
    if (fixtureError) throw fixtureError;
    expect(decisionStatus).toBe(409);
    await expect(allow).toHaveCount(0);
    await expect(
      pane(page).getByRole("button", { name: "Stop session", exact: true }),
    ).toHaveCount(0);
    expect(decisionPosts).toBe(1);
    expect(answerCount()).toBe(answers);
    await reloadSettled(page);
    await approvals(page)
      .getByRole("button", { name: "Check original decision", exact: true })
      .click();
    await expect(
      approvals(page).getByText(/original decision is not confirmed/i),
    ).toBeVisible();
    await expect(allow).toHaveCount(0);
    expect(decisionPosts).toBe(1);
    expect(promptCount()).toBe(before + 1);
    expect(answerCount()).toBe(answers);
  } finally {
    readGate.release();
    postGate.release();
    await Promise.all([readDone.promise, postDone.promise]);
  }
});

test("saved native deadline hides a genuinely actionable old offer before generic finish and complete export cannot revive it", async ({
  page,
}) => {
  mode("permission-tree", { holdOutcome: true });
  const before = promptCount(),
    answers = answerCount(),
    dialog = await openComposer(page);
  const identityRegion = dialog.getByRole("region", {
    name: "Original Start requests",
    exact: true,
  });
  await expect(
    identityRegion.getByRole("button", { name: "Check server", exact: true }),
  ).toBeEnabled();
  let previewPostObserved = false;
  const previewPath = `/__agent-forge/projects/${alpha.id}/sessions/preview`;
  const previewOrigin = new URL(page.url()).origin;
  const observePreviewPost = (request: Request) => {
    const url = new URL(request.url());
    if (
      request.method() === "POST" &&
      url.origin === previewOrigin &&
      url.pathname === previewPath &&
      url.search === ""
    )
      previewPostObserved = true;
  };
  page.on("request", observePreviewPost);
  const identityRead = await verifiedIdentityReadBarrier(page, {
    projectId: alpha.id,
    workspace,
    shouldHold: () => previewPostObserved,
  });
  const start = dialog.getByRole("button", { name: "Start", exact: true });
  const identityLoading = identityRegion.getByText(
    "Checking the server-owned identity page…",
    { exact: true },
  );
  identityRead.arm();
  let previewClick: Promise<void> | null = null;
  try {
    const previewResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).origin === previewOrigin &&
        new URL(response.url()).pathname === previewPath &&
        new URL(response.url()).search === "",
    );
    previewClick = dialog
      .getByRole("button", { name: "Check supported options", exact: true })
      .click();
    const response = await previewResponse;
    expect(response.status()).toBe(200);
    let rawPreview: unknown;
    try {
      rawPreview = await response.json();
    } catch {
      throw Error("The actual Gemini preview was not valid JSON.");
    }
    const envelope = z
      .object({
        ok: z.literal(true),
        data: geminiChatPreviewReceiptSchema,
        error: z.null(),
      })
      .strict()
      .safeParse(rawPreview);
    if (!envelope.success)
      throw Error("The exact Gemini preview could not be verified.");
    expect(envelope.data.data.provider).toBe("gemini");
    expect(envelope.data.data.projectId).toBe(alpha.id);
    expect(envelope.data.data.snapshot.launch.cwd).toBe(workspace);
    expect(envelope.data.data.serialized.argv).toEqual(["--acp"]);
    expect(promptCount()).toBe(before);
    await expect.poll(identityRead.held).toBe(true);
    await expect(
      identityRegion.getByRole("button", { name: "Checking…", exact: true }),
    ).toBeDisabled();
    await expect(identityLoading).toBeVisible();
    await expect(start).toBeDisabled();
  } finally {
    identityRead.release();
    if (previewClick) await previewClick.catch(() => undefined);
    page.off("request", observePreviewPost);
  }
  await expect(identityLoading).toBeHidden();
  await expect(start).toBeEnabled();
  await start.click();
  const record = await accepted();
  const allow = approvals(page).getByRole("button", {
    name: "Allow once",
    exact: true,
  });
  await expect(allow).toBeEnabled();
  const entered = deferred(),
    gate = deferred(),
    finished = deferred();
  let held = false,
    posts = 0,
    fixtureError: unknown;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith(`/sessions/${record.id}/approval-decisions`)
    )
      posts++;
  });
  await page.route(`**/sessions/${record.id}/approvals`, async (route) => {
    if (held) {
      await route.continue();
      return;
    }
    held = true;
    try {
      const response = await route.fetch({
          headers: {
            ...(await route.request().allHeaders()),
            Origin: new URL(route.request().url()).origin,
            "Sec-Fetch-Site": "same-origin",
          },
        }),
        body = await response.json();
      if (!body.ok) throw Error("No original protected native offer");
      expect(
        geminiChatApprovalPageSchema.parse(body.data).pending,
      ).toHaveLength(1);
      entered.release();
      await gate.promise;
      await route.fulfill({ response, json: body });
    } catch (error) {
      fixtureError = error;
      entered.release();
      await route.abort().catch(() => {});
    } finally {
      finished.release();
    }
  });
  try {
    await approvals(page)
      .getByRole("button", { name: "Refresh native permissions", exact: true })
      .click();
    await entered.promise;
    if (fixtureError) throw fixtureError;
    await expect
      .poll(
        () => existsSync(join(HEARTH_HOME, "gemini-chat-outcome-held.json")),
        { timeout: 8000 },
      )
      .toBe(true);
    expect(saved(record.id).turns[0]?.phase).toBe("running");
    await expect(
      pane(page).getByText(
        "Native process ended · saving final conversation status…",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(allow).toHaveCount(0);
    await expect(
      pane(page).getByRole("button", { name: "Stop session", exact: true }),
    ).toHaveCount(0);
    gate.release();
    await finished.promise;
    if (fixtureError) throw fixtureError;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(allow).toHaveCount(0);
    expect(posts).toBe(0);
  } finally {
    gate.release();
    writeFileSync(
      join(HEARTH_HOME, "gemini-chat-outcome-release"),
      "release only the inert final metadata hold",
    );
    await finished.promise;
  }
  await expect.poll(() => saved(record.id).turns[0]?.phase).toBe("failed");
  const state = saved(record.id),
    nativeOutcome = state.frames.flatMap((frame) =>
      frame.event.kind === "coding-gemini-chat" &&
      frame.event.event.kind === "outcome"
        ? [frame.event.event]
        : [],
    );
  expect(nativeOutcome).toHaveLength(1);
  expect(nativeOutcome[0]).toMatchObject({
    timedOut: true,
    stopped: true,
    outcome: {
      phase: "failed",
      reason: "The Gemini Chat prompt timed out.",
      sessionId: nativeId,
      stopReason: "cancelled",
    },
  });
  expect(state.binding).toEqual({
    provider: "gemini",
    sessionId: nativeId,
    version: "0.65.0",
  });
  const processCall = calls()
      .filter((row) => row.kind === "start")
      .at(-1),
    helper = calls()
      .filter((row) => row.kind === "helper")
      .at(-1);
  if (!processCall?.pid || !helper?.pid)
    throw Error("No actual expired inert ACP tree witness");
  expect(running(processCall.pid)).toBe(false);
  expect(running(helper.pid)).toBe(false);
  await reloadSettled(page);
  await expect(allow).toHaveCount(0);
  const { exported } = await exportSaved(page);
  expect(
    exported.conversation.frames.some(
      (frame) =>
        frame.event.kind === "coding-gemini-chat" &&
        frame.event.event.kind === "outcome" &&
        frame.event.event.timedOut,
    ),
  ).toBe(true);
  expect(posts).toBe(0);
  expect(promptCount()).toBe(before + 1);
  expect(answerCount()).toBe(answers);
});
