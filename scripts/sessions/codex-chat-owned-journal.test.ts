import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eventSchema } from "../conversations/protocol";
import { createConversationStore } from "../conversations/store";
import {
  FIXTURE_CHAT_SESSION,
  seedChatDecision,
} from "../hearth/routes/codex-chat-fixture";
import { startTestHearth } from "../hearth/testing";
import { FIXTURE_PROJECT_ID } from "../projects/testing";
import { ownedCodingStateSchema } from "./codex-owned-journal";

test("private native approvals stay correlated with their exact Chat intent and native identity, and Keeper stays closed", async () => {
  const h = await startTestHearth();
  try {
    await seedChatDecision(h);
    const state = createConversationStore(h.home, undefined, {
      kind: "session",
      projectId: FIXTURE_PROJECT_ID,
      sessionId: FIXTURE_CHAT_SESSION,
    }).read(FIXTURE_PROJECT_ID);
    expect(ownedCodingStateSchema.safeParse(state).success).toBe(true);
    const request = state.frames.find(
      (frame) =>
        frame.event.kind === "coding-chat" &&
        frame.event.event.kind === "approval-request",
    );
    if (
      request?.event.kind !== "coding-chat" ||
      request.event.event.kind !== "approval-request"
    )
      throw Error("No native request fixture");
    expect(eventSchema.safeParse(request.event).success).toBe(false);
    const foreign = structuredClone(state),
      frame = foreign.frames.find((item) => item.seq === request.seq);
    if (
      frame?.event.kind !== "coding-chat" ||
      frame.event.event.kind !== "approval-request"
    )
      throw Error("No copied request");
    frame.event.event.approval.threadId = randomUUID();
    expect(ownedCodingStateSchema.safeParse(foreign).success).toBe(false);
    for (const change of [
      { processId: 123 },
      { turnId: randomUUID() },
      { id: randomUUID() },
    ]) {
      const altered = structuredClone(state),
        target = altered.frames.find((item) => item.seq === request.seq);
      if (
        target?.event.kind !== "coding-chat" ||
        target.event.event.kind !== "approval-request"
      )
        throw Error("No copied native request");
      Object.assign(target.event.event.approval, change);
      expect(ownedCodingStateSchema.safeParse(altered).success).toBe(false);
    }
  } finally {
    await h.close();
  }
});
