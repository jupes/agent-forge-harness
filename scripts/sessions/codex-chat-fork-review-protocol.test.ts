import { expect, test } from "bun:test";
import {
  assertForkReviewEnvelopeBound,
  codexChatForkContextPageSchema,
  codexChatForkSourcePageSchema,
} from "./codex-chat-fork-review-protocol";

const requestId = "a1f167b5-df83-47ef-a04f-ff1b0a2f0011",
  turnId = "a1f167b5-df83-47ef-a04f-ff1b0a2f0012",
  hash = "a".repeat(64);

function sourcePage(request: string | null = null) {
  return {
    version: 1,
    projectId: "project-a1f167b5-df83-47ef-a04f-ff1b0a2f0013",
    parentSessionId: "session-a1f167b5-df83-47ef-a04f-ff1b0a2f0014",
    requestId: request,
    throughTurnRequestId: turnId,
    selectedTurnHash: hash,
    target: {
      smith: "codex-journeyman",
      repository: "C:/work/project",
      worktree: "C:/work/project",
      beadId: null,
    },
    settings: {
      model: "exact-model",
      provider: "openai",
      serviceTier: { present: true, value: null },
      effort: null,
      approvalPolicy: "never",
      sandbox: { mode: "workspace-write", networkAccess: "not-reported" },
    },
    provenance: {
      turn: "saved-completed-parent-turn",
      configuration: "captured-native-configuration",
    },
    frames: [
      {
        kind: "user",
        seq: 1,
        turnId,
        at: "2026-10-26T12:00:00.000Z",
        text: "Review this completed source.",
        about: [],
      },
    ],
    nextCursor: null,
    complete: true,
  };
}

test("Fork review DTO preserves nullable tier presence and rejects private or mismatched proof fields", () => {
  const source = sourcePage();
  expect(
    codexChatForkSourcePageSchema.parse(source).settings.serviceTier,
  ).toEqual({
    present: true,
    value: null,
  });
  expect(
    codexChatForkSourcePageSchema.safeParse({
      ...source,
      sourceSeal: { parentTurnHash: hash },
    }).success,
  ).toBe(false);

  const context = {
    version: 1,
    available: true,
    requestId,
    requestHash: hash,
    parentSessionId: source.parentSessionId,
    throughTurnRequestId: turnId,
    state: "reserved",
    reason: null,
    source: sourcePage(requestId),
  };
  expect(codexChatForkContextPageSchema.safeParse(context).success).toBe(true);
  expect(
    codexChatForkContextPageSchema.safeParse({
      ...context,
      source: sourcePage("b2f167b5-df83-47ef-a04f-ff1b0a2f0011"),
    }).success,
  ).toBe(false);
});

test("Fork review refuses a response envelope beyond the byte budget", () => {
  expect(() =>
    assertForkReviewEnvelopeBound({
      ok: true,
      data: { visibleText: "x".repeat(65_536) },
      error: null,
    }),
  ).toThrow("safe response limit");
});
