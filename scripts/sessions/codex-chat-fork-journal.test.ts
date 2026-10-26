import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CodexChatForkOriginal } from "../../types/codex-chat-fork";
import { scratchDirs } from "../test-scratch";
import type {
  CodexChatForkEventEntry,
  CodexChatForkJournalStorage,
} from "./codex-chat-fork-journal";
import { createCodexChatForkJournal } from "./codex-chat-fork-journal";
import {
  CODEX_CHAT_FORK_LIMITS,
  canonicalCodexChatForkJournalEvent,
  codexChatForkCaptureHash,
  codexChatForkJournalEventBodySchema,
  codexChatForkJournalEventHash,
  codexChatForkJournalEventSchema,
} from "./codex-chat-fork-protocol";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());

class MemoryStorage implements CodexChatForkJournalStorage {
  readonly events = new Map<string, string>();
  private tail = Promise.resolve();

  listEvents(): Iterable<CodexChatForkEventEntry> {
    return [...this.events].map(([name, text]) => ({
      name,
      bytes: new TextEncoder().encode(text).byteLength,
      plain: true,
    }));
  }

  read(entry: CodexChatForkEventEntry, maxBytes: number): string {
    const text = this.events.get(entry.name);
    if (text === undefined || entry.bytes > maxBytes)
      throw Error("missing event");
    return text;
  }

