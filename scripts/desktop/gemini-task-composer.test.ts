import { expect, test } from "bun:test";
import {
  chooseGeminiTaskSmith,
  geminiTaskStartBody,
  matchesGeminiTaskPreview,
  newGeminiTaskDraft,
} from "../../apps/desktop/src/gemini-task-composer";
import { newSessionDraft } from "../../apps/desktop/src/session-composer";
import { geminiTaskLaunchFromStart } from "../sessions/gemini-owned-preparation";
import { serializeGeminiTask } from "../sessions/gemini-task";
import { geminiTaskPreviewReceiptSchema } from "../sessions/gemini-task-preview-protocol";

const projectId = "project-015821b4-4b38-4bf3-9326-71ce9c09ff46";
const common = () => ({
  ...newSessionDraft(),
  repository: "/repo",
  worktree: "/repo",
  prompt: "  PRIVATE Task\n",
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
    options = { ...newGeminiTaskDraft(), initialized: true, smith: smith.name };
  const launch = geminiTaskLaunchFromStart(
    projectId,
    geminiTaskStartBody(draft, options),
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
      flags: ["--output-format", "--model", "--approval-mode", "--sandbox"],
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
      serialized: serializeGeminiTask(launch, snapshot.capabilities),
    },
  };
}

test("Gemini native defaults stay omitted and an explicit smith preset copies its actual model without effort", () => {
  const draft = common(),
    original = structuredClone(draft),
    options = { ...newGeminiTaskDraft(), initialized: true, smith: smith.name };
  const defaults = geminiTaskStartBody(draft, options);
  expect(defaults.launch).toEqual({
    route: "gemini-cli",
    mode: "task",
    prompt: draft.prompt,
    attachments: [],
  });
  const selected = chooseGeminiTaskSmith(options, smith);
  expect(geminiTaskStartBody(draft, selected).launch.model).toBe(smith.model);
  expect(selected).not.toHaveProperty("effort");
  expect(
    geminiTaskStartBody(draft, {
      ...selected,
      model: "",
      approvalMode: "default",
      sandbox: "enabled",
    }).launch,
  ).toMatchObject({ approvalMode: "default", sandbox: true });
  expect(draft).toEqual(original);
  expect(() =>
    chooseGeminiTaskSmith(options, { ...smith, enabled: false }),
  ).toThrow("enabled");
  expect(() =>
    chooseGeminiTaskSmith(options, { ...smith, provider: "codex" }),
  ).toThrow("Gemini");
});

test("Gemini preview binds exact private input, scope and options; every edit requires a fresh check", () => {
  const { draft, options, preview } = checked();
  expect(geminiTaskPreviewReceiptSchema.safeParse(preview).success).toBe(true);
  expect(matchesGeminiTaskPreview(projectId, draft, options, preview)).toBe(
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
      matchesGeminiTaskPreview(
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
      matchesGeminiTaskPreview(
        projectId,
        draft,
        { ...options, ...change },
        preview,
      ),
    ).toBe(false);
  expect(
    matchesGeminiTaskPreview(
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
    expect(geminiTaskPreviewReceiptSchema.safeParse(forged).success).toBe(
      false,
    );
});

test("Gemini preview rejects unsupported capabilities, unscoped paths, forged modes and oversized private preparations", () => {
  const { preview } = checked();
  for (const launch of [
    { ...preview.snapshot.launch, mode: "chat" },
    { ...preview.snapshot.launch, route: "adk" },
    { ...preview.snapshot.launch, effort: "high" },
    { ...preview.snapshot.launch, approvalMode: "yolo" },
    { ...preview.snapshot.launch, policyFiles: ["/repo/policy.toml"] },
    { ...preview.snapshot.launch, includeDirectories: ["/repo/extra"] },
    { ...preview.snapshot.launch, prompt: "x".repeat(2_097_153) },
  ])
    expect(
      geminiTaskPreviewReceiptSchema.safeParse({
        ...preview,
        snapshot: { ...preview.snapshot, launch },
      }).success,
    ).toBe(false);
});

test("a correctly serialized sandbox-off preview remains locked at the Gemini composer boundary", () => {
  const { preview } = checked();
  const launch = { ...preview.snapshot.launch, sandbox: false };
  expect(
    geminiTaskPreviewReceiptSchema.safeParse({
      ...preview,
      snapshot: { ...preview.snapshot, launch },
      serialized: serializeGeminiTask(launch, preview.snapshot.capabilities),
    }).success,
  ).toBe(false);
});

test("Gemini uses a new worktree only after the exact repository, branch, base and bead receipt is confirmed", () => {
  const options = {
    ...newGeminiTaskDraft(),
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
  expect(geminiTaskStartBody(draft, options).worktree).toBe(
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
      geminiTaskStartBody({ ...draft, ...changed }, options),
    ).toThrow("confirm");
});
