import { geminiTaskLaunchFromStart } from "../../../scripts/sessions/gemini-owned-preparation";
import { geminiTaskStartSchema } from "../../../scripts/sessions/gemini-owned-protocol";
import { geminiTaskPreviewReceiptSchema } from "../../../scripts/sessions/gemini-task-preview-protocol";
import { canonicalSessionInput } from "../../../scripts/sessions/preparation";
import type {
  GeminiTaskPreviewReceipt,
  GeminiTaskStartRequest,
} from "../../../types/gemini-owned-task";
import type { Smith } from "../../../types/hearth";
import type { SessionComposerDraft } from "./session-composer";

export interface GeminiTaskComposerDraft {
  initialized: boolean;
  smith: string;
  model: string;
  approvalMode: "" | "default" | "auto_edit" | "plan";
  sandbox: "" | "enabled";
}
export const newGeminiTaskDraft = (): GeminiTaskComposerDraft => ({
  initialized: false,
  smith: "",
  model: "",
  approvalMode: "",
  sandbox: "",
});
/** Explicit preset selection copies its actual configured model; Gemini has no effort option. */
export function chooseGeminiTaskSmith(
  draft: GeminiTaskComposerDraft,
  smith: Smith,
): GeminiTaskComposerDraft {
  if (!smith.enabled || smith.provider !== "gemini")
    throw Error("Choose an enabled Gemini smith.");
  return { ...draft, initialized: true, smith: smith.name, model: smith.model };
}

export function geminiTaskStartBody(
  common: SessionComposerDraft,
  options: GeminiTaskComposerDraft,
): Omit<GeminiTaskStartRequest, "requestId"> {
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
      "Explicitly create and confirm this worktree before checking or starting the Task.",
    );
  const attachments = common.attachments.map((item) => {
    if (item.kind !== "text")
      throw Error(
        "Images require server-owned staging and are unavailable for Gemini Tasks.",
      );
    return { kind: "text" as const, name: item.name, text: item.text };
  });
  const parsed = geminiTaskStartSchema.safeParse({
    requestId: "00000000-0000-4000-8000-000000000000",
    provider: "gemini",
    smith: options.smith,
    repository: common.repository,
    worktree: common.worktree,
    ...(common.beadId ? { beadId: common.beadId } : {}),
    about: structuredClone(common.about),
    launch: {
      route: "gemini-cli",
      mode: "task",
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
export function matchesGeminiTaskPreview(
  projectId: string,
  common: SessionComposerDraft,
  options: GeminiTaskComposerDraft,
  preview: GeminiTaskPreviewReceipt | null,
): boolean {
  try {
    const checked = geminiTaskPreviewReceiptSchema.safeParse(preview);
    if (
      !checked.success ||
      checked.data.projectId !== projectId ||
      checked.data.snapshot.smith !== options.smith
    )
      return false;
    return (
      canonicalSessionInput(checked.data.snapshot.launch) ===
      canonicalSessionInput(
        geminiTaskLaunchFromStart(
          projectId,
          geminiTaskStartBody(common, options),
        ),
      )
    );
  } catch {
    return false;
  }
}
