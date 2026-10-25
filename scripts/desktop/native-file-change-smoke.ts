import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CodexChatFileChange } from "../../types/codex-chat";
import type {
  CodexChatOwnedRecord,
  CodexChatStartRequest,
} from "../../types/codex-owned-chat";
import { conversationFile } from "../conversations/paths";
import { createConversationStore } from "../conversations/store";
import { canonicalOwnedSessionStart } from "../sessions/codex-owned-protocol";
import { createSessionRegistry } from "../sessions/registry";

/** Historical fixture only. Its saved process marker is never live execution or Stop authority. */
export async function seedNativeFileChangeSession(
  home: string,
  workspace: string,
  projectId: string,
): Promise<CodexChatOwnedRecord> {
  const requestId = randomUUID(),
    prompt = "Private native file report fixture",
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
    pid: 2_000_000_000,
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
  const initial: CodexChatFileChange = {
    kind: "file-change",
    source: "item/started",
    threadId,
    turnId,
    itemId: "native-smoke-files",
    status: "inProgress",
    changes: [
      {
        path: { text: "native-display-only.ts", truncated: false },
        kind: {
          type: "update",
          move_path: { text: "inert/<script>.ts", truncated: false },
        },
        diff: {
          text: "-old\n+<script>native patch stays text</script>",
          truncated: false,
        },
      },
      {
        path: { text: "empty-native.ts", truncated: false },
        kind: { type: "add" },
        diff: { text: "", truncated: false },
      },
    ],
    truncated: false,
    partial: true,
    closure: "open",
    turnStatus: null,
  };
  const ended: CodexChatFileChange = {
    ...initial,
    source: "item/completed",
    status: "declined",
    closure: "item-ended",
    partial: false,
  };
  for (const event of [
    initial,
    ended,
    {
      ...ended,
      source: "turn/completed" as const,
      closure: "turn-ended" as const,
      turnStatus: "completed" as const,
    },
  ])
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

interface FileChangePageTools<Socket extends EventTarget> {
  evaluate(socket: Socket, expression: string): Promise<unknown>;
  waitForPage(socket: Socket, expression: string, error: string): Promise<void>;
  pressTab(socket: Socket): Promise<void>;
  enableRequests(socket: Socket): Promise<void>;
  screenshot(socket: Socket, name: string): Promise<unknown>;
}

export function hasVisibleNativePatchFocus(facts: {
  activeIsPre: unknown;
  focusVisible: unknown;
  outlineStyle: unknown;
  specifiedCssPx: unknown;
  outlineWidthCssPx: unknown;
  dpr: unknown;
}): boolean {
  const width = facts.outlineWidthCssPx,
    dpr = facts.dpr;
  return (
    facts.activeIsPre === true &&
    facts.focusVisible === true &&
    facts.outlineStyle === "solid" &&
    facts.specifiedCssPx === 2 &&
    typeof width === "number" &&
    Number.isFinite(width) &&
    width > 0 &&
    typeof dpr === "number" &&
    Number.isFinite(dpr) &&
    dpr > 0 &&
    Math.abs(width - 2) * dpr < 1
  );
}

function boundedFocusFacts(value: unknown) {
  if (!value || typeof value !== "object") return { available: false as const };
  const facts = value as Record<string, unknown>;
  const shortString = (input: unknown) =>
    typeof input === "string" ? input.slice(0, 32) : null;
  const finiteNumber = (input: unknown) =>
    typeof input === "number" && Number.isFinite(input) ? input : null;
  const boolean = (input: unknown) =>
    typeof input === "boolean" ? input : null;
  return {
    available: true as const,
    reportFound: boolean(facts["reportFound"]),
    preFound: boolean(facts["preFound"]),
    preConnected: boolean(facts["preConnected"]),
    activeIsPre: boolean(facts["activeIsPre"]),
    activeTag: shortString(facts["activeTag"]),
    focusVisible: boolean(facts["focusVisible"]),
    outlineWidth: shortString(facts["outlineWidth"]),
    outlineWidthCssPx: finiteNumber(facts["outlineWidthCssPx"]),
    outlineStyle: shortString(facts["outlineStyle"]),
    specifiedCssPx: finiteNumber(facts["specifiedCssPx"]),
    dpr: finiteNumber(facts["dpr"]),
  };
}

/** Inspect saved fixture bytes in the actual packaged WebView; never dispatch a provider or touch a reported path. */
export async function verifyNativeFileChanges<Socket extends EventTarget>(
  socket: Socket,
  record: CodexChatOwnedRecord,
  home: string,
  tools: FileChangePageTools<Socket>,
) {
  const file = conversationFile(home, record.projectId, {
      kind: "session",
      projectId: record.projectId,
      sessionId: record.id,
    }),
    before = readFileSync(file),
    report = `Array.from(document.querySelectorAll('.af-session-activity-item')).find(d=>d.querySelector('.af-session-report-source')?.textContent?.includes('Item: native-smoke-files'))`,
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
      `!!${report}`,
      "The packaged native file snapshot did not appear in its owned conversation.",
    );
    await tools.evaluate(socket, `${report}.querySelector('summary').click()`);
    await tools.waitForPage(
      socket,
      `(() => { const d=${report}; return d?.open && d.textContent.includes('File changes · Reported declined') && d.textContent.includes('Provider reported an empty diff') && d.textContent.includes('Native turn reported completed') && d.querySelector('pre')?.textContent === ${JSON.stringify("-old\n+<script>native patch stays text</script>")} && !d.querySelector('a,button,script,img,iframe,form'); })()`,
      "The packaged native patch lost its literal text, status or read-only boundary.",
    );
    await tools.evaluate(socket, `${report}.querySelector('summary').focus()`);
    await tools.pressTab(socket);
    try {
      const focusPredicate = hasVisibleNativePatchFocus.toString();
      await tools.waitForPage(
        socket,
        `(() => {const d=${report},p=d?.querySelector('pre'),style=p?getComputedStyle(p):null;let specified=null;try{for(const sheet of document.styleSheets)for(const rule of sheet.cssRules??[])if(rule.selectorText===':focus-visible'){const value=Number.parseFloat(rule.style.getPropertyValue('outline-width')||rule.style.getPropertyValue('outline'));if(Number.isFinite(value))specified=value;}}catch{}const width=style?Number.parseFloat(style.outlineWidth):NaN,dpr=devicePixelRatio,proof=${focusPredicate};return proof({activeIsPre:document.activeElement===p,focusVisible:p?.matches(':focus-visible')===true,outlineStyle:style?.outlineStyle,specifiedCssPx:specified,outlineWidthCssPx:width,dpr});})()`,
        "The packaged native patch region did not support visible keyboard focus.",
      );
    } catch (error) {
      const diagnostic = await tools
        .evaluate(
          socket,
          `(() => {const d=${report},p=d?.querySelector('pre'),style=p?getComputedStyle(p):null;let specifiedCssPx=null;try{for(const sheet of document.styleSheets)for(const rule of sheet.cssRules??[])if(rule.selectorText===':focus-visible'){const value=Number.parseFloat(rule.style.getPropertyValue('outline-width')||rule.style.getPropertyValue('outline'));if(Number.isFinite(value))specifiedCssPx=value;}}catch{}const width=style?Number.parseFloat(style.outlineWidth):NaN;return {reportFound:!!d,preFound:!!p,preConnected:p?.isConnected??null,activeIsPre:document.activeElement===p,activeTag:document.activeElement?.tagName??null,focusVisible:p?.matches(':focus-visible')??null,outlineWidth:style?.outlineWidth??null,outlineWidthCssPx:Number.isFinite(width)?width:null,outlineStyle:style?.outlineStyle??null,specifiedCssPx,dpr:devicePixelRatio};})()`,
        )
        .catch(() => null);
      const facts = boundedFocusFacts(diagnostic);
      const reason =
        error instanceof Error
          ? error.message.slice(0, 240)
          : "The focus assertion did not complete.";
      throw Error(`${reason} Bounded focus facts: ${JSON.stringify(facts)}`);
    }
    if (posts) throw Error("The native file inspection sent a POST.");
    if (!readFileSync(file).equals(before))
      throw Error(
        "Inspecting the packaged file report changed its saved private bytes.",
      );
  } catch (error) {
    await tools
      .screenshot(socket, "native-chat-file-changes-failure.png")
      .catch(() => undefined);
    throw error;
  } finally {
    socket.removeEventListener("message", observe);
    if (typeof originalHash === "string")
      await tools
        .evaluate(socket, `location.hash=${JSON.stringify(originalHash)}`)
        .catch(() => undefined);
  }
}
