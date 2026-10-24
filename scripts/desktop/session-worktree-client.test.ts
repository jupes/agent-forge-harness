import { expect, test } from "bun:test";
import { createSessionWorktreeClient } from "../../apps/desktop/src/session-worktree-client";
import type { ActionOutcome } from "../../docs/js/action-outcome";
import type { SessionWorktreeRequest } from "../../types/session-worktrees";

const projectId = "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
  requestId = "18da5c95-3218-439c-a33d-e5662465f505";
const input = {
  repository: "/repo",
  baseRef: "HEAD",
  branch: "feat/new-session",
  beadId: "alpha-epic",
};
const worktree = {
  id: `sw-${"a".repeat(28)}`,
  path: `/repo/trees/sw-${"a".repeat(28)}`,
  branch: input.branch,
  createdAt: "2026-10-23T03:00:00.000Z",
};
const receipt = {
  ...input,
  beadId: undefined,
  projectId,
  requestId,
  resolvedCommit: "b".repeat(40),
  worktree,
  state: "created",
  reason: null,
};
const wireReceipt = () => {
  const { beadId: _unused, ...value } = receipt;
  return value;
};

test("unknown worktree creation freezes its original UUID and plan through missing reads, edited plans and refused retries", async () => {
  const posts: SessionWorktreeRequest[] = [];
  let reply: ActionOutcome = { state: "unknown", message: "Lost response" },
    raw: unknown = null;
  const client = createSessionWorktreeClient({
    canWrite: () => true,
    requestId: () => requestId,
    changed() {},
    post: async (_project, body) => {
      posts.push(body);
      return reply;
    },
    read: async () => {
      if (!raw) throw new Error("404");
      return raw;
    },
  });
  await client.create(projectId, input);
  await client.check(projectId);
  expect(client.get(projectId).original).toEqual({ ...input, requestId });
  await client.create(projectId, { ...input, branch: "feat/different" });
  expect(posts).toHaveLength(1);
  reply = {
    state: "refused",
    message: "The repository is temporarily unavailable",
  };
  await client.retry(projectId);
  expect(posts[1]).toEqual(posts[0]);
  expect(client.get(projectId).original?.requestId).toBe(requestId);
  raw = {
    ...wireReceipt(),
    state: "unknown",
    reason: "Git has no confirmed outcome",
  };
  await client.check(projectId);
  expect(client.get(projectId).receipt?.state).toBe("unknown");
  client.another(projectId);
  expect(client.get(projectId).original?.requestId).toBe(requestId);
  raw = wireReceipt();
  await client.check(projectId);
  expect(client.get(projectId).receipt?.state).toBe("created");
  await client.retry(projectId);
  expect(posts).toHaveLength(2);
  expect(client.get("project-beta").receipt).toBeNull();
  client.another(projectId);
  expect(client.get(projectId).original).toBeNull();
});

test("a verified created lookup wins over a delayed malformed create response, while foreign receipts never enable a path", async () => {
  let finish: ((value: ActionOutcome) => void) | undefined,
    raw: unknown = {
      ...wireReceipt(),
      projectId: "project-b5832fa0-7a21-403b-8184-44892f0d8d86",
    };
  const client = createSessionWorktreeClient({
    canWrite: () => true,
    requestId: () => requestId,
    changed() {},
    post: async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    read: async () => raw,
  });
  const starting = client.create(projectId, input);
  await client.check(projectId);
  expect(client.get(projectId).receipt).toBeNull();
  raw = wireReceipt();
  await client.check(projectId);
  finish?.({ state: "done", data: { malformed: true } });
  await starting;
  expect(client.get(projectId).receipt?.state).toBe("created");
  expect(client.get(projectId).notice).toContain("Worktree created");
});

test("a canonical Windows receipt matches the original scoped path without changing its immutable request", async () => {
  const repository = "c:/fixture/repository",
    native = "C:\\Fixture\\Repository";
  const client = createSessionWorktreeClient({
    canWrite: () => true,
    requestId: () => requestId,
    changed() {},
    post: async () => ({
      state: "done",
      data: {
        ...wireReceipt(),
        repository: native,
        worktree: { ...worktree, path: `${native}\\trees\\${worktree.id}` },
      },
    }),
    read: async () => null,
  });
  await client.create(projectId, { ...input, repository });
  expect(client.get(projectId).receipt?.state).toBe("created");
  expect(client.get(projectId).original?.repository).toBe(repository);
});
