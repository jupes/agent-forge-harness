import { expect, test } from "bun:test";
import type { OperatorPost, OperatorRead } from "../../docs/js/operator";
import {
  CODEX_CHAT_FORK_PROTOCOL_VERSION,
  codexChatForkOriginalHash,
  codexChatForkOriginalHashInput,
} from "../../scripts/sessions/codex-chat-fork-protocol";
import type {
  CodexChatForkContextPage,
  CodexChatForkSourcePage,
} from "../../scripts/sessions/codex-chat-fork-review-protocol";
import type { CodexChatForkIdentityMetadata } from "../../types/session-operation-identities";

const projectId = "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
  parentSessionId = "session-2d5ed741-5528-424c-a927-263348778dad",
  requestId = "18da5c95-3218-439c-a33d-e5662465f505",
  throughTurnRequestId = "925f49e8-14b5-46d2-80f5-a143ae120bed",
  workspace = "/repo",
  requestHash = codexChatForkOriginalHash(
    codexChatForkOriginalHashInput({
      projectId,
      workspaceKey: workspace,
      parentSessionId,
      throughTurnRequestId,
      requestId,
      protocolVersion: CODEX_CHAT_FORK_PROTOCOL_VERSION,
    }),
  );

type Scope = { projectId: string; workspace: string; generation: number };
interface ForkClient {
  reviewSource(input: {
    projectId: string;
    parentSessionId: string;
    throughTurnRequestId: string;
  }): Promise<CodexChatForkSourcePage>;
  reserveFork(input: {
    projectId: string;
    parentSessionId: string;
    throughTurnRequestId: string;
    source: CodexChatForkSourcePage;
  }): Promise<CodexChatForkIdentityMetadata>;
  dispatchReservedFork(projectId: string, requestId: string): Promise<unknown>;
  recoverOriginal(
    projectId: string,
    requestId: string,
  ): Promise<{
    state: "verified" | "held";
    identity: CodexChatForkIdentityMetadata | null;
    original: CodexChatForkIdentityMetadata | null;
    context: CodexChatForkContextPage | null;
  }>;
  dispose(): void;
}
interface ForkClientModule {
  createCodexChatForkClient(deps: {
    currentScope(): Scope | null;
    canWrite(): boolean;
    requestId(): string;
    read: OperatorRead;
    post: OperatorPost;
  }): ForkClient;
}

// Keep the module lookup dynamic so this behavior checkpoint typechecks before
// the new browser-only client exists, while the focused test fails at runtime.
async function loadForkClient(): Promise<ForkClientModule> {
  const modulePath: string = "../../apps/desktop/src/codex-chat-fork-client";
  const loaded: unknown = await import(modulePath);
  if (
    typeof loaded !== "object" ||
    loaded === null ||
    typeof Reflect.get(loaded, "createCodexChatForkClient") !== "function"
  )
    throw new Error("The Codex Fork client could not be loaded.");
  return loaded as ForkClientModule;
}

const scope = (): Scope => ({ projectId, workspace, generation: 3 });
function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, data, error: null }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function sourcePage(input: {
  frames: CodexChatForkSourcePage["frames"];
  complete: boolean;
  nextCursor: number | null;
}): CodexChatForkSourcePage {
  return {
    version: 1,
    projectId,
    parentSessionId,
    requestId: null,
    throughTurnRequestId,
    selectedTurnHash: "a".repeat(64),
    target: {
      smith: "codex-chat",
      repository: workspace,
      worktree: workspace,
      beadId: null,
    },
    settings: {
      model: "gpt-5-codex",
      provider: "codex",
      serviceTier: { present: true, value: null },
      effort: "high",
      approvalPolicy: "on-request",
      sandbox: { mode: "read-only", networkAccess: "not-reported" },
    },
    provenance: {
      turn: "saved-completed-parent-turn",
      configuration: "captured-native-configuration",
    },
    frames: input.frames,
    nextCursor: input.nextCursor,
    complete: input.complete,
  };
}

