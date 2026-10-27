/** One-shot Codex Fork originals over an immutable event-storage boundary. */
import { randomUUID } from "node:crypto";
import type {
  CodexChatForkCapture,
  CodexChatForkHeldReason,
  CodexChatForkIntent,
  CodexChatForkLink,
  CodexChatForkOriginal,
  CodexChatForkOriginalRef,
  CodexChatForkSourceSeal,
} from "../../types/codex-chat-fork";
import { resolveCheckout } from "../ledger/workspace";
import { workspaceKey } from "../projects/scope";
import {
  type CodexChatForkJournalStorageOptions,
  createCodexChatForkJournalStorage,
} from "./codex-chat-fork-journal-storage";
import {
  CODEX_CHAT_FORK_LIMITS,
  CODEX_CHAT_FORK_PROTOCOL_VERSION,
  CODEX_CHAT_FORK_ZERO_HASH,
  canonicalCodexChatForkCapture,
  canonicalCodexChatForkJournalEvent,
  canonicalCodexChatForkLink,
  canonicalCodexChatForkOriginalRecord,
  codexChatForkCaptureHash,
  codexChatForkCaptureSchema,
  codexChatForkHeldReasonSchema,
  codexChatForkIntentSchema,
  codexChatForkJournalEventBodySchema,
  codexChatForkJournalEventHash,
  codexChatForkJournalEventSchema,
  codexChatForkLinkSchema,
  codexChatForkOriginalHash,
  codexChatForkOriginalRefSchema,
  codexChatForkOriginalSchema,
  codexChatForkSourceSealSchema,
} from "./codex-chat-fork-protocol";
import {
  ownedSessionIdSchema,
  sessionProjectIdSchema,
  sessionRequestIdSchema,
} from "./protocol";

export interface CodexChatForkEventEntry {
  name: string;
  bytes: number;
  plain: boolean;
}

/** Immutable records must be published once, under the one profile-wide lock. */
export interface CodexChatForkJournalStorage {
  listEvents(): Iterable<CodexChatForkEventEntry>;
  read(entry: CodexChatForkEventEntry, maxBytes: number): string;
  writeOnce(name: string, text: string): void;
  exclusive<T>(work: () => Promise<T>): Promise<T>;
}

export interface CodexChatForkJournalOptions {
  root: string;
  home: string;
  storage?: CodexChatForkJournalStorage;
  storageOptions?: CodexChatForkJournalStorageOptions;
  now?: () => string;
  createChildAppSessionId?: () => string;
}

export class CodexChatForkJournalError extends Error {
  constructor(
    readonly reason: "conflict" | "held" | "missing",
    message: string,
  ) {
    super(message);
  }
}

const conflict = (): never => {
  throw new CodexChatForkJournalError(
    "conflict",
    "This Codex Fork UUID belongs to another immutable original.",
  );
};
const held = (): never => {
  throw new CodexChatForkJournalError(
    "held",
    "The private Codex Fork journal is held or unavailable; no Fork was repeated.",
  );
};
const missing = (): never => {
  throw new CodexChatForkJournalError(
    "missing",
    "The exact Codex Fork original is not present in this trusted workspace.",
  );
};

interface LoadedEvent {
  name: string;
  text: string;
  eventHash: string;
  event: ReturnType<typeof codexChatForkJournalEventSchema.parse>;
}
interface LoadedChain {
  events: LoadedEvent[];
  originals: Map<string, CodexChatForkOriginal>;
  lastOperationHashes: Map<string, string>;
  totalBytes: number;
}

const immutableIdentity = (record: CodexChatForkOriginal) => ({
  projectId: record.projectId,
  workspaceKey: record.workspaceKey,
  requestId: record.requestId,
  requestHash: record.requestHash,
  parentSessionId: record.parentSessionId,
  throughTurnRequestId: record.throughTurnRequestId,
  protocolVersion: record.protocolVersion,
  childAppSessionId: record.childAppSessionId,
  ...(record.sourceSeal === undefined ? {} : { sourceSeal: record.sourceSeal }),
  createdAt: record.createdAt,
});
const matchesRef = (
  record: CodexChatForkOriginal,
  ref: CodexChatForkOriginalRef,
) =>
  record.projectId === ref.projectId &&
  record.workspaceKey === ref.workspaceKey &&
  record.requestId === ref.requestId &&
  record.requestHash === ref.requestHash &&
  record.parentSessionId === ref.parentSessionId &&
  record.throughTurnRequestId === ref.throughTurnRequestId &&
  record.protocolVersion === ref.protocolVersion &&
  record.childAppSessionId === ref.childAppSessionId &&
  same(record.sourceSeal ?? null, ref.sourceSeal ?? null);
