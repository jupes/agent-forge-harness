import { expect, test } from "bun:test";
import {
  createSessionStartIdentityServer,
  type VerifiedSessionIdentityScope,
} from "../../apps/desktop/src/session-start-identity-server";
import type { OperatorPost, OperatorRead } from "../../docs/js/operator";
import { canonicalOwnedSessionStart } from "../../scripts/sessions/codex-owned-protocol";
import type { OwnedSessionStartRequest } from "../../types/codex-owned-task";
import type {
  SessionStartIdentityMetadata,
  SessionStartIdentityPage,
  SessionStartIdentityReply,
} from "../../types/session-start-identities";

const scope: VerifiedSessionIdentityScope = {
  projectId: "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
  workspace: "c:/fixture/workspace",
  generation: 1,
};

const page: SessionStartIdentityPage = {
  version: 1,
  scope: {
    family: "owned-session-start",
    projectId: scope.projectId,
    workspace: scope.workspace,
  },
  identities: [
    {
      version: 1,
      requestId: "b14cc7eb-3231-4930-a288-d411c5ee0426",
      requestHash: "a".repeat(64),
      provider: "codex",
      mode: "chat",
      state: "attempted",
    },
  ],
};

function originalRequest(): OwnedSessionStartRequest {
  return {
    requestId: "d0f45418-10a6-4dfc-9acd-bd8c1a8689a1",
    provider: "codex",
    smith: "codex-default",
    repository: "C:/fixture/repository",
    worktree: "C:/fixture/worktree",
    launch: {
      mode: "chat",
      model: "gpt-5",
      prompt: "PRIVATE original prompt",
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
    },
  };
}

async function hashRequest(request: OwnedSessionStartRequest): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalOwnedSessionStart(request)),
  );
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function reply(
  identity: SessionStartIdentityMetadata,
): SessionStartIdentityReply {
  return {
    version: 1,
    scope: page.scope,
    identity,
  };
}

