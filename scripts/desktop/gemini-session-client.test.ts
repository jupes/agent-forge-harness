import { expect, test } from "bun:test";
import { createSessionsClient } from "../../apps/desktop/src/session-client";
import {
  SESSION_START_IDENTITIES,
  sessionStartHash,
} from "../../apps/desktop/src/session-start-identities";
import { ownedCodingStartReceiptSchema } from "../sessions/codex-owned-wire-protocol";
import { sessionStartFixture } from "./session-start-fixture";

const projectId = "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
  requestId = "18da5c95-3218-439c-a33d-e5662465f505",
  id = `session-${requestId}`,
  at = "2026-10-23T03:00:00.000Z";
const input = {
  provider: "gemini" as const,
  smith: "gemini-example",
  repository: "/repo",
  worktree: "/repo",
  about: [{ kind: "bead" as const, id: "alpha-epic" }],
  launch: {
    route: "gemini-cli" as const,
    mode: "task" as const,
    prompt: "  PRIVATE exact Task\n",
    attachments: [
      { kind: "text" as const, name: "note.txt", text: "PRIVATE attachment" },
    ],
  },
};
const record = {
  id,
  projectId,
  requestId,
  requestHash: await sessionStartHash({ ...input, requestId }),
  provider: "gemini" as const,
  route: "gemini-cli" as const,
  mode: "task" as const,
  smith: input.smith,
  workspace: "/repo",
  repository: "/repo",
  worktree: "/repo",
  requestedModel: null,
  requestedEffort: null,
  createdAt: at,
};
const turn = {
  requestId,
  hash: "a".repeat(64),
  phase: "accepted" as const,
  owner: requestId,
  createdAt: at,
  updatedAt: at,
  reason: null,
};
const receipt = {
  session: record,
  receipt: { conversationId: id, revision: 1, turn },
};

test("a public Gemini Start reserves durable provider metadata before dispatch without storing its private input", async () => {
  const journal = sessionStartFixture();
  const reserved = await journal.identities.reserve(
    projectId,
    input,
    () => requestId,
  );
  expect(reserved.created).toBe(true);
  expect(reserved.identity).toEqual({
    projectId,
    requestId,
    requestHash: record.requestHash,
    provider: "gemini",
  });
  expect(journal.make().read(projectId)).toEqual(reserved.identity);
  const saved = journal.storage.getItem(SESSION_START_IDENTITIES);
  expect(saved).not.toContain("PRIVATE");
  expect(saved).not.toContain("/repo");
  expect(saved).not.toContain(input.smith);
});

test("a matching public Gemini admission receipt confirms one Task and releases its original durable hold", async () => {
  expect(ownedCodingStartReceiptSchema.safeParse(receipt).success).toBe(true);
  const journal = sessionStartFixture(),
    sent: unknown[] = [];
  const client = createSessionsClient({
    identities: journal.identities,
    canWrite: () => true,
    requestId: () => requestId,
    list: async () => [],
    read: async () => {
      throw Error("No saved read expected");
    },
    post: async (_project, _session, _action, body) => {
      expect(journal.make().read(projectId)?.provider).toBe("gemini");
      sent.push(structuredClone(body));
      return { state: "done", data: receipt };
    },
    stream: () => () => ({ close() {} }),
  });
  await client.start(projectId, input);
  expect(sent).toEqual([{ ...input, requestId }]);
  expect(client.project(projectId).lastStarted).toBe(id);
  expect(client.project(projectId).pendingStart).toBeNull();
  expect(journal.make().read(projectId)).toBeNull();
  client.draft(projectId, id, "Do not turn a Task into Chat");
  expect(client.canSend(projectId, id)).toBe(false);
  client.dispose();
});

test("switching all providers preserves the common bead/worktree and independent Gemini, Codex and Claude options", () => {
  const client = createSessionsClient({
    identities: sessionStartFixture().identities,
    canWrite: () => true,
    requestId: () => requestId,
    list: async () => [],
    read: async () => null,
    post: async () => {
      throw Error("Provider switching must not dispatch");
    },
    stream: () => () => ({ close() {} }),
  });
  client.editComposer(projectId, {
    prompt: input.launch.prompt,
    repository: "/repo",
    worktree: "/repo",
    beadId: "alpha-1",
    model: "claude-model",
  });
  client.editCodexComposer(projectId, { model: "codex-task" });
  client.editCodexChatComposer(projectId, { model: "codex-chat" });
  client.chooseComposerProvider(projectId, "gemini");
  client.editGeminiComposer(projectId, {
    model: "gemini-explicit",
    sandbox: "enabled",
    approvalMode: "plan",
  });
  for (const provider of ["claude", "codex", "gemini"] as const)
    client.chooseComposerProvider(projectId, provider);
  expect(client.project(projectId)).toMatchObject({
    composerProvider: "gemini",
    composer: {
      prompt: input.launch.prompt,
      repository: "/repo",
      worktree: "/repo",
      beadId: "alpha-1",
      model: "claude-model",
    },
    codexComposer: { model: "codex-task" },
    codexChatComposer: { model: "codex-chat" },
    geminiComposer: {
      model: "gemini-explicit",
      sandbox: "enabled",
      approvalMode: "plan",
    },
  });
  client.dispose();
});

test("a Gemini Start with an unknown pre-admission reply survives recreation and cannot be replaced by another provider", async () => {
  const journal = sessionStartFixture(),
    sent: unknown[] = [];
  const make = () =>
    createSessionsClient({
      identities: journal.make(),
      canWrite: () => true,
      requestId: () => requestId,
      list: async () => [],
      read: async () => {
        throw Error("Not admitted yet");
      },
      post: async (_project, _session, _action, body) => {
        sent.push(structuredClone(body));
        return { state: "unknown", message: "Lost original reply" };
      },
      stream: () => () => ({ close() {} }),
    });
  const first = make();
  await first.start(projectId, input);
  first.dispose();
  const next = make();
  await next.refresh(projectId);
  await next.start(projectId, {
    smith: "claude-example",
    repository: "/repo",
    worktree: "/repo",
    launch: { mode: "task", model: "claude-model", prompt: "A replacement" },
  });
  expect(sent).toEqual([{ ...input, requestId }]);
  expect(next.project(projectId).startIdentity?.provider).toBe("gemini");
  expect(next.project(projectId).lastStarted).toBeNull();
  expect(journal.storage.getItem(SESSION_START_IDENTITIES)).not.toContain(
    "PRIVATE",
  );
  next.dispose();
});
