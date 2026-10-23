import type { CodexTaskStartRequest } from "../../types/codex-owned-task";
import type { CodexTaskLaunch } from "../../types/codex-task";
import { ConversationError } from "../conversations/error";
import type { createCodexTaskRuntime } from "./codex-task-runtime";
import { preparedCodexTaskSchema } from "./codex-task-runtime-protocol";
import { canonicalSessionInput } from "./preparation";

/** Data construction only. The scoped server must authorize these paths and references independently. */
export function codexTaskLaunchFromStart(
  projectId: string,
  request: Omit<CodexTaskStartRequest, "requestId">,
): CodexTaskLaunch {
  return {
    mode: "task",
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
export async function prepareReviewedCodexTask(
  runtime: Pick<ReturnType<typeof createCodexTaskRuntime>, "prepare">,
  input: { smith: string; launch: CodexTaskLaunch },
) {
  const reviewed = structuredClone(input);
  let raw: unknown;
  try {
    raw = await runtime.prepare(structuredClone(reviewed));
  } catch {
    throw new ConversationError(
      503,
      "The selected Codex Task options are unavailable or lack exact capability evidence. No turn was accepted.",
    );
  }
  const parsed = preparedCodexTaskSchema.safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.smith !== reviewed.smith ||
    parsed.data.cwd !== reviewed.launch.cwd ||
    canonicalSessionInput(parsed.data.launch) !==
      canonicalSessionInput(reviewed.launch)
  )
    throw new ConversationError(
      503,
      "The prepared Codex Task changed the reviewed input. No turn was accepted.",
    );
  return parsed.data;
}
