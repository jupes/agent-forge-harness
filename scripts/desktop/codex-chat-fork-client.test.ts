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
import { codexChatForkContextPageSchema } from "../../scripts/sessions/codex-chat-fork-review-protocol";
import { ownedCodingPageSchema } from "../../scripts/sessions/codex-owned-journal";
import { codexChatForkIdentityMetadataSchema } from "../../scripts/sessions/session-operation-identities-protocol";
import type { ConversationPage } from "../../types/conversation";
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
  listOriginals(projectId: string): Promise<CodexChatForkIdentityMetadata[]>;
  dispatchReservedFork(projectId: string, requestId: string): Promise<unknown>;
  canDispatchReservedFork(requestId: string): boolean;
  canRetireFork(requestId: string): boolean;
  retireFork(projectId: string, requestId: string): Promise<unknown>;
  readChildTurns(
    projectId: string,
    childSessionId: string,
    requestId: string,
    after?: number,
  ): Promise<ConversationPage>;
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
function requestPath(path: string): string {
  return new URL(path, "http://localhost").pathname;
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
      `/__agent-forge/projects/${projectId}/sessions/${parentSessionId}/fork-review?throughTurnRequestId=${throughTurnRequestId}&after=0&limit=50`,
      `/__agent-forge/projects/${projectId}/sessions/${parentSessionId}/fork-review?throughTurnRequestId=${throughTurnRequestId}&after=1&limit=50`,
    ]);
    expect(reads).toBe(2);
    expect(posts).toBe(0);
  } finally {
    client.dispose();
  }
});

test("Fork discovery preserves a verified empty page but rejects incomplete or unavailable identity reads", async () => {
  const emptyPage = {
    version: 1,
    scope: { projectId, workspace },
    operations: [],
  };
  let posts = 0;
  const emptyModule = await loadForkClient(),
    emptyClient = emptyModule.createCodexChatForkClient({
      currentScope: scope,
      canWrite: () => true,
      requestId: () => requestId,
      read: (async () => envelope(emptyPage)) satisfies OperatorRead,
      post: (async () => {
        posts++;
        throw new Error("Discovery must not POST");
      }) satisfies OperatorPost,
    });
  try {
    await expect(emptyClient.listOriginals(projectId)).resolves.toEqual([]);
  } finally {
    emptyClient.dispose();
  }

  const unavailablePages: Array<{ name: string; response: Response }> = [
    { name: "404", response: new Response("", { status: 404 }) },
    { name: "unavailable", response: new Response("", { status: 503 }) },
    {
      name: "malformed JSON",
      response: new Response("{", { status: 200 }),
    },
    {
      name: "invalid page",
      response: envelope({
        version: 1,
        scope: { projectId, workspace },
        operations: [{}],
      }),
    },
    {
      name: "wrong project scope",
      response: envelope({
        ...emptyPage,
        scope: {
          projectId: "project-00000000-0000-4000-8000-000000000000",
          workspace,
        },
      }),
    },
    {
      name: "oversized page",
      response: new Response("x".repeat(65_537), { status: 200 }),
    },
  ];

  for (const scenario of unavailablePages) {
    const module = await loadForkClient(),
      client = module.createCodexChatForkClient({
        currentScope: scope,
        canWrite: () => true,
        requestId: () => requestId,
        read: (async () => scenario.response.clone()) satisfies OperatorRead,
        post: (async () => {
          posts++;
          throw new Error("Failed discovery must not POST");
        }) satisfies OperatorPost,
      });
    try {
      await expect(client.listOriginals(projectId)).rejects.toThrow();
    } catch (error) {
      throw new Error(`Fork discovery did not hold on ${scenario.name}.`, {
        cause: error,
      });
    } finally {
      client.dispose();
    }
  }
  let wrongScopeReads = 0;
  const wrongScopeModule = await loadForkClient(),
    wrongScopeClient = wrongScopeModule.createCodexChatForkClient({
      currentScope: scope,
      canWrite: () => true,
      requestId: () => requestId,
      read: (async () => {
        wrongScopeReads++;
        return envelope(emptyPage);
      }) satisfies OperatorRead,
      post: (async () => {
        posts++;
        throw new Error("Invalid scope must not POST");
      }) satisfies OperatorPost,
    });
  try {
    await expect(
      wrongScopeClient.listOriginals(
        "project-00000000-0000-4000-8000-000000000000",
      ),
    ).rejects.toThrow();
  } finally {
    wrongScopeClient.dispose();
  }
  expect(wrongScopeReads).toBe(0);
  expect(posts).toBe(0);
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
          const pathname = requestPath(path);
          if (pathname.endsWith("/session-operation-identities"))
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
      path: `/__agent-forge/projects/${projectId}/sessions/${parentSessionId}/fork-reservations`,
      body: intent,
    });
    expect(
      await client.dispatchReservedFork(projectId, identity.requestId),
    ).toMatchObject({
      state: "held",
    });
    expect(
      await client.dispatchReservedFork(projectId, identity.requestId),
    ).toEqual({
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
        path: `/__agent-forge/projects/${projectId}/session-operation-identities`,
      },
      {
        method: "GET",
        path: `/__agent-forge/projects/${projectId}/codex-chat-forks/${requestId}`,
      },
    ]);
    expect(calls.filter((call) => call.method === "POST")).toEqual([
      {
        method: "POST",
        path: `/__agent-forge/projects/${projectId}/sessions/${parentSessionId}/fork-reservations`,
        body: intent,
      },
      {
        method: "POST",
        path: `/__agent-forge/projects/${projectId}/sessions/${parentSessionId}/forks`,
        body: intent,
      },
    ]);
    expect(forkPosts).toBe(1);
    expect(requestIds).toBe(1);
  } finally {
    recoveryClient.dispose();
  }
});

