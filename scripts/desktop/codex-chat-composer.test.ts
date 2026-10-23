import { expect, test } from "bun:test";
import {
  chooseCodexChatSmith,
  codexChatStartBody,
  matchesCodexChatPreview,
  newCodexChatDraft,
} from "../../apps/desktop/src/codex-chat-composer";
import {
  chooseCodexTaskSmith,
  newCodexTaskDraft,
} from "../../apps/desktop/src/codex-session-composer";
import { newSessionDraft } from "../../apps/desktop/src/session-composer";
import {
  CODEX_APP_SERVER_VERSION,
  serializeCodexChat,
} from "../sessions/codex-app-server-protocol";
import { codexChatLaunchFromStart } from "../sessions/codex-chat-owned-preparation";

const projectId = "project-015821b4-4b38-4bf3-9326-71ce9c09ff46";
const smith = {
  name: "codex-journeyman",
  provider: "codex" as const,
  model: "exact-model",
  effort: "",
  enabled: true,
  tags: [],
};
const common = () => ({
  ...newSessionDraft(),
  repository: "/repo",
  worktree: "/repo",
  prompt: "  PRIVATE-CHAT-PROMPT\n",
  about: [{ kind: "bead" as const, id: "alpha-1" }],
});

test("dedicated Chat options produce native on-request intent without changing Task or Claude drafts", () => {
  const draft = common(),
    before = structuredClone(draft),
    task = chooseCodexTaskSmith(newCodexTaskDraft(), smith);
  const options = chooseCodexChatSmith(newCodexChatDraft(), {
    ...smith,
    effort: "high",
  });
  expect(codexChatStartBody(draft, options)).toMatchObject({
    provider: "codex",
    launch: {
      mode: "chat",
      model: "exact-model",
      effort: "high",
      approvalPolicy: "on-request",
      prompt: draft.prompt,
    },
  });
  expect(draft).toEqual(before);
  expect(task).toEqual(chooseCodexTaskSmith(newCodexTaskDraft(), smith));
  expect(
    codexChatStartBody(draft, { ...options, effort: "" }).launch,
  ).not.toHaveProperty("effort");
  expect(() =>
    chooseCodexChatSmith(options, { ...smith, enabled: false }),
  ).toThrow("enabled");
});

test("Start requires the exact reviewed Chat selection and every private or scope edit invalidates that preview", () => {
  const draft = common(),
    options = chooseCodexChatSmith(newCodexChatDraft(), smith);
  const launch = codexChatLaunchFromStart(
    projectId,
    codexChatStartBody(draft, options),
  );
  const snapshot = {
    version: 1 as const,
    provider: "codex" as const,
    smith: smith.name,
    cwd: "/repo",
    canonicalCwd: "/repo",
    launch,
    capabilities: { version: CODEX_APP_SERVER_VERSION, flags: ["--stdio"] },
  };
  const preview = {
    provider: "codex" as const,
    mode: "chat" as const,
    projectId,
    requestId: "825f49e8-14b5-46d2-80f5-a143ae120bed",
    snapshot,
    serialized: serializeCodexChat(launch, snapshot.capabilities),
  };
  expect(matchesCodexChatPreview(projectId, draft, options, preview)).toBe(
    true,
  );
  for (const change of [
    { prompt: "changed" },
    { repository: "/other" },
    { worktree: "/other" },
    { beadId: "alpha-2" },
    { about: [] },
    { attachments: [{ kind: "text" as const, name: "note", text: "private" }] },
  ])
    expect(
      matchesCodexChatPreview(
        projectId,
        { ...draft, ...change },
        options,
        preview,
      ),
    ).toBe(false);
  for (const change of [
    { smith: "another" },
    { model: "other" },
    { effort: "high" },
    { sandbox: "workspace-write" as const },
    { approvalPolicy: "never" as const },
  ])
    expect(
      matchesCodexChatPreview(
        projectId,
        draft,
        { ...options, ...change },
        preview,
      ),
    ).toBe(false);
  expect(
    matchesCodexChatPreview(
      "project-f05a117f-8d19-4906-80f0-75d72835f3e8",
      draft,
      options,
      preview,
    ),
  ).toBe(false);
});
