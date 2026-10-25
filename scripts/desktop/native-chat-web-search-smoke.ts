import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CodexChatWebSearch } from "../../types/codex-chat";
import type {
  CodexChatOwnedRecord,
  CodexChatStartRequest,
} from "../../types/codex-owned-chat";
import { conversationFile } from "../conversations/paths";
import { createConversationStore } from "../conversations/store";
import { canonicalOwnedSessionStart } from "../sessions/codex-owned-protocol";
import { createSessionRegistry } from "../sessions/registry";
import { hasVisibleNativePatchFocus } from "./native-file-change-smoke";

/** Historical fixture only; its saved reports do not grant search or page-fetch authority. */
export async function seedNativeWebSearchSession(
  home: string,
  workspace: string,
  projectId: string,
): Promise<CodexChatOwnedRecord> {
  const requestId = randomUUID(),
    prompt = "Private native web-search snapshot fixture",
    launch = {
      mode: "chat" as const,
      model: "fixture-model",
      sandbox: "read-only" as const,
      approvalPolicy: "never" as const,
      prompt,
    },
    start: CodexChatStartRequest = {
      provider: "codex",
      requestId,
      smith: "codex-journeyman",
      repository: workspace,
      worktree: workspace,
      launch,
    },
    record = await createSessionRegistry(home, "codex", "chat").reserve(
      projectId,
      requestId,
      createHash("sha256")
        .update(canonicalOwnedSessionStart(start))
        .digest("hex"),
      () => ({
        mode: "chat",
        provider: "codex",
        workspace,
        repository: workspace,
        worktree: workspace,
        smith: start.smith,
        requestedModel: launch.model,
        requestedEffort: null,
      }),
    ),
    store = createConversationStore(home, undefined, {
      kind: "session",
      projectId,
      sessionId: record.id,
    }),
    version = "0.163.0-alpha.10.2",
    threadId = randomUUID(),
    turnId = randomUUID(),
    owner = randomUUID();
  await store.accept(projectId, {
    requestId,
    expectedRevision: 0,
    text: prompt,
    about: [],
    codexChat: {
      version: 1,
      provider: "codex",
      smith: record.smith,
      cwd: workspace,
      canonicalCwd: workspace,
      capabilities: { version, flags: ["--stdio"] },
      launch: {
        ...launch,
        cwd: workspace,
        context: {
          projectId,
          repository: workspace,
          worktree: workspace,
          about: [],
        },
      },
    },
  });
  await store.start(projectId, requestId, owner);
  await store.append(projectId, requestId, owner, {
    kind: "process",
    pid: 2_000_000_002,
    smith: record.smith,
    requestedModel: launch.model,
    requestedEffort: "default",
  });
  await store.append(projectId, requestId, owner, {
    kind: "identity",
    provider: "codex",
    sessionId: threadId,
    version,
  });
  await store.append(projectId, requestId, owner, {
    kind: "coding-chat",
    provider: "codex",
    version,
    event: { kind: "turn", threadId, turnId },
  });
  const mainReport: CodexChatWebSearch = {
      kind: "web-search",
      source: "item/completed",
      threadId,
      turnId,
      itemId: "native-smoke-web-search-main",
      query: { text: "literal query <tag>", truncated: false },
      action: {
        json: '{"type":"search","query":"literal query <tag>","queries":["literal query <tag>"]}',
        truncated: false,
      },
      results: {
        json: '[{"title":"<literal>","url":"https://fixture.invalid/private"}]',
        truncated: false,
      },
      partial: false,
      closure: "item-ended",
      turnStatus: null,
    },
    mainReportAtTurnEnd: CodexChatWebSearch = {
      ...mainReport,
      source: "turn/completed",
      closure: "turn-ended",
      turnStatus: "completed",
    },
    reports: CodexChatWebSearch[] = [
      mainReport,
      {
        kind: "web-search",
        source: "item/completed",
        threadId,
        turnId,
        itemId: "native-smoke-web-search-empty",
        query: { text: "", truncated: false },
        action: {
          json: '{"type":"search","query":null,"queries":[]}',
          truncated: false,
        },
        results: { json: "[]", truncated: false },
        partial: false,
        closure: "item-ended",
        turnStatus: null,
      },
      {
        kind: "web-search",
        source: "item/started",
        threadId,
        turnId,
        itemId: "native-smoke-web-search-absent",
        query: { text: "waiting query", truncated: false },
        action: null,
        results: null,
        partial: true,
        closure: "open",
        turnStatus: null,
      },
      {
        kind: "web-search",
        source: "item/started",
        threadId,
        turnId,
        itemId: "native-smoke-web-search-clipped",
        query: { text: "", truncated: true },
        action: null,
        results: { json: "", truncated: true, omitted: "size" },
        partial: true,
        closure: "open",
        turnStatus: null,
      },
      mainReportAtTurnEnd,
    ];
  for (const event of reports)
    await store.append(projectId, requestId, owner, {
      kind: "coding-chat",
      provider: "codex",
      version,
      event,
    });
  await store.append(projectId, requestId, owner, {
    kind: "coding-chat",
    provider: "codex",
    version,
    event: {
      kind: "outcome",
      outcome: {
        phase: "completed",
        reason: null,
        threadId,
        turnId,
        observedModel: null,
        usage: null,
        exitCode: 0,
        stopped: false,
        timedOut: false,
      },
    },
  });
  await store.finish(projectId, requestId, owner, "completed", null);
  return record;
}

