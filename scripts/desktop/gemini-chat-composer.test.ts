import { expect, test } from "bun:test";
import { createSessionsClient } from "../../apps/desktop/src/session-client";
import { sessionStartFixture } from "./session-start-fixture";

const projectId = "project-015821b4-4b38-4bf3-9326-71ce9c09ff46";
test("Gemini Task and ACP Chat keep independent native selections while preserving common prompt and scope", () => {
  const client = createSessionsClient({
    identities: sessionStartFixture().identities,
    canWrite: () => true,
    requestId: () => crypto.randomUUID(),
    list: async () => [],
    read: async () => null,
    post: async () => ({ state: "unknown", message: "Unexpected write" }),
    stream: () => () => ({ close() {} }),
  });
  expect(client.project(projectId)).toHaveProperty("geminiChatComposer");
  expect(client.project(projectId).geminiMode).toBe("task");
  client.editComposer(projectId, {
    prompt: "Private shared prompt",
    repository: "/repo",
    worktree: "/repo",
    beadId: "alpha-1",
  });
  client.editGeminiComposer(projectId, {
    initialized: true,
    smith: "gemini-task",
    model: "task-model",
    approvalMode: "plan",
  });
  client.chooseComposerProvider(projectId, "gemini");
  client.chooseGeminiMode(projectId, "chat");
  client.editGeminiChatComposer(projectId, {
    initialized: true,
    smith: "gemini-chat",
    model: "chat-model",
    sandbox: "enabled",
  });
  client.chooseComposerProvider(projectId, "claude");
  client.chooseComposerProvider(projectId, "gemini");
  expect(client.project(projectId)).toMatchObject({
    geminiMode: "chat",
    composer: {
      prompt: "Private shared prompt",
      worktree: "/repo",
      beadId: "alpha-1",
    },
    geminiComposer: { model: "task-model", approvalMode: "plan" },
    geminiChatComposer: {
      model: "chat-model",
      sandbox: "enabled",
      approvalMode: "",
    },
  });
  client.chooseGeminiMode(projectId, "task");
  expect(client.project(projectId).geminiComposer.model).toBe("task-model");
  client.dispose();
});

import {
  chooseGeminiChatSmith,
  geminiChatStartBody,
  matchesGeminiChatPreview,
  newGeminiChatDraft,
  reviewedGeminiChatStart,
} from "../../apps/desktop/src/gemini-chat-composer";
import { newSessionDraft } from "../../apps/desktop/src/session-composer";
import { geminiChatLaunchFromStart } from "../sessions/gemini-chat-owned-preparation";
import { geminiChatPreviewReceiptSchema } from "../sessions/gemini-chat-preview-protocol";
import { serializeGeminiChat } from "../sessions/gemini-task";

const common = () => ({
  ...newSessionDraft(),
  repository: "/repo",
  worktree: "/repo",
  prompt: "  PRIVATE Chat\n",
  beadId: "alpha-1",
  about: [{ kind: "bead" as const, id: "alpha-1" }],
});
const smith = {
  name: "gemini-example",
  provider: "gemini" as const,
  model: "gemini-exact-model",
  effort: "high",
  enabled: true,
  tags: [],
};
function checked() {
  const draft = common(),
    options = { ...newGeminiChatDraft(), initialized: true, smith: smith.name };
  const launch = geminiChatLaunchFromStart(
    projectId,
    geminiChatStartBody(draft, options),
  );
  const snapshot = {
    version: 1 as const,
    provider: "gemini" as const,
    smith: smith.name,
    canonicalRoot: "/repo",
    canonicalCwd: "/repo",
    command: ["/native/gemini"],
    paths: ["/repo", "/repo"],
    launch,
    capabilities: {
      version: "0.65.0",
      flags: ["--acp", "--model", "--approval-mode", "--sandbox"],
    },
  };
  return {
    draft,
    options,
    preview: {
      provider: "gemini" as const,
      projectId,
      requestId: "825f49e8-14b5-46d2-80f5-a143ae120bed",
      snapshot,
      serialized: serializeGeminiChat(launch, snapshot.capabilities),
    },
  };
}

test("Start rereads the fresh provider/mode/common/options instead of dispatching an old rendered preview", () => {
  const { draft, options, preview } = checked();
  const current = {
    composerProvider: "gemini",
    geminiMode: "chat",
    composer: draft,
    geminiChatComposer: options,
  };
  expect(
    reviewedGeminiChatStart(projectId, current, preview).launch.prompt,
  ).toBe(draft.prompt);
  for (const change of [
    { composerProvider: "claude" },
    { geminiMode: "task" },
    { composer: { ...draft, prompt: "Synchronous edit before paint" } },
    { geminiChatComposer: { ...options, model: "edited-model" } },
  ])
    expect(() =>
      reviewedGeminiChatStart(projectId, { ...current, ...change }, preview),
    ).toThrow("selection changed");
});

test("Gemini native defaults stay omitted and an explicit smith preset copies its actual model without effort", () => {
  const draft = common(),
    original = structuredClone(draft),
    options = { ...newGeminiChatDraft(), initialized: true, smith: smith.name };
  const defaults = geminiChatStartBody(draft, options);
  expect(defaults.launch).toEqual({
    route: "gemini-cli",
    mode: "chat",
    prompt: draft.prompt,
    attachments: [],
  });
  const selected = chooseGeminiChatSmith(options, smith);
  expect(geminiChatStartBody(draft, selected).launch.model).toBe(smith.model);
  expect(selected).not.toHaveProperty("effort");
  expect(
    geminiChatStartBody(draft, {
      ...selected,
      model: "",
      approvalMode: "default",
      sandbox: "enabled",
    }).launch,
  ).toMatchObject({ approvalMode: "default", sandbox: true });
  expect(draft).toEqual(original);
  expect(() =>
    chooseGeminiChatSmith(options, { ...smith, enabled: false }),
  ).toThrow("enabled");
  expect(() =>
    chooseGeminiChatSmith(options, { ...smith, provider: "codex" }),
  ).toThrow("Gemini");
});