test("identity list is a strict scoped GET and returns a defensive page copy", async () => {
  let current: VerifiedSessionIdentityScope | null = { ...scope };
  let url = "";
  let method = "";
  let readLimit: number | undefined;
  const read: OperatorRead = async (input, init, limits) => {
      url = input;
      method = init?.method ?? "GET";
      readLimit = limits?.maxBodyBytes;
      return new Response(
        JSON.stringify({ ok: true, data: page, error: null }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
    post: OperatorPost = async () => {
      throw Error("List must not POST.");
    },
    server = createSessionStartIdentityServer({
      currentScope: () => current,
      read,
      post,
    });

  const result = await server.list(scope);

  expect(method).toBe("GET");
  expect(url).toBe(
    `/__agent-forge/projects/${scope.projectId}/session-start-identities`,
  );
  expect(readLimit).toBe(256 * 1024);
  expect(result).toEqual(page);
  expect(result).not.toBe(page);
  expect(() => {
    result.identities[0]!.state = "retired";
  }).toThrow();
  expect(page.identities[0]!.state).toBe("attempted");

  current = { ...scope, generation: scope.generation + 1 };
  await expect(server.list(scope)).rejects.toThrow();
});

test("a rejected or malformed page never becomes an empty identity page", async () => {
  for (const response of [
    new Response(JSON.stringify({ ok: false, data: null, error: "missing" }), {
      status: 404,
    }),
    new Response(
      JSON.stringify({
        ok: true,
        data: { version: 1, identities: [] },
        error: null,
      }),
      {
        status: 200,
      },
    ),
  ]) {
    const server = createSessionStartIdentityServer({
      currentScope: () => scope,
      read: async () => response.clone(),
      post: async () => {
        throw Error("Unexpected POST");
      },
    });
    await expect(server.list(scope)).rejects.toThrow();
  }
});

test("duplicate, multiply unresolved, future and foreign pages are refused", async () => {
  const duplicate = { ...page.identities[0]! };
  const invalidPages: unknown[] = [
    { ...page, identities: [duplicate, { ...duplicate }] },
    {
      ...page,
      identities: [
        duplicate,
        {
          ...duplicate,
          requestId: "d0f45418-10a6-4dfc-9acd-bd8c1a8689a1",
        },
      ],
    },
    { ...page, version: 2 },
    {
      ...page,
      scope: { ...page.scope, workspace: "c:/different/workspace" },
    },
    {
      ...page,
      identities: [{ ...duplicate, state: "future-state" }],
    },
  ];
  for (const invalid of invalidPages) {
    const server = createSessionStartIdentityServer({
      currentScope: () => scope,
      read: async () =>
        new Response(JSON.stringify({ ok: true, data: invalid, error: null }), {
          status: 200,
        }),
      post: async () => {
        throw Error("Unexpected POST");
      },
    });
    await expect(server.list(scope)).rejects.toThrow();
  }
});

test("an oversized list envelope is refused before it can become a page", async () => {
  const oversized = new Response(
    JSON.stringify({
      ok: true,
      data: {
        ...page,
        identities: [
          {
            ...page.identities[0]!,
            requestHash: "a".repeat(256 * 1024),
          },
        ],
      },
      error: null,
    }),
    { status: 200 },
  );
  const server = createSessionStartIdentityServer({
    currentScope: () => scope,
    read: async () => oversized.clone(),
    post: async () => {
      throw Error("Unexpected POST");
    },
  });
  await expect(server.list(scope)).rejects.toThrow("exceeds its limit");
});

test("reserve hashes and posts the frozen original even if the caller mutates it while hashing", async () => {
  const original = originalRequest();
  let posted: unknown;
  let postUrl = "";
  let postLimit: number | undefined;
  let postCount = 0;
  const expectedHash = await hashRequest(original);
  const identity: SessionStartIdentityMetadata = {
    version: 1,
    requestId: original.requestId,
    requestHash: expectedHash,
    provider: "codex",
    mode: "chat",
    state: "reserved",
  };
  const server = createSessionStartIdentityServer({
    currentScope: () => scope,
    read: async () => {
      throw Error("Unexpected GET");
    },
    post: async (url, body, limits) => {
      postCount++;
      postUrl = url;
      postLimit = limits?.maxBodyBytes;
      posted = structuredClone(body);
      return new Response(
        JSON.stringify({ ok: true, data: reply(identity), error: null }),
        {
          status: 200,
        },
      );
    },
  });

  const pending = server.reserve(scope, original);
  original.launch.prompt = "MUTATED prompt";
  const result = await pending;

  expect(postCount).toBe(1);
  expect(postUrl).toBe(
    `/__agent-forge/projects/${scope.projectId}/session-start-identities`,
  );
  expect(postLimit).toBe(64 * 1024);
  expect(posted).toEqual({
    ...original,
    launch: { ...original.launch, prompt: "PRIVATE original prompt" },
  });
  expect(result.request.launch.prompt).toBe("PRIVATE original prompt");
  expect(result.requestHash).toBe(expectedHash);
  expect(JSON.stringify(posted)).not.toContain("MUTATED");
});

test("reserve rechecks verified scope after hashing and before its only POST", async () => {
  const original = originalRequest();
  let current: VerifiedSessionIdentityScope | null = { ...scope };
  let postCount = 0;
  const server = createSessionStartIdentityServer({
    currentScope: () => {
      const snapshot = current;
      current = { ...scope, generation: scope.generation + 1 };
      return snapshot;
    },
    read: async () => {
      throw Error("Unexpected GET");
    },
    post: async () => {
      postCount++;
      throw Error("Scope changed before POST");
    },
  });

  await expect(server.reserve(scope, original)).rejects.toThrow(
    "scope changed",
  );
  expect(postCount).toBe(0);
});

test("retire accepts only a verified reserved metadata object and validates the CAS reply", async () => {
  const original = originalRequest();
  let postCount = 0;
  const reserved: SessionStartIdentityMetadata = {
    version: 1,
    requestId: original.requestId,
    requestHash: await hashRequest(original),
    provider: "codex",
    mode: "chat",
    state: "reserved",
  };
  const reservedPage: SessionStartIdentityPage = {
    ...page,
    identities: [reserved],
  };
  const server = createSessionStartIdentityServer({
    currentScope: () => scope,
    read: async () =>
      new Response(
        JSON.stringify({ ok: true, data: reservedPage, error: null }),
        {
          status: 200,
        },
      ),
    post: async (url, body) => {
      postCount++;
      expect(url).toBe(
        `/__agent-forge/projects/${scope.projectId}/session-start-identities/${original.requestId}/retire`,
      );
      expect(body).toEqual({ requestHash: reserved.requestHash });
      return new Response(
        JSON.stringify({
          ok: true,
          data: reply({ ...reserved, state: "retired" }),
          error: null,
        }),
        { status: 200 },
      );
    },
  });
  const verified = await server.list(scope);
  const row = verified.identities[0]!;
  await expect(server.retire(scope, structuredClone(row))).rejects.toThrow();
  expect(postCount).toBe(0);

  const result = await server.retire(scope, row);
  expect(result.identity.state).toBe("retired");
  expect(postCount).toBe(1);
});

test("a newer same-scope page invalidates an earlier reserved retirement handle", async () => {
  const request = originalRequest();
  let pageVersion = 0;
  let postCount = 0;
  const reserved: SessionStartIdentityMetadata = {
    version: 1,
    requestId: request.requestId,
    requestHash: await hashRequest(request),
    provider: "codex",
    mode: "chat",
    state: "reserved",
  };
  const server = createSessionStartIdentityServer({
    currentScope: () => scope,
    read: async () => {
      pageVersion++;
      const next = {
        ...page,
        identities: [
          { ...reserved, state: pageVersion === 1 ? "reserved" : "attempted" },
        ],
      } satisfies SessionStartIdentityPage;
      return new Response(
        JSON.stringify({ ok: true, data: next, error: null }),
        { status: 200 },
      );
    },
    post: async () => {
      postCount++;
      return new Response(
        JSON.stringify({
          ok: true,
          data: reply({ ...reserved, state: "retired" }),
          error: null,
        }),
        { status: 200 },
      );
    },
  });

  const first = await server.list(scope);
  const earlierReserved = first.identities[0]!;
  const newer = await server.list(scope);
  expect(newer.identities[0]!.state).toBe("attempted");

  await expect(server.retire(scope, earlierReserved)).rejects.toThrow();
  expect(postCount).toBe(0);
});

test("an older pending GET cannot replace the newer verified page", async () => {
  let releaseOlder: (response: Response) => void = () => {};
  let readCount = 0;
  const olderPending = new Promise<Response>((resolve) => {
    releaseOlder = resolve;
  });
  const server = createSessionStartIdentityServer({
    currentScope: () => scope,
    read: async () => {
      readCount++;
      return readCount === 1
        ? olderPending
        : new Response(JSON.stringify({ ok: true, data: page, error: null }), {
            status: 200,
          });
    },
    post: async () => {
      throw Error("Unexpected POST");
    },
  });

  const older = server.list(scope);
  const newer = await server.list(scope);
  expect(newer.identities[0]!.state).toBe("attempted");
  releaseOlder(
    new Response(
      JSON.stringify({
        ok: true,
        data: {
          ...page,
          identities: [{ ...page.identities[0]!, state: "reserved" }],
        },
        error: null,
      }),
      { status: 200 },
    ),
  );
  await expect(older).rejects.toThrow("superseded");
});

test("a reserve reply superseded by a newer page cannot install stale retirement authority", async () => {
  const request = originalRequest();
  const requestHash = await hashRequest(request);
  const reserved: SessionStartIdentityMetadata = {
    version: 1,
    requestId: request.requestId,
    requestHash,
    provider: "codex",
    mode: "chat",
    state: "reserved",
  };
  let releasePost: (response: Response) => void = () => {};
  let postStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    postStarted = resolve;
  });
  const pendingPost = new Promise<Response>((resolve) => {
    releasePost = resolve;
  });
  const currentPage: SessionStartIdentityPage = {
    ...page,
    identities: [{ ...reserved, state: "attempted" }],
  };
  const server = createSessionStartIdentityServer({
    currentScope: () => scope,
    read: async () =>
      new Response(
        JSON.stringify({ ok: true, data: currentPage, error: null }),
        { status: 200 },
      ),
    post: async () => {
      postStarted();
      return pendingPost;
    },
  });

  const reservePending = server.reserve(scope, request);
  await started;
  await server.list(scope);
  releasePost(
    new Response(
      JSON.stringify({ ok: true, data: reply(reserved), error: null }),
      { status: 200 },
    ),
  );
  await expect(reservePending).rejects.toThrow("superseded");
});

test("an aborted protected GET cannot return an eligible page when its reader ignores abort", async () => {
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  let alreadyAbortedReads = 0;
  const alreadyAbortedServer = createSessionStartIdentityServer({
    currentScope: () => scope,
    read: async () => {
      alreadyAbortedReads++;
      return new Response(
        JSON.stringify({ ok: true, data: page, error: null }),
        { status: 200 },
      );
    },
    post: async () => {
      throw Error("Unexpected POST");
    },
  });
  await expect(
    alreadyAbortedServer.list(scope, alreadyAborted.signal),
  ).rejects.toThrow("cancelled");
  expect(alreadyAbortedReads).toBe(0);

  const controller = new AbortController();
  let releaseBody: () => void = () => {};
  let bodyStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    bodyStarted = resolve;
  });
  const bodyGate = new Promise<void>((resolve) => {
    releaseBody = resolve;
  });
  const response = new Response(
    new ReadableStream<Uint8Array>({
      async pull(stream) {
        bodyStarted();
        await bodyGate;
        stream.enqueue(
          new TextEncoder().encode(
            JSON.stringify({ ok: true, data: page, error: null }),
          ),
        );
        stream.close();
      },
    }),
  );
  const server = createSessionStartIdentityServer({
    currentScope: () => scope,
    read: async () => response,
    post: async () => {
      throw Error("Unexpected POST");
    },
  });

  const pending = server.list(scope, controller.signal);
  await started;
  controller.abort();
  releaseBody();
  await expect(pending).rejects.toThrow("cancelled");
});

