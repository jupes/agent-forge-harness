import { expect, test } from "bun:test";
import { createSessionsClient } from "../../apps/desktop/src/session-client";
import type {
  OwnedCodingSessionRecord,
  OwnedSessionStartRequest,
} from "../../types/codex-owned-task";

const projectId = "project-a5832fa0-7a21-403b-8184-44892f0d8d86";
const requestId = "18da5c95-3218-439c-a33d-e5662465f505";
const id = "session-2d5ed741-5528-424c-a927-263348778dad";
const at = "2026-10-23T03:00:00.000Z";
const input = {
  provider: "codex" as const,
  smith: "codex-journeyman",
  repository: "/repo",
  worktree: "/repo",
  launch: {
    mode: "task" as const,
    model: "gpt-example-exact",
    prompt: "  Private Task\n",
    sandbox: "read-only" as const,
    approvalPolicy: "never" as const,
    attachments: [
      { kind: "text" as const, name: "note.txt", text: "Private attachment" },
    ],
  },
  about: [{ kind: "bead" as const, id: "alpha-epic" }],
};
const record = {
  id,
  projectId,
  requestId,
  requestHash: "a".repeat(64),
  mode: "task" as const,
  provider: "codex" as const,
  workspace: "/repo",
  repository: "/repo",
  worktree: "/repo",
  smith: input.smith,
  requestedModel: input.launch.model,
  requestedEffort: null,
  createdAt: at,
};
const turn = {
  requestId,
  hash: "a".repeat(64),
  phase: "completed" as const,
  createdAt: at,
  updatedAt: at,
  reason: null,
  owner: null,
};
const page = {
  version: 1,
  projectId,
  conversationId: id,
  revision: 2,
  binding: {
    provider: "codex",
    sessionId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
    version: "0.163.0-alpha.10.2",
  },
  turns: [turn],
  frames: [],
  more: false,
  nextCursor: 0,
  lastSequence: 0,
  request: turn,
  controllable: false,
};

test("Codex lost Start preserves its explicit immutable provider intent across edits and retries, then confirms one Task", async () => {
  const sent: OwnedSessionStartRequest[] = [];
  let listed = false;
  const client = createSessionsClient({
    canWrite: () => true,
    requestId: () => requestId,
    list: async () => (listed ? [record] : []),
    read: async () => page,
    post: async (_project, _session, action, body) => {
      if (action === "start" && "launch" in body) sent.push(body);
      return { state: "unknown", message: "Lost response" };
    },
    stream: () => () => ({ close() {} }),
  });
  client.editComposer(projectId, {
    prompt: input.launch.prompt,
    attachments: input.launch.attachments,
    about: input.about,
  });
  client.chooseComposerProvider(projectId, "codex");
  client.editCodexComposer(projectId, {
    model: input.launch.model,
    effort: "high",
    sandbox: "read-only",
  });
  const original = structuredClone(input);
  await client.start(projectId, original);
  original.launch.attachments[0]!.text = "Edited caller object";
  client.chooseComposerProvider(projectId, "claude");
  client.editComposer(projectId, { prompt: "Next draft" });
  client.editCodexComposer(projectId, { model: "next-model" });
  await client.start(projectId, {
    ...input,
    launch: { ...input.launch, prompt: "Must not replace original" },
  });
  await client.retryStart(projectId);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  expect(sent[0]).toMatchObject({
    provider: "codex",
    requestId,
    launch: {
      prompt: "  Private Task\n",
      attachments: [{ text: "Private attachment" }],
    },
  });
  listed = true;
  await client.refresh(projectId);
  expect(client.project(projectId).pendingStart).toBeNull();
  expect(client.project(projectId).lastStarted).toBe(id);
  expect(client.project(projectId).composer.prompt).toBe("Next draft");
  expect(client.project(projectId).codexComposer).toMatchObject({
    model: "next-model",
    effort: "high",
  });
  client.draft(projectId, id, "A Task must not become Chat");
  expect(client.canSend(projectId, id)).toBe(false);
  await client.send(projectId, id);
  expect(sent).toHaveLength(2);
  client.dispose();
});

test("a same-UUID receipt from another provider cannot confirm Codex Start", async () => {
  let listed: OwnedCodingSessionRecord[] = [];
  let reads = 0;
  const client = createSessionsClient({
    canWrite: () => true,
    requestId: () => requestId,
    list: async () => listed,
    read: async () => {
      reads++;
      return page;
    },
    post: async () => ({ state: "unknown", message: "Lost response" }),
    stream: () => () => ({ close() {} }),
  });
  await client.start(projectId, input);
  listed = [{ ...record, provider: "claude" }];
  await client.refresh(projectId);
  expect(reads).toBe(0);
  expect(client.project(projectId).pendingStart?.requestId).toBe(requestId);
  expect(client.project(projectId).lastStarted).toBeNull();
  expect(client.project(projectId).error).toContain("could not be verified");
  client.dispose();
});
