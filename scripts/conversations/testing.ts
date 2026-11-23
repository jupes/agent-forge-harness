import type { ConversationTransport } from "./transport";

/** Tests only: no subprocess, credential, network or real model invocation. */
export function fakeConversationTransport(): ConversationTransport {
  return {
    provider: "claude",
    async run(request, persist, signal) {
      if (signal.aborted)
        return { phase: "failed", reason: "Fixture was stopped." };
      await persist({
        kind: "identity",
        provider: "claude",
        sessionId: request.resume?.sessionId ?? `fixture-${request.project.id}`,
        version: "fixture-1",
      });
      await persist({ kind: "text", text: "Fixture Keeper reply." });
      return { phase: "completed", reason: null };
    },
  };
}
