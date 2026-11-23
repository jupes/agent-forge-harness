import { expect, test } from "bun:test";
import type { CodexChatPreviewReceipt } from "../../types/codex-chat-ui";
import type { CodexChatStartRequest } from "../../types/codex-owned-chat";
import {
  CODEX_APP_SERVER_VERSION,
  serializeCodexChat,
} from "./codex-app-server-protocol";
import { prepareReviewedCodexChat } from "./codex-chat-owned-preparation";
import { createCodexChatPreview } from "./codex-chat-owned-preview";
import { codexChatPreviewReceiptSchema } from "./codex-chat-preview-protocol";

const projectId = "project-015821b4-4b38-4bf3-9326-71ce9c09ff46";
function receipt(): CodexChatPreviewReceipt {
  const snapshot = {
    version: 1 as const,
    provider: "codex" as const,
    smith: "codex-journeyman",
    cwd: "/repo",
    canonicalCwd: "/repo",
    launch: {
      mode: "chat" as const,
      cwd: "/repo",
      model: "exact-model",
      prompt: "PRIVATE-CHAT-PROMPT",
      sandbox: "read-only" as const,
      approvalPolicy: "on-request" as const,
      context: { projectId, repository: "/repo", worktree: "/repo", about: [] },
    },
    capabilities: { version: CODEX_APP_SERVER_VERSION, flags: ["--stdio"] },
  };
  return {
    provider: "codex",
    mode: "chat",
    projectId,
    requestId: "825f49e8-14b5-46d2-80f5-a143ae120bed",
    snapshot,
    serialized: serializeCodexChat(snapshot.launch, snapshot.capabilities),
  };
}

test("the browser verifies a native Chat preview against its exact snapshot and refuses Task or altered protocol plans", () => {
  const original = receipt();
  expect(codexChatPreviewReceiptSchema.safeParse(original).success).toBe(true);
  for (const changed of [
    { ...original, mode: "task" },
    { ...original, snapshot: { ...original.snapshot, cwd: "/foreign" } },
    {
      ...original,
      projectId: "project-f05a117f-8d19-4906-80f0-75d72835f3e8",
    },
    {
      ...original,
      serialized: { ...original.serialized, argv: ["exec", "--json"] },
    },
    {
      ...original,
      serialized: {
        ...original.serialized,
        input: { ...original.serialized.input, text: "Changed private input" },
      },
    },
    {
      ...original,
      serialized: { ...original.serialized, nativeRequestId: "widened" },
    },
  ])
    expect(codexChatPreviewReceiptSchema.safeParse(changed).success).toBe(
      false,
    );
});

test("a preview refuses a preparation that changes reviewed options and isolates its input from runtime mutation", async () => {
  const original = receipt().snapshot;
  const reviewed = { smith: original.smith, launch: original.launch };
  await expect(
    prepareReviewedCodexChat(
      {
        async prepare(input) {
          input.launch.model = "changed-model";
          return { ...original, launch: input.launch };
        },
      },
      reviewed,
    ),
  ).rejects.toThrow("changed the reviewed input");
  expect(reviewed.launch.model).toBe("exact-model");
});

test("a preview rechecks mutable scope after bounded preparation and cannot return a stale authorized plan", async () => {
  const original = receipt();
  const request: CodexChatStartRequest = {
    provider: "codex",
    requestId: original.requestId,
    smith: original.snapshot.smith,
    repository: "/repo",
    worktree: "/repo",
    launch: {
      mode: "chat",
      model: "exact-model",
      prompt: "PRIVATE-CHAT-PROMPT",
      sandbox: "read-only",
      approvalPolicy: "on-request",
    },
  };
  let validations = 0,
    preparations = 0;
  const preview = createCodexChatPreview({
    root: import.meta.dir,
    runtime: {
      async prepare(input) {
        preparations++;
        return { ...original.snapshot, launch: input.launch };
      },
    },
    async validateScope() {
      if (++validations === 2) throw Error("The project was archived");
    },
  });
  await expect(preview(projectId, request)).rejects.toThrow("archived");
  expect(preparations).toBe(1);
  expect(validations).toBe(2);
});
