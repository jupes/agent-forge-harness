import { expect, test } from "bun:test";
import type {
  CodexChatEvent,
  CodexChatFileChange,
} from "../../types/codex-chat";
import type { CodexChatDecisionIntent } from "../../types/codex-owned-chat";
import { eventSchema } from "../conversations/protocol";
import { createConversationStore } from "../conversations/store";
import {
  FIXTURE_CHAT_SESSION,
  seedChatDecision,
} from "../hearth/routes/codex-chat-fixture";
import { startTestHearth } from "../hearth/testing";
import { FIXTURE_PROJECT_ID } from "../projects/testing";
import { createCodexChatApprovalBroker } from "./codex-chat-approval-broker";
import { codexChatPrivateEventSchema } from "./codex-chat-owned-journal";
import {
  ownedCodingPageSchema,
  ownedCodingStateSchema,
} from "./codex-owned-journal";

const version = "0.163.0-alpha.10.2";
const file: CodexChatFileChange = {
  kind: "file-change",
  source: "item/started",
  threadId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
  turnId: "0199a213-81c0-7800-8aa1-bbab2a035a54",
  itemId: "native-files",
  status: "inProgress",
  closure: "open",
  turnStatus: null,
  partial: true,
  truncated: false,
  changes: [
    {
      path: { text: "../native-display-only/a.txt", truncated: false },
      kind: { type: "update", move_path: null },
      diff: { text: "", truncated: false },
    },
  ],
};
const packet = (event: unknown) => ({
  kind: "coding-chat",
  provider: "codex",
  version,
  event,
});

test("inspectable native diff text grants no file Allow choice or callback authority", async () => {
  const report = codexChatPrivateEventSchema.parse(
    packet({
      ...file,
      changes: [
        {
          path: { text: "display-only.txt", truncated: false },
          kind: { type: "add" },
          diff: { text: "+PRIVATE INSPECTION DIFF", truncated: false },
        },
      ],
    }),
  );
  expect(report.event.kind).toBe("file-change");
  const intents: CodexChatDecisionIntent[] = [];
  const broker = createCodexChatApprovalBroker({ readIntents: () => intents });
  const address = {
    projectId: FIXTURE_PROJECT_ID,
    sessionId: FIXTURE_CHAT_SESSION,
  };
  const turnRequestId = "023834ee-4c0f-48d2-a360-77bf938661a2",
    approvalId = "8eaf6b78-7fb5-4c0a-ad01-19ad9660789b";
  const offered = broker.offer({
    ...address,
    turnRequestId,
    version,
    signal: new AbortController().signal,
    approval: {
      id: approvalId,
      provider: "codex",
      processId: 2_000_000_000,
      nativeRequestId: 1,
      nativeApprovalId: null,
      threadId: file.threadId,
      turnId: file.turnId,
      itemId: file.itemId,
      kind: "file-change",
      command: null,
      cwd: null,
      reason: "Native request",
      availableDecisions: ["accept", "decline", "cancel"],
    },
    persist: async (event) => {
      intents.push(event);
    },
  });
  const page = broker.read(address);
  expect(page.pending[0]?.approval.availableDecisions).toEqual([
    "decline",
    "cancel",
  ]);
  expect(page.pending[0]?.detailsUnavailableReason).toContain(
    "Allow is disabled",
  );
  expect(JSON.stringify(page)).not.toContain("PRIVATE INSPECTION DIFF");
  const request = {
    requestId: "053567e4-1b60-47ea-aa1b-c4e05a4819b8",
    turnRequestId,
    approvalId,
  };
  await expect(
    broker.decide(address, { ...request, decision: "accept" }),
  ).rejects.toThrow("offer");
  expect(intents).toEqual([]);
  await broker.decide(address, { ...request, decision: "decline" });
  expect(await offered).toBe("decline");
});

test("private native file snapshots preserve empty diffs and exact source/status/closure while sealed Keeper refuses the family", () => {
  expect(codexChatPrivateEventSchema.safeParse(packet(file)).success).toBe(
    true,
  );
  expect(eventSchema.safeParse(packet(file)).success).toBe(false);
  for (const changed of [
    { source: "item/fileChange/outputDelta" },
    { closure: "item-ended" },
    { status: "completed" },
    { partial: false },
    { turnStatus: "completed" },
    { command: "unrelated" },
    { changes: [{ ...file.changes[0], diff: undefined }] },
    {
      changes: [{ ...file.changes[0], kind: { type: "add", move_path: null } }],
    },
    { changes: [{ ...file.changes[0], path: { text: "", truncated: false } }] },
  ])
    expect(
      codexChatPrivateEventSchema.safeParse(packet({ ...file, ...changed }))
        .success,
    ).toBe(false);
});

