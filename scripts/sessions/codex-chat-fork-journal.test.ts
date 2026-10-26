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
