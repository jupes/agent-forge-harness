import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CodexChatMcpToolCall } from "../../types/codex-chat";
import type {
  CodexChatOwnedRecord,
  CodexChatStartRequest,
} from "../../types/codex-owned-chat";
import { conversationFile } from "../conversations/paths";
import { createConversationStore } from "../conversations/store";
import { canonicalOwnedSessionStart } from "../sessions/codex-owned-protocol";
import { createSessionRegistry } from "../sessions/registry";
import { hasVisibleNativePatchFocus } from "./native-file-change-smoke";

/** Historical fixture only; it contains no live provider or tool authority. */
export async function seedNativeMcpToolCallSession(
  home: string,
  workspace: string,
  projectId: string,
): Promise<CodexChatOwnedRecord> {
  const requestId = randomUUID(),
    prompt = "Private native MCP snapshot fixture",
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
    pid: 2_000_000_001,
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
  const reports: CodexChatMcpToolCall[] = [
    {
      kind: "mcp-tool-call",
      source: "turn/completed",
      threadId,
      turnId,
      itemId: "native-smoke-mcp-empty",
      server: { text: "fixture-server", truncated: false },
      tool: { text: "list-fixture", truncated: false },
      status: "completed",
      arguments: {
        json: '{"filter":"<script>literal</script>"',
        truncated: true,
        omitted: "size",
      },
      result: {
        content: { json: "[]", truncated: false },
        structuredContent: null,
      },
      error: null,
      durationMs: 17,
      partial: false,
      closure: "turn-ended",
      turnStatus: "completed",
    },
    {
      kind: "mcp-tool-call",
      source: "turn/completed",
      threadId,
      turnId,
      itemId: "native-smoke-mcp-null",
      server: { text: "fixture-server", truncated: false },
      tool: { text: "failed-fixture", truncated: false },
      status: "failed",
      arguments: { json: "{}", truncated: false },
      result: null,
      error: { text: "<script>reported failure</script>", truncated: false },
      durationMs: null,
      partial: false,
      closure: "turn-ended",
      turnStatus: "completed",
    },
    {
      kind: "mcp-tool-call",
      source: "turn/completed",
      threadId,
      turnId,
      itemId: "native-smoke-mcp-clipped-error",
      server: { text: "fixture-server", truncated: false },
      tool: { text: "clipped-fixture", truncated: false },
      status: "failed",
      arguments: { json: "{}", truncated: false },
      result: null,
      error: { text: "", truncated: true },
      durationMs: null,
      partial: false,
      closure: "turn-ended",
      turnStatus: "completed",
    },
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

interface NativeMcpPageTools<Socket extends EventTarget> {
  evaluate(socket: Socket, expression: string): Promise<unknown>;
  waitForPage(socket: Socket, expression: string, error: string): Promise<void>;
  pressTab(socket: Socket): Promise<void>;
  enableRequests(socket: Socket): Promise<void>;
  screenshot(socket: Socket, name: string): Promise<unknown>;
}

/** Inspect only the admitted historical report in the packaged WebView. */
export async function verifyNativeMcpToolCalls<Socket extends EventTarget>(
  socket: Socket,
  record: CodexChatOwnedRecord,
  home: string,
  tools: NativeMcpPageTools<Socket>,
) {
  const file = conversationFile(home, record.projectId, {
      kind: "session",
      projectId: record.projectId,
      sessionId: record.id,
    }),
    before = readFileSync(file),
    empty = `Array.from(document.querySelectorAll('.af-session-activity-item')).find(d=>d.querySelector('.af-session-report-source')?.textContent?.includes('Item: native-smoke-mcp-empty'))`,
    failed = `Array.from(document.querySelectorAll('.af-session-activity-item')).find(d=>d.querySelector('.af-session-report-source')?.textContent?.includes('Item: native-smoke-mcp-null'))`,
    clipped = `Array.from(document.querySelectorAll('.af-session-activity-item')).find(d=>d.querySelector('.af-session-report-source')?.textContent?.includes('Item: native-smoke-mcp-clipped-error'))`,
    originalHash = await tools.evaluate(socket, "location.hash");
  let posts = 0;
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
      `!!(${empty})&&!!(${failed})&&!!(${clipped})`,
      "The packaged native MCP snapshots did not appear in the historical Chat.",
    );
    await tools.waitForPage(
      socket,
      `!(${empty}).open&&!(${failed}).open&&!(${clipped}).open`,
      "Native MCP report disclosures were not collapsed by default.",
    );
    await tools.evaluate(
      socket,
      `${empty}.querySelector('summary').click();${failed}.querySelector('summary').click();${clipped}.querySelector('summary').click()`,
    );
    await tools.waitForPage(
      socket,
      `(() => {const a=${empty},b=${failed},c=${clipped};return a?.open&&b?.open&&c?.open&&a.textContent.includes('Reported completed')&&a.textContent.includes('Native turn reported completed')&&a.textContent.includes('[]')&&a.textContent.includes('Structured content not reported')&&a.textContent.includes('"<script>literal</script>"')&&a.textContent.includes('Arguments truncated (size limit)')&&b.textContent.includes('Reported failed')&&b.textContent.includes('Native turn reported completed')&&b.textContent.includes('Result not reported (native result was null).')&&b.textContent.includes('<script>reported failure</script>')&&c.textContent.includes('Error text truncated before any content was retained')&&a.querySelectorAll('pre[role="region"]').length===2&&b.querySelectorAll('pre[role="region"]').length===2&&c.querySelectorAll('pre[role="region"]').length===1&&!a.querySelector('a,button,script,img,iframe,form')&&!b.querySelector('a,button,script,img,iframe,form')&&!c.querySelector('a,button,script,img,iframe,form');})()`,
      "The packaged MCP snapshot lost literal JSON, null/empty distinctions, closure or its read-only boundary.",
    );
    await tools.evaluate(socket, `${empty}.querySelector('summary').focus()`);
    await tools.pressTab(socket);
    const focusPredicate = hasVisibleNativePatchFocus.toString();
    await tools.waitForPage(
      socket,
      `(() => {const d=${empty},p=d?.querySelector('pre[aria-label="Arguments report"]'),style=p?getComputedStyle(p):null;let specified=null;try{for(const sheet of document.styleSheets)for(const rule of sheet.cssRules??[])if(rule.selectorText===':focus-visible'){const value=Number.parseFloat(rule.style.getPropertyValue('outline-width')||rule.style.getPropertyValue('outline'));if(Number.isFinite(value))specified=value;}}catch{}const width=style?Number.parseFloat(style.outlineWidth):NaN,dpr=devicePixelRatio,proof=${focusPredicate};return proof({activeIsPre:document.activeElement===p,focusVisible:p?.matches(':focus-visible')===true,outlineStyle:style?.outlineStyle,specifiedCssPx:specified,outlineWidthCssPx:width,dpr});})()`,
      "The packaged MCP JSON region did not support visible keyboard focus.",
    );
    if (posts) throw Error("The native MCP inspection sent a POST.");
    if (!readFileSync(file).equals(before))
      throw Error(
        "Inspecting the packaged MCP report changed its saved private bytes.",
      );
    // The screenshot is captured only after all assertions, with all report identity text masked.
    await tools.evaluate(
      socket,
      `document.querySelectorAll('.af-session-report-source').forEach(p=>{p.textContent='Native app-server snapshot · identifiers masked';});document.querySelectorAll('[data-session-id],[data-project-id]').forEach(e=>{e.removeAttribute('data-session-id');e.removeAttribute('data-project-id');});`,
    );
    await tools.screenshot(socket, "native-chat-mcp-tool-calls.png");
  } finally {
    socket.removeEventListener("message", observe);
    if (typeof originalHash === "string")
      await tools
        .evaluate(socket, `location.hash=${JSON.stringify(originalHash)}`)
        .catch(() => undefined);
  }
}
