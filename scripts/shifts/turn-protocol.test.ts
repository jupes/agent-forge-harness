import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ConversationEvent,
  ConversationObject,
} from "../../types/conversation";
import type { ShiftTurnSnapshot } from "../../types/shift-turn";
import {
  conversationFile,
  conversationWriteLockFile,
} from "../conversations/paths";
import {
  eventSchema,
  parsePreparedConversationSend,
} from "../conversations/protocol";
import { createConversationStore } from "../conversations/store";
import { writeOwnerOnly } from "../hearth/token";
import { withQueueLock } from "../scheduler/queue-lock";
import {
  ownedCodingEventSchema,
  ownedCodingStateSchema,
  parseOwnedPreparedConversationSend,
} from "../sessions/codex-owned-journal";
import { scratchDirs } from "../test-scratch";

const requestId = "15165118-dcd6-4a5e-b6b3-ddf3b34651f3";
const projectId = "project-05f27fd0-011b-4e0c-bb01-0da9104b1439";
const snapshot = {
  version: 1,
  projectId,
  originalRequestId: "2230bb02-1119-4c69-adad-c44116b375c1",
  shiftId: "shift-20261023-080000-1234",
  runId: "bounded-run-1",
  beadId: "bounded-task-1",
  attempt: 1,
  conversationId: "session-75126685-270f-49b9-8262-d74b49b0b94e",
  turnId: requestId,
  provider: "claude",
  cliVersion: "2.1.293",
  workspace: "/fixture",
  cwd: "/fixture/worktree",
  smith: "claude-journeyman",
  requestedModel: "claude-sonnet-5-5",
  requestedEffort: "medium",
  command: [
    "/fixture/claude",
    "-p",
    "--output-format",
    "stream-json",
    "--model",
    "claude-sonnet-5-5",
    "--effort",
    "medium",
  ],
  stdin: "  exact bounded task\n",
  timeoutMs: 60000,
} satisfies ShiftTurnSnapshot;
const about: ConversationObject[] = [
  { kind: "bead", id: snapshot.beadId },
  { kind: "run", id: snapshot.runId },
];
const user = {
  kind: "user",
  text: snapshot.stdin,
  about,
  shift: snapshot,
} satisfies ConversationEvent;
const scratch = scratchDirs();
afterEach(() => scratch.cleanup());
function state() {
  return {
    version: 1,
    projectId,
    conversationId: snapshot.conversationId,
    revision: 1,
    binding: null,
    turns: [
      {
        requestId,
        hash: "a".repeat(64),
        phase: "accepted",
        createdAt: "2026-10-23T08:00:00.000Z",
        updatedAt: "2026-10-23T08:00:00.000Z",
        reason: null,
        owner: null,
      },
    ],
    frames: [
      {
        seq: 1,
        turnId: requestId,
        at: "2026-10-23T08:00:00.000Z",
        event: user,
      },
    ],
  };
}

test("the owned coding codec retains exact canonical shift input while public and Keeper messages stay sealed", () => {
  const input = {
    requestId,
    expectedRevision: 0,
    text: snapshot.stdin,
    about,
    shift: snapshot,
  };
  expect(parseOwnedPreparedConversationSend(input)).toEqual(input);
  expect(ownedCodingEventSchema.safeParse(user).success).toBe(true);
  expect(eventSchema.safeParse(user).success).toBe(false);
  expect(() => parsePreparedConversationSend(input)).toThrow();
  expect(ownedCodingStateSchema.safeParse(state()).success).toBe(true);
});