test("a scope change during response body decoding discards the pending page", async () => {
  let current: VerifiedSessionIdentityScope | null = { ...scope };
  let releaseBody: () => void = () => {};
  let bodyStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    bodyStarted = resolve;
  });
  const bodyGate = new Promise<void>((resolve) => {
    releaseBody = resolve;
  });
  const response = new Response(
    new ReadableStream<Uint8Array>({
      async pull(stream) {
        bodyStarted();
        await bodyGate;
        stream.enqueue(
          new TextEncoder().encode(
            JSON.stringify({ ok: true, data: page, error: null }),
          ),
        );
        stream.close();
      },
    }),
  );
  const server = createSessionStartIdentityServer({
    currentScope: () => current,
    read: async () => response,
    post: async () => {
      throw Error("Unexpected POST");
    },
  });

  const pending = server.list(scope);
  await started;
  current = { ...scope, generation: scope.generation + 1 };
  releaseBody();
  await expect(pending).rejects.toThrow("scope changed");
});

test("reserve uses existing canonical bytes for all six provider/mode shapes", async () => {
  const requests: OwnedSessionStartRequest[] = [
    {
      requestId: "d0f45418-10a6-4dfc-9acd-bd8c1a8689a1",
      smith: "claude-default",
      repository: "C:/fixture/repository",
      worktree: "C:/fixture/worktree",
      launch: {
        mode: "task",
        model: "claude-sonnet-4",
        prompt: "claude task",
      },
    },
    {
      requestId: "e61b84bb-c732-4881-903d-e3b21f5c941f",
      smith: "claude-default",
      repository: "C:/fixture/repository",
      worktree: "C:/fixture/worktree",
      launch: {
        mode: "chat",
        model: "claude-sonnet-4",
        prompt: "claude chat",
      },
    },
    {
      requestId: "c9db1407-a1a4-487f-872b-fd513ca1e7dd",
      provider: "codex",
      smith: "codex-default",
      repository: "C:/fixture/repository",
      worktree: "C:/fixture/worktree",
      launch: {
        mode: "task",
        model: "gpt-5",
        prompt: "codex task",
        sandbox: "workspace-write",
        approvalPolicy: "never",
      },
    },
    {
      requestId: "6d06d3cc-d458-4e62-8609-6484b570efac",
      provider: "codex",
      smith: "codex-default",
      repository: "C:/fixture/repository",
      worktree: "C:/fixture/worktree",
      launch: {
        mode: "chat",
        model: "gpt-5",
        prompt: "codex chat",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
      },
    },
    {
      requestId: "c0072ef5-95b6-4f2d-a29b-2a20f4387b5f",
      provider: "gemini",
      smith: "gemini-default",
      repository: "C:/fixture/repository",
      worktree: "C:/fixture/worktree",
      launch: { route: "gemini-cli", mode: "task", prompt: "gemini task" },
    },
    {
      requestId: "d2b4497d-0095-49f4-8c52-12bed9b44187",
      provider: "gemini",
      smith: "gemini-default",
      repository: "C:/fixture/repository",
      worktree: "C:/fixture/worktree",
      launch: { route: "gemini-cli", mode: "chat", prompt: "gemini chat" },
    },
  ];
  const posts: unknown[] = [];
  const server = createSessionStartIdentityServer({
    currentScope: () => scope,
    read: async () => {
      throw Error("Unexpected GET");
    },
    post: async (_url, body) => {
      const request = body as OwnedSessionStartRequest;
      posts.push(structuredClone(body));
      return new Response(
        JSON.stringify({
          ok: true,
          data: reply({
            version: 1,
            requestId: request.requestId,
            requestHash: await hashRequest(request),
            provider: "provider" in request ? request.provider : "claude",
            mode: request.launch.mode,
            state: "reserved",
          }),
          error: null,
        }),
        { status: 200 },
      );
    },
  });

  for (const request of requests) {
    const result = await server.reserve(scope, request);
    expect(result.requestHash).toBe(await hashRequest(request));
    expect(result.request).toEqual(request);
  }
  expect(posts).toEqual(requests);
});

