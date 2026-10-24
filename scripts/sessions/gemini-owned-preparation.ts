import type { GeminiTaskStartRequest } from "../../types/gemini-owned-task";
import type { GeminiTaskLaunch } from "../../types/gemini-task";
import { ConversationError } from "../conversations/error";
import type { createGeminiTaskRuntime } from "./gemini-task-runtime";
import { preparedGeminiTaskSchema } from "./gemini-task-runtime-protocol";
import { canonicalSessionInput } from "./preparation";

/** Pure construction only. The admission owner independently authorizes every path and selected object. */
export function geminiTaskLaunchFromStart(
  projectId: string,
  request: Omit<GeminiTaskStartRequest, "requestId">,
): GeminiTaskLaunch {
  return {
    ...structuredClone(request.launch),
    cwd: request.worktree,
    context: {
      projectId,
      repository: request.repository,
      worktree: request.worktree,
      ...(request.beadId === undefined ? {} : { beadId: request.beadId }),
      about: structuredClone(request.about ?? []),
    },
  };
}

export async function prepareReviewedGeminiTask(
  runtime: Pick<ReturnType<typeof createGeminiTaskRuntime>, "prepare">,
  input: { smith: string; launch: GeminiTaskLaunch },
) {
  const reviewed = structuredClone(input);
  let raw: unknown;
  try {
    raw = await runtime.prepare(structuredClone(reviewed));
  } catch {
    throw new ConversationError(
      503,
      "The selected Gemini Task options are unavailable or lack exact native capability evidence. No turn was accepted.",
    );
  }
  const parsed = preparedGeminiTaskSchema.safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.smith !== reviewed.smith ||
    parsed.data.launch.cwd !== reviewed.launch.cwd ||
    canonicalSessionInput(parsed.data.launch) !==
      canonicalSessionInput(reviewed.launch)
  )
    throw new ConversationError(
      503,
      "The prepared Gemini Task changed the reviewed private input. No turn was accepted.",
    );
  return parsed.data;
}
