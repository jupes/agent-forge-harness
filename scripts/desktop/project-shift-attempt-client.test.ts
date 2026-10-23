import { expect, test } from "bun:test";
import { join } from "node:path";
import { createShiftAttemptObserver } from "../../apps/desktop/src/project-shift-attempt-client";
import type { StreamHandlers } from "../../docs/js/use-stream";
import type {
  ConversationFrame,
  ConversationPage,
} from "../../types/conversation";
import { SHIFT_ATTEMPT_METADATA_REASON } from "../shifts/attempt-read-protocol";

const projectId = "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
  originalRequestId = "2230bb02-1119-4c69-adad-c44116b375c1",
  turnId = "18da5c95-3218-439c-a33d-e5662465f505",
  sessionId = "session-2d5ed741-5528-424c-a927-263348778dad",
  shiftId = "shift-20261023-180000-1234",
  at = "2026-10-23T18:00:00.000Z",
  workspace = "/repo";
const snapshot = {
  version: 1 as const,
  projectId,
  originalRequestId,
  shiftId,
  runId: "run-owned",
  beadId: "alpha-work",
  attempt: 1,
  conversationId: sessionId,
  turnId,
  provider: "claude" as const,
  cliVersion: "2.1.296",
  workspace,
  cwd: "/repo/trees/shift-work",
  smith: "claude-journeyman",
  requestedModel: "exact-model",
  requestedEffort: "medium",
  command: ["/fixture/claude", "-p"],
  stdin: "PRIVATE INPUT",
  timeoutMs: 1000,
};
const record = {
  id: sessionId,
  projectId,
  requestId: turnId,
  requestHash: "a".repeat(64),
  mode: "task" as const,
  provider: "claude" as const,
  workspace,
  repository: workspace,
  worktree: snapshot.cwd,
  beadId: snapshot.beadId,
  smith: snapshot.smith,
  requestedModel: snapshot.requestedModel,
  requestedEffort: snapshot.requestedEffort,
  createdAt: at,
  origin: {
    kind: "shift" as const,
    projectId,
    originalRequestId,
    shiftId,
    runId: snapshot.runId,
    beadId: snapshot.beadId,
    attempt: 1,
  },
};
const turn = {
  requestId: turnId,
  hash: "a".repeat(64),
  phase: "unknown" as const,
  createdAt: at,
  updatedAt: at,
  owner: null,
  reason: "Historical fixture",
};
const frames: ConversationFrame[] = Array.from({ length: 121 }, (_, index) => ({
  seq: index + 1,
  turnId,
  at,
  event:
    index === 0
      ? {
          kind: "user",
          text: snapshot.stdin,
          about: [
            { kind: "bead", id: snapshot.beadId },
            { kind: "run", id: snapshot.runId },
          ],
          shift: snapshot,
        }
      : { kind: "text", text: `Private frame ${index}\n` },
}));
function page(from = 0, to = 100): ConversationPage {
  return {
    version: 1,
    projectId,
    conversationId: sessionId,
    revision: 123,
    binding: null,
    turns: [turn],
    frames: frames.slice(from, to),
    more: to < frames.length,
    nextCursor: Math.min(to, frames.length),
    lastSequence: frames.length,
    request: null,
    controllable: false,
  };
}
function fixture() {
  const connections: {
    handlers: StreamHandlers;
    cursor: number | null;
    closed: boolean;
  }[] = [];
  const timers = new Map<unknown, () => void>();
  let index: unknown = {
    projectId,
    originalRequestId,
    shiftId,
    asOf: at,
    items: [
      {
        session: record,
        phase: "unknown",
        reason: SHIFT_ATTEMPT_METADATA_REASON,
        controllable: false,
      },
    ],
  };
  const observer = createShiftAttemptObserver({
    projectId,
    originalRequestId,
    shiftId,
    workspace,
    read: async () => index,
    stream: () => (cursor, handlers) => {
      const connection = { cursor, handlers, closed: false };
      connections.push(connection);
      return {
        close: () => {
          connection.closed = true;
        },
      };
    },
    changed: () => {},
    timers: {
      set(work) {
        const id = {};
        timers.set(id, work);
        return id;
      },
      clear: (id) => {
        timers.delete(id);
      },
    },
  });
  const emit = (value: unknown, connection = connections.at(-1)) => {
    if (!connection) throw Error("No private feed");
    connection.handlers.onMessage({
      event: "conversation",
      id: null,
      data: JSON.stringify(value),
    });
  };
  return {
    observer,
    connections,
    timers,
    emit,
    setIndex: (value: unknown) => {
      index = value;
    },
  };
}

test("the dedicated observer reads beyond100 private frames and never gains per-attempt control authority", async () => {
  const f = fixture();
  await f.observer.refresh();
  expect(f.connections).toHaveLength(1);
  expect(f.connections[0]?.cursor).toBe(0);
  f.emit(page());
  expect(f.observer.get().loaded).toBe(false);
  f.emit(page(100, 121));
  expect(f.observer.get().loaded).toBe(true);
  expect(f.observer.get().page?.frames).toHaveLength(121);
  expect(f.observer.get().page?.frames.at(-1)?.event).toEqual({
    kind: "text",
    text: "Private frame 120\n",
  });
  expect(f.observer.get().page?.controllable).toBe(false);
  f.observer.close();
  expect(f.observer.get().page).toBeNull();
  expect(f.connections[0]?.closed).toBe(true);
  expect(f.timers.size).toBe(0);
});