test("ambiguous reservation stays on its exact UUID when discovery is empty or the original is missing", async () => {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [],
    intent = { requestId, throughTurnRequestId },
    reserved: CodexChatForkIdentityMetadata = {
      family: "codex-chat-fork",
      requestId,
      requestHash,
      parentSessionId,
      throughTurnRequestId,
      state: "reserved",
    };
  let requestIds = 0,
    identityReads = 0,
    reservePosts = 0,
    forkPosts = 0,
    currentGeneration = 3,
    releaseReservation!: (response: Response) => void;
  const reservationReply = new Promise<Response>((resolve) => {
    releaseReservation = resolve;
  });
  const module = await loadForkClient(),
    client = module.createCodexChatForkClient({
      currentScope: () => ({
        projectId,
        workspace,
        generation: currentGeneration,
      }),
      canWrite: () => true,
      requestId: () => {
        requestIds++;
        return requestIds === 1
          ? requestId
          : "b2a3a3c8-e9fa-4f45-8ba8-a29a3ee0fa01";
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
        const pathname = requestPath(path);
        if (pathname.endsWith("/session-operation-identities")) {
          identityReads++;
          return envelope({
            version: 1,
            scope: { projectId, workspace },
            operations: identityReads === 1 ? [] : [reserved],
          });
        }
        if (pathname.endsWith(`/codex-chat-forks/${requestId}`))
          return new Response("not found", { status: 404 });
        throw new Error(`Unexpected GET ${path}`);
      }) satisfies OperatorRead,
      post: (async (path, body) => {
        calls.push({ method: "POST", path, body: structuredClone(body) });
        if (path.endsWith("/fork-reservations")) {
          reservePosts++;
          return reservationReply;
        }
        if (path.endsWith("/forks")) forkPosts++;
        throw new Error("No Fork dispatch is allowed in this recovery case.");
      }) satisfies OperatorPost,
    });

  try {
    const firstSource = await client.reviewSource({
        projectId,
        parentSessionId,
        throughTurnRequestId,
      }),
      firstReservation = client.reserveFork({
        projectId,
        parentSessionId,
        throughTurnRequestId,
        source: firstSource,
      });
    await expect(
      client.reserveFork({
        projectId,
        parentSessionId,
        throughTurnRequestId,
        source: firstSource,
      }),
    ).rejects.toThrow();
    expect(requestIds).toBe(1);
    expect(reservePosts).toBe(1);
    releaseReservation(
      new Response("reply lost after request", { status: 503 }),
    );
    const pending = await firstReservation;
    expect(pending).toMatchObject({
      requestId,
      requestHash,
      parentSessionId,
      throughTurnRequestId,
      state: "reserved",
    });

    await expect(client.listOriginals(projectId)).resolves.toEqual([]);
    expect(await client.recoverOriginal(projectId, requestId)).toMatchObject({
      state: "held",
      identity: reserved,
      original: null,
      context: null,
    });

    const refreshedSource = await client.reviewSource({
        projectId,
        parentSessionId,
        throughTurnRequestId,
      }),
      repeated = await client.reserveFork({
        projectId,
        parentSessionId,
        throughTurnRequestId,
        source: refreshedSource,
      });
    expect(repeated).toEqual(pending);
    expect(requestIds).toBe(1);
    expect(reservePosts).toBe(1);
    expect(forkPosts).toBe(0);
    expect(calls.filter((call) => call.method === "POST")).toEqual([
      {
        method: "POST",
        path: `/__agent-forge/projects/${projectId}/sessions/${parentSessionId}/fork-reservations`,
        body: intent,
      },
    ]);
    expect(client.canDispatchReservedFork(requestId)).toBe(false);

    currentGeneration++;
    await expect(
      client.reserveFork({
        projectId,
        parentSessionId,
        throughTurnRequestId,
        source: refreshedSource,
      }),
    ).rejects.toThrow();
    expect(requestIds).toBe(1);
    expect(reservePosts).toBe(1);
  } finally {
    client.dispose();
  }
});

