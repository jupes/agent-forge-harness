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
  CODEX_CHAT_FORK_PROTOCOL_VERSION,
  canonicalCodexChatForkJournalEvent,
  codexChatForkCaptureHash,
  codexChatForkJournalEventBodySchema,
  codexChatForkJournalEventHash,
  codexChatForkJournalEventSchema,
  codexChatForkOriginalHash,
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
const testSourceSeal = {
  parentRequestHash: "a".repeat(64),
  parentTurnHash: "b".repeat(64),
  parentNativeThreadId: "0199a213-81c0-7800-8aa1-bbab2a035a70",
  throughNativeTurnId: "0199a213-81c0-7800-8aa1-bbab2a035a71",
  sourceSettingsHash: "c".repeat(64),
};

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
    sourceSeal,
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
    sourceSeal,
  };
}

function fixture(root: string, storage: MemoryStorage) {
  const home = join(root, "profile");
  mkdirSync(home, { recursive: true });
  const journal = createCodexChatForkJournal({
    root,
    home,
    storage,
    now: () => "2026-10-25T00:00:00.000Z",
    createChildAppSessionId: () =>
      "session-0199a213-81c0-7800-8aa1-bbab2a035a60",
  });
  return {
    root,
    home,
    journal: {
      ...journal,
      reserve: (
        project: string,
        parent: string,
        intent: Parameters<typeof journal.reserve>[2],
      ) => journal.reserve(project, parent, intent, testSourceSeal),
    },
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

test("an active parent address cannot be claimed by a second UUID across instances", async () => {
  const root = scratch.make("codex-fork-root-"),
    storage = new MemoryStorage(),
    first = fixture(root, storage).journal,
    second = fixture(root, storage).journal;
  const claims = await Promise.allSettled([
    first.reserve(projectId, parentSessionId, {
      requestId,
      throughTurnRequestId,
    }),
    second.reserve(projectId, parentSessionId, {
      requestId: otherRequestId,
      throughTurnRequestId,
    }),
  ]);

  expect(claims.filter((claim) => claim.status === "fulfilled")).toHaveLength(
    1,
  );
  expect(claims.filter((claim) => claim.status === "rejected")).toHaveLength(1);
  expect(
    fixture(root, storage).journal.read(projectId, requestId) !== null ||
      fixture(root, storage).journal.read(projectId, otherRequestId) !== null,
  ).toBe(true);
});

test("a validly rehashed event cannot change the reserved source seal", async () => {
  const root = scratch.make("codex-fork-root-"),
    storage = new MemoryStorage(),
    journal = fixture(root, storage).journal,
    reserved = await journal.reserve(projectId, parentSessionId, {
      requestId,
      throughTurnRequestId,
    });
  await journal.markAttempted(reference(reserved));
  const [name, text] = [...storage.events].at(-1) ?? [];
  if (!name || !text) throw Error("Missing attempted event.");
  let rawPrevious: unknown;
  try {
    rawPrevious = JSON.parse(text);
  } catch {
    throw Error("Attempted event was not valid JSON.");
  }
  const previous = codexChatForkJournalEventSchema.parse(rawPrevious),
    body = codexChatForkJournalEventBodySchema.parse({
      version: previous.version,
      sequence: previous.sequence,
      previousEventHash: previous.previousEventHash,
      previousOperationHash: previous.previousOperationHash,
      transition: previous.transition,
      record: {
        ...previous.record,
        sourceSeal: {
          ...previous.record.sourceSeal,
          parentTurnHash: "d".repeat(64),
        },
      },
    }),
    event = codexChatForkJournalEventSchema.parse({
      ...body,
      eventHash: codexChatForkJournalEventHash(body),
    });
  storage.events.delete(name);
  storage.events.set(
    `${String(event.sequence).padStart(8, "0")}-${event.eventHash}.json`,
    canonicalCodexChatForkJournalEvent(event),
  );
  expect(() => journal.read(projectId, requestId)).toThrow();
});

test("journal replay rejects a checksummed second UUID for an active parent", async () => {
  const root = scratch.make("codex-fork-root-"),
    storage = new MemoryStorage(),
    journal = fixture(root, storage).journal,
    first = await journal.reserve(projectId, parentSessionId, {
      requestId,
      throughTurnRequestId,
    }),
    firstText = [...storage.events.values()][0];
  if (!firstText) throw Error("Missing first reservation event.");
  const firstEvent = codexChatForkJournalEventSchema.parse(
      JSON.parse(firstText),
    ),
    secondId = otherRequestId,
    secondRecord: CodexChatForkOriginal = {
      ...first,
      requestId: secondId,
      requestHash: codexChatForkOriginalHash({
        kind: "codex-chat-fork",
        hashVersion: 1,
        projectId,
        workspaceKey: first.workspaceKey,
        parentSessionId,
        throughTurnRequestId,
        requestId: secondId,
        protocolVersion: CODEX_CHAT_FORK_PROTOCOL_VERSION,
      }),
      childAppSessionId: "session-0199a213-81c0-7800-8aa1-bbab2a035a61",
    },
    body = codexChatForkJournalEventBodySchema.parse({
      version: 1,
      sequence: 2,
      previousEventHash: firstEvent.eventHash,
      previousOperationHash: null,
      transition: "reserved",
      record: secondRecord,
    }),
    eventHash = codexChatForkJournalEventHash(body),
    secondText = canonicalCodexChatForkJournalEvent(
      codexChatForkJournalEventSchema.parse({ ...body, eventHash }),
    );
  storage.events.set(`00000002-${eventHash}.json`, secondText);

  expect(() => journal.read(projectId, requestId)).toThrow();
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