test("uncertain reserve replies are held after one POST without fallback", async () => {
  let postCount = 0;
  for (const answer of ["lost", "mismatched"] as const) {
    const request = originalRequest();
    const server = createSessionStartIdentityServer({
      currentScope: () => scope,
      read: async () => {
        throw Error("Unexpected GET fallback");
      },
      post: async () => {
        postCount++;
        if (answer === "lost") throw Error("reply lost");
        return new Response(
          JSON.stringify({
            ok: true,
            data: reply({
              version: 1,
              requestId: "e61b84bb-c732-4881-903d-e3b21f5c941f",
              requestHash: "f".repeat(64),
              provider: "codex",
              mode: "chat",
              state: "reserved",
            }),
            error: null,
          }),
          { status: 200 },
        );
      },
    });
    await expect(server.reserve(scope, request)).rejects.toThrow();
  }
  expect(postCount).toBe(2);
});

test("retire rejects forbidden states and leaves lost or mismatched replies held", async () => {
  let postCount = 0;
  const request = originalRequest();
  const base: SessionStartIdentityMetadata = {
    version: 1,
    requestId: request.requestId,
    requestHash: await hashRequest(request),
    provider: "codex",
    mode: "chat",
    state: "reserved",
  };
  let listed: SessionStartIdentityMetadata = base;
  let answer: "lost" | "mismatched" = "lost";
  const server = createSessionStartIdentityServer({
    currentScope: () => scope,
    read: async () =>
      new Response(
        JSON.stringify({
          ok: true,
          data: { ...page, identities: [listed] },
          error: null,
        }),
        { status: 200 },
      ),
    post: async () => {
      postCount++;
      if (answer === "lost") throw Error("reply lost");
      return new Response(
        JSON.stringify({
          ok: true,
          data: reply({
            ...base,
            requestHash: "f".repeat(64),
            state: "retired",
          }),
          error: null,
        }),
        { status: 200 },
      );
    },
  });

  for (const state of [
    "attempted",
    "not-sent",
    "admitted",
    "retired",
  ] as const) {
    listed = { ...base, state };
    const current = await server.list(scope);
    await expect(
      server.retire(scope, current.identities[0]!),
    ).rejects.toThrow();
  }
  expect(postCount).toBe(0);

  listed = base;
  const lost = (await server.list(scope)).identities[0]!;
  await expect(server.retire(scope, lost)).rejects.toThrow();
  expect(postCount).toBe(1);

  answer = "mismatched";
  const mismatched = (await server.list(scope)).identities[0]!;
  await expect(server.retire(scope, mismatched)).rejects.toThrow();
  expect(postCount).toBe(2);
});
