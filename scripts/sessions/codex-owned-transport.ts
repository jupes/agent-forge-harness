import { ConversationError } from "../conversations/error";
import type { ConversationTransport } from "../conversations/transport";
import type { createCodexTaskRuntime } from "./codex-task-runtime";
import { preparedCodexTaskSchema } from "./codex-task-runtime-protocol";

/** Owned coding adapter only. The sealed Keeper transport and parser do not use this. */
export function createCodexOwnedTransport(
  runtime: ReturnType<typeof createCodexTaskRuntime>,
): ConversationTransport {
  return {
    provider: "codex",
    async run(request, persist, signal) {
      const snapshot = preparedCodexTaskSchema.safeParse(
        request.input.codexTask,
      );
      if (
        !snapshot.success ||
        request.resume ||
        snapshot.data.launch.prompt !== request.input.text
      )
        throw new ConversationError(
          409,
          "The private Codex Task or its one-turn identity could not be verified.",
        );
      const result = await runtime.run(
        snapshot.data,
        async (event) => {
          if (event.kind === "identity")
            await persist({
              kind: "identity",
              provider: "codex",
              sessionId: event.threadId,
              version: event.version,
            });
          else if (event.kind === "process")
            await persist({
              ...event,
              requestedEffort: event.requestedEffort ?? "default",
            });
          else if (event.kind === "usage")
            await persist({
              kind: "coding-usage",
              provider: "codex",
              source: "exec.turn.completed",
              version: snapshot.data.capabilities.version,
              usage: event.usage,
            });
          else if (event.kind === "coding-activity") await persist(event);
          else {
            let text = "",
              part = 0;
            for (const character of event.text) {
              if (text.length + character.length > 16_384) {
                await persist({
                  kind: "text",
                  messageId: `${event.itemId}:${part++}`,
                  text,
                });
                text = "";
              }
              text += character;
            }
            if (text)
              await persist({
                kind: "text",
                messageId: `${event.itemId}:${part}`,
                text,
              });
          }
        },
        signal,
      );
      return { phase: result.phase, reason: result.reason };
    },
  };
}
