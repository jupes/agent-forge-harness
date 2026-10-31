import { expect, test } from "bun:test";
import {
  type ChatDecisionActivation,
  createChatDecisionAuthorityProxy,
  createChatDecisionOwners,
} from "../../apps/desktop/src/chat-decision-owners";

const projectId = "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
  sessionId = "session-2d5ed741-5528-424c-a927-263348778dad",
  turnRequestId = "18da5c95-3218-439c-a33d-e5662465f505",
  approvalId = "fa5c45ae-8487-4c61-84a5-e22ab343c227";

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