const same = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);
const sameRecord = (left: unknown, right: unknown) => {
  try {
    return (
      canonicalCodexChatForkOriginalRecord(left) ===
      canonicalCodexChatForkOriginalRecord(right)
    );
  } catch {
    return false;
  }
};
const sameCapture = (left: unknown, right: unknown) => {
  try {
    return (
      canonicalCodexChatForkCapture(left) ===
      canonicalCodexChatForkCapture(right)
    );
  } catch {
    return false;
  }
};
const sameLink = (left: unknown, right: unknown) => {
  try {
    return (
      canonicalCodexChatForkLink(left) === canonicalCodexChatForkLink(right)
    );
  } catch {
    return false;
  }
};

function eventName(sequence: number, hash: string): string {
  return `${String(sequence).padStart(8, "0")}-${hash}.json`;
}

function parsedCanonicalEvent(text: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return held();
  }
  const parsed = codexChatForkJournalEventSchema.safeParse(raw);
  if (!parsed.success) return held();
  let canonical: string;
  try {
    canonical = canonicalCodexChatForkJournalEvent(parsed.data);
  } catch {
    return held();
  }
  // This also rejects duplicate keys, alternate key order, whitespace and noncanonical numbers.
  if (canonical !== text) return held();
  return parsed.data;
}

function originalHash(record: CodexChatForkOriginal): string {
  return codexChatForkOriginalHash({
    kind: "codex-chat-fork",
    hashVersion: 1,
    projectId: record.projectId,
    workspaceKey: record.workspaceKey,
    parentSessionId: record.parentSessionId,
    throughTurnRequestId: record.throughTurnRequestId,
    requestId: record.requestId,
    protocolVersion: record.protocolVersion,
  });
}

function validRecord(record: CodexChatForkOriginal): boolean {
  if (record.requestHash !== originalHash(record)) return false;
  if (record.childAppSessionId === record.parentSessionId) return false;
  if (record.state === "captured" || record.state === "linked") {
    if (
      record.capture.parentNativeThreadId ===
        record.capture.childNativeThreadId ||
      record.capture.protocolVersion !== CODEX_CHAT_FORK_PROTOCOL_VERSION
    )
      return false;
  }
  if (
    record.state === "linked" &&
    (record.link.childAppSessionId !== record.childAppSessionId ||
      record.link.captureHash !== codexChatForkCaptureHash(record.capture))
  )
    return false;
  return true;
}

function latestRecordIsLegal(
  previous: CodexChatForkOriginal | undefined,
  current: CodexChatForkOriginal,
  previousOperationHash: string | null,
): boolean {
  if (previous === undefined)
    return current.state === "reserved" && previousOperationHash === null;
  if (!same(immutableIdentity(previous), immutableIdentity(current)))
    return false;
  if (previous.state === "reserved")
    return current.state === "attempted" && previousOperationHash !== null;
  if (previous.state === "attempted")
    return (
      (current.state === "captured" || current.state === "held") &&
      previousOperationHash !== null
    );
  if (previous.state === "captured")
    return (
      current.state === "linked" &&
      sameCapture(previous.capture, current.capture) &&
      previousOperationHash !== null
    );
  return false;
}