test("a changed scope or mixed source page cannot become a reserveable review", async () => {
  let generation = 3,
    calls = 0,
    posts = 0;
  const module = await loadForkClient(),
    client = module.createCodexChatForkClient({
      currentScope: () => ({ projectId, workspace, generation }),
      canWrite: () => true,
      requestId: () => requestId,
      read: (async () => {
        calls++;
        generation++;
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
      }) satisfies OperatorRead,
      post: (async () => {
        posts++;
        throw new Error("A changed scope cannot reserve.");
      }) satisfies OperatorPost,
    });
  try {
    await expect(
      client.reviewSource({ projectId, parentSessionId, throughTurnRequestId }),
    ).rejects.toThrow("workspace changed");
    expect(calls).toBe(1);
    expect(posts).toBe(0);
  } finally {
    client.dispose();
  }

  const mixedReplies = [
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
      {
        ...sourcePage({
          frames: [
            {
              kind: "text" as const,
              seq: 2,
              turnId: throughTurnRequestId,
              at: "2026-10-23T03:00:01.000Z",
              text: "Saved reply",
            },
          ],
          complete: true,
          nextCursor: null,
        }),
        settings: {
          ...sourcePage({ frames: [], complete: true, nextCursor: null })
            .settings,
          effort: "low",
        },
      },
    ],
    wrongSourceClient = module.createCodexChatForkClient({
      currentScope: scope,
      canWrite: () => true,
      requestId: () => requestId,
      read: (async () => envelope(mixedReplies.shift())) satisfies OperatorRead,
      post: (async () => {
        posts++;
        throw new Error("A mixed source cannot reserve.");
      }) satisfies OperatorPost,
    });
  try {
    await expect(
      wrongSourceClient.reviewSource({
        projectId,
        parentSessionId,
        throughTurnRequestId,
      }),
    ).rejects.toThrow("changed during review");
    expect(posts).toBe(0);
  } finally {
    wrongSourceClient.dispose();
  }
});

test("disposing a Fork client prevents a delayed source page from becoming actionable", async () => {
  let finish: ((value: Response) => void) | undefined,
    posts = 0;
  const module = await loadForkClient(),
    client = module.createCodexChatForkClient({
      currentScope: scope,
      canWrite: () => true,
      requestId: () => requestId,
      read: (() =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        })) satisfies OperatorRead,
      post: (async () => {
        posts++;
        throw new Error("Disposed clients cannot write.");
      }) satisfies OperatorPost,
    }),
    review = client.reviewSource({
      projectId,
      parentSessionId,
      throughTurnRequestId,
    });
  client.dispose();
  finish?.(
    envelope(
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
    ),
  );
  await expect(review).rejects.toThrow("cancelled");
  expect(posts).toBe(0);
});

