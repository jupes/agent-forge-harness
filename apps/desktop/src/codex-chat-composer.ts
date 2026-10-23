import { codexChatLaunchFromStart } from "../../../scripts/sessions/codex-chat-owned-preparation";
import { codexChatStartSchema } from "../../../scripts/sessions/codex-chat-owned-protocol";
import { codexChatPreviewReceiptSchema } from "../../../scripts/sessions/codex-chat-preview-protocol";
import { canonicalSessionInput } from "../../../scripts/sessions/preparation";
import type { CodexChatPreviewReceipt } from "../../../types/codex-chat-ui";
import type { CodexChatStartRequest } from "../../../types/codex-owned-chat";
import type { Smith } from "../../../types/hearth";
import type { SessionComposerDraft } from "./session-composer";

export interface CodexChatComposerDraft {
  initialized: boolean;
  smith: string;
  model: string;
  effort: string;
  sandbox: "read-only" | "workspace-write";
  approvalPolicy: "on-request" | "never";
}
export const newCodexChatDraft = (): CodexChatComposerDraft => ({
  initialized: false,
  smith: "",
  model: "",
  effort: "",
  sandbox: "read-only",
  approvalPolicy: "on-request",
});
export function chooseCodexChatSmith(
  draft: CodexChatComposerDraft,
  smith: Smith,
): CodexChatComposerDraft {
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

/** Native Chat options stay independent of exec Task and Claude option drafts. */
export function codexChatStartBody(
  common: SessionComposerDraft,
  options: CodexChatComposerDraft,
): Omit<CodexChatStartRequest, "requestId"> {
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
      "Explicitly create and confirm this worktree before checking or starting Chat.",
    );
  const attachments = common.attachments.map((attachment) => {
    if (attachment.kind !== "text")
      throw Error(
        "Images require server-owned staging and are unavailable for Codex Chat.",
      );
    return {
      kind: "text" as const,
      name: attachment.name,
      text: attachment.text,
    };
  });
  const parsed = codexChatStartSchema.omit({ requestId: true }).safeParse({
    provider: "codex",
    smith: options.smith,
    repository: common.repository,
    worktree: common.worktree,
    ...(common.beadId ? { beadId: common.beadId } : {}),
    about: structuredClone(common.about),
    launch: {
      mode: "chat",
      model: options.model,
      prompt: common.prompt,
      sandbox: options.sandbox,
      approvalPolicy: options.approvalPolicy,
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

/** Editing any reviewed option, context or private input requires a new native preview. */
export function matchesCodexChatPreview(
  projectId: string,
  common: SessionComposerDraft,
  options: CodexChatComposerDraft,
  preview: CodexChatPreviewReceipt | null,
): boolean {
  try {
    const checked = codexChatPreviewReceiptSchema.safeParse(preview);
    if (
      !checked.success ||
      checked.data.projectId !== projectId ||
      checked.data.snapshot.smith !== options.smith
    )
      return false;
    return (
      canonicalSessionInput(checked.data.snapshot.launch) ===
      canonicalSessionInput(
        codexChatLaunchFromStart(
          projectId,
          codexChatStartBody(common, options),
        ),
      )
    );
  } catch {
    return false;
  }
}