function loadChain(storage: CodexChatForkJournalStorage): LoadedChain {
  let entries: CodexChatForkEventEntry[];
  try {
    entries = [];
    for (const entry of storage.listEvents()) {
      if (entries.length >= CODEX_CHAT_FORK_LIMITS.events) return held();
      entries.push(entry);
    }
  } catch {
    return held();
  }
  if (entries.length > CODEX_CHAT_FORK_LIMITS.events) return held();
  let listedBytes = 0;
  for (const entry of entries) {
    if (
      !entry.plain ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 1 ||
      entry.bytes > CODEX_CHAT_FORK_LIMITS.eventBytes
    )
      return held();
    listedBytes += entry.bytes;
    if (listedBytes > CODEX_CHAT_FORK_LIMITS.journalBytes) return held();
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const chain: LoadedChain = {
    events: [],
    originals: new Map(),
    lastOperationHashes: new Map(),
    totalBytes: 0,
  };
  let lastEventHash = CODEX_CHAT_FORK_ZERO_HASH;
  for (const [index, entry] of entries.entries()) {
    let text: string;
    try {
      text = storage.read(entry, CODEX_CHAT_FORK_LIMITS.eventBytes);
    } catch {
      return held();
    }
    const size = new TextEncoder().encode(text).byteLength;
    if (size !== entry.bytes || size > CODEX_CHAT_FORK_LIMITS.eventBytes)
      return held();
    const event = parsedCanonicalEvent(text);
    const sequence = index + 1;
    if (
      event.sequence !== sequence ||
      event.previousEventHash !== lastEventHash ||
      entry.name !== eventName(sequence, event.eventHash) ||
      !validRecord(event.record)
    )
      return held();
    const prior = chain.originals.get(event.record.requestId),
      priorOperationHash =
        chain.lastOperationHashes.get(event.record.requestId) ?? null;
    const activeAddress = [...chain.originals.values()].some(
      (record) =>
        record.projectId === event.record.projectId &&
        record.workspaceKey === event.record.workspaceKey &&
        record.parentSessionId === event.record.parentSessionId &&
        record.state !== "linked",
    );
    if (
      !latestRecordIsLegal(prior, event.record, event.previousOperationHash) ||
      event.previousOperationHash !== priorOperationHash ||
      (prior === undefined && activeAddress)
    )
      return held();
    if (
      prior === undefined &&
      chain.originals.size >= CODEX_CHAT_FORK_LIMITS.originals
    )
      return held();
    for (const [requestId, existing] of chain.originals) {
      if (
        requestId !== event.record.requestId &&
        existing.childAppSessionId === event.record.childAppSessionId
      )
        return held();
    }
    chain.events.push({
      name: entry.name,
      text,
      eventHash: event.eventHash,
      event,
    });
    chain.originals.set(event.record.requestId, event.record);
    chain.lastOperationHashes.set(event.record.requestId, event.eventHash);
    chain.totalBytes += size;
    if (chain.totalBytes > CODEX_CHAT_FORK_LIMITS.journalBytes) return held();
    lastEventHash = event.eventHash;
  }
  return chain;
}

function checkedRef(
  raw: CodexChatForkOriginalRef,
  workspace: string,
): CodexChatForkOriginalRef {
  const parsed = codexChatForkOriginalRefSchema.safeParse(raw);
  if (!parsed.success || parsed.data.workspaceKey !== workspace) return held();
  return parsed.data;
}

export function createCodexChatForkJournal(
  options: CodexChatForkJournalOptions,
) {
  const workspace = workspaceKey(resolveCheckout(options.root).workspace),
    now = options.now ?? (() => new Date().toISOString()),
    childId =
      options.createChildAppSessionId ?? (() => `session-${randomUUID()}`),
    storage =
      options.storage ??
      createCodexChatForkJournalStorage(options.home, options.storageOptions);

  const runExclusive = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await storage.exclusive(work);
    } catch (error) {
      if (error instanceof CodexChatForkJournalError) throw error;
      return held();
    }
  };
  const assertExpected = (
    record: CodexChatForkOriginal | undefined,
    raw: CodexChatForkOriginalRef,
  ): CodexChatForkOriginal => {
    if (!record) return missing();
    const expected = checkedRef(raw, workspace);
    if (!matchesRef(record, expected)) return conflict();
    return record;
  };

  const append = (
    chain: LoadedChain,
    previous: CodexChatForkOriginal | undefined,
    record: CodexChatForkOriginal,
  ): CodexChatForkOriginal => {
    if (!validRecord(record)) return held();
    const sequence = chain.events.length + 1;
    if (sequence > CODEX_CHAT_FORK_LIMITS.events) return held();
    const body = codexChatForkJournalEventBodySchema.parse({
      version: 1,
      sequence,
      previousEventHash:
        chain.events.at(-1)?.eventHash ?? CODEX_CHAT_FORK_ZERO_HASH,
      previousOperationHash: previous
        ? (chain.lastOperationHashes.get(previous.requestId) ?? null)
        : null,
      transition: record.state,
      record,
    });
    const event = codexChatForkJournalEventSchema.parse({
      ...body,
      eventHash: codexChatForkJournalEventHash(body),
    });
    const text = canonicalCodexChatForkJournalEvent(event),
      bytes = new TextEncoder().encode(text).byteLength;
    if (
      bytes > CODEX_CHAT_FORK_LIMITS.eventBytes ||
      chain.totalBytes + bytes > CODEX_CHAT_FORK_LIMITS.journalBytes
    )
      return held();
    const name = eventName(sequence, event.eventHash);
    try {
      storage.writeOnce(name, text);
    } catch {
      return held();
    }
    const confirmed = loadChain(storage),
      saved = confirmed.originals.get(record.requestId);
    if (
      !saved ||
      !sameRecord(saved, record) ||
      confirmed.events.at(-1)?.eventHash !== event.eventHash
    )
      return held();
    return saved;
  };

  return {
    async reserve(
      projectId: string,
      parentSessionId: string,
      raw: CodexChatForkIntent,
      rawSourceSeal: CodexChatForkSourceSeal,
    ): Promise<CodexChatForkOriginal> {
      const intent = codexChatForkIntentSchema.safeParse(raw);
      const sourceSeal = codexChatForkSourceSealSchema.safeParse(rawSourceSeal);
      if (
        !intent.success ||
        !sourceSeal.success ||
        !sessionProjectIdSchema.safeParse(projectId).success ||
        !ownedSessionIdSchema.safeParse(parentSessionId).success
      )
        return conflict();
      return runExclusive(async () => {
        const chain = loadChain(storage),
          existing = chain.originals.get(intent.data.requestId);
        const requestHash = codexChatForkOriginalHash({
          kind: "codex-chat-fork",
          hashVersion: 1,
          projectId,
          workspaceKey: workspace,
          parentSessionId,
          throughTurnRequestId: intent.data.throughTurnRequestId,
          requestId: intent.data.requestId,
          protocolVersion: CODEX_CHAT_FORK_PROTOCOL_VERSION,
        });
        if (existing) {
          if (
            existing.projectId !== projectId ||
            existing.workspaceKey !== workspace ||
            existing.parentSessionId !== parentSessionId ||
            existing.throughTurnRequestId !==
              intent.data.throughTurnRequestId ||
            existing.requestHash !== requestHash ||
            !same(existing.sourceSeal ?? null, sourceSeal.data)
          )
            return conflict();
          return existing;
        }
        if (
          [...chain.originals.values()].some(
            (record) =>
              record.projectId === projectId &&
              record.workspaceKey === workspace &&
              record.parentSessionId === parentSessionId &&
              record.state !== "linked",
          )
        )
          return conflict();
        if (chain.originals.size >= CODEX_CHAT_FORK_LIMITS.originals)
          return held();
        const childAppSessionId = childId();
        if (
          !ownedSessionIdSchema.safeParse(childAppSessionId).success ||
          childAppSessionId === parentSessionId ||
          [...chain.originals.values()].some(
            (record) => record.childAppSessionId === childAppSessionId,
          )
        )
          return held();
        const at = now();
        if (!Number.isFinite(Date.parse(at))) return held();
        const record: CodexChatForkOriginal = {
          projectId,
          workspaceKey: workspace,
          requestId: intent.data.requestId,
          requestHash,
          parentSessionId,
          throughTurnRequestId: intent.data.throughTurnRequestId,
          protocolVersion: CODEX_CHAT_FORK_PROTOCOL_VERSION,
          childAppSessionId,
          sourceSeal: sourceSeal.data,
          state: "reserved",
          createdAt: at,
          updatedAt: at,
        };
        return append(chain, undefined, record);
      });
    },
    read(projectId: string, requestId: string): CodexChatForkOriginal | null {
      if (
        !sessionProjectIdSchema.safeParse(projectId).success ||
        !sessionRequestIdSchema.safeParse(requestId).success
      )
        return null;
      const record = loadChain(storage).originals.get(requestId);
      return record &&
        record.projectId === projectId &&
        record.workspaceKey === workspace
        ? record
        : null;
    },
    /** Reads the entire authenticated chain before returning a complete scoped list. */
    list(projectId: string): CodexChatForkOriginal[] {
      if (!sessionProjectIdSchema.safeParse(projectId).success)
        return conflict();
      const chain = loadChain(storage);
      return [...chain.originals.values()]
        .filter(
          (record) =>
            record.projectId === projectId && record.workspaceKey === workspace,
        )
        .sort((left, right) => left.requestId.localeCompare(right.requestId));
    },
    async markAttempted(raw: CodexChatForkOriginalRef) {
      const expected = checkedRef(raw, workspace);
      return runExclusive(async () => {
        const chain = loadChain(storage),
          current = assertExpected(
            chain.originals.get(expected.requestId),
            expected,
          );
        if (!current.sourceSeal) return { record: current, mayDispatch: false };
        if (current.state !== "reserved")
          return { record: current, mayDispatch: false };
        const at = now(),
          record = codexChatForkOriginalSchema.parse({
            ...current,
            state: "attempted",
            updatedAt: at,
          });
        return { record: append(chain, current, record), mayDispatch: true };
      });
    },
    async capture(rawRef: CodexChatForkOriginalRef, rawCapture: unknown) {
      const expected = checkedRef(rawRef, workspace);
      return runExclusive(async () => {
        const chain = loadChain(storage),
          current = assertExpected(
            chain.originals.get(expected.requestId),
            expected,
          ),
          checkedCapture = codexChatForkCaptureSchema.safeParse(rawCapture);
        if (!current.sourceSeal) return held();
        if (!checkedCapture.success) {
          if (current.state === "held") return current;
          if (current.state !== "attempted") return conflict();
          return append(
            chain,
            current,
            codexChatForkOriginalSchema.parse({
              ...current,
              state: "held",
              heldReason: "invalid-native-outcome",
              updatedAt: now(),
            }),
          );
        }
        if (
          checkedCapture.data.parentNativeThreadId ===
            checkedCapture.data.childNativeThreadId ||
          checkedCapture.data.protocolVersion !==
            CODEX_CHAT_FORK_PROTOCOL_VERSION
        ) {
          if (current.state !== "attempted") return conflict();
          return append(
            chain,
            current,
            codexChatForkOriginalSchema.parse({
              ...current,
              state: "held",
              heldReason: "invalid-native-outcome",
              updatedAt: now(),
            }),
          );
        }
        if (current.state === "captured" || current.state === "linked") {
          if (sameCapture(current.capture, checkedCapture.data)) return current;
          return conflict();
        }
        if (current.state !== "attempted") return conflict();
        return append(
          chain,
          current,
          codexChatForkOriginalSchema.parse({
            ...current,
            state: "captured",
            capture: checkedCapture.data,
            updatedAt: now(),
          }),
        );
      });
    },
    async markLinked(
      rawRef: CodexChatForkOriginalRef,
      rawLink: CodexChatForkLink,
    ) {
      // This validates durable shape/identity only; a future service must derive the claim from an exact registry proof.
      const expected = checkedRef(rawRef, workspace),
        checkedLink = codexChatForkLinkSchema.safeParse(rawLink);
      if (!checkedLink.success) return conflict();
      return runExclusive(async () => {
        const chain = loadChain(storage),
          current = assertExpected(
            chain.originals.get(expected.requestId),
            expected,
          );
        if (!current.sourceSeal) return held();
        if (current.state === "linked") {
          if (sameLink(current.link, checkedLink.data)) return current;
          return conflict();
        }
        if (
          current.state !== "captured" ||
          checkedLink.data.childAppSessionId !== current.childAppSessionId ||
          checkedLink.data.captureHash !==
            codexChatForkCaptureHash(current.capture)
        )
          return conflict();
        const at = now();
        return append(
          chain,
          current,
          codexChatForkOriginalSchema.parse({
            ...current,
            state: "linked",
            link: checkedLink.data,
            updatedAt: at,
          }),
        );
      });
    },
    async hold(
      rawRef: CodexChatForkOriginalRef,
      rawReason: CodexChatForkHeldReason,
    ) {
      const expected = checkedRef(rawRef, workspace),
        reason = codexChatForkHeldReasonSchema.safeParse(rawReason);
      if (!reason.success) return conflict();
      return runExclusive(async () => {
        const chain = loadChain(storage),
          current = assertExpected(
            chain.originals.get(expected.requestId),
            expected,
          );
        if (!current.sourceSeal) return held();
        if (current.state === "held") {
          if (current.heldReason === reason.data) return current;
          return conflict();
        }
        if (current.state !== "attempted") return conflict();
        return append(
          chain,
          current,
          codexChatForkOriginalSchema.parse({
            ...current,
            state: "held",
            heldReason: reason.data,
            updatedAt: now(),
          }),
        );
      });
    },
  };
}