test("a private shift user is bound to its exact project, address, turn, body and provider version", () => {
  for (const changed of [
    { ...state(), projectId: "project-69e03926-471b-4fbc-b15e-e29f778361b6" },
    {
      ...state(),
      conversationId: "session-76c12d8a-a41c-41a3-a383-aac004d332e4",
    },
    {
      ...state(),
      frames: [
        {
          ...state().frames[0],
          turnId: "b6986769-69d8-4e69-a90f-a8115d2c8ec0",
        },
      ],
    },
    {
      ...state(),
      binding: { provider: "claude", sessionId: requestId, version: "2.1.296" },
    },
  ])
    expect(ownedCodingStateSchema.safeParse(changed).success).toBe(false);
  for (const shift of [
    { ...snapshot, extra: true },
    { ...snapshot, attempt: 0 },
    {
      ...snapshot,
      command: [...snapshot.command, "--api-key", "never-persist"],
    },
    { ...snapshot, env: { ANTHROPIC_API_KEY: "never-persist" } },
    { ...snapshot, timeoutMs: 0 },
    { ...snapshot, cwd: "../escape" },
  ])
    expect(ownedCodingEventSchema.safeParse({ ...user, shift }).success).toBe(
      false,
    );
  expect(
    ownedCodingEventSchema.safeParse({ ...user, text: "edited body" }).success,
  ).toBe(false);
  const coding = {
    kind: "coding-account",
    provider: "claude",
    version: "2.1.293",
    id: "usage",
    observedAt: "2026-10-23T08:00:00.000Z",
    source: "claude.usage_report",
    report: { rate_limits: null },
  };
  const framed = {
    seq: 2,
    turnId: requestId,
    at: "2026-10-23T08:00:01.000Z",
    event: coding,
  };
  expect(
    ownedCodingStateSchema.safeParse({
      ...state(),
      frames: [...state().frames, framed],
    }).success,
  ).toBe(true);
  expect(
    ownedCodingStateSchema.safeParse({
      ...state(),
      frames: [
        ...state().frames,
        { ...framed, event: { ...coding, version: "2.1.296" } },
      ],
    }).success,
  ).toBe(false);
});

test("the existing owned journal persists full shift input, rejects foreign ownership, and preserves a valid-looking changed input", async () => {
  const home = join(scratch.make("shift private input "), "home");
  const address = {
    kind: "session",
    projectId,
    sessionId: snapshot.conversationId,
  } as const;
  const store = createConversationStore(home, undefined, address);
  const input = parseOwnedPreparedConversationSend({
    requestId,
    expectedRevision: 0,
    text: snapshot.stdin,
    about,
    shift: snapshot,
  });
  const receipt = await store.accept(projectId, input);
  expect(receipt.turn.phase).toBe("accepted");
  expect(store.read(projectId).frames[0]?.event).toEqual(user);
  expect((await store.accept(projectId, input)).turn.hash).toBe(
    receipt.turn.hash,
  );
  await expect(
    store.accept(projectId, {
      ...input,
      shift: {
        ...input.shift!,
        conversationId: "session-76c12d8a-a41c-41a3-a383-aac004d332e4",
      },
    }),
  ).rejects.toThrow("does not belong");
  const file = conversationFile(home, projectId, address);
  const changed = store.read(projectId);
  const first = changed.frames[0]?.event;
  if (first?.kind !== "user" || !first.shift)
    throw Error("Missing stored shift input");
  first.shift.command.push("--verbose");
  const bytes = JSON.stringify(changed);
  writeOwnerOnly(file, bytes);
  expect(() => store.read(projectId)).toThrow("invalid");
  expect(readFileSync(file, "utf8")).toBe(bytes);
});

test("the private shift response codec compiles for the browser without Node or Bun runtime imports", async () => {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "turn-protocol.ts")],
    target: "browser",
  });
  expect(result.success).toBe(true);
  expect(result.logs).toEqual([]);
  expect(result.outputs.length).toBeGreaterThan(0);
});

test("a queued private append checks the live owner again inside the journal write lock", async () => {
  const home = join(scratch.make("shift queued owner "), "home");
  const address = {
    kind: "session",
    projectId,
    sessionId: snapshot.conversationId,
  } as const;
  const store = createConversationStore(home, undefined, address);
  const input = parseOwnedPreparedConversationSend({
    requestId,
    expectedRevision: 0,
    text: snapshot.stdin,
    about,
    shift: snapshot,
  });
  const owner = "776002c5-fb80-422f-9949-612ff65c32ce";
  await store.accept(projectId, input);
  await store.start(projectId, requestId, owner);
  let entered!: () => void,
    release!: () => void,
    current = true;
  const acquired = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = withQueueLock(
    conversationWriteLockFile(home, projectId, address),
    async () => {
      entered();
      await released;
    },
  );
  await acquired;
  const queued = store.append(
    projectId,
    requestId,
    owner,
    { kind: "text", text: "late private output" },
    () => current,
  );
  current = false;
  release();
  await held;
  await expect(queued).rejects.toThrow("owner");
  expect(store.read(projectId).frames).toHaveLength(1);
});