test("Fork source review reads every page for the explicit turn and never posts", async () => {
  const calls: string[] = [],
    replies = [
      sourcePage({
        frames: [
          {
            kind: "user",
            seq: 1,
            turnId: throughTurnRequestId,
            at: "2026-10-23T03:00:00.000Z",
            text: "PRIVATE original prompt",
            about: [],
          },
        ],
        complete: false,
        nextCursor: 1,
      }),
      sourcePage({
        frames: [
          {
            kind: "text",
            seq: 2,
            turnId: throughTurnRequestId,
            at: "2026-10-23T03:00:01.000Z",
            text: "Saved reply",
          },
        ],
        complete: true,
        nextCursor: null,
      }),
    ];
  let posts = 0,
    reads = 0;
  const module = await loadForkClient(),
    client = module.createCodexChatForkClient({
      currentScope: scope,
      canWrite: () => true,
      requestId: () => requestId,
      read: (async (path) => {
        calls.push(path);
        reads++;
        return envelope(replies.shift());
      }) satisfies OperatorRead,
      post: (async () => {
        posts++;
        throw new Error("Source review must never POST");
      }) satisfies OperatorPost,
    });
  try {
    const reviewed = await client.reviewSource({
      projectId,
      parentSessionId,
      throughTurnRequestId,
    });
    expect(reviewed.throughTurnRequestId).toBe(throughTurnRequestId);
    expect(reviewed.selectedTurnHash).toBe("a".repeat(64));
    expect(reviewed.settings.serviceTier).toEqual({
      present: true,
      value: null,
    });
    expect(reviewed.frames.map((frame) => frame.seq)).toEqual([1, 2]);
    expect(reviewed.frames.map((frame) => frame.kind)).toEqual([
      "user",
      "text",
    ]);
    expect(reviewed.frames[0]?.kind === "user" && reviewed.frames[0].text).toBe(
      "PRIVATE original prompt",
    );
    expect(calls).toEqual([
      `/projects/${projectId}/sessions/${parentSessionId}/fork-review?throughTurnRequestId=${throughTurnRequestId}&after=0&limit=50`,
      `/projects/${projectId}/sessions/${parentSessionId}/fork-review?throughTurnRequestId=${throughTurnRequestId}&after=1&limit=50`,
    ]);
    expect(reads).toBe(2);
    expect(posts).toBe(0);
  } finally {
    client.dispose();
  }
});

test("lost Fork reply reloads the same reserved UUID and hash, keeps a missing original held, and never re-POSTs", async () => {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [],
    intent = { requestId, throughTurnRequestId },
    reserved: CodexChatForkIdentityMetadata = {
      family: "codex-chat-fork",
      requestId,
      requestHash,
      parentSessionId,
      throughTurnRequestId,
      state: "reserved",
    },
    attempted: CodexChatForkIdentityMetadata = {
      ...reserved,
      state: "attempted",
    };
  let requestIds = 0,
    forkPosts = 0;
  const module = await loadForkClient(),
    makeClient = (recovery = false) =>
      module.createCodexChatForkClient({
        currentScope: scope,
        canWrite: () => !recovery,
        requestId: () => {
          requestIds++;
          return requestId;
        },
        read: (async (path, init) => {
          calls.push({ method: init?.method ?? "GET", path });
          if (path.includes("/fork-review?"))
            return envelope(
              sourcePage({
                frames: [
                  {
                    kind: "user",
                    seq: 1,
                    turnId: throughTurnRequestId,
                    at: "2026-10-23T03:00:00.000Z",
                    text: "PRIVATE original prompt",
                    about: [],
                  },
                ],
                complete: true,
                nextCursor: null,
              }),
            );
          if (path.endsWith("/session-operation-identities"))
            return envelope({
              version: 1,
              scope: { projectId, workspace },
              operations: [recovery ? attempted : reserved],
            });
          if (path.endsWith(`/codex-chat-forks/${requestId}`))
            return new Response("not found", { status: 404 });
          throw new Error(`Unexpected GET ${path}`);
        }) satisfies OperatorRead,
        post: (async (path, body) => {
          calls.push({ method: "POST", path, body: structuredClone(body) });
          if (path.endsWith("/fork-reservations")) return envelope(reserved);
          if (path.endsWith("/forks")) {
            forkPosts++;
            throw new Error(
              "The server may have completed Fork before the reply was lost.",
            );
          }
          throw new Error(`Unexpected POST ${path}`);
        }) satisfies OperatorPost,
      });
  const client = makeClient();
  try {
    const reviewed = await client.reviewSource({
        projectId,
        parentSessionId,
        throughTurnRequestId,
      }),
      identity = await client.reserveFork({
        projectId,
        parentSessionId,
        throughTurnRequestId,
        source: reviewed,
      });
    expect(identity).toEqual(reserved);
    expect(calls.at(-1)).toEqual({
      method: "POST",
      path: `/projects/${projectId}/sessions/${parentSessionId}/fork-reservations`,
      body: intent,
    });
    expect(
      await client.dispatchReservedFork(projectId, identity.requestId),
    ).toMatchObject({
      state: "held",
    });
  } finally {
    client.dispose();
  }

  const beforeRecovery = calls.length,
    recoveryClient = makeClient(true);
  try {
    const recovered = await recoveryClient.recoverOriginal(
      projectId,
      requestId,
    );
    expect(recovered).toMatchObject({
      state: "held",
      identity: attempted,
      original: null,
      context: null,
    });
    expect(calls.slice(beforeRecovery)).toEqual([
      {
        method: "GET",
        path: `/projects/${projectId}/session-operation-identities`,
      },
      {
        method: "GET",
        path: `/projects/${projectId}/codex-chat-forks/${requestId}`,
      },
    ]);
    expect(calls.filter((call) => call.method === "POST")).toEqual([
      {
        method: "POST",
        path: `/projects/${projectId}/sessions/${parentSessionId}/fork-reservations`,
        body: intent,
      },
      {
        method: "POST",
        path: `/projects/${projectId}/sessions/${parentSessionId}/forks`,
        body: intent,
      },
    ]);
    expect(forkPosts).toBe(1);
    expect(requestIds).toBe(1);
  } finally {
    recoveryClient.dispose();
  }
});