test("file snapshot private codecs enforce shared retained text, event shape, truncation and change-count bounds", () => {
  for (const changed of [
    { changes: [{ ...file.changes[0], diff: { text: "x", truncated: true } }] },
    {
      changes: [
        {
          path: { text: "x", truncated: false },
          kind: { type: "add" },
          diff: { text: "y".repeat(16_384), truncated: false },
        },
      ],
    },
    { changes: Array.from({ length: 129 }, () => file.changes[0]) },
    {
      changes: [
        {
          ...file.changes[0],
          path: { text: "unpaired\ud800", truncated: false },
        },
      ],
    },
    {
      changes: [{ ...file.changes[0], diff: { text: "\0", truncated: true } }],
      truncated: true,
    },
    {
      changes: [
        {
          ...file.changes[0],
          kind: { type: "update", move_path: "not-reported-text" },
        },
      ],
    },
  ])
    expect(
      codexChatPrivateEventSchema.safeParse(packet({ ...file, ...changed }))
        .success,
    ).toBe(false);
  expect(
    codexChatPrivateEventSchema.safeParse(
      packet({
        ...file,
        truncated: true,
        changes: [{ ...file.changes[0], diff: { text: "", truncated: true } }],
      }),
    ).success,
  ).toBe(true);
});

test("whole private file-change history fences identity, item closure, matching final snapshots and failed native outcome truth", async () => {
  const h = await startTestHearth();
  try {
    await seedChatDecision(h);
    const state = createConversationStore(h.home, undefined, {
      kind: "session",
      projectId: FIXTURE_PROJECT_ID,
      sessionId: FIXTURE_CHAT_SESSION,
    }).read(FIXTURE_PROJECT_ID);
    const native = state.frames.find(
      (frame) =>
        frame.event.kind === "coding-chat" && frame.event.event.kind === "turn",
    );
    if (!native) throw Error("Missing correlated native turn fixture");
    const prefix = state.frames.filter((frame) => frame.seq <= native.seq);
    const accepts = (events: CodexChatEvent[], head = prefix) =>
      ownedCodingStateSchema.safeParse({
        ...state,
        frames: [
          ...head,
          ...events.map((event, index) => ({
            ...native,
            seq: prefix.length + index + 1,
            event: packet(event),
          })),
        ],
      }).success;
    const updated: CodexChatFileChange = {
      ...file,
      source: "item/fileChange/patchUpdated",
      changes: [],
    };
    const ended: CodexChatFileChange = {
      ...updated,
      source: "item/completed",
      status: "failed",
      closure: "item-ended",
      partial: false,
    };
    const final: CodexChatFileChange = {
      ...ended,
      source: "turn/completed",
      closure: "turn-ended",
      turnStatus: "failed",
      partial: true,
    };
    expect(accepts([file, updated, ended, final])).toBe(true);
    expect(
      accepts(
        [file],
        prefix.filter((frame) => frame.event.kind !== "process"),
      ),
    ).toBe(false);
    expect(
      accepts([{ ...file, threadId: "0199a213-81c0-7800-8aa1-bbab2a035a55" }]),
    ).toBe(false);
    expect(
      accepts([{ ...file, turnId: "0199a213-81c0-7800-8aa1-bbab2a035a55" }]),
    ).toBe(false);
    for (const events of [
      [updated],
      [file, file],
      [file, ended, updated],
      [file, ended, { ...final, changes: file.changes }],
      [file, ended, final, final],
      [file, { kind: "text", itemId: file.itemId, text: "Wrong kind" }],
      [{ kind: "text", itemId: file.itemId, text: "Wrong kind" }, file],
    ] satisfies CodexChatEvent[][])
      expect(accepts(events)).toBe(false);
    expect(
      accepts([
        final,
        {
          kind: "outcome",
          outcome: {
            phase: "completed",
            reason: null,
            threadId: file.threadId,
            turnId: file.turnId,
            observedModel: null,
            usage: null,
            exitCode: 0,
            stopped: false,
            timedOut: false,
          },
        },
      ]),
    ).toBe(false);
    const one = { ...native, seq: native.seq + 1, event: packet(file) };
    const page = {
      ...state,
      frames: [one],
      more: false,
      nextCursor: one.seq,
      lastSequence: one.seq,
      request: state.turns[0],
      controllable: false,
    };
    expect(ownedCodingPageSchema.safeParse(page).success).toBe(true);
    expect(
      ownedCodingPageSchema.safeParse({
        ...page,
        binding: {
          ...state.binding,
          sessionId: "0199a213-81c0-7800-8aa1-bbab2a035a55",
        },
      }).success,
    ).toBe(false);
    const mixed: CodexChatEvent[] = Array.from(
      { length: 64 },
      (_, index): CodexChatEvent[] => [
        {
          ...file,
          itemId: `file-${index}`,
          changes: [
            {
              path: { text: "x", truncated: false },
              kind: { type: "add" },
              diff: { text: "y".repeat(16_383), truncated: false },
            },
          ],
        },
        {
          kind: "turn-plan",
          source: "turn/plan/updated",
          threadId: file.threadId,
          turnId: file.turnId,
          explanation: { text: "z".repeat(16_384), truncated: false },
          plan: [],
          truncated: false,
        },
      ],
    ).flat();
    expect(accepts(mixed.slice(0, 100))).toBe(true);
    expect(accepts(mixed)).toBe(false);
    expect(
      accepts(
        Array.from({ length: 257 }, (_, index) => ({
          ...file,
          itemId: `item-${index}`,
        })),
      ),
    ).toBe(false);
  } finally {
    await h.close();
  }
});
