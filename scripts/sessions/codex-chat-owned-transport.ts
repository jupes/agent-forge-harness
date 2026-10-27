import { ConversationError } from "../conversations/error";
import type { ConversationTransport } from "../conversations/transport";
import { preparedCodexChatSchema } from "./codex-app-server-protocol";
import type { createCodexChatApprovalBroker } from "./codex-chat-approval-broker";
import type { createCodexChatRuntime } from "./codex-chat-runtime";

/** Lease-owned Chat only. The standing Keeper and exec Task never use this native protocol. */
export function createCodexChatOwnedTransport(
  runtime: ReturnType<typeof createCodexChatRuntime>,
  broker: ReturnType<typeof createCodexChatApprovalBroker>,
  address: { projectId: string; sessionId: string },
): ConversationTransport {
  return {
    provider: "codex",
    async run(request, persist, signal) {
      const snapshot = preparedCodexChatSchema.safeParse(
        request.input.codexChat,
      );
      if (
        !snapshot.success ||
        snapshot.data.launch.prompt !== request.input.text ||
        snapshot.data.launch.context?.projectId !== address.projectId ||
        (request.resume && request.resume.provider !== "codex")
      )
        throw new ConversationError(
          409,
          "The private Codex Chat intent or saved native identity could not be verified.",
        );
      const prepared = snapshot.data;
      const result = await runtime.run(
        {
          prepared,
          ...(request.codexResumeSettings
            ? { resumeSettings: request.codexResumeSettings }
            : {}),
          resume: request.resume
            ? {
                provider: "codex",
                threadId: request.resume.sessionId,
                version: request.resume.version,
              }
            : null,
        },
        async (event) => {
          if (event.kind === "identity")
            await persist({
              kind: "identity",
              provider: "codex",
              sessionId: event.threadId,
              version: event.version,
            });
          else if (event.kind === "text") {
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
          } else {
            if (event.kind === "process")
              await persist({
                kind: "process",
                pid: event.pid,
                smith: event.smith,
                requestedModel: event.requestedModel,
                requestedEffort: event.requestedEffort ?? "default",
              });
            await persist({
              kind: "coding-chat",
              provider: "codex",
              version: prepared.capabilities.version,
              event,
            });
          }
        },
        signal,
        {
          requestApproval: (approval, approvalSignal) =>
            broker.offer({
              ...address,
              turnRequestId: request.input.requestId,
              approval,
              signal: approvalSignal,
              version: prepared.capabilities.version,
              persist,
            }),
        },
      );
      return { phase: result.phase, reason: result.reason };
    },
  };
}