test("an undispatched reservation remains safely retireable after reload", async () => {
  const reserved: CodexChatForkIdentityMetadata = {
    family: "codex-chat-fork",
    requestId,
    requestHash,
    parentSessionId,
    throughTurnRequestId,
    state: "reserved",
  };
  const posts: Array<{ path: string; body: unknown }> = [];
  const module = await loadForkClient(),
    make = () =>
      module.createCodexChatForkClient({
        currentScope: scope,
        canWrite: () => true,
        requestId: () => requestId,
        read: (async (path) => {
          const pathname = requestPath(path);
          if (pathname.endsWith("/fork-review"))
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
          if (pathname.endsWith("/session-operation-identities"))
            return envelope({
              version: 1,
              scope: { projectId, workspace },
              operations: [reserved],
            });
          if (pathname.endsWith(`/codex-chat-forks/${requestId}`))
            return envelope(reserved);
          if (pathname.endsWith(`/codex-chat-forks/${requestId}/context`))
            return envelope({
              version: 1,
              available: true,
              requestId,
              requestHash,
              parentSessionId,
              throughTurnRequestId,
              state: "reserved",
              reason: null,
              source: {
                ...sourcePage({
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
                requestId,
              },
            });
          throw new Error(`Unexpected GET ${path}`);
        }) satisfies OperatorRead,
        post: (async (path, body) => {
          posts.push({ path, body: structuredClone(body) });
          if (path.endsWith("/fork-reservations")) return envelope(reserved);
          if (path.endsWith(`/fork-reservations/${requestId}/retire`)) {
            const retired = {
              ...reserved,
              state: "retired" as const,
              retiredReason: "verified-not-sent" as const,
            };
            expect(
              codexChatForkIdentityMetadataSchema.safeParse(retired).success,
            ).toBe(true);
            return envelope(retired);
          }
          throw new Error(`Unexpected POST ${path}`);
        }) satisfies OperatorPost,
      });
  const first = make();
  try {
    const reviewed = await first.reviewSource({
      projectId,
      parentSessionId,
      throughTurnRequestId,
    });
    await first.reserveFork({
      projectId,
      parentSessionId,
      throughTurnRequestId,
      source: reviewed,
    });
  } finally {
    first.dispose();
  }

  const recovered = make();
  try {
    const result = await recovered.recoverOriginal(projectId, requestId);
    expect(result).toMatchObject({ state: "verified", original: reserved });
    expect(recovered.canRetireFork(requestId)).toBe(true);
    expect(await recovered.retireFork(projectId, requestId)).toMatchObject({
      state: "retired",
    });
    expect(posts).toEqual([
      {
        path: `/__agent-forge/projects/${projectId}/sessions/${parentSessionId}/fork-reservations`,
        body: { requestId, throughTurnRequestId },
      },
      {
        path: `/__agent-forge/projects/${projectId}/sessions/${parentSessionId}/fork-reservations/${requestId}/retire`,
        body: { requestHash },
      },
    ]);
  } finally {
    recovered.dispose();
  }
});

test("source review accepts 51 ordered frames across bounded pages", async () => {
  const frames: CodexChatForkSourcePage["frames"] = Array.from(
    { length: 51 },
    (_, index) =>
      index === 0
        ? {
            kind: "user" as const,
            seq: 1,
            turnId: throughTurnRequestId,
            at: "2026-10-23T03:00:00.000Z",
            text: "PRIVATE original prompt",
            about: [],
          }
        : {
            kind: "text" as const,
            seq: index + 1,
            turnId: throughTurnRequestId,
            at: `2026-10-23T03:00:${String(index + 1).padStart(2, "0")}.000Z`,
            text: `saved frame ${index + 1}`,
          },
  );
  const pages = [
    sourcePage({
      frames: frames.slice(0, 50),
      complete: false,
      nextCursor: 50,
    }),
    sourcePage({ frames: frames.slice(50), complete: true, nextCursor: null }),
  ];
  let posts = 0,
    reads = 0;
  const module = await loadForkClient(),
    client = module.createCodexChatForkClient({
      currentScope: scope,
      canWrite: () => true,
      requestId: () => requestId,
      read: (async () => {
        reads++;
        return envelope(pages.shift());
      }) satisfies OperatorRead,
      post: (async () => {
        posts++;
        throw new Error("Source review must remain GET-only.");
      }) satisfies OperatorPost,
    });
  try {
    const reviewed = await client.reviewSource({
      projectId,
      parentSessionId,
      throughTurnRequestId,
    });
    expect(reviewed.frames.map((frame) => frame.seq)).toEqual(
      Array.from({ length: 51 }, (_, index) => index + 1),
    );
    expect(reviewed.settings.serviceTier).toEqual({
      present: true,
      value: null,
    });
    expect(reads).toBe(2);
    expect(posts).toBe(0);
  } finally {
    client.dispose();
  }
});

test("a valid-shaped context for a different source stays held and cannot dispatch", async () => {
  const reserved: CodexChatForkIdentityMetadata = {
    family: "codex-chat-fork",
    requestId,
    requestHash,
    parentSessionId,
    throughTurnRequestId,
    state: "reserved",
  };
  let posts = 0;
  const module = await loadForkClient();
  const mismatches: Array<{
    context: Partial<CodexChatForkContextPage>;
    sourceProjectId?: string;
  }> = [
    { context: { requestHash: "b".repeat(64) } },
    { context: { state: "held" } },
    {
      context: {},
      sourceProjectId: "project-b5832fa0-7a21-403b-8184-44892f0d8d86",
    },
  ];
  for (const mismatch of mismatches) {
    const client = module.createCodexChatForkClient({
      currentScope: scope,
      canWrite: () => true,
      requestId: () => requestId,
      read: (async (path) => {
        const pathname = requestPath(path);
        if (pathname.endsWith("/session-operation-identities"))
          return envelope({
            version: 1,
            scope: { projectId, workspace },
            operations: [reserved],
          });
        if (pathname.endsWith(`/codex-chat-forks/${requestId}`))
          return envelope(reserved);
        if (pathname.endsWith(`/codex-chat-forks/${requestId}/context`)) {
          const matchingContext: CodexChatForkContextPage = {
            version: 1,
            available: true,
            requestId,
            requestHash,
            parentSessionId,
            throughTurnRequestId,
            state: "reserved",
            reason: null,
            source: {
              ...sourcePage({
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
              projectId: mismatch.sourceProjectId ?? projectId,
              requestId,
            },
          };
          expect(
            codexChatForkContextPageSchema.safeParse(matchingContext).success,
          ).toBe(true);
          return envelope({ ...matchingContext, ...mismatch.context });
        }
        throw new Error(`Unexpected GET ${path}`);
      }) satisfies OperatorRead,
      post: (async () => {
        posts++;
        throw new Error("Mismatched source context cannot write.");
      }) satisfies OperatorPost,
    });
    try {
      const recovered = await client.recoverOriginal(projectId, requestId);
      expect(recovered.state).toBe("held");
      expect(recovered.original).toEqual(reserved);
      expect(recovered.context).toBeNull();
      expect(client.canDispatchReservedFork(requestId)).toBe(false);
      expect(posts).toBe(0);
    } finally {
      client.dispose();
    }
  }
});

test("uncertain and unconfirmed Fork reservations cannot be retired", async () => {
  const module = await loadForkClient();
  for (const mode of ["reserve-unknown", "dispatch-unknown"] as const) {
    let posts = 0;
    const client = module.createCodexChatForkClient({
      currentScope: scope,
      canWrite: () => true,
      requestId: () => requestId,
      read: (async () =>
        envelope(
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
        )) satisfies OperatorRead,
      post: (async (path) => {
        posts++;
        if (mode === "reserve-unknown" || path.endsWith("/forks"))
          throw new Error("The Fork outcome is not proven safe to retire.");
        return envelope({
          family: "codex-chat-fork",
          requestId,
          requestHash,
          parentSessionId,
          throughTurnRequestId,
          state: "reserved",
        });
      }) satisfies OperatorPost,
    });
    try {
      const reviewed = await client.reviewSource({
        projectId,
        parentSessionId,
        throughTurnRequestId,
      });
      await client.reserveFork({
        projectId,
        parentSessionId,
        throughTurnRequestId,
        source: reviewed,
      });
      if (mode === "dispatch-unknown")
        expect(await client.dispatchReservedFork(projectId, requestId)).toEqual(
          { state: "held" },
        );
      expect(client.canRetireFork(requestId)).toBe(false);
      await expect(client.retireFork(projectId, requestId)).rejects.toThrow(
        "Only the exact unattempted Fork reservation can be retired.",
      );
      expect(posts).toBe(mode === "reserve-unknown" ? 1 : 2);
    } finally {
      client.dispose();
    }
  }
});

test("Fork child transcript reads preserve verified native coding frames and reject wrong scope", async () => {
  const childSessionId = "session-822c51d0-4d7a-48e9-9c90-9f252b3b8a8f",
    page: ConversationPage = {
      version: 1,
      projectId,
      conversationId: childSessionId,
      revision: 1,
      binding: {
        provider: "codex",
        sessionId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
        version: "0.163.0-alpha.10.2",
      },
      turns: [
        {
          requestId,
          hash: "a".repeat(64),
          phase: "completed",
          createdAt: "2026-10-23T03:00:00.000Z",
          updatedAt: "2026-10-23T03:00:01.000Z",
          reason: null,
          owner: null,
        },
      ],
      frames: [
        {
          seq: 1,
          turnId: requestId,
          at: "2026-10-23T03:00:01.000Z",
          event: {
            kind: "coding-chat",
            provider: "codex",
            version: "0.163.0-alpha.10.2",
            event: {
              kind: "usage",
              usage: {
                lastResponse: { inputTokens: 7 },
                threadTotal: { inputTokens: 70 },
              },
            },
          },
        },
      ],
      more: false,
      nextCursor: 1,
      lastSequence: 1,
      request: null,
      controllable: false,
    };
  expect(ownedCodingPageSchema.safeParse(page).success).toBe(true);
  let responsePage: ConversationPage = page,
    project = projectId,
    generation = 3,
    reads = 0,
    changeScopeOnRead = false;
  const module = await loadForkClient(),
    client = module.createCodexChatForkClient({
      currentScope: () => ({ projectId: project, workspace, generation }),
      canWrite: () => true,
      requestId: () => requestId,
      read: (async () => {
        reads++;
        if (changeScopeOnRead) {
          project = "project-b5832fa0-7a21-403b-8184-44892f0d8d86";
          generation++;
          changeScopeOnRead = false;
        }
        return envelope(responsePage);
      }) satisfies OperatorRead,
      post: (async () => {
        throw new Error("Reading the child transcript must stay GET-only.");
      }) satisfies OperatorPost,
    });
  try {
    const childPage = await client.readChildTurns(
      projectId,
      childSessionId,
      requestId,
    );
    expect(childPage).toEqual(page);
    expect(childPage.frames[0]?.event.kind).toBe("coding-chat");

    responsePage = {
      ...page,
      conversationId: "session-913d62e1-5e8b-49fa-ad01-a0643c4c9b90",
    };
    expect(ownedCodingPageSchema.safeParse(responsePage).success).toBe(true);
    await expect(
      client.readChildTurns(projectId, childSessionId, requestId),
    ).rejects.toThrow("exact Fork-child transcript");

    responsePage = {
      ...page,
      projectId: "project-b5832fa0-7a21-403b-8184-44892f0d8d86",
    };
    expect(ownedCodingPageSchema.safeParse(responsePage).success).toBe(true);
    await expect(
      client.readChildTurns(projectId, childSessionId, requestId),
    ).rejects.toThrow("exact Fork-child transcript");

    responsePage = {
      ...page,
      revision: 0,
      binding: null,
      turns: [],
      frames: [],
      more: false,
      nextCursor: 0,
      lastSequence: 0,
    };
    expect(ownedCodingPageSchema.safeParse(responsePage).success).toBe(true);
    await expect(
      client.readChildTurns(projectId, childSessionId, requestId),
    ).rejects.toThrow("exact Fork-child transcript");

    responsePage = page;
    changeScopeOnRead = true;
    await expect(
      client.readChildTurns(projectId, childSessionId, requestId),
    ).rejects.toThrow("workspace changed");
    expect(reads).toBe(5);
  } finally {
    client.dispose();
  }
});
