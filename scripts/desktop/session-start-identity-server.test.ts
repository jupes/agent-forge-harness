import { expect, test } from "bun:test";
import type { OperatorPost, OperatorRead } from "../../docs/js/operator";
import {
  createSessionStartIdentityServer,
  type VerifiedSessionIdentityScope,
} from "../../apps/desktop/src/session-start-identity-server";
import type { SessionStartIdentityPage } from "../../types/session-start-identities";

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
  result.identities[0]!.state = "retired";
  expect(page.identities[0]!.state).toBe("attempted");

  current = { ...scope, generation: scope.generation + 1 };
  await expect(server.list(scope)).rejects.toThrow();
});