  writeOnce(name: string, text: string): void {
    if (this.events.has(name)) throw Error("event already exists");
    this.events.set(name, text);
  }

  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

const requestId = "0199a213-81c0-7800-8aa1-bbab2a035a55",
  otherRequestId = "0199a213-81c0-7800-8aa1-bbab2a035a56",
  parentSessionId = "session-0199a213-81c0-7800-8aa1-bbab2a035a51",
  throughTurnRequestId = "0199a213-81c0-7800-8aa1-bbab2a035a54",
  projectId = "project-00000000-0000-4000-8000-000000000001";

function reference(record: CodexChatForkOriginal) {
  const {
    projectId,
    workspaceKey,
    requestId,
    requestHash,
    parentSessionId,
    throughTurnRequestId,
    protocolVersion,
    childAppSessionId,
  } = record;
  return {
    projectId,
    workspaceKey,
    requestId,
    requestHash,
    parentSessionId,
    throughTurnRequestId,
    protocolVersion,
    childAppSessionId,
  };
}

function fixture(root: string, storage: MemoryStorage) {
  const home = join(root, "profile");
  mkdirSync(home, { recursive: true });
  return {
    root,
    home,
    journal: createCodexChatForkJournal({
      root,
      home,
      storage,
      now: () => "2026-10-25T00:00:00.000Z",
      createChildAppSessionId: () =>
        "session-0199a213-81c0-7800-8aa1-bbab2a035a60",
    }),
  };
}

test("reserve persists a stable child ID and exact original across reopen", async () => {
  const root = scratch.make("codex-fork-root-"),
    storage = new MemoryStorage(),
    first = fixture(root, storage);
  const reserved = await first.journal.reserve(projectId, parentSessionId, {
    requestId,
    throughTurnRequestId,
  });
  expect(reserved.state).toBe("reserved");
  const reopened = fixture(root, storage).journal,
    read = reopened.read(projectId, requestId);
  expect(read).toEqual(reserved);
  expect(
    await reopened.reserve(projectId, parentSessionId, {
      requestId,
      throughTurnRequestId,
    }),
  ).toEqual(reserved);
  expect(read?.childAppSessionId).toBe(
    "session-0199a213-81c0-7800-8aa1-bbab2a035a60",
  );
});

test("only one independent instance gets the one-shot mayDispatch claim", async () => {
  const root = scratch.make("codex-fork-root-"),
    storage = new MemoryStorage(),
    first = fixture(root, storage),
    reserved = await first.journal.reserve(projectId, parentSessionId, {
      requestId,
      throughTurnRequestId,
    }),
    second = fixture(root, storage).journal;
  const claims = await Promise.all([
    first.journal.markAttempted(reference(reserved)),
    second.markAttempted(reference(reserved)),
  ]);
  expect(claims.filter((claim) => claim.mayDispatch)).toHaveLength(1);
  expect(claims.every((claim) => claim.record.state === "attempted")).toBe(
    true,
  );
  expect(
    (await fixture(root, storage).journal.markAttempted(reference(reserved)))
      .mayDispatch,
  ).toBe(false);
  expect(fixture(root, storage).journal.read(projectId, requestId)?.state).toBe(
    "attempted",
  );
});

test("a linked event cannot replace the exact capture saved by its prior event", async () => {
  const root = scratch.make("codex-fork-root-"),
    storage = new MemoryStorage(),
    journal = fixture(root, storage).journal,
    reserved = await journal.reserve(projectId, parentSessionId, {
      requestId,
      throughTurnRequestId,
    }),
    ref = reference(reserved),
    capture = {
      parentNativeThreadId: "0199a213-81c0-7800-8aa1-bbab2a035a70",
      childNativeThreadId: "0199a213-81c0-7800-8aa1-bbab2a035a71",
      throughNativeTurnId: "0199a213-81c0-7800-8aa1-bbab2a035a54",
      protocolVersion: "0.163.0-alpha.10.2" as const,
    };
  await journal.markAttempted(ref);
  await journal.capture(ref, capture);
  const linked = await journal.markLinked(ref, {
    childAppSessionId: reserved.childAppSessionId,
    childRequestId: "0199a213-81c0-7800-8aa1-bbab2a035a72",
    childRequestHash: "a".repeat(64),
    captureHash: codexChatForkCaptureHash(capture),
  });
  expect(linked.state).toBe("linked");

  const [oldName, oldText] = [...storage.events].at(-1) ?? [];
  if (!oldName || !oldText) throw Error("Missing final linked event.");
  const event = codexChatForkJournalEventSchema.parse(JSON.parse(oldText));
  if (event.record.state !== "linked") throw Error("Expected linked event.");
  const changedCapture = {
    ...event.record.capture,
    childNativeThreadId: "0199a213-81c0-7800-8aa1-bbab2a035a73",
  };
  const body = codexChatForkJournalEventBodySchema.parse({
    version: event.version,
    sequence: event.sequence,
    previousEventHash: event.previousEventHash,
    previousOperationHash: event.previousOperationHash,
    transition: event.transition,
    record: {
      ...event.record,
      capture: changedCapture,
      link: {
        ...event.record.link,
        captureHash: codexChatForkCaptureHash(changedCapture),
      },
    },
  });
  const eventHash = codexChatForkJournalEventHash(body),
    tamperedText = canonicalCodexChatForkJournalEvent(
      codexChatForkJournalEventSchema.parse({ ...body, eventHash }),
    );
  storage.events.delete(oldName);
  storage.events.set(
    `${String(event.sequence).padStart(8, "0")}-${eventHash}.json`,
    tamperedText,
  );

  expect(() => journal.read(projectId, requestId)).toThrow();
});

test("event listing stops at the configured bound before reading an unbounded namespace", () => {
  const root = scratch.make("codex-fork-root-"),
    storage = new MemoryStorage(),
    journal = fixture(root, storage).journal;
  let pulls = 0;
  storage.listEvents = function* () {
    for (;;) {
      pulls++;
      if (pulls > CODEX_CHAT_FORK_LIMITS.events + 1)
        throw Error("Iterator advanced past the bounded lookahead.");
      yield { name: "oversized-invalid-event", bytes: 1, plain: true };
    }
  };

  expect(() => journal.read(projectId, requestId)).toThrow();
  expect(pulls).toBe(CODEX_CHAT_FORK_LIMITS.events + 1);
});

test("held outcome survives reopen and cannot be captured or linked", async () => {
  const root = scratch.make("codex-fork-root-"),
    storage = new MemoryStorage(),
    journal = fixture(root, storage).journal,
    reserved = await journal.reserve(projectId, parentSessionId, {
      requestId,
      throughTurnRequestId,
    }),
    ref = reference(reserved),
    capture = {
      parentNativeThreadId: "0199a213-81c0-7800-8aa1-bbab2a035a70",
      childNativeThreadId: "0199a213-81c0-7800-8aa1-bbab2a035a71",
      throughNativeTurnId: throughTurnRequestId,
      protocolVersion: "0.163.0-alpha.10.2" as const,
    };
  await journal.markAttempted(ref);
  const held = await journal.hold(ref, "unknown-native-outcome");
  expect(held.state).toBe("held");

  const reopened = fixture(root, storage).journal;
  expect(reopened.read(projectId, requestId)).toEqual(held);
  expect((await reopened.markAttempted(ref)).mayDispatch).toBe(false);
  await expect(reopened.capture(ref, capture)).rejects.toThrow();
  expect(reopened.read(projectId, requestId)).toEqual(held);
});

test("captured local-link crash reuses the stable child app ID and exact link", async () => {
  const root = scratch.make("codex-fork-root-"),
    storage = new MemoryStorage(),
    journal = fixture(root, storage).journal,
    reserved = await journal.reserve(projectId, parentSessionId, {
      requestId,
      throughTurnRequestId,
    }),
    ref = reference(reserved),
    capture = {
      parentNativeThreadId: "0199a213-81c0-7800-8aa1-bbab2a035a70",
      childNativeThreadId: "0199a213-81c0-7800-8aa1-bbab2a035a71",
      throughNativeTurnId: throughTurnRequestId,
      protocolVersion: "0.163.0-alpha.10.2" as const,
    },
    syntheticLocalLinks = new Map<string, string>();
  await journal.markAttempted(ref);
  const captured = await journal.capture(ref, capture),
    link = {
      childAppSessionId: captured.childAppSessionId,
      childRequestId: "0199a213-81c0-7800-8aa1-bbab2a035a72",
      childRequestHash: "b".repeat(64),
      captureHash: codexChatForkCaptureHash(capture),
    };

  // Simulate a local registration write, then interruption before linked-event persistence.
  syntheticLocalLinks.set(link.childAppSessionId, JSON.stringify(link));
  const reopened = fixture(root, storage).journal,
    recovered = reopened.read(projectId, requestId);
  expect(recovered?.state).toBe("captured");
  expect(recovered?.childAppSessionId).toBe(reserved.childAppSessionId);
  expect(syntheticLocalLinks.size).toBe(1);

  const linked = await reopened.markLinked(ref, link);
  expect(linked.state).toBe("linked");
  expect(await fixture(root, storage).journal.markLinked(ref, link)).toEqual(
    linked,
  );
  expect(syntheticLocalLinks.size).toBe(1);
});

test("a conflicting child ID in a synthetic link claim preserves captured proof", async () => {
  const root = scratch.make("codex-fork-root-"),
    storage = new MemoryStorage(),
    journal = fixture(root, storage).journal,
    reserved = await journal.reserve(projectId, parentSessionId, {
      requestId,
      throughTurnRequestId,
    }),
    ref = reference(reserved),
    capture = {
      parentNativeThreadId: "0199a213-81c0-7800-8aa1-bbab2a035a70",
      childNativeThreadId: "0199a213-81c0-7800-8aa1-bbab2a035a71",
      throughNativeTurnId: throughTurnRequestId,
      protocolVersion: "0.163.0-alpha.10.2" as const,
    };
  await journal.markAttempted(ref);
  const captured = await journal.capture(ref, capture),
    wrongLink = {
      childAppSessionId: "session-0199a213-81c0-7800-8aa1-bbab2a035a74",
      childRequestId: "0199a213-81c0-7800-8aa1-bbab2a035a75",
      childRequestHash: "c".repeat(64),
      captureHash: codexChatForkCaptureHash(capture),
    };
  await expect(journal.markLinked(ref, wrongLink)).rejects.toThrow();
  expect(journal.read(projectId, requestId)).toEqual(captured);
});

test("duplicate generated child app ID refuses a second Fork original", async () => {
  const root = scratch.make("codex-fork-root-"),
    storage = new MemoryStorage(),
    first = fixture(root, storage).journal,
    reserved = await first.reserve(projectId, parentSessionId, {
      requestId,
      throughTurnRequestId,
    });
  await expect(
    first.reserve(projectId, parentSessionId, {
      requestId: otherRequestId,
      throughTurnRequestId,
    }),
  ).rejects.toThrow();
  expect(first.read(projectId, requestId)).toEqual(reserved);
  expect(first.read(projectId, otherRequestId)).toBeNull();
});
