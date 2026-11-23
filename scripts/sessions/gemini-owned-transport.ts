import { ConversationError } from "../conversations/error";
import type { ConversationTransport } from "../conversations/transport";
import type { createGeminiTaskRuntime } from "./gemini-task-runtime";
import { preparedGeminiTaskSchema } from "./gemini-task-runtime-protocol";

/** This adapter has only the native Gemini Task runtime; no provider fallback or resume path. */
export function createGeminiOwnedTransport(
  runtime: ReturnType<typeof createGeminiTaskRuntime>,
): ConversationTransport {
  return {
    provider: "gemini",
    async run(request, persist, signal) {
      const snapshot = preparedGeminiTaskSchema.safeParse(
        request.input.geminiTask,
      );
      if (
        !snapshot.success ||
        request.resume ||
        snapshot.data.launch.prompt !== request.input.text
      )
        throw new ConversationError(
          409,
          "The private Gemini Task or its one-turn identity could not be verified.",
        );
      const result = await runtime.run(
        snapshot.data,
        async (event) => {
          if (event.kind === "identity")
            await persist({
              kind: "identity",
              provider: "gemini",
              sessionId: event.sessionId,
              version: event.version,
            });
          await persist({
            kind: "coding-gemini-task",
            provider: "gemini",
            version: "0.65.0",
            event,
          });
        },
        signal,
      );
      return { phase: result.phase, reason: result.reason };
    },
  };
}
