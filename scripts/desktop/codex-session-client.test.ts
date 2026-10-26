import { expect, test } from "bun:test";
import { createSessionsClient } from "../../apps/desktop/src/session-client";
import { sessionStartHash } from "../../apps/desktop/src/session-start-identities";
import type {
  OwnedCodingSessionRecord,
  OwnedSessionStartRequest,
} from "../../types/codex-owned-task";
import { codexTaskLaunchFromStart } from "../sessions/codex-owned-preparation";
import { preparedCodexTaskSchema } from "../sessions/codex-task-runtime-protocol";
import { sessionStartFixture } from "./session-start-fixture";

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
record.requestHash = await sessionStartHash({ ...input, requestId });
const originalTaskSnapshot = preparedCodexTaskSchema.parse({
  version: 1,
  provider: "codex",
  smith: input.smith,
  cwd: input.worktree,
  canonicalCwd: input.worktree,
  launch: codexTaskLaunchFromStart(projectId, input),
  capabilities: {
    version: "0.163.0-alpha.10.2",
    flags: ["--json", "--color", "--sandbox", "--model", "--cd", "--config"],
  },
});
const turn = {
  requestId,
  hash: record.requestHash,
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
  frames: [
    {
      seq: 1,
      turnId: requestId,
      at,
      event: {
        kind: "user" as const,
        text: input.launch.prompt,
        about: input.about,
        codexTask: originalTaskSnapshot,
      },
    },
  ],
  more: false,
  nextCursor: 1,
  lastSequence: 1,
  request: turn,
  controllable: false,
};

test("switching Codex modes preserves separate Chat and Task options and shared private context without starting either", () => {
  let posts = 0;
  const client = createSessionsClient({
    identities: sessionStartFixture().identities,
    canWrite: () => true,
    requestId: () => requestId,
    list: async () => [],
    read: async () => page,
    post: async () => {
      posts++;
      return { state: "unknown", message: "Unexpected dispatch" };
    },
    stream: () => () => ({ close() {} }),
  });
  client.editComposer(projectId, { prompt: "PRIVATE shared context" });
  client.editCodexComposer(projectId, { model: "task-model", effort: "high" });
  client.chooseCodexMode(projectId, "chat");
  client.editCodexChatComposer(projectId, {
    model: "chat-model",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  });
  client.chooseComposerProvider(projectId, "claude");
  client.chooseComposerProvider(projectId, "codex");
  client.chooseCodexMode(projectId, "task");
  expect(client.project(projectId)).toMatchObject({
    codexMode: "task",
    composer: { prompt: "PRIVATE shared context" },
    codexComposer: { model: "task-model", effort: "high" },
    codexChatComposer: {
      model: "chat-model",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    },
  });
  client.chooseCodexMode(projectId, "chat");
  expect(client.project(projectId).codexChatComposer.model).toBe("chat-model");
  expect(posts).toBe(0);
  client.dispose();
});

test("Codex lost Start preserves its explicit immutable provider intent across edits and retries, then confirms one Task", async () => {
  const sent: OwnedSessionStartRequest[] = [];
  let listed = false;
  const client = createSessionsClient({
    identities: sessionStartFixture().identities,
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
    identities: sessionStartFixture().identities,
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

test("recreating the client cannot replace a Start whose original POST has not reached admission", async () => {
  const sent: unknown[] = [];
  const journal = sessionStartFixture();
  let next = 0;
  const make = () =>
    createSessionsClient({
      identities: journal.make(),
      canWrite: () => true,
      requestId: () =>
        next++ === 0 ? requestId : "28da5c95-3218-439c-a33d-e5662465f505",
      list: async () => [],
      read: async () => {
        throw Error("No admission yet");
      },
      post: async (_project, _session, _action, body) => {
        sent.push(body);
        return { state: "unknown", message: "POST delivery unknown" };
      },
      stream: () => () => ({ close() {} }),
    });
  const first = make();
  await first.start(projectId, input);
  first.dispose();
  const second = make();
  await second.refresh(projectId);
  await second.start(projectId, {
    ...input,
    launch: { ...input.launch, prompt: "A replacement must stay blocked" },
  });
  expect(sent).toHaveLength(1);
  expect(next).toBe(1);
  expect(second.project(projectId).startIdentity?.requestId).toBe(requestId);
  expect(JSON.stringify([...journal.values])).not.toContain(
    input.launch.prompt,
  );
  second.dispose();
});

test("a restored metadata hold clears only after matching protected provider/hash and actual admitted turn", async () => {
  const journal = sessionStartFixture();
  let listed: OwnedCodingSessionRecord[] = [],
    admitted = false,
    posts = 0;
  const make = () =>
    createSessionsClient({
      identities: journal.make(),
      canWrite: () => true,
      requestId: () => requestId,
      list: async () => listed,
      read: async () =>
        admitted ? page : { ...page, turns: [], request: null },
      post: async () => {
        posts++;
        return { state: "unknown", message: "Unknown" };
      },
      stream: () => () => ({ close() {} }),
    });
  const first = make();
  await first.start(projectId, input);
  first.dispose();
  const second = make();
  expect(second.project(projectId).startIdentity?.requestId).toBe(requestId);
  listed = [{ ...record, requestHash: "f".repeat(64) }];
  await second.refresh(projectId);
  expect(second.project(projectId).lastStarted).toBeNull();
  expect(journal.identities.read(projectId)).not.toBeNull();
  listed = [record];
  await second.refresh(projectId);
  expect(journal.identities.read(projectId)).not.toBeNull();
  admitted = true;
  await second.refresh(projectId);
  await journal.withLock(() => {});
  expect(second.project(projectId).lastStarted).toBe(id);
  expect(journal.identities.read(projectId)).toBeNull();
  expect(posts).toBe(1);
  second.dispose();
});

test("uncertain refusals and failed durable erasure retain the hold; only a guaranteed unsent request can release it", async () => {
  for (const kind of ["generic-refusal", "not-sent", "erase-fails"] as const) {
    const journal = sessionStartFixture();
    let posts = 0;
    const identities =
      kind === "erase-fails"
        ? {
            ...journal.identities,
            release: async () => {
              throw Error("Storage unavailable");
            },
          }
        : journal.identities;
    const client = createSessionsClient({
      identities,
      canWrite: () => true,
      requestId: () => requestId,
      list: async () => [],
      read: async () => page,
      post: async () => {
        posts++;
        return kind === "generic-refusal"
          ? { state: "refused", message: "No admission guarantee" }
          : {
              state: "refused",
              message: "The request never left this browser",
              notSent: true,
            };
      },
      stream: () => () => ({ close() {} }),
    });
    await client.start(projectId, input);
    expect(posts).toBe(1);
    expect(journal.identities.read(projectId) === null).toBe(
      kind === "not-sent",
    );
    expect(client.project(projectId).pendingStart === null).toBe(
      kind === "not-sent",
    );
    if (kind === "erase-fails")
      expect(client.project(projectId).startIdentityError).toContain("durably");
    client.dispose();
  }
});