test("loading, empty or unsupported Chat input refuses before original Start reservation", () => {
  const { draft, options } = checked();
  expect(() => geminiChatStartBody(draft, newGeminiChatDraft())).toThrow(
    "Wait",
  );
  for (const update of [{ prompt: "" }, { repository: "" }, { worktree: "" }])
    expect(() =>
      geminiChatStartBody({ ...draft, ...update }, options),
    ).toThrow();
  expect(() =>
    geminiChatStartBody(
      {
        ...draft,
        attachments: [
          {
            kind: "image",
            name: "image.png",
            mediaType: "image/png",
            data: "YQ==",
          },
        ],
      },
      options,
    ),
  ).toThrow("Images");
});

test("Gemini preview binds exact private input, scope and options; every edit requires a fresh check", () => {
  const { draft, options, preview } = checked();
  expect(geminiChatPreviewReceiptSchema.safeParse(preview).success).toBe(true);
  expect(matchesGeminiChatPreview(projectId, draft, options, preview)).toBe(
    true,
  );
  for (const change of [
    { prompt: "changed" },
    { repository: "/other" },
    { worktree: "/other" },
    { beadId: "alpha-2" },
    { about: [] },
    {
      attachments: [
        { kind: "text" as const, name: "note", text: "PRIVATE extra" },
      ],
    },
  ])
    expect(
      matchesGeminiChatPreview(
        projectId,
        { ...draft, ...change },
        options,
        preview,
      ),
    ).toBe(false);
  for (const change of [
    { smith: "another" },
    { model: "other" },
    { approvalMode: "plan" as const },
    { sandbox: "enabled" as const },
  ])
    expect(
      matchesGeminiChatPreview(
        projectId,
        draft,
        { ...options, ...change },
        preview,
      ),
    ).toBe(false);
  expect(
    matchesGeminiChatPreview(
      "project-f05a117f-8d19-4906-80f0-75d72835f3e8",
      draft,
      options,
      preview,
    ),
  ).toBe(false);
  for (const forged of [
    { ...preview, rawFlags: [] },
    { ...preview, projectId: "project-f05a117f-8d19-4906-80f0-75d72835f3e8" },
    {
      ...preview,
      serialized: {
        ...preview.serialized,
        argv: [...preview.serialized.argv, "--yolo"],
      },
    },
    { ...preview, serialized: { ...preview.serialized, stdin: "changed" } },
    {
      ...preview,
      serialized: { ...preview.serialized, equivalentCommand: "fake preview" },
    },
    {
      ...preview,
      snapshot: {
        ...preview.snapshot,
        capabilities: { ...preview.snapshot.capabilities, flags: [] },
      },
    },
  ])
    expect(geminiChatPreviewReceiptSchema.safeParse(forged).success).toBe(
      false,
    );
});

test("Gemini preview rejects unsupported capabilities, unscoped paths, forged modes and oversized private preparations", () => {
  const { preview } = checked();
  for (const launch of [
    { ...preview.snapshot.launch, mode: "task" },
    { ...preview.snapshot.launch, route: "adk" },
    { ...preview.snapshot.launch, effort: "high" },
    { ...preview.snapshot.launch, approvalMode: "yolo" },
    { ...preview.snapshot.launch, policyFiles: ["/repo/policy.toml"] },
    { ...preview.snapshot.launch, includeDirectories: ["/repo/extra"] },
    { ...preview.snapshot.launch, prompt: "x".repeat(2_097_153) },
  ])
    expect(
      geminiChatPreviewReceiptSchema.safeParse({
        ...preview,
        snapshot: { ...preview.snapshot, launch },
      }).success,
    ).toBe(false);
});

test("a correctly serialized sandbox-off preview remains locked at the Gemini composer boundary", () => {
  const { preview } = checked();
  const launch = { ...preview.snapshot.launch, sandbox: false };
  expect(
    geminiChatPreviewReceiptSchema.safeParse({
      ...preview,
      snapshot: { ...preview.snapshot, launch },
      serialized: serializeGeminiChat(launch, preview.snapshot.capabilities),
    }).success,
  ).toBe(false);
});

test("Gemini uses a new worktree only after the exact repository, branch, base and bead receipt is confirmed", () => {
  const options = {
    ...newGeminiChatDraft(),
    initialized: true,
    smith: smith.name,
  };
  const draft = {
    ...common(),
    where: "new" as const,
    baseRef: "HEAD",
    branch: "feature/confirmed",
    worktree: "/repo/trees/confirmed",
    createdWorktree: {
      path: "/repo/trees/confirmed",
      repository: "/repo",
      baseRef: "HEAD",
      branch: "feature/confirmed",
      beadId: "alpha-1",
    },
  };
  expect(geminiChatStartBody(draft, options).worktree).toBe(
    draft.createdWorktree.path,
  );
  for (const changed of [
    { createdWorktree: null },
    { worktree: "/repo/trees/another" },
    { repository: "/foreign" },
    { baseRef: "other" },
    { branch: "feature/another" },
    { beadId: "alpha-2" },
  ])
    expect(() =>
      geminiChatStartBody({ ...draft, ...changed }, options),
    ).toThrow("confirm");
});
