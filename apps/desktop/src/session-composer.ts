import type { ConversationObject } from "../../../types/conversation";
import type { Smith } from "../../../types/hearth";
import type {
  ClaudeEffort,
  SessionAttachment,
} from "../../../types/session-launch";
import type { SessionStartRequest } from "../../../types/session-requests";

export interface SessionComposerDraft {
  initialized: boolean;
  prompt: string;
  attachments: SessionAttachment[];
  about: ConversationObject[];
  repository: string;
  worktree: string;
  where: "main" | "existing" | "new";
  beadId: string;
  mode: "task" | "chat";
  smith: string;
  custom: boolean;
  model: string;
  effort: string;
  permissionMode: "acceptEdits" | "plan";
  fallbackModels: string;
  extraDirectories: string;
  maxBudgetUsd: string;
  outputSchema: string;
}
export const newSessionDraft = (): SessionComposerDraft => ({
  initialized: false,
  prompt: "",
  attachments: [],
  about: [],
  repository: "",
  worktree: "",
  where: "main",
  beadId: "",
  mode: "chat",
  smith: "",
  custom: false,
  model: "",
  effort: "",
  permissionMode: "acceptEdits",
  fallbackModels: "",
  extraDirectories: "",
  maxBudgetUsd: "",
  outputSchema: "",
});
export function chooseSessionSmith(
  draft: SessionComposerDraft,
  smith: Smith,
): SessionComposerDraft {
  if (!smith.enabled || smith.provider !== "claude")
    throw new Error("Choose an enabled Claude smith.");
  return {
    ...draft,
    smith: smith.name,
    custom: false,
    model: smith.model,
    effort: smith.effort,
  };
}
export function sessionStartBody(
  draft: SessionComposerDraft,
): Omit<SessionStartRequest, "requestId"> {
  if (
    !draft.prompt.trim() ||
    !draft.repository ||
    !draft.worktree ||
    !draft.smith ||
    !draft.model
  )
    throw new Error(
      "Choose a repository, worktree, smith and model, and enter a prompt.",
    );
  if (draft.where === "new")
    throw new Error("Creating a worktree is not available in this build.");
  if (
    draft.effort &&
    !["low", "medium", "high", "xhigh", "max"].includes(draft.effort)
  )
    throw new Error(
      "The configured effort is unsupported. Explicitly choose a verified effort or the CLI default.",
    );
  let outputSchema: Record<string, unknown> | undefined;
  if (draft.mode === "task" && draft.outputSchema.trim()) {
    let value: unknown;
    try {
      value = JSON.parse(draft.outputSchema);
    } catch {
      throw new Error("The output schema must be a JSON object.");
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("The output schema must be a JSON object.");
    outputSchema = value as Record<string, unknown>;
  }
  const fallbackModels = draft.fallbackModels
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter(Boolean);
  const extraDirectories = draft.extraDirectories
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    smith: draft.smith,
    repository: draft.repository,
    worktree: draft.worktree,
    ...(draft.beadId.trim() ? { beadId: draft.beadId.trim() } : {}),
    about: structuredClone(draft.about),
    launch: {
      mode: draft.mode,
      model: draft.model,
      prompt: draft.prompt,
      ...(draft.effort ? { effort: draft.effort as ClaudeEffort } : {}),
      permissionMode: draft.permissionMode,
      attachments: structuredClone(draft.attachments),
      ...(fallbackModels.length ? { fallbackModels } : {}),
      ...(extraDirectories.length ? { extraDirectories } : {}),
      ...(draft.mode === "task" && draft.maxBudgetUsd
        ? { maxBudgetUsd: Number(draft.maxBudgetUsd) }
        : {}),
      ...(draft.mode === "task" && outputSchema ? { outputSchema } : {}),
    },
  };
}

/** User-selected browser files only: no path, upload endpoint or ambient filesystem read. */
export async function sessionAttachments(
  files: readonly File[],
): Promise<SessionAttachment[]> {
  if (files.length > 8) throw new Error("Choose at most eight attachments.");
  const attachments: SessionAttachment[] = [];
  for (const file of files) {
    if (file.size > 1_000_000)
      throw new Error("Each attachment must be 1 MB or smaller.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (
      ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type)
    ) {
      let binary = "";
      for (let start = 0; start < bytes.length; start += 8192)
        binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
      attachments.push({
        kind: "image",
        name: file.name,
        mediaType: file.type as Extract<
          SessionAttachment,
          { kind: "image" }
        >["mediaType"],
        data: btoa(binary),
      });
    } else {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error(
          "Text attachments must be UTF-8. Choose a supported image for binary content.",
        );
      }
      if (text.includes("\0"))
        throw new Error(
          "Binary attachments are unavailable; choose text or a supported image.",
        );
      attachments.push({ kind: "text", name: file.name, text });
    }
  }
  if (
    new TextEncoder().encode(JSON.stringify(attachments)).byteLength > 1_500_000
  )
    throw new Error(
      "The selected attachments exceed the combined 1.5 MB input limit.",
    );
  return attachments;
}
