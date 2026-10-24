/** Packaged, inert review probe. The caller owns and validates this smoke home. */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { conversationFile } from "../conversations/paths";
import { createConversationStore } from "../conversations/store";
import { keeperProposalFile } from "../keeper/proposal-store";
import { keeperProposals } from "../keeper/proposals";
import { sessionRegistryFile } from "../sessions/registry";

interface PageTools {
  evaluate(socket: WebSocket, expression: string): Promise<unknown>;
  reload(socket: WebSocket): Promise<void>;
  waitForPage(
    socket: WebSocket,
    expression: string,
    error: string,
  ): Promise<void>;
  command(
    socket: WebSocket,
    method: string,
    parameters: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  screenshot(socket: WebSocket, name: string): Promise<void>;
}
const title = "Review native session";
const prompt = "Inspect the native fixture without starting a provider.";
const edited = "Keep this separate native review draft.";
const bytes = (file: string) =>
  existsSync(file) ? readFileSync(file).toString("base64") : null;

/** No executable, tool, ledger event, registry reservation or new write authority. */
export async function verifyKeeperSessionReview(
  socket: WebSocket,
  fixture: { home: string; workspace: string; projectId: string },
  tools: PageTools,
): Promise<void> {
  const store = createConversationStore(fixture.home);
  const before = store.read(fixture.projectId);
  if (before.turns.length || before.frames.length)
    throw Error("Native review must follow the unchanged empty Keeper checks.");
  const requestId = randomUUID(),
    owner = randomUUID();
  await store.accept(fixture.projectId, {
    requestId,
    expectedRevision: before.revision,
    text: "Recorded native review fixture question",
    about: [],
  });
  await store.start(fixture.projectId, requestId, owner);
  await store.append(fixture.projectId, requestId, owner, {
    kind: "identity",
    provider: "claude",
    sessionId: randomUUID(),
    version: "recorded-native-fixture",
  });
  await store.append(fixture.projectId, requestId, owner, {
    kind: "text",
    text: JSON.stringify({
      kind: "keeper.proposals.v1",
      message: "Review this suggestion before any Start.",
      proposals: [
        {
          title,
          detail: "A saved inert native proposal; Cancel starts nothing.",
          action: {
            kind: "start-session",
            provider: "claude",
            smith: "claude-journeyman",
            beadId: "fixture-epic",
            repository: fixture.workspace,
            worktree: "current",
            prompt,
          },
        },
      ],
    }),
  });
  await store.finish(fixture.projectId, requestId, owner, "completed", null);
  const [proposal] = keeperProposals(store.read(fixture.projectId));
  if (!proposal || proposal.draft.action.kind !== "start-session")
    throw Error("The strict native source did not project its session card.");
  const protectedPath = `/__agent-forge/projects/${fixture.projectId}/keeper/proposals/${proposal.id}/session-start`;
  const snapshots = [
    conversationFile(fixture.home, fixture.projectId),
    keeperProposalFile(fixture.home, fixture.projectId),
    sessionRegistryFile(fixture.home),
  ].map((file) => ({ file, before: bytes(file) }));
  const originalHash = await tools.evaluate(socket, "location.hash"),
    posts: string[] = [],
    statuses: number[] = [];
  const observe = (event: MessageEvent) => {
    let value: unknown;
    try {
      value = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (!value || typeof value !== "object" || !("params" in value)) return;
    const params = value.params;
    if (!params || typeof params !== "object") return;
    if ("method" in value && value.method === "Network.requestWillBeSent") {
      if (!("request" in params)) return;
      const request = params.request;
      if (
        request &&
        typeof request === "object" &&
        "method" in request &&
        request.method === "POST" &&
        "url" in request &&
        typeof request.url === "string"
      ) {
        const path = new URL(request.url).pathname;
        if (
          /\/keeper\/proposals\//.test(path) ||
          /\/session-worktrees(?:\/|$)/.test(path) ||
          /\/sessions(?:\/|$)/.test(path)
        )
          posts.push(path);
      }
    }
    if ("method" in value && value.method === "Network.responseReceived") {
      if (!("response" in params)) return;
      const response = params.response;
      if (
        response &&
        typeof response === "object" &&
        "url" in response &&
        typeof response.url === "string" &&
        new URL(response.url).pathname === protectedPath &&
        "status" in response &&
        typeof response.status === "number"
      )
        statuses.push(response.status);
    }
  };
  const card = `Array.from(document.querySelectorAll('.af-proposal-card')).find(card=>card.querySelector('h3')?.textContent===${JSON.stringify(title)})`;
  const review = `document.querySelector('dialog[aria-labelledby="af-keeper-session-review-title"][open]')`;
  const opener = `Array.from((${card})?.querySelectorAll('button')??[]).find(button=>button.textContent.trim()==='Review & start')`;
  const key = async (name: string, code: number) => {
    for (const type of ["keyDown", "keyUp"])
      await tools.command(socket, "Input.dispatchKeyEvent", {
        type,
        key: name,
        code: name,
        windowsVirtualKeyCode: code,
      });
  };
  socket.addEventListener("message", observe);
  try {
    await tools.evaluate(
      socket,
      `location.hash='#/desktop/project/${fixture.projectId}/keeper'`,
    );
    // Reload the observer so the newly saved private fixture is read through the
    // actual compiled route; this does not dispatch or replay a turn.
    await tools.reload(socket);
    await tools.waitForPage(
      socket,
      `!!(${opener}) && !(${opener}).disabled`,
      "The packaged Keeper did not show its strict saved session proposal.",
    );
    await tools.evaluate(socket, `(${opener}).focus()`);
    await key("Enter", 13);
    await tools.waitForPage(
      socket,
      `(() => {const dialog=${review};const input=dialog?.querySelector('[aria-label="Session prompt"]');return input?.value===${JSON.stringify(prompt)}&&!input.readOnly;})()`,
      "The packaged review did not read its protected original and exact prefill.",
    );
    await tools.waitForPage(
      socket,
      `(() => {const dialog=${review};if(!dialog)return false;const buttons=[...dialog.querySelectorAll('button')],provider=label=>buttons.find(button=>button.textContent.trim().startsWith(label));return provider('Cx · Codex')?.disabled && provider('Gm · Gemini')?.disabled && provider('Cl · Claude')?.textContent.includes('Not installed') && dialog.textContent.includes('Keeper session reviews support Claude here.') && buttons.find(button=>button.textContent.trim()==='Start')?.disabled && dialog.querySelector('[aria-label="Session repository"]')?.value===${JSON.stringify(fixture.workspace)} && dialog.querySelector('[aria-label="Session smith"]')?.value==='claude-journeyman' && dialog.querySelector('[aria-label="Session mode"]')?.value==='task';})()`,
      "Native review lost its Claude-only or unavailable-CLI boundary.",
    );
    if (!statuses.includes(404))
      throw Error("The compiled protected original read was not observed.");
    const denied = await tools.evaluate(
      socket,
      `(async()=>{const response=await fetch(${JSON.stringify(protectedPath)},{signal:AbortSignal.timeout(5000)});return response.status;})()`,
    );
    if (denied !== 403)
      throw Error(
        "The native private original read did not require its operator token.",
      );
    await tools.evaluate(
      socket,
      `(() => {const input=(${review}).querySelector('[aria-label="Session prompt"]');input.value=${JSON.stringify(edited)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await key("Escape", 27);
    await tools.waitForPage(
      socket,
      `!(${review}) && document.activeElement===(${opener})`,
      "Native Escape did not return review focus to its exact card.",
    );
    if (
      !(await tools.evaluate(
        socket,
        `getComputedStyle(${opener}).outlineWidth==='2px' && getComputedStyle(${opener}).outlineStyle==='solid'`,
      ))
    )
      throw Error("Native review return focus lost its visible 2px outline.");
    await key("Enter", 13);
    await tools.waitForPage(
      socket,
      `(${review})?.querySelector('[aria-label="Session prompt"]')?.value===${JSON.stringify(edited)}`,
      "The native review lost its edited draft after closing.",
    );
    await tools.screenshot(socket, "native-keeper-session-review.png");
    await tools.evaluate(
      socket,
      `Array.from((${review}).querySelectorAll('button')).find(button=>button.textContent.trim()==='Cancel').focus()`,
    );
    await key("Enter", 13);
    await tools.waitForPage(
      socket,
      `!(${review}) && document.activeElement===(${opener})`,
      "Native Cancel did not close the review and return keyboard focus.",
    );
    if (posts.length)
      throw Error("The inert native review sent a session or worktree action.");
    for (const snapshot of snapshots)
      if (bytes(snapshot.file) !== snapshot.before)
        throw Error(
          "The native review changed private history or session admission.",
        );
  } catch (error) {
    // Preserve the failing screen before finally restores the prior route.
    // These facts deliberately omit the prompt, private replies and source IDs.
    const state = await tools
      .evaluate(
        socket,
        `(() => {const dialog=${review},input=dialog?.querySelector('[aria-label="Session prompt"]'),button=${opener};return {dialogOpen:!!dialog,promptMatches:input?.value===${JSON.stringify(prompt)},promptReadOnly:input?.readOnly??null,choicesUnavailable:!!dialog?.textContent.includes('Session choices could not be loaded.'),claudeOnlyReason:!!dialog?.textContent.includes('Keeper session reviews support Claude here.'),openerConnected:!!button?.isConnected,openerFocused:document.activeElement===button};})()`,
      )
      .catch(() => ({ stateUnavailable: true }));
    const screenshot = await tools
      .screenshot(socket, "native-keeper-session-review-failure.png")
      .then(
        () => true,
        () => false,
      );
    throw new Error(
      `${error instanceof Error ? error.message : "Native review failed."} Probe facts: ${JSON.stringify({ state, protectedStatuses: statuses.slice(-8), screenshot })}`,
      { cause: error },
    );
  } finally {
    socket.removeEventListener("message", observe);
    if (typeof originalHash === "string")
      await tools.evaluate(
        socket,
        `location.hash=${JSON.stringify(originalHash)}`,
      );
  }
}
