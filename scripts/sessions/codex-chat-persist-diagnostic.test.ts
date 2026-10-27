import { describe, expect, test } from "bun:test";
import type { CodexChatEvent } from "../../types/codex-chat";
import { ConversationError } from "../conversations/error";
import {
  CODEX_CHAT_PERSIST_FACT_MAX_BYTES,
  type CodexChatPersistFailureFact,
  observeCodexChatPersist,
} from "./fixtures/codex-chat-persist-diagnostic";

const identity: CodexChatEvent = {
  kind: "identity",
  provider: "codex",
  threadId: "00000000-0000-4000-8000-000000000001",
  version: "0.163.0-alpha.10.2",
};

describe("Codex Chat fixture persistence diagnostics", () => {
  test("counts only completed callbacks and preserves successful results", async () => {
    const facts: CodexChatPersistFailureFact[] = [];
    let calls = 0;
    const wrapped = observeCodexChatPersist({
      async persist() {
        calls++;
        return "saved";
      },
      recordFailure: (fact) => facts.push(fact),
    });

    await expect(wrapped(identity)).resolves.toBe("saved");
    expect(calls).toBe(1);
    expect(facts).toEqual([]);
  });

  test("records one bounded sanitized failure fact and rethrows the identical rejection", async () => {
    const secret = "private-event-body-and-native-error-detail";
    const rejection = new ConversationError(409, secret);
    const facts: CodexChatPersistFailureFact[] = [];
    const textEvent: CodexChatEvent = {
      kind: "text",
      itemId: "fixture-item",
      text: secret,
    };
    let calls = 0;
    const wrapped = observeCodexChatPersist({
      async persist() {
        calls++;
        if (calls === 1) return;
        throw rejection;
      },
      recordFailure: (fact) => facts.push(fact),
    });

    await wrapped(identity);
    let caught: unknown;
    try {
      await wrapped(textEvent);
    } catch (error) {
      caught = error;
    }

    expect(calls).toBe(2);
    expect(caught).toBe(rejection);
    expect(facts).toEqual([
      {
        version: 1,
        phase: "event-persist",
        eventKind: "text",
        completedPersistCallbacks: 1,
        countCapped: false,
        failureClass: "conversation-409",
      },
    ]);
    await expect(wrapped(textEvent)).rejects.toBe(rejection);
    expect(facts).toHaveLength(1);
    const serialized = JSON.stringify(facts[0]);
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(
      CODEX_CHAT_PERSIST_FACT_MAX_BYTES,
    );
    expect(serialized).not.toContain(secret);
  });

  test("diagnostic sink failure cannot mask the original rejection or retry persistence", async () => {
    const rejection = new Error("private callback detail");
    let calls = 0,
      reports = 0;
    const wrapped = observeCodexChatPersist({
      async persist() {
        calls++;
        throw rejection;
      },
      recordFailure() {
        reports++;
        throw new Error("diagnostic filesystem failure");
      },
    });

    let caught: unknown;
    try {
      await wrapped(identity);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(rejection);
    expect(calls).toBe(1);
    expect(reports).toBe(1);
  });

  test("saturates the callback counter explicitly without claiming an exact larger count", async () => {
    const facts: CodexChatPersistFailureFact[] = [];
    let calls = 0;
    const wrapped = observeCodexChatPersist({
      async persist() {
        calls++;
        if (calls > 257) throw new Error("fixture callback rejected");
      },
      recordFailure: (fact) => facts.push(fact),
    });

    for (let index = 0; index < 257; index++) await wrapped(identity);
    await expect(wrapped(identity)).rejects.toThrow();

    expect(calls).toBe(258);
    expect(facts).toEqual([
      {
        version: 1,
        phase: "event-persist",
        eventKind: "identity",
        completedPersistCallbacks: 256,
        countCapped: true,
        failureClass: "other",
      },
    ]);
  });
});
