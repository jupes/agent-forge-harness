import { expect, test } from "bun:test";
import {
  CODEX_CHAT_DECISION_IDENTITIES,
  createCodexChatDecisionIdentities,
} from "../../apps/desktop/src/codex-chat-decision-identities";
import { sessionStartFixture } from "./session-start-fixture";

const input = {
    projectId: "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
    sessionId: "session-2d5ed741-5528-424c-a927-263348778dad",
    turnRequestId: "18da5c95-3218-439c-a33d-e5662465f505",
    approvalId: "fa5c45ae-8487-4c61-84a5-e22ab343c227",
    decision: "accept" as const,
  },
  requestId = "93eb33c3-9386-4dda-a4d4-4b26d04d869a";
test("future, corrupt, duplicate, oversized or full decision journals preserve bytes and refuse before minting", async () => {
  const identity = { ...input, requestId },
    full = Array.from({ length: 256 }, (_, at) => ({
      ...identity,
      sessionId: `session-${at.toString(16).padStart(8, "0")}-5528-424c-a927-263348778dad`,
      requestId: `${at.toString(16).padStart(8, "0")}-9386-4dda-a4d4-4b26d04d869a`,
    }));
  for (const text of [
    "{corrupt",
    JSON.stringify({ version: 2, records: [] }),
    JSON.stringify({ version: 1, records: [identity, identity] }),
    JSON.stringify({ version: 1, records: full }),
    " ".repeat(100_001),
  ]) {
    const fixture = sessionStartFixture();
    fixture.storage.setItem(CODEX_CHAT_DECISION_IDENTITIES, text);
    let minted = 0;
    const journal = createCodexChatDecisionIdentities({
      storage: fixture.storage,
      withLock: fixture.withLock,
    });
    await expect(
      journal.reserve(input, () => {
        minted++;
        return requestId;
      }),
    ).rejects.toThrow();
    expect(minted).toBe(0);
    expect(fixture.storage.getItem(CODEX_CHAT_DECISION_IDENTITIES)).toBe(text);
  }
});
test("only exact identity release is permitted and unverified persistence or missing origin lock cannot authorize dispatch", async () => {
  const fixture = sessionStartFixture(),
    journal = createCodexChatDecisionIdentities({
      storage: fixture.storage,
      withLock: fixture.withLock,
    });
  const reserved = await journal.reserve(input, () => requestId);
  await expect(
    journal.release({ ...reserved.identity, decision: "decline" }),
  ).rejects.toThrow("different original");
  expect(journal.read(input.projectId, input.sessionId)).toEqual(
    reserved.identity,
  );
  await expect(
    journal.reserve(
      { ...input, sessionId: "session-96b0f7b4-48a4-417f-97c7-bb551f455631" },
      () => requestId,
    ),
  ).rejects.toThrow("collides");
  const missing = createCodexChatDecisionIdentities({
    storage: null,
    withLock: fixture.withLock,
  });
  await expect(missing.reserve(input, () => requestId)).rejects.toThrow(
    "unavailable",
  );
  const unverified = createCodexChatDecisionIdentities({
    storage: { getItem: () => null, setItem() {} },
    withLock: fixture.withLock,
  });
  await expect(unverified.reserve(input, () => requestId)).rejects.toThrow(
    "verified",
  );
  const noLock = createCodexChatDecisionIdentities({
    storage: fixture.storage,
    withLock: async () => {
      throw Error("No origin lock");
    },
  });
  await expect(noLock.reserve(input, () => requestId)).rejects.toThrow(
    "origin lock",
  );
});
