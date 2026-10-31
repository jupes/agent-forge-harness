import { expect, test } from "bun:test";
import { chatDecisionAuthorityScopeIsCurrent } from "../../apps/desktop/src/chat-decision-authority";
import {
  type ChatDecisionActivation,
  createChatDecisionAuthorityProxy,
  createChatDecisionOwners,
} from "../../apps/desktop/src/chat-decision-owners";
import { createCodexChatDecisionIdentities } from "../../apps/desktop/src/codex-chat-decision-identities";
import { createCodexChatDecisions } from "../../apps/desktop/src/codex-chat-decisions";
import { createGeminiChatDecisionIdentities } from "../../apps/desktop/src/gemini-chat-decision-identities";
import { createGeminiChatDecisions } from "../../apps/desktop/src/gemini-chat-decisions";
import type { InboxPermissionSelection } from "../../apps/desktop/src/inbox-model";
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
      inboxSelectionGeneration: 3,
    },
    project = { id: projectId, workspaces: [{ root: workspace }] },
    summary = {
      projectId,
      workspace,
      complete: true,
      sessionsComplete: true,
      problems: [],
    },
    session = { id: sessionId, projectId, workspace, mode: "chat", provider },
    sessionList = { loaded: true, loading: false, error: "" };
  let selectedInboxPermission: InboxPermissionSelection | null = null;
  let currentRoute: DesktopRoute = {
    destination: "sessions",
    projectId,
    selection: { kind: "session", id: sessionId },
  };
  const authority = {
    canWrite: () => true,
    isCurrent: (current: ChatDecisionActivation) => {
      const addressMatches =
        current.projectId === projectId &&
        current.workspace === workspace &&
        current.sessionId === sessionId &&
        current.acceptedTurnId === turnRequestId &&
        current.requestId === approvalId &&
        current.turnRequestId === turnRequestId &&
        current.actionable;
      return Boolean(
        addressMatches &&
          (currentRoute.destination === "sessions" ||
            (selectedInboxPermission?.state === "current" &&
              selectedInboxPermission.actionable &&
              chatDecisionAuthorityScopeIsCurrent({
                address: current,
                provider,
                route: currentRoute,
                actualRoute: currentRoute,
                project,
                summary,
                session,
                sessionList,
                inboxSelection: selectedInboxPermission,
              }))),
      );
    },
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
        sessionList,
        inboxSelection: selectedInboxPermission,
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
    selectedInboxPermission = {
      kind: "permission",
      state: "current",
      complete: true,
      actionable: true,
      projectId,
      workspace,
      provider,
      sessionId,
      acceptedTurnId: turnRequestId,
      offerId: approvalId,
      snapshotGeneration: 4,
      currentSnapshotGeneration: 4,
      selectionGeneration: 3,
      currentSelectionGeneration: 3,
    };
    expect(owner.view()?.activation).toMatchObject({
      projectId,
      workspace,
      sessionId,
      acceptedTurnId: turnRequestId,
      requestId: approvalId,
      turnRequestId,
    });

    for (const contextProjectId of [null, "project-foreign-context"]) {
      currentRoute = {
        destination: "inbox",
        projectId: contextProjectId,
        selection: null,
      };
      expect(owner.view()?.activation).toMatchObject({
        projectId,
        sessionId,
        requestId: approvalId,
      });
    }

    const currentSelection = selectedInboxPermission;
    for (const mismatch of [
      { ...currentSelection, workspace: "C:/workspaces/beta" },
      { ...currentSelection, offerId: "d1757233-e46b-4b0a-abcf-dc4958b13c9f" },
      { ...currentSelection, complete: false },
      { ...currentSelection, snapshotGeneration: 3 },
      {
        ...currentSelection,
        selectionGeneration: 4,
        currentSelectionGeneration: 4,
      },
    ]) {
      selectedInboxPermission = mismatch;
      expect(owner.view()).toBeNull();
    }
    selectedInboxPermission = currentSelection;
    summary.complete = false;
    expect(owner.view()).toBeNull();
    summary.complete = true;
    currentRoute = { destination: "inbox", projectId, selection: null };
    selectedInboxPermission = {
      ...currentSelection,
      selectionGeneration: 4,
      currentSelectionGeneration: 4,
    };
    expect(owner.view()).toBeNull();
    owner.activate({ ...address, inboxSelectionGeneration: 4 });
    expect(owner.view()?.activation).toMatchObject({
      inboxSelectionGeneration: 4,
      requestId: approvalId,
      turnRequestId,
    });
    selectedInboxPermission = {
      ...selectedInboxPermission,
      state: "held",
      actionable: false,
    };
    expect(owner.view()).toMatchObject({ pending: [], actionable: false });
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

test("Codex decision factory sends nothing after Inbox selection leaves and returns", async () => {
  let reads = 0,
    posts = 0,
    writes = 0;
  const address: ChatDecisionActivation = {
      projectId,
      workspace: "C:/workspaces/alpha",
      sessionId,
      acceptedTurnId: turnRequestId,
      requestId: approvalId,
      generation: 1,
      inboxSelectionGeneration: 2,
      turnRequestId,
      actionable: true,
    },
    inboxSelection: InboxPermissionSelection = {
      kind: "permission",
      state: "current",
      complete: true,
      actionable: true,
      projectId,
      workspace: address.workspace,
      provider: "codex",
      sessionId,
      acceptedTurnId: turnRequestId,
      offerId: approvalId,
      snapshotGeneration: 2,
      currentSnapshotGeneration: 2,
      selectionGeneration: 4,
      currentSelectionGeneration: 4,
    },
    route: DesktopRoute = { destination: "inbox", projectId, selection: null },
    scope = () =>
      chatDecisionAuthorityScopeIsCurrent({
        address,
        provider: "codex",
        route,
        actualRoute: route,
        project: { id: projectId, workspaces: [{ root: address.workspace }] },
        summary: {
          projectId,
          workspace: address.workspace,
          complete: true,
          sessionsComplete: true,
          problems: [],
        },
        session: {
          id: sessionId,
          projectId,
          workspace: address.workspace,
          provider: "codex",
          mode: "chat",
        },
        sessionList: { loaded: true, loading: false, error: "" },
        inboxSelection,
      });
  const owner = createCodexChatDecisions({
    identities: createCodexChatDecisionIdentities({
      storage: {
        getItem: () =>
          JSON.stringify({
            version: 1,
            records: [
              {
                requestId: "4ed0a0c0-32da-4d6d-972f-616f2489556e",
                turnRequestId,
                approvalId,
                decision: "accept",
                projectId,
                sessionId,
              },
            ],
          }),
        setItem: () => {
          writes++;
        },
      },
      withLock: async (work) => work(),
    }),
    canWrite: () => true,
    current: () => (scope() ? address : null),
    scopeCurrent: () =>
      scope()
        ? {
            projectId,
            workspace: address.workspace,
            sessionId,
            provider: "codex",
          }
        : null,
    requestId: () => "",
    read: async () => {
      reads++;
      return null;
    },
    post: async () => {
      posts++;
      throw Error("A stale Inbox selection must not dispatch.");
    },
  });
  owner.activate(address);
  expect(owner.view()).toBeNull();
  await owner.checkOriginal();
  await owner.decide(approvalId, "accept");
  expect(reads).toBe(0);
  expect(posts).toBe(0);
  expect(writes).toBe(0);
  owner.dispose();
});

test("Gemini decision factory sends nothing after Inbox selection leaves and returns", async () => {
  let reads = 0,
    posts = 0,
    writes = 0;
  const address: ChatDecisionActivation = {
      projectId,
      workspace: "C:/workspaces/alpha",
      sessionId,
      acceptedTurnId: turnRequestId,
      requestId: approvalId,
      generation: 1,
      inboxSelectionGeneration: 2,
      turnRequestId,
      actionable: true,
    },
    inboxSelection: InboxPermissionSelection = {
      kind: "permission",
      state: "current",
      complete: true,
      actionable: true,
      projectId,
      workspace: address.workspace,
      provider: "gemini",
      sessionId,
      acceptedTurnId: turnRequestId,
      offerId: approvalId,
      snapshotGeneration: 2,
      currentSnapshotGeneration: 2,
      selectionGeneration: 4,
      currentSelectionGeneration: 4,
    },
    route: DesktopRoute = { destination: "inbox", projectId, selection: null },
    scope = () =>
      chatDecisionAuthorityScopeIsCurrent({
        address,
        provider: "gemini",
        route,
        actualRoute: route,
        project: { id: projectId, workspaces: [{ root: address.workspace }] },
        summary: {
          projectId,
          workspace: address.workspace,
          complete: true,
          sessionsComplete: true,
          problems: [],
        },
        session: {
          id: sessionId,
          projectId,
          workspace: address.workspace,
          provider: "gemini",
          mode: "chat",
        },
        sessionList: { loaded: true, loading: false, error: "" },
        inboxSelection,
      });
  const owner = createGeminiChatDecisions({
    identities: createGeminiChatDecisionIdentities({
      storage: {
        getItem: () =>
          JSON.stringify({
            version: 1,
            records: [
              {
                requestId: "4ed0a0c0-32da-4d6d-972f-616f2489556e",
                turnRequestId,
                approvalId,
                optionId: null,
                projectId,
                sessionId,
              },
            ],
          }),
        setItem: () => {
          writes++;
        },
      },
      withLock: async (work) => work(),
    }),
    canWrite: () => true,
    current: () => (scope() ? address : null),
    scopeCurrent: () =>
      scope()
        ? {
            projectId,
            workspace: address.workspace,
            sessionId,
            provider: "gemini",
          }
        : null,
    requestId: () => "",
    read: async () => {
      reads++;
      return null;
    },
    post: async () => {
      posts++;
      throw Error("An incomplete Inbox selection must not dispatch.");
    },
  });
  owner.activate(address);
  expect(owner.view()).toBeNull();
  await owner.checkOriginal();
  await owner.decide(approvalId, null);
  expect(reads).toBe(0);
  expect(posts).toBe(0);
  expect(writes).toBe(0);
  owner.dispose();
});

async function verifyHeldReadRejectsReturnedActivation(
  provider: "codex" | "gemini",
) {
  const workspace = "C:/workspaces/alpha";
  let route: DesktopRoute = {
      destination: "inbox",
      projectId: null,
      selection: null,
    },
    selectionGeneration = 5,
    reads = 0,
    posts = 0,
    writes = 0,
    observedActivation: ChatDecisionActivation | null = null,
    sessionList = { loaded: true, loading: false, error: "" };
  const readGate: { resolve?: (value: unknown) => void } = {};
  const pendingRead = new Promise<unknown>((resolve) => {
    readGate.resolve = resolve;
  });
  const rawIdentity = {
    requestId: "4ed0a0c0-32da-4d6d-972f-616f2489556e",
    turnRequestId,
    approvalId,
    projectId,
    sessionId,
    ...(provider === "codex" ? { decision: "accept" } : { optionId: null }),
  };
  let identityStore = JSON.stringify({ version: 1, records: [rawIdentity] });
  let inboxSelection: InboxPermissionSelection = {
    kind: "permission",
    state: "current",
    complete: true,
    actionable: true,
    projectId,
    workspace,
    provider,
    sessionId,
    acceptedTurnId: turnRequestId,
    offerId: approvalId,
    snapshotGeneration: 8,
    currentSnapshotGeneration: 8,
    selectionGeneration,
    currentSelectionGeneration: selectionGeneration,
  };
  const storage = {
      getItem: () => identityStore,
      setItem: (_key: string, value: string) => {
        writes++;
        identityStore = value;
      },
    },
    activationBase = {
      projectId,
      workspace,
      sessionId,
      acceptedTurnId: turnRequestId,
      requestId: approvalId,
      turnRequestId,
      actionable: true,
    },
    scopeFor = (address: Omit<ChatDecisionActivation, "generation">) =>
      chatDecisionAuthorityScopeIsCurrent({
        address: { ...address, generation: 0 },
        provider,
        route,
        actualRoute: route,
        project: { id: projectId, workspaces: [{ root: workspace }] },
        summary: {
          projectId,
          workspace,
          complete: true,
          sessionsComplete: true,
          problems: [],
        },
        session: {
          id: sessionId,
          projectId,
          workspace,
          provider,
          mode: "chat",
        },
        sessionList,
        inboxSelection,
      });
  let freshAddress: typeof activationBase & {
    inboxSelectionGeneration: number;
  } = {
    ...activationBase,
    inboxSelectionGeneration: selectionGeneration,
  };

  let activate: (
      address: typeof activationBase & { inboxSelectionGeneration: number },
    ) => void,
    view: () => unknown,
    checkOriginal: () => Promise<void>,
    dispatch: () => Promise<void>,
    dispose: () => void;
  const common = {
    canWrite: () => true,
    current: () => observedActivation,
    scopeCurrent: () =>
      scopeFor(freshAddress)
        ? {
            projectId,
            workspace,
            sessionId,
            provider,
            inboxSelectionGeneration: selectionGeneration,
          }
        : null,
    requestId: () => "",
    read: async () => {
      reads++;
      return reads === 1
        ? pendingRead
        : {
            pending: [],
            receipt: {
              ...rawIdentity,
              state: "recorded",
              projectId,
              sessionId,
              recordedAt: "2026-10-31T00:00:00.000Z",
            },
          };
    },
    post: async () => {
      posts++;
      throw Error("Held original must never dispatch.");
    },
  };
  if (provider === "codex") {
    const owner = createCodexChatDecisions({
      ...common,
      identities: createCodexChatDecisionIdentities({
        storage,
        withLock: async (work) => work(),
      }),
    });
    activate = (address) => {
      owner.activate(address);
      observedActivation = owner.view()?.activation ?? null;
    };
    view = () => owner.view();
    checkOriginal = () => owner.checkOriginal();
    dispatch = () => owner.decide(approvalId, "accept");
    dispose = () => owner.dispose();
  } else {
    const owner = createGeminiChatDecisions({
      ...common,
      identities: createGeminiChatDecisionIdentities({
        storage,
        withLock: async (work) => work(),
      }),
    });
    activate = (address) => {
      owner.activate(address);
      observedActivation = owner.view()?.activation ?? null;
    };
    view = () => owner.view();
    checkOriginal = () => owner.checkOriginal();
    dispatch = () => owner.decide(approvalId, null);
    dispose = () => owner.dispose();
  }
  try {
    activate(freshAddress);
    expect(view()).toMatchObject({ identity: rawIdentity });
    const staleCheck = checkOriginal();
    await Promise.resolve();
    expect(reads).toBe(1);
    route = {
      destination: "sessions",
      projectId,
      selection: { kind: "session", id: sessionId },
    };
    selectionGeneration++;
    route = {
      destination: "inbox",
      projectId: "project-other-context",
      selection: null,
    };
    inboxSelection = {
      ...inboxSelection,
      selectionGeneration,
      currentSelectionGeneration: selectionGeneration,
    };
    observedActivation = null;
    expect(view()).toBeNull();
    await dispatch();
    const resolveRead = readGate.resolve;
    if (!resolveRead) throw Error("The original held read was not pending.");
    resolveRead({ pending: [], receipt: null });
    await staleCheck;
    await dispatch();
    expect(posts).toBe(0);
    expect(writes).toBe(0);
    const identityStoreSnapshot = (): string => identityStore;
    expect(identityStoreSnapshot()).toContain(rawIdentity.requestId);
    expect(reads).toBe(1);

    freshAddress = {
      ...activationBase,
      inboxSelectionGeneration: selectionGeneration,
    };
    activate(freshAddress);
    expect(view()).toMatchObject({
      identity: rawIdentity,
      pending: [],
      actionable: false,
    });
    sessionList = {
      loaded: false,
      loading: true,
      error: "session list is refreshing",
    };
    await checkOriginal();
    expect(reads).toBe(1);
    expect(writes).toBe(0);
    sessionList = { loaded: true, loading: false, error: "" };
    await checkOriginal();
    expect(reads).toBe(2);
    expect(posts).toBe(0);
    expect(writes).toBeGreaterThan(0);
  } finally {
    dispose();
  }
}

test("Codex held original survives A→away→A while read waits; fresh activation can confirm it", async () => {
  await verifyHeldReadRejectsReturnedActivation("codex");
});

test("Gemini held original survives A→away→A while read waits; fresh activation can confirm it", async () => {
  await verifyHeldReadRejectsReturnedActivation("gemini");
});

async function verifyLiveDecisionReadRejectsReturnedActivation(
  provider: "codex" | "gemini",
) {
  const workspace = "C:/workspaces/alpha";
  let route: DesktopRoute = {
      destination: "inbox",
      projectId: null,
      selection: null,
    },
    selectionGeneration = 1,
    inboxSelection: InboxPermissionSelection = {
      kind: "permission",
      state: "current",
      complete: true,
      actionable: true,
      projectId,
      workspace,
      provider,
      sessionId,
      acceptedTurnId: turnRequestId,
      offerId: approvalId,
      snapshotGeneration: 8,
      currentSnapshotGeneration: 8,
      selectionGeneration,
      currentSelectionGeneration: selectionGeneration,
    },
    observedAddress: ChatDecisionActivation | null = null,
    sessionList = { loaded: true, loading: false, error: "" },
    readCalls = 0,
    posts = 0,
    writes = 0,
    saved: string | null = null;
  const delayedDecisionReads = new Map<number, Promise<unknown>>(),
    releaseDecisionReads = new Map<number, (value: unknown) => void>();
  const savedSnapshot = (): string | null => saved;
  for (const call of [2, 4, 5])
    delayedDecisionReads.set(
      call,
      new Promise<unknown>((resolve) =>
        releaseDecisionReads.set(call, resolve),
      ),
    );
  const project = { id: projectId, workspaces: [{ root: workspace }] },
    summary = {
      projectId,
      workspace,
      complete: true,
      sessionsComplete: true,
      problems: [],
    },
    session = { id: sessionId, projectId, workspace, mode: "chat", provider },
    pendingPage: unknown =
      provider === "codex"
        ? {
            pending: [
              {
                turnRequestId,
                actionable: true,
                detailsUnavailableReason: null,
                approval: {
                  id: approvalId,
                  kind: "command",
                  command: "command",
                  cwd: workspace,
                  reason: "requested",
                  availableDecisions: ["accept", "decline", "cancel"],
                },
              },
            ],
            receipt: null,
          }
        : {
            pending: [
              {
                turnRequestId,
                actionable: true,
                approval: {
                  id: approvalId,
                  detail: { json: "{}", truncated: false },
                  detailsComplete: true,
                  options: [
                    {
                      optionId: "native-allow",
                      name: "Allow once",
                      kind: "allow_once",
                    },
                    {
                      optionId: "native-reject",
                      name: "Reject once",
                      kind: "reject_once",
                    },
                  ],
                },
              },
            ],
            receipt: null,
          },
    scopeIsCurrent = (address: ChatDecisionActivation) =>
      chatDecisionAuthorityScopeIsCurrent({
        address,
        provider,
        route,
        actualRoute: route,
        project,
        summary,
        session,
        sessionList,
        inboxSelection,
      }),
    address: ChatDecisionActivation = {
      projectId,
      workspace,
      sessionId,
      acceptedTurnId: turnRequestId,
      requestId: approvalId,
      generation: 1,
      inboxSelectionGeneration: selectionGeneration,
      turnRequestId,
      actionable: true,
    },
    storage = {
      getItem: () => saved,
      setItem: (_key: string, value: string) => {
        writes++;
        saved = value;
      },
    },
    read = async () => {
      readCalls++;
      return delayedDecisionReads.get(readCalls) ?? pendingPage;
    },
    post = async () => {
      posts++;
      return {
        state: "unknown" as const,
        message: "awaiting original receipt",
      };
    };
  const common = {
    canWrite: () => true,
    current: () =>
      observedAddress && scopeIsCurrent(observedAddress)
        ? observedAddress
        : null,
    scopeCurrent: () =>
      observedAddress && scopeIsCurrent(observedAddress)
        ? {
            projectId,
            workspace,
            sessionId,
            provider,
            inboxSelectionGeneration: selectionGeneration,
          }
        : null,
    requestId: () => "93eb33c3-9386-4dda-a4d4-4b26d04d869a",
    read,
    post,
  };
  let refreshPending: () => Promise<void>,
    decide: () => Promise<void>,
    activate: (next: ChatDecisionActivation) => void,
    dispose: () => void;
  if (provider === "codex") {
    const owner = createCodexChatDecisions({
      ...common,
      identities: createCodexChatDecisionIdentities({
        storage,
        withLock: async (work) => work(),
      }),
    });
    refreshPending = () => owner.refreshPending();
    decide = () => owner.decide(approvalId, "accept");
    activate = (next) => {
      owner.activate(next);
      observedAddress = next;
    };
    dispose = () => owner.dispose();
  } else {
    const owner = createGeminiChatDecisions({
      ...common,
      identities: createGeminiChatDecisionIdentities({
        storage,
        withLock: async (work) => work(),
      }),
    });
    refreshPending = () => owner.refreshPending();
    decide = () => owner.decide(approvalId, "native-allow");
    activate = (next) => {
      owner.activate(next);
      observedAddress = next;
    };
    dispose = () => owner.dispose();
  }
  try {
    activate(address);
    await refreshPending();
    const liveDecision = decide();
    await Promise.resolve();
    expect(readCalls).toBe(2);
    route = {
      destination: "sessions",
      projectId,
      selection: { kind: "session", id: sessionId },
    };
    route = {
      destination: "inbox",
      projectId: "project-other-context",
      selection: null,
    };
    selectionGeneration++;
    inboxSelection = {
      ...inboxSelection,
      selectionGeneration,
      currentSelectionGeneration: selectionGeneration,
    };
    observedAddress = null;
    releaseDecisionReads.get(2)?.(pendingPage);
    await liveDecision;
    expect(posts).toBe(0);
    expect(writes).toBe(0);
    expect(saved).toBeNull();

    const freshAddress: ChatDecisionActivation = {
      ...address,
      generation: 2,
      inboxSelectionGeneration: selectionGeneration,
    };
    activate(freshAddress);
    await refreshPending();
    const loadingDecision = decide();
    await Promise.resolve();
    expect(readCalls).toBe(4);
    sessionList = { loaded: true, loading: true, error: "refreshing" };
    releaseDecisionReads.get(4)?.(pendingPage);
    await loadingDecision;
    expect(posts).toBe(0);
    expect(writes).toBe(0);

    sessionList = { loaded: true, loading: false, error: "" };
    const unavailableDecision = decide();
    await Promise.resolve();
    expect(readCalls).toBe(5);
    sessionList = {
      loaded: false,
      loading: false,
      error: "session list unavailable",
    };
    releaseDecisionReads.get(5)?.(pendingPage);
    await unavailableDecision;
    expect(posts).toBe(0);
    expect(writes).toBe(0);

    sessionList = { loaded: true, loading: false, error: "" };
    selectionGeneration++;
    inboxSelection = {
      ...inboxSelection,
      selectionGeneration,
      currentSelectionGeneration: selectionGeneration,
    };
    const recoveredAddress: ChatDecisionActivation = {
      ...freshAddress,
      generation: 3,
      inboxSelectionGeneration: selectionGeneration,
    };
    activate(recoveredAddress);
    await refreshPending();
    await decide();
    expect(readCalls).toBe(7);
    expect(posts).toBe(1);
    expect(writes).toBe(1);
    expect(savedSnapshot()).toContain(approvalId);
  } finally {
    dispose();
  }
}

test("Codex live pending decision cannot dispatch after its protected read spans A→away→A", async () => {
  await verifyLiveDecisionReadRejectsReturnedActivation("codex");
});

test("Gemini live pending decision cannot dispatch after its protected read spans A→away→A", async () => {
  await verifyLiveDecisionReadRejectsReturnedActivation("gemini");
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
