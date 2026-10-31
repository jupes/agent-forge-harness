import { useEffect, useRef } from "preact/hooks";
import { actionOutcome } from "../../../docs/js/action-outcome";
import { operatorPost, operatorRead } from "../../../docs/js/operator";
import { pageReads, readOperatorRoute } from "../../../docs/js/use-stream";
import {
  CODEX_CHAT_DECISION_IDENTITIES,
  createCodexChatDecisionIdentities,
} from "./codex-chat-decision-identities";
import { createCodexChatDecisions } from "./codex-chat-decisions";
import {
  createGeminiChatDecisionIdentities,
  GEMINI_CHAT_DECISION_IDENTITIES,
} from "./gemini-chat-decision-identities";
import { createGeminiChatDecisions } from "./gemini-chat-decisions";

export interface ChatDecisionActivation {
  projectId: string;
  workspace: string;
  sessionId: string;
  acceptedTurnId: string;
  requestId: string | null;
  generation: number;
  turnRequestId: string | null;
  actionable: boolean;
}

export interface ChatDecisionAuthority {
  canWrite(address: ChatDecisionActivation): boolean;
  isCurrent(address: ChatDecisionActivation): boolean;
  isSameAuthorityScope(
    address: ChatDecisionActivation,
    provider: "codex" | "gemini",
  ): boolean;
}

export interface ChatDecisionScope {
  projectId: string;
  workspace: string;
  sessionId: string;
  provider: "codex" | "gemini";
}

export interface ChatDecisionOwnerPlatform {
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  withLock<T>(name: string, work: () => T | Promise<T>): Promise<T>;
}

type CodexClient = ReturnType<typeof createCodexChatDecisions>;
type GeminiClient = ReturnType<typeof createGeminiChatDecisions>;
type SharedClient<T> = Omit<T, "activate" | "dispose"> & {
  activate(address: Omit<ChatDecisionActivation, "generation"> | null): void;
};

export interface ChatDecisionOwners {
  codex: SharedClient<CodexClient>;
  gemini: SharedClient<GeminiClient>;
  dispose(): void;
}

export function createChatDecisionAuthorityProxy(latest: {
  current: ChatDecisionAuthority;
}): ChatDecisionAuthority {
  return {
    canWrite: (address) => latest.current.canWrite(address),
    isCurrent: (address) => latest.current.isCurrent(address),
    isSameAuthorityScope: (address, provider) =>
      latest.current.isSameAuthorityScope(address, provider),
  };
}

const route = (project: string, session: string) =>
  `/projects/${encodeURIComponent(project)}/sessions/${encodeURIComponent(session)}`;

function browserPlatform(): ChatDecisionOwnerPlatform {
  let storage: Storage | null = null;
  try {
    storage = window.localStorage;
  } catch {
    /* Refuse before POST if the existing identity store is unavailable. */
  }
  return {
    storage,
    withLock: async (name, work) => {
      if (!navigator.locks)
        throw Error("Shared original approval decision lock is unavailable.");
      return navigator.locks.request(
        name,
        { signal: AbortSignal.timeout(30_000) },
        work,
      );
    },
  };
}

