import { expect, test } from "bun:test";
import type { CodexChatOutcome } from "../../types/codex-chat";
import { projectCodexDeadlineFacts } from "./codex-chat-deadline-diagnostic.test-utils";

test("projects a typed Codex timeout outcome into fixed safe facts", () => {
  const runtimeOutcome: CodexChatOutcome = {
    phase: "unknown",
    reason: "private diagnostic sentinel",
    threadId: "private-thread-id",
    turnId: "private-turn-id",
    observedModel: null,
    usage: null,
    exitCode: 0,
    stopped: false,
    timedOut: true,
  };
  expect(projectCodexDeadlineFacts({ runtimeOutcome })).toEqual({
    runtimeOutcome: {
      state: "observed",
      phase: "unknown",
      timedOut: true,
      stopped: false,
      exitCode: "zero",
      reasonPresent: true,
    },
  });
});
