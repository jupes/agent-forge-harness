import { codexTaskStartSchema } from "../../../scripts/sessions/codex-owned-protocol";
import type { CodexTaskStartRequest } from "../../../types/codex-owned-task";
import type { Smith } from "../../../types/hearth";
import type { SessionComposerDraft } from "./session-composer";

export interface CodexTaskComposerDraft {
  initialized: boolean;
  smith: string;
  model: string;
  effort: string;
  sandbox: "read-only" | "workspace-write";
}
export const newCodexTaskDraft = (): CodexTaskComposerDraft => ({
  initialized: false,
  smith: "",
  model: "",
  effort: "",
  sandbox: "read-only",
});
export function chooseCodexTaskSmith(
  draft: CodexTaskComposerDraft,
  smith: Smith,
): CodexTaskComposerDraft {
  if (!smith.enabled || smith.provider !== "codex")
    throw Error("Choose an enabled Codex smith.");
  return {
    ...draft,
    initialized: true,
    smith: smith.name,
    model: smith.model,
    effort: smith.effort,
  };
}
/** Provider options stay separate; prompt, context and explicitly confirmed worktree are shared composer input. */
export function codexTaskStartBody(
  common: SessionComposerDraft,
  options: CodexTaskComposerDraft,
): Omit<CodexTaskStartRequest, "requestId"> {
  if (
    common.where === "new" &&
    (!common.createdWorktree ||
      common.createdWorktree.path !== common.worktree ||
      common.createdWorktree.repository !== common.repository ||
      common.createdWorktree.baseRef !== common.baseRef ||
      common.createdWorktree.branch !== common.branch ||
      common.createdWorktree.beadId !== (common.beadId || undefined))
  )
    throw Error(
      "Explicitly create and confirm this worktree before checking or starting the Task.",
    );
  const attachments = common.attachments.map((attachment) => {
    if (attachment.kind !== "text")
      throw Error(
        "Images require server-owned staging and are unavailable for Codex Tasks.",
      );
    return {
      kind: "text" as const,
      name: attachment.name,
      text: attachment.text,
    };
  });
  const parsed = codexTaskStartSchema.omit({ requestId: true }).safeParse({
    provider: "codex",
    smith: options.smith,
    repository: common.repository,
    worktree: common.worktree,
    ...(common.beadId ? { beadId: common.beadId } : {}),
    about: structuredClone(common.about),
    launch: {
      mode: "task",
      model: options.model,
      prompt: common.prompt,
      sandbox: options.sandbox,
      approvalPolicy: "never",
      attachments,
      ...(options.effort ? { effort: options.effort } : {}),
    },
  });
  if (!parsed.success)
    throw Error(
      "Choose a checked repository/worktree, enabled Codex smith and model, then enter a bounded prompt and text attachments.",
    );
  return parsed.data;
}
