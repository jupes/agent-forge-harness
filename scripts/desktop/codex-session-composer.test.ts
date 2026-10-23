import { expect, test } from "bun:test";
import {
  chooseCodexTaskSmith,
  codexTaskStartBody,
  newCodexTaskDraft,
} from "../../apps/desktop/src/codex-session-composer";
import { newSessionDraft } from "../../apps/desktop/src/session-composer";
import type { Smith } from "../../types/hearth";

const smith: Smith = {
  name: "codex-journeyman",
  provider: "codex",
  model: "gpt-example-exact",
  effort: "high",
  enabled: true,
  tags: [],
};
const context = () => ({
  ...newSessionDraft(),
  repository: "/fixture",
  worktree: "/fixture/tree",
  beadId: "alpha-1",
  prompt: "  Exact prompt\n",
});
test("Codex options preserve configured model/effort and leave Claude options intact until an explicit CLI-default selection", () => {
  const common = context(),
    before = structuredClone(common);
  const chosen = chooseCodexTaskSmith(newCodexTaskDraft(), smith);
  const first = codexTaskStartBody(common, chosen);
  expect(first).toMatchObject({
    provider: "codex",
    smith: smith.name,
    beadId: "alpha-1",
    worktree: common.worktree,
    launch: {
      mode: "task",
      model: smith.model,
      effort: "high",
      approvalPolicy: "never",
      sandbox: "read-only",
      prompt: common.prompt,
    },
  });
  expect(common).toEqual(before);
  expect(
    codexTaskStartBody(common, { ...chosen, effort: "" }).launch,
  ).not.toHaveProperty("effort");
  expect(() =>
    chooseCodexTaskSmith(chosen, { ...smith, provider: "claude" }),
  ).toThrow();
  expect(() =>
    chooseCodexTaskSmith(chosen, { ...smith, enabled: false }),
  ).toThrow();
});
test("new worktrees require the exact confirmed receipt path and text attachments remain bounded private input", () => {
  const common = {
    ...context(),
    where: "new" as const,
    baseRef: "main",
    branch: "feat/task",
  };
  const options = chooseCodexTaskSmith(newCodexTaskDraft(), smith);
  expect(() => codexTaskStartBody(common, options)).toThrow("confirm");
  const confirmed = {
    ...common,
    createdWorktree: {
      path: common.worktree,
      repository: common.repository,
      baseRef: common.baseRef,
      branch: common.branch,
      beadId: common.beadId,
    },
    attachments: [
      { kind: "text" as const, name: "note.txt", text: "PRIVATE-NOTE" },
    ],
  };
  expect(codexTaskStartBody(confirmed, options).launch.attachments).toEqual(
    confirmed.attachments,
  );
  expect(() =>
    codexTaskStartBody({ ...confirmed, branch: "feat/changed" }, options),
  ).toThrow("confirm");
  expect(() =>
    codexTaskStartBody(
      {
        ...confirmed,
        attachments: [
          {
            kind: "image",
            name: "x.png",
            mediaType: "image/png",
            data: "aA==",
          },
        ],
      },
      options,
    ),
  ).toThrow("staging");
});
