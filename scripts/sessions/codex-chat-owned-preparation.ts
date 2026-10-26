import type { CodexChatLaunch } from "../../types/codex-chat";
import type { CodexChatStartRequest } from "../../types/codex-owned-chat";
import { ConversationError } from "../conversations/error";
import { markKnownPreacceptPreparationRefusal } from "../identities/preaccept-not-sent-proof";
import { preparedCodexChatSchema } from "./codex-app-server-protocol";
import type { createCodexChatRuntime } from "./codex-chat-runtime";
import { canonicalSessionInput } from "./preparation";

/** Pure construction only. The server must independently validate scope and original intent. */
export function codexChatLaunchFromStart(
  projectId: string,
  request: Omit<CodexChatStartRequest, "requestId">,
): CodexChatLaunch {
  return {
    mode: "chat",
    cwd: request.worktree,
    model: request.launch.model,
    prompt: request.launch.prompt,
    sandbox: request.launch.sandbox,
    approvalPolicy: request.launch.approvalPolicy,
    ...(request.launch.effort === undefined
      ? {}
      : { effort: request.launch.effort }),
    ...(request.launch.attachments === undefined
      ? {}
      : { attachments: structuredClone(request.launch.attachments) }),
    context: {
      projectId,
      repository: request.repository,
      worktree: request.worktree,
      ...(request.beadId ? { beadId: request.beadId } : {}),
      about: structuredClone(request.about ?? []),
    },
  };
}

export async function prepareReviewedCodexChat(
  runtime: Pick<ReturnType<typeof createCodexChatRuntime>, "prepare">,
  input: { smith: string; launch: CodexChatLaunch },
) {
  const reviewed = structuredClone(input);
  let raw: unknown;
  try {
    raw = await runtime.prepare(structuredClone(reviewed));
  } catch (error) {
    throw markKnownPreacceptPreparationRefusal(
      new ConversationError(
        503,
        "The selected Codex Chat options are unavailable or lack exact capability evidence. No conversation was started.",
      ),
      error,
    );
  }
  const parsed = preparedCodexChatSchema.safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.smith !== reviewed.smith ||
    parsed.data.cwd !== reviewed.launch.cwd ||
    canonicalSessionInput(parsed.data.launch) !==
      canonicalSessionInput(reviewed.launch)
  )
    throw new ConversationError(
      503,
      "The prepared Codex Chat changed the reviewed input. No conversation was started.",
    );
  return parsed.data;
}
