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

test("reserve hashes and posts the frozen original even if the caller mutates it while hashing", async () => {
  const original = originalRequest();
  let posted: unknown;
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
    post: async (_url, body) => {
      postCount++;
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
  let scopeReads = 0;
  let postCount = 0;
  const server = createSessionStartIdentityServer({
    currentScope: () =>
      ++scopeReads === 1
        ? scope
        : { ...scope, generation: scope.generation + 1 },
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
  expect(scopeReads).toBe(2);
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