/** One original-decision factory and identity store per provider for the app lifetime. */
export function createChatDecisionOwners(
  authority: ChatDecisionAuthority,
  platform: ChatDecisionOwnerPlatform = browserPlatform(),
): ChatDecisionOwners {
  const currentAuthority = { current: authority };
  let codexAddress: ChatDecisionActivation | null = null;
  let geminiAddress: ChatDecisionActivation | null = null;
  let codexGeneration = 0;
  let geminiGeneration = 0;
  const current = (address: ChatDecisionActivation | null) =>
    !!address && currentAuthority.current.isCurrent(address);
  const writable = (address: ChatDecisionActivation | null) =>
    !!address && current(address) && currentAuthority.current.canWrite(address);

  const codex = createCodexChatDecisions({
    identities: createCodexChatDecisionIdentities({
      storage: platform.storage,
      withLock: (work) =>
        platform.withLock(CODEX_CHAT_DECISION_IDENTITIES, work),
    }),
    canWrite: () => writable(codexAddress),
    current: () => (current(codexAddress) ? codexAddress : null),
    scopeCurrent: () =>
      codexAddress &&
      currentAuthority.current.isSameAuthorityScope(codexAddress, "codex")
        ? {
            projectId: codexAddress.projectId,
            workspace: codexAddress.workspace,
            sessionId: codexAddress.sessionId,
            provider: "codex",
          }
        : null,
    requestId: () => crypto.randomUUID(),
    read: (projectId, sessionId, requestId) =>
      readOperatorRoute(
        `${route(projectId, sessionId)}/approvals${requestId ? `?requestId=${encodeURIComponent(requestId)}` : ""}`,
        { ...pageReads(), fetch: operatorRead },
      ),
    post: (projectId, sessionId, body) =>
      actionOutcome(
        () =>
          operatorPost(
            `/__agent-forge${route(projectId, sessionId)}/approval-decisions`,
            body,
          ),
        "Check the original approval decision receipt; do not choose another identity.",
      ),
  });
  const gemini = createGeminiChatDecisions({
    identities: createGeminiChatDecisionIdentities({
      storage: platform.storage,
      withLock: (work) =>
        platform.withLock(GEMINI_CHAT_DECISION_IDENTITIES, work),
    }),
    canWrite: () => writable(geminiAddress),
    current: () => (current(geminiAddress) ? geminiAddress : null),
    scopeCurrent: () =>
      geminiAddress &&
      currentAuthority.current.isSameAuthorityScope(geminiAddress, "gemini")
        ? {
            projectId: geminiAddress.projectId,
            workspace: geminiAddress.workspace,
            sessionId: geminiAddress.sessionId,
            provider: "gemini",
          }
        : null,
    requestId: () => crypto.randomUUID(),
    read: (projectId, sessionId, requestId) =>
      readOperatorRoute(
        `${route(projectId, sessionId)}/approvals${requestId ? `?requestId=${encodeURIComponent(requestId)}` : ""}`,
        { ...pageReads(), fetch: operatorRead },
      ),
    post: (projectId, sessionId, body) =>
      actionOutcome(
        () =>
          operatorPost(
            `/__agent-forge${route(projectId, sessionId)}/approval-decisions`,
            body,
          ),
        "Check the original approval decision receipt; do not choose another identity.",
      ),
  });

  const {
    activate: activateCodex,
    dispose: disposeCodex,
    ...codexPublic
  } = codex;
  const {
    activate: activateGemini,
    dispose: disposeGemini,
    ...geminiPublic
  } = gemini;
  const sharedCodex = Object.assign({}, codexPublic, {
    activate(address: Omit<ChatDecisionActivation, "generation"> | null) {
      codexGeneration++;
      codexAddress = address
        ? { ...address, generation: codexGeneration }
        : null;
      activateCodex(codexAddress);
    },
  }) as SharedClient<CodexClient>;
  const sharedGemini = Object.assign({}, geminiPublic, {
    activate(address: Omit<ChatDecisionActivation, "generation"> | null) {
      geminiGeneration++;
      geminiAddress = address
        ? { ...address, generation: geminiGeneration }
        : null;
      activateGemini(geminiAddress);
    },
  }) as SharedClient<GeminiClient>;
  return {
    codex: sharedCodex,
    gemini: sharedGemini,
    dispose() {
      codexAddress = null;
      geminiAddress = null;
      disposeCodex();
      disposeGemini();
    },
  };
}

/** Keep the mutable authority current while retaining exactly one owner pair. */
export function useChatDecisionOwners(authority: ChatDecisionAuthority) {
  const latest = useRef(authority);
  latest.current = authority;
  const held = useRef<ChatDecisionOwners | null>(null);
  if (!held.current) {
    held.current = createChatDecisionOwners(
      createChatDecisionAuthorityProxy(latest),
    );
  }
  const owners = held.current;
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === CODEX_CHAT_DECISION_IDENTITIES)
        owners.codex.refreshIdentities();
      if (event.key === GEMINI_CHAT_DECISION_IDENTITIES)
        owners.gemini.refreshIdentities();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [owners]);
  useEffect(() => () => owners.dispose(), [owners]);
  return owners;
}
