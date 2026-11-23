import { ConversationError } from "../conversations/error";
import type { ConversationTransport } from "../conversations/transport";
import type { createGeminiChatApprovalBroker } from "./gemini-chat-approval-broker";
import type { createGeminiChatRuntime } from "./gemini-chat-runtime";
import { preparedGeminiChatSchema } from "./gemini-chat-runtime-protocol";

/** Private ACP only. Native session updates retain their scope and user/assistant role. */
export function createGeminiChatOwnedTransport(
  runtime: ReturnType<typeof createGeminiChatRuntime>,
  broker: ReturnType<typeof createGeminiChatApprovalBroker>,
  address: { projectId: string; sessionId: string },
): ConversationTransport {
  return {
    provider: "gemini",
    async run(request, persist, signal) {
      const snapshot = preparedGeminiChatSchema.safeParse(
        request.input.geminiChat,
      );
      if (
        !snapshot.success ||
        snapshot.data.launch.prompt !== request.input.text ||
        snapshot.data.launch.context?.projectId !== address.projectId ||
        (request.resume &&
          (request.resume.provider !== "gemini" ||
            request.resume.version !== "0.65.0"))
      )
        throw new ConversationError(
          409,
          "The private Gemini Chat intent or saved native identity could not be verified.",
        );
      const result = await runtime.run(
        {
          prepared: snapshot.data,
          requestId: request.input.requestId,
          resume: request.resume
            ? { sessionId: request.resume.sessionId, version: "0.65.0" }
            : null,
        },
        async (event) => {
          if (event.kind === "identity")
            await persist({
              kind: "identity",
              provider: "gemini",
              sessionId: event.sessionId,
              version: "0.65.0",
            });
          // No generic text projection: even a new prompt can be interleaved with native replay after load.
          await persist({
            kind: "coding-gemini-chat",
            provider: "gemini",
            version: "0.65.0",
            event,
          });
        },
        signal,
        {
          requestPermission: (offer, approvalSignal) =>
            broker.offer({
              ...address,
              turnRequestId: request.input.requestId,
              offer,
              signal: approvalSignal,
              persist,
            }),
        },
      );
      return { phase: result.phase, reason: result.reason };
    },
  };
}