test("foreign pages, missing sequence history or a changed private original fail closed and preserve verified partial text", async () => {
  for (const fault of ["project", "gap", "original"]) {
    const f = fixture();
    await f.observer.refresh();
    f.emit(page());
    const changed = page(100, 121);
    if (fault === "project")
      changed.projectId = "project-00000000-0000-4000-8000-000000000000";
    if (fault === "gap") changed.frames = changed.frames.slice(1);
    if (fault === "original") {
      const firstFrame = frames[0];
      if (!firstFrame) throw Error("Missing fixture original");
      const first = page(0, 1);
      first.frames = [
        {
          ...firstFrame,
          event: {
            kind: "user",
            text: snapshot.stdin,
            about: [
              { kind: "bead", id: snapshot.beadId },
              { kind: "run", id: snapshot.runId },
            ],
            shift: {
              ...snapshot,
              originalRequestId: "8230bb02-1119-4c69-adad-c44116b375c1",
            },
          },
        },
      ];
      f.emit(first);
      expect(f.observer.get().page?.frames).toHaveLength(100);
      f.observer.close();
      continue;
    }
    f.emit(changed);
    expect(f.observer.get().error).not.toBeNull();
    expect(f.observer.get().page?.frames).toHaveLength(100);
    expect(f.connections[0]?.closed).toBe(true);
    f.observer.close();
  }
});

test("foreign attempt indices and controllable generic session pages never become private shift history", async () => {
  const f = fixture();
  f.setIndex({
    projectId,
    originalRequestId,
    shiftId,
    asOf: at,
    items: [
      {
        session: { ...record, workspace: "/foreign" },
        phase: "unknown",
        reason: SHIFT_ATTEMPT_METADATA_REASON,
        controllable: false,
      },
    ],
  });
  await f.observer.refresh();
  expect(f.connections).toEqual([]);
  expect(f.observer.get().error).not.toBeNull();
  f.observer.close();
  const valid = fixture();
  await valid.observer.refresh();
  valid.emit({ ...page(), controllable: true });
  expect(valid.observer.get().page).toBeNull();
  expect(valid.observer.get().error).not.toBeNull();
  valid.observer.close();
});

test("a full-history completion without actual process/binding/outcome proof is refused", async () => {
  const f = fixture();
  await f.observer.refresh();
  const incomplete = page(0, 1);
  incomplete.more = false;
  incomplete.nextCursor = 1;
  incomplete.lastSequence = 1;
  incomplete.turns = [{ ...turn, phase: "completed" }];
  f.emit(incomplete);
  expect(f.observer.get().page).toBeNull();
  expect(f.observer.get().error).not.toBeNull();
  f.observer.close();
});

test("completion is published only after all correlated private pages, and a closed connection cannot mutate them", async () => {
  const f = fixture();
  await f.observer.refresh();
  const first = frames[0];
  if (!first) throw Error("No fixture original");
  const binding = {
    provider: "claude" as const,
    sessionId: "native-fixture-id",
    version: snapshot.cliVersion,
  };
  const events: ConversationFrame[] = [
    first,
    {
      seq: 2,
      turnId,
      at,
      event: {
        kind: "process",
        pid: 1234,
        smith: snapshot.smith,
        requestedModel: snapshot.requestedModel,
        requestedEffort: snapshot.requestedEffort,
      },
    },
    { seq: 3, turnId, at, event: { kind: "identity", ...binding } },
    {
      seq: 4,
      turnId,
      at,
      event: {
        kind: "coding-outcome",
        provider: "claude",
        version: snapshot.cliVersion,
        code: "completed",
        exitCode: 0,
        stopped: false,
        timedOut: false,
        message: null,
        stderrTail: { text: "", truncated: false },
      },
    },
  ];
  const completed = {
    ...page(),
    binding,
    turns: [{ ...turn, phase: "completed" as const }],
    lastSequence: 4,
  };
  f.emit({
    ...completed,
    frames: events.slice(0, 1),
    nextCursor: 1,
    more: true,
  });
  expect(f.observer.get().loaded).toBe(false);
  expect(f.observer.get().error).toBeNull();
  f.emit({ ...completed, frames: events.slice(1), nextCursor: 4, more: false });
  expect(f.observer.get().loaded).toBe(true);
  expect(f.observer.get().page?.binding).toEqual(binding);
  const previous = f.connections[0];
  f.observer.reload();
  f.emit(
    { ...completed, frames: events, nextCursor: 4, more: false },
    previous,
  );
  expect(f.observer.get().page).toBeNull();
  f.emit({
    ...completed,
    binding: { ...binding, version: "wrong-version" },
    frames: events,
    nextCursor: 4,
    more: false,
  });
  expect(f.observer.get().page).toBeNull();
  expect(f.observer.get().error).not.toBeNull();
  f.observer.close();
});

test("the dedicated private observer has a browser-only dependency graph", async () => {
  const built = await Bun.build({
    entrypoints: [
      join(
        import.meta.dir,
        "../../apps/desktop/src/project-shift-attempt-client.ts",
      ),
    ],
    target: "browser",
  });
  expect(built.success).toBe(true);
  const text = await built.outputs[0]?.text();
  for (const forbidden of [
    "node:fs",
    "bun:sqlite",
    "createProjectShiftRegistry",
    "createConversationStore",
    "runExec",
  ])
    expect(text).not.toContain(forbidden);
});