interface NativeWebSearchPageTools<Socket extends EventTarget> {
  evaluate(socket: Socket, expression: string): Promise<unknown>;
  waitForPage(socket: Socket, expression: string, error: string): Promise<void>;
  pressTab(socket: Socket): Promise<void>;
  enableRequests(socket: Socket): Promise<void>;
}

/** Inspect only the saved historical report in the packaged WebView. */
export async function verifyNativeWebSearches<Socket extends EventTarget>(
  socket: Socket,
  record: CodexChatOwnedRecord,
  home: string,
  tools: NativeWebSearchPageTools<Socket>,
) {
  const file = conversationFile(home, record.projectId, {
      kind: "session",
      projectId: record.projectId,
      sessionId: record.id,
    }),
    before = readFileSync(file),
    main = `Array.from(document.querySelectorAll('.af-session-activity-item')).find(d=>d.querySelector('.af-session-report-source')?.textContent?.includes('Item: native-smoke-web-search-main'))`,
    empty = `Array.from(document.querySelectorAll('.af-session-activity-item')).find(d=>d.querySelector('.af-session-report-source')?.textContent?.includes('Item: native-smoke-web-search-empty'))`,
    absent = `Array.from(document.querySelectorAll('.af-session-activity-item')).find(d=>d.querySelector('.af-session-report-source')?.textContent?.includes('Item: native-smoke-web-search-absent'))`,
    clipped = `Array.from(document.querySelectorAll('.af-session-activity-item')).find(d=>d.querySelector('.af-session-report-source')?.textContent?.includes('Item: native-smoke-web-search-clipped'))`,
    originalHash = await tools.evaluate(socket, "location.hash");
  let posts = 0,
    probeFailed = false,
    probeError: unknown;
  const observe = (event: Event) => {
    if (!(event instanceof MessageEvent)) return;
    let value: unknown;
    try {
      value = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (
      !value ||
      typeof value !== "object" ||
      !("method" in value) ||
      value.method !== "Network.requestWillBeSent" ||
      !("params" in value)
    )
      return;
    const params = value.params;
    if (!params || typeof params !== "object" || !("request" in params)) return;
    const request = params.request;
    if (
      request &&
      typeof request === "object" &&
      "method" in request &&
      request.method === "POST"
    )
      posts = Math.min(posts + 1, 2);
  };
  await tools.enableRequests(socket);
  socket.addEventListener("message", observe);
  try {
    await tools.evaluate(
      socket,
      `location.hash=${JSON.stringify(`#/desktop/project/${record.projectId}/sessions?selectionKind=session&selectionId=${record.id}`)}`,
    );
    await tools.waitForPage(
      socket,
      `!!(${main})&&!!(${empty})&&!!(${absent})&&!!(${clipped})`,
      "The packaged native WebSearch snapshots did not appear in historical Chat.",
    );
    await tools.waitForPage(
      socket,
      `!(${main}).open&&!(${empty}).open&&!(${absent}).open&&!(${clipped}).open`,
      "Native WebSearch report disclosures were not collapsed by default.",
    );
    await tools.evaluate(
      socket,
      `${main}.querySelector('summary').click();${empty}.querySelector('summary').click();${absent}.querySelector('summary').click();${clipped}.querySelector('summary').click()`,
    );
    await tools.waitForPage(
      socket,
      `(() => {const a=${main},b=${empty},c=${absent},d=${clipped};return a?.open&&b?.open&&c?.open&&d?.open&&a.textContent.includes('literal query <tag>')&&a.textContent.includes('{"type":"search","query":"literal query <tag>"')&&a.textContent.includes('"title":"<literal>"')&&a.textContent.includes('Reported closure: turn-ended. Native turn reported completed.')&&b.textContent.includes('Empty query text reported')&&b.textContent.includes('"queries":[]')&&b.textContent.includes('[]')&&b.textContent.includes('Reported closure: item-ended.')&&!b.textContent.includes('Native turn reported')&&c.textContent.includes('Action not reported')&&c.textContent.includes('Results not reported')&&c.textContent.includes('Reported closure: open.')&&d.textContent.includes('Query text truncated')&&d.textContent.includes('Reported results truncated (size limit)')&&[a,b,c,d].every(e=>!e.querySelector('a,button,script,img,iframe,form'))&&a.querySelectorAll('pre[role="region"]').length===3&&b.querySelectorAll('pre[role="region"]').length===3&&c.querySelectorAll('pre[role="region"]').length===1&&d.querySelectorAll('pre[role="region"]').length===2;})()`,
      "The packaged WebSearch report lost supplied JSON, null/empty/clipping distinctions, closure or its inert boundary.",
    );
    await tools.evaluate(socket, `${main}.querySelector('summary').focus()`);
    await tools.pressTab(socket);
    const focusPredicate = hasVisibleNativePatchFocus.toString();
    await tools.waitForPage(
      socket,
      `(() => {const d=${main},p=d?.querySelector('pre[aria-label="Reported query report"]'),style=p?getComputedStyle(p):null;let specified=null;try{for(const sheet of document.styleSheets)for(const rule of sheet.cssRules??[])if(rule.selectorText===':focus-visible'){const value=Number.parseFloat(rule.style.getPropertyValue('outline-width')||rule.style.getPropertyValue('outline'));if(Number.isFinite(value))specified=value;}}catch{}const width=style?Number.parseFloat(style.outlineWidth):NaN,dpr=devicePixelRatio,proof=${focusPredicate};return proof({activeIsPre:document.activeElement===p,focusVisible:p?.matches(':focus-visible')===true,outlineStyle:style?.outlineStyle,specifiedCssPx:specified,outlineWidthCssPx:width,dpr});})()`,
      "The packaged WebSearch text region did not support visible keyboard focus.",
    );
    if (posts) throw Error("The native WebSearch inspection sent a POST.");
    if (!readFileSync(file).equals(before))
      throw Error(
        "Inspecting the packaged WebSearch reports changed saved private bytes.",
      );
  } catch (error) {
    probeFailed = true;
    probeError = error;
  }
  let cleanupError: unknown;
  try {
    socket.removeEventListener("message", observe);
  } catch (error) {
    cleanupError = error;
  }
  try {
    if (typeof originalHash !== "string")
      throw Error(
        "The packaged WebSearch probe could not record its original route.",
      );
    await tools.evaluate(
      socket,
      `location.hash=${JSON.stringify(originalHash)}`,
    );
  } catch (error) {
    cleanupError ??= error;
  }
  if (probeFailed) throw probeError;
  if (cleanupError !== undefined)
    throw Error(
      "The packaged WebSearch probe could not restore its original route and observer.",
      { cause: cleanupError },
    );
}
