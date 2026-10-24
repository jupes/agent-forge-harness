import { geminiChatLaunchFromStart } from "../../../scripts/sessions/gemini-chat-owned-preparation";
import { geminiChatStartSchema } from "../../../scripts/sessions/gemini-chat-owned-protocol";
import { geminiChatPreviewReceiptSchema } from "../../../scripts/sessions/gemini-chat-preview-protocol";
import { canonicalSessionInput } from "../../../scripts/sessions/preparation";
import type {
  GeminiChatPreviewReceipt,
  GeminiChatStartRequest,
} from "../../../types/gemini-owned-chat";
import type { Smith } from "../../../types/hearth";
import type { SessionComposerDraft } from "./session-composer";

export interface GeminiChatComposerDraft {
  initialized: boolean;
  smith: string;
  model: string;
  approvalMode: "" | "default" | "auto_edit" | "plan";
  sandbox: "" | "enabled";
}
export const newGeminiChatDraft = (): GeminiChatComposerDraft => ({
  initialized: false,
  smith: "",
  model: "",
  approvalMode: "",
  sandbox: "",
});
/** Explicit preset selection copies its actual configured model; Gemini has no effort option. */
export function chooseGeminiChatSmith(
  draft: GeminiChatComposerDraft,
  smith: Smith,
): GeminiChatComposerDraft {
  if (!smith.enabled || smith.provider !== "gemini")
    throw Error("Choose an enabled Gemini smith.");
  return { ...draft, initialized: true, smith: smith.name, model: smith.model };
}

export function geminiChatStartBody(
  common: SessionComposerDraft,
  options: GeminiChatComposerDraft,
): Omit<GeminiChatStartRequest, "requestId"> {
  if (!options.initialized)
    throw Error("Wait for the Gemini launch choices to load.");
  if (options.sandbox !== "" && options.sandbox !== "enabled")
    throw Error("Disabling the sandbox is unavailable in this composer.");
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
      "Explicitly create and confirm this worktree before checking or starting the Chat.",
    );
  const attachments = common.attachments.map((item) => {
    if (item.kind !== "text")
      throw Error(
        "Images require server-owned staging and are unavailable for Gemini Chats.",
      );
    return { kind: "text" as const, name: item.name, text: item.text };
  });
  const parsed = geminiChatStartSchema.safeParse({
    requestId: "00000000-0000-4000-8000-000000000000",
    provider: "gemini",
    smith: options.smith,
    repository: common.repository,
    worktree: common.worktree,
    ...(common.beadId ? { beadId: common.beadId } : {}),
    about: structuredClone(common.about),
    launch: {
      route: "gemini-cli",
      mode: "chat",
      prompt: common.prompt,
      attachments,
      ...(options.model === "" ? {} : { model: options.model }),
      ...(options.approvalMode === ""
        ? {}
        : { approvalMode: options.approvalMode }),
      ...(options.sandbox === "" ? {} : { sandbox: true }),
    },
  });
  if (!parsed.success)
    throw Error(
      "Choose a checked repository/worktree and enabled Gemini smith, then enter supported options, a bounded prompt and text attachments.",
    );
  const value = parsed.data;
  return {
    provider: value.provider,
    smith: value.smith,
    repository: value.repository,
    worktree: value.worktree,
    ...(value.beadId ? { beadId: value.beadId } : {}),
    about: value.about,
    launch: value.launch,
  };
}

/** Re-run synchronously against current drafts immediately before an explicit Start. */
export function matchesGeminiChatPreview(
  projectId: string,
  common: SessionComposerDraft,
  options: GeminiChatComposerDraft,
  preview: GeminiChatPreviewReceipt | null,
): boolean {
  try {
    const checked = geminiChatPreviewReceiptSchema.safeParse(preview);
    if (
      !checked.success ||
      checked.data.projectId !== projectId ||
      checked.data.snapshot.smith !== options.smith
    )
      return false;
    return (
      canonicalSessionInput(checked.data.snapshot.launch) ===
      canonicalSessionInput(
        geminiChatLaunchFromStart(
          projectId,
          geminiChatStartBody(common, options),
        ),
      )
    );
  } catch {
    return false;
  }
}

/** Call at dispatch, after reading the current shared draft; render-time state is not a review. */
export function reviewedGeminiChatStart(
  projectId: string,
  current: {
    composerProvider: string;
    geminiMode: string;
    composer: SessionComposerDraft;
    geminiChatComposer: GeminiChatComposerDraft;
  },
  preview: GeminiChatPreviewReceipt | null,
): Omit<GeminiChatStartRequest, "requestId"> {
  if (
    current.composerProvider !== "gemini" ||
    current.geminiMode !== "chat" ||
    !matchesGeminiChatPreview(
      projectId,
      current.composer,
      current.geminiChatComposer,
      preview,
    )
  )
    throw Error(
      "The Chat selection changed. Check supported options again before Start.",
    );
  return geminiChatStartBody(current.composer, current.geminiChatComposer);
}
