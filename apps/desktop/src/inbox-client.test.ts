import { expect, test } from "bun:test";
import type { ConversationFrame } from "../../../types/conversation";
import type { InboxCurrentPermissionItem } from "./inbox-model";
import { exactTerminalPermissionJoin, withInboxReadSlot } from "./inbox-client";

test("the shared inbox read slot caps concurrent protected reads at four", async () => {
  let active = 0;
  let maximum = 0;
  let completed = 0;
  await Promise.all(
    Array.from({ length: 11 }, () =>
      withInboxReadSlot(async () => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active--;
        completed++;
      }),
    ),
  );
  expect(maximum).toBe(4);
  expect(completed).toBe(11);
  expect(active).toBe(0);
});

const codexPermission: InboxCurrentPermissionItem = {
  kind: "permission",
  state: "current",
  complete: true,
  projectId: "project-a",
  workspace: "C:/work/a",
  provider: "codex",
  sessionId: "session-a",
  acceptedTurnId: "turn-a",
  offerId: "offer-a",
  key: "permission-a",
  actionable: true,
  snapshotGeneration: 1,
  observedAt: "2026-10-31T12:00:00.000Z",
  approval: {
    provider: "codex",
    value: { id: "offer-a", kind: "command", command: "bun test", cwd: "C:/work/a", reason: "Review", availableDecisions: ["accept"] },
  },
};
const codexOffer = {
  id: "offer-a",
  provider: "codex" as const,
  processId: 41,
  nativeRequestId: "native-request-a",
  nativeApprovalId: null,
  threadId: "thread-a",
  turnId: "turn-a",
  itemId: "item-a",
  kind: "command" as const,
  command: "bun test",
  cwd: "C:/work/a",
  reason: "Review",
  availableDecisions: ["accept"] as const,
};
const codexFrame = (seq: number, event: ConversationFrame["event"]): ConversationFrame => ({
  seq,
  turnId: "turn-a",
  at: "2026-10-31T12:00:00.000Z",
  event,
});

test("Codex Done proof requires the exact original offer and its own resolved event", () => {
  const offer = codexFrame(1, { kind: "coding-chat", provider: "codex", version: "0.1", event: { kind: "approval-request", approval: codexOffer } });
  const resolved = codexFrame(2, { kind: "coding-chat", provider: "codex", version: "0.1", event: { kind: "approval-resolved", approvalId: "offer-a", source: "serverRequest/resolved" } });
  expect(exactTerminalPermissionJoin(codexPermission, [offer, resolved], "0.1")).toBe(true);
  expect(exactTerminalPermissionJoin(codexPermission, [offer], "0.1")).toBe(false);
  expect(exactTerminalPermissionJoin(codexPermission, [offer, codexFrame(2, { kind: "coding-chat", provider: "codex", version: "0.1", event: { kind: "approval-resolved", approvalId: "offer-other", source: "turn/completed" } })], "0.1")).toBe(false);
  expect(exactTerminalPermissionJoin(codexPermission, [codexFrame(1, { kind: "coding-chat-decision", provider: "codex", version: "0.1", requestHash: "a".repeat(64), receipt: { projectId: "project-a", sessionId: "session-a", requestId: "request-a", turnRequestId: "turn-a", approvalId: "offer-a", decision: "accept", state: "recorded", recordedAt: "2026-10-31T12:00:00.000Z" } })], "0.1")).toBe(false);
});

const geminiPermission: InboxCurrentPermissionItem = {
  ...codexPermission,
  provider: "gemini",
  sessionId: "session-g",
  offerId: "offer-g",
  key: "permission-g",
  approval: {
    provider: "gemini",
    value: { id: "offer-g", detail: { json: "{\"tool\":\"read_file\"}", truncated: false }, detailsComplete: true, options: [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }] },
  },
};
const geminiFrame = (seq: number, event: Extract<ConversationFrame["event"], { kind: "coding-gemini-chat" }> ["event"]): ConversationFrame => ({
  seq,
  turnId: "turn-a",
  at: "2026-10-31T12:00:00.000Z",
  event: { kind: "coding-gemini-chat", provider: "gemini", version: "0.65.0", event },
});

test("Gemini Done proof binds the opaque offer to its exact tool completion or native result", () => {
  const offer = geminiFrame(1, { kind: "approval-offer", id: "offer-g", requestId: "turn-a", rpcId: "rpc-g", toolCallId: "tool-g" });
  const tool = geminiFrame(2, { kind: "tool", toolCallId: "tool-g", status: "completed", detail: { json: "{}", truncated: false }, scope: "turn", requestId: "turn-a" });
  const result = geminiFrame(3, { kind: "result", requestId: "turn-a", stopReason: "end_turn", usage: null });
  expect(exactTerminalPermissionJoin(geminiPermission, [offer, tool], "0.65.0")).toBe(true);
  expect(exactTerminalPermissionJoin(geminiPermission, [offer, result], "0.65.0")).toBe(true);
  expect(exactTerminalPermissionJoin(geminiPermission, [offer, geminiFrame(2, { kind: "tool", toolCallId: "other-tool", status: "completed", detail: { json: "{}", truncated: false }, scope: "turn", requestId: "turn-a" })], "0.65.0")).toBe(false);
  expect(exactTerminalPermissionJoin(geminiPermission, [offer, geminiFrame(2, { kind: "tool", toolCallId: "tool-g", status: "completed", detail: { json: "{}", truncated: false }, scope: "native-session", requestId: null })], "0.65.0")).toBe(false);
  expect(exactTerminalPermissionJoin(geminiPermission, [offer], "0.65.0")).toBe(false);
});
