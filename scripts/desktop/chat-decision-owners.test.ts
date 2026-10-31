import { expect, test } from "bun:test";
import { chatDecisionAuthorityScopeIsCurrent } from "../../apps/desktop/src/chat-decision-authority";
import {
  type ChatDecisionActivation,
  createChatDecisionAuthorityProxy,
  createChatDecisionOwners,
} from "../../apps/desktop/src/chat-decision-owners";
import type { DesktopRoute } from "../../apps/desktop/src/navigation";

const projectId = "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
  sessionId = "session-2d5ed741-5528-424c-a927-263348778dad",
  turnRequestId = "18da5c95-3218-439c-a33d-e5662465f505",
  approvalId = "fa5c45ae-8487-4c61-84a5-e22ab343c227";

function expectProviderInboxScope(provider: "codex" | "gemini") {
  const workspace = "C:/workspaces/alpha",
    address = {
      projectId,
      workspace,
      sessionId,
      acceptedTurnId: turnRequestId,
      requestId: approvalId,
      turnRequestId,
      actionable: true,
    },
    project = { id: projectId, workspaces: [{ root: workspace }] },
    summary = { projectId, workspace },
    session = { id: sessionId, projectId, mode: "chat", provider };
  let currentRoute: DesktopRoute = {
    destination: "sessions",
    projectId,
    selection: { kind: "session", id: sessionId },
  };
  const authority = {
    canWrite: () => true,
    isCurrent: (current: ChatDecisionActivation) =>
      current.projectId === projectId &&
      current.workspace === workspace &&
      current.sessionId === sessionId &&
      current.acceptedTurnId === turnRequestId &&
      current.requestId === approvalId &&
      current.turnRequestId === turnRequestId &&
      current.actionable,
    isSameAuthorityScope: (
      current: ChatDecisionActivation,
      currentProvider: "codex" | "gemini",
    ) =>
      chatDecisionAuthorityScopeIsCurrent({
        address: current,
        provider: currentProvider,
        route: currentRoute,
        actualRoute: currentRoute,
        project,
        summary,
        session,
      }),
  };
  const owners = createChatDecisionOwners(authority, {
    storage: {
      getItem: () => null,
      setItem: () => undefined,
    },
    withLock: async (_name, work) => work(),
  });
  const owner = owners[provider];

  try {
    owner.activate(address);
    expect(owner.view()?.activation).toMatchObject({
      projectId,
      workspace,
      sessionId,
      acceptedTurnId: turnRequestId,
      requestId: approvalId,
      turnRequestId,
    });

    currentRoute = { destination: "inbox", projectId, selection: null };
    expect(owner.view()?.activation).toMatchObject({
      projectId,
      workspace,
      sessionId,
      acceptedTurnId: turnRequestId,
      requestId: approvalId,
      turnRequestId,
    });
  } finally {
    owners.dispose();
  }
}

test("Codex owner exposes the exact selected Inbox scope through the shared factory", () => {
  expectProviderInboxScope("codex");
});

test("Gemini owner exposes the exact selected Inbox scope through the shared factory", () => {
  expectProviderInboxScope("gemini");
});

test("authority proxy forwards the mutable same-scope predicate", () => {
  const address: ChatDecisionActivation = {
    projectId,
    workspace: "C:/workspaces/alpha",
    sessionId,
    acceptedTurnId: turnRequestId,
    requestId: approvalId,
    generation: 1,
    turnRequestId,
    actionable: false,
  };
  let accepted = true;
  const proxy = createChatDecisionAuthorityProxy({
    current: {
      canWrite: () => false,
      isCurrent: () => false,
      isSameAuthorityScope: (_address, provider) =>
        accepted && provider === "codex",
    },
  });
  expect(proxy.isSameAuthorityScope(address, "codex")).toBe(true);
  expect(proxy.isSameAuthorityScope(address, "gemini")).toBe(false);
  accepted = false;
  expect(proxy.isSameAuthorityScope(address, "codex")).toBe(false);
});

test("conversation and future Inbox share one per-provider owner with exact root generations", () => {
  const values = new Map<string, string>(),
    base = {
      projectId,
      workspace: "C:/workspaces/alpha",
      sessionId,
      acceptedTurnId: turnRequestId,
      requestId: approvalId,
      turnRequestId,
      actionable: true,
    },
    authorityAddress = { current: null as ChatDecisionActivation | null };
  let currentTurn = true;
  const owners = createChatDecisionOwners(
    {
      canWrite: () => true,
      isCurrent: (address) =>
        currentTurn &&
        JSON.stringify(authorityAddress.current) === JSON.stringify(address),
      isSameAuthorityScope: (address) =>
        authorityAddress.current?.projectId === address.projectId &&
        authorityAddress.current?.workspace === address.workspace &&
        authorityAddress.current?.sessionId === address.sessionId,
    },
    {
      storage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
      },
      withLock: async (_name, work) => work(),
    },
  );
  const conversationCodexOwner = owners.codex,
    futureInboxCodexOwner = owners.codex,
    conversationGeminiOwner = owners.gemini,
    futureInboxGeminiOwner = owners.gemini;

  expect(futureInboxCodexOwner).toBe(conversationCodexOwner);
  expect(futureInboxGeminiOwner).toBe(conversationGeminiOwner);
  expect(conversationCodexOwner).not.toBe(conversationGeminiOwner);

  authorityAddress.current = { ...base, generation: 1 };
  owners.codex.activate(base);
  expect(owners.codex.view()?.activation).toEqual(authorityAddress.current);
  currentTurn = false;
  expect(owners.codex.view()).toMatchObject({ pending: [], actionable: false });
  currentTurn = true;

  const foreign = {
    ...base,
    workspace: "C:/workspaces/beta",
    requestId: "d1757233-e46b-4b0a-abcf-dc4958b13c9f",
  };
  authorityAddress.current = { ...foreign, generation: 2 };
  owners.codex.activate(foreign);
  expect(owners.codex.view()).toMatchObject({
    activation: authorityAddress.current,
    pending: [],
  });

  authorityAddress.current = { ...base, generation: 1 };
  owners.gemini.activate(base);
  expect(owners.gemini.view()?.activation).toEqual(authorityAddress.current);
  owners.dispose();
  expect(owners.codex.view()).toBeNull();
  expect(owners.gemini.view()).toBeNull();
});
