import { expect, test } from "bun:test";
import type { CodexChatEvent, CodexChatOutcome } from "../../types/codex-chat";
import type { ConversationPage } from "../../types/conversation";
import {
  createDeadlineObserver,
  emitCodexDeadlineFailureAndRethrow,
  projectCodexDeadlineFacts,
  type SafeOutcome,
} from "./codex-chat-deadline-diagnostic.test-utils";

const outcome = (overrides: Partial<CodexChatOutcome> = {}): CodexChatOutcome => ({
  phase: "unknown", reason: "private diagnostic sentinel",
  threadId: "private-thread-id", turnId: "private-turn-id",
  observedModel: null, usage: null, exitCode: 0,
  stopped: false, timedOut: true, ...overrides,
});
const emptyPage = () => ({
  version: 1, projectId: "private-project", conversationId: "private-conversation",
  revision: 0, binding: null, turns: [], frames: [], more: false,
  nextCursor: 0, lastSequence: 0, request: null, controllable: false,
}) as unknown as ConversationPage;

function observationPage(options: {
  summaryPartials?: boolean[];
  outcomes?: Array<{ threadId: string | null; version: string }>;
} = {}): ConversationPage {
  const requestId = "private-last-request";
  const threadId = "private-thread";
  const version = "private-version";
  const partials = options.summaryPartials ?? [];
  const summaries = partials.map((partial, index) => ({
    seq: index + 1,
    turnId: requestId,
    at: "2026-01-01T00:00:00.000Z",
    event: {
      kind: "coding-chat", provider: "codex", version,
      event: {
        kind: "reasoning-summary", source: "item/started",
        threadId, turnId: "private-native-turn",
        itemId: "private-summary-" + index, partial,
        update: {
          kind: "snapshot", summary: [], truncated: false,
          closure: "open", turnStatus: null,
        },
      },
    },
  }));
  const outcomes = (options.outcomes ?? []).map((item, index) => ({
    seq: summaries.length + index + 1,
    turnId: requestId,
    at: "2026-01-01T00:00:00.000Z",
    event: {
      kind: "coding-chat", provider: "codex", version: item.version,
      event: {
        kind: "outcome",
        outcome: outcome({
          threadId: item.threadId, turnId: "private-native-turn",
        }),
      },
    },
  }));
  return {
    version: 1, projectId: "private-project",
    conversationId: "private-conversation", revision: 1,
    binding: { provider: "codex", sessionId: threadId, version },
    turns: [{
      requestId, hash: "private-hash", phase: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z", reason: null, owner: null,
    }],
    frames: [...summaries, ...outcomes],
    more: false, nextCursor: 0, lastSequence: summaries.length + outcomes.length,
    request: null, controllable: false,
  } as unknown as ConversationPage;
}

test("projects typed runtime outcomes into the original fixed RED DTO", async () => {
  const observer = createDeadlineObserver();
  const runtime = Promise.resolve(outcome());
  expect(observer.observeRuntime(() => runtime)).toBe(runtime);
  await runtime;
  await Promise.resolve();
  const facts = projectCodexDeadlineFacts({
    observer: observer.snapshot(), page: null, originalRequestId: "private-request",
  });
  expect(facts.runtime.outcome).toEqual({
    state: "observed", phase: "unknown", timedOut: true, stopped: false,
    exitCode: "zero", reasonPresent: true,
  });
  expect(facts.reopened.read).toBe("not-read");
  expect(JSON.stringify(facts)).not.toContain("private diagnostic sentinel");
  expect(JSON.stringify(facts)).not.toContain("private-thread-id");
});

test("preserves the original rejection object and records a fixed rejection class", async () => {
  const observer = createDeadlineObserver();
  const rejection = Error("private rejection sentinel");
  const original = Promise.reject(rejection);
  const returned = observer.observeRuntime(() => original);
  expect(returned).toBe(original);
  await expect(returned).rejects.toBe(rejection);
  await Promise.resolve();
  expect(observer.snapshot().runtime.failure).toBe("rejection");
});

test("preserves synchronous value and thrown object identity", () => {
  const observer = createDeadlineObserver();
  const value = { marker: "identity" };
  expect(observer.observeRuntime(() => value)).toBe(value);
  const thrown = Error("private synchronous failure");
  let caught: unknown;
  try {
    observer.observeRuntime(() => { throw thrown; });
  } catch (error) { caught = error; }
  expect(caught).toBe(thrown);
});

test("does not read or call arbitrary thenables or Promise impostors", () => {
  const observer = createDeadlineObserver();
  let getterReads = 0, thenCalls = 0;
  const thenable = Object.defineProperty({}, "then", {
    get() { getterReads += 1; throw Error("must remain untouched"); },
  });
  const inertThenable = { then() { thenCalls += 1; } };
  expect(observer.observeRuntime(() => thenable)).toBe(thenable);
  expect(observer.observeRuntime(() => inertThenable)).toBe(inertThenable);
  const impostor = Object.create(Promise.prototype) as object;
  expect(observer.observeRuntime(() => impostor)).toBe(impostor);
  expect(getterReads).toBe(0);
  expect(thenCalls).toBe(0);
  const overridden = Promise.resolve(outcome());
  Object.defineProperty(overridden, "then", { get() { getterReads += 1; throw Error("must remain untouched"); } });
  expect(observer.observeRuntime(() => overridden)).toBe(overridden);
  expect(getterReads).toBe(0);
  expect(observer.snapshot().runtime.promise).toBe("pending");
});

test("one-read projection ignores hostile getters and private extras", () => {
  const observer = createDeadlineObserver();
  let phaseReads = 0;
  const hostile = Object.defineProperties({}, {
    phase: { get() { phaseReads += 1; return phaseReads === 1 ? "unknown" : "private leak"; } },
    timedOut: { get() { return true; } },
    stopped: { value: false },
    exitCode: { value: 0 },
    toJSON: { value: () => ({ private: "toJSON sentinel" }) },
    threadId: { value: "private thread sentinel" },
  });
  const result = projectCodexDeadlineFacts({
    observer: {
      ...observer.snapshot(),
      runtime: {
        ...observer.snapshot().runtime,
        outcome: hostile as unknown as SafeOutcome,
      },
    },
    page: emptyPage(), originalRequestId: "private request",
  });
  expect(phaseReads).toBe(0);
  expect(result.runtime.outcome).toMatchObject({
    state: "invalid", phase: null, timedOut: null, reasonPresent: null,
  });
  expect(JSON.stringify(result)).not.toContain("private");
});

test("terminal persistence tap preserves callback identity and tracks bounded attempts", async () => {
  const observer = createDeadlineObserver();
  const event: CodexChatEvent = { kind: "outcome", outcome: outcome() };
  const original = Promise.resolve();
  let calls = 0;
  const persist = () => { calls += 1; return original; };
  expect(observer.tapPersist(event, persist)).toBe(original);
  expect(calls).toBe(1);
  expect(observer.snapshot().terminalPersist).toMatchObject({
    attempts: 1, capped: false, callback: "pending",
    outcome: { state: "observed", reasonPresent: true },
  });
  await original;
  await Promise.resolve();
  expect(observer.snapshot().terminalPersist.callback).toBe("fulfilled");
  observer.tapPersist(event, persist);
  observer.tapPersist(event, persist);
  expect(calls).toBe(3);
  expect(observer.snapshot().terminalPersist).toMatchObject({ attempts: 2, capped: true });
});

test("terminal persistence preserves the exact rejected Promise and rejection object", async () => {
  const observer = createDeadlineObserver();
  const event: CodexChatEvent = { kind: "outcome", outcome: outcome() };
  const rejection = Error("private terminal persist rejection");
  const original = Promise.reject(rejection);
  const returned = observer.tapPersist(event, () => original);
  expect(returned).toBe(original);
  await expect(returned).rejects.toBe(rejection);
  await Promise.resolve();
  expect(observer.snapshot().terminalPersist.callback).toBe("rejected");
});

test("throwing event metadata cannot suppress or duplicate original persistence", () => {
  const observer = createDeadlineObserver();
  let kindReads = 0, outcomeReads = 0, calls = 0;
  const unreadableKind = Object.defineProperty({}, "kind", {
    get() { kindReads += 1; throw Error("private kind getter"); },
  }) as unknown as CodexChatEvent;
  const first = Promise.resolve();
  expect(observer.tapPersist(unreadableKind, () => { calls += 1; return first; })).toBe(first);
  const unreadableOutcome = Object.defineProperties({}, {
    kind: { value: "outcome" },
    outcome: { get() { outcomeReads += 1; throw Error("private outcome getter"); } },
  }) as unknown as CodexChatEvent;
  const second = Promise.resolve();
  expect(observer.tapPersist(unreadableOutcome, () => { calls += 1; return second; })).toBe(second);
  expect(kindReads).toBe(0);
  expect(outcomeReads).toBe(0);
  expect(calls).toBe(2);
  expect(observer.snapshot().terminalPersist).toMatchObject({
    attempts: null, capped: null, ambiguous: true, callback: "ambiguous",
    outcome: { state: "invalid" },
  });
});

test("out-of-order duplicate persistence callbacks stay explicitly ambiguous", async () => {
  const observer = createDeadlineObserver();
  const event: CodexChatEvent = { kind: "outcome", outcome: outcome() };
  let resolveFirst!: () => void, resolveSecond!: () => void;
  const first = new Promise<void>((resolve) => { resolveFirst = resolve; });
  const second = new Promise<void>((resolve) => { resolveSecond = resolve; });
  expect(observer.tapPersist(event, () => first)).toBe(first);
  expect(observer.tapPersist(event, () => second)).toBe(second);
  resolveSecond();
  await second;
  resolveFirst();
  await first;
  await Promise.resolve();
  expect(observer.snapshot().terminalPersist).toMatchObject({
    attempts: 2, capped: false, ambiguous: true, callback: "ambiguous",
  });
  observer.tapPersist(event, () => Promise.resolve());
  expect(observer.snapshot().terminalPersist).toMatchObject({
    attempts: 2, capped: true, ambiguous: true, callback: "ambiguous",
  });
});

test("invalid reported outcomes and missing or corrupt counts remain explicit", () => {
  const missingObserver = createDeadlineObserver();
  missingObserver.observeRuntime(() => null);
  expect(missingObserver.snapshot().runtime.outcome.state).toBe("missing");
  missingObserver.observeRuntime(() => undefined);
  expect(missingObserver.snapshot().runtime.outcome.state).toBe("missing");
  for (const invalid of [7, [], { phase: 4 }]) {
    const observer = createDeadlineObserver();
    expect(observer.observeRuntime(() => invalid)).toBe(invalid);
    expect(observer.snapshot().runtime.outcome.state).toBe("invalid");
  }
  const unknownPhase = { phase: "private phase", timedOut: "yes" };
  const unknownPhaseObserver = createDeadlineObserver();
  expect(unknownPhaseObserver.observeRuntime(() => unknownPhase)).toBe(unknownPhase);
  const unknownPhaseOutcome = unknownPhaseObserver.snapshot().runtime.outcome;
  expect(unknownPhaseOutcome).toMatchObject({ state: "observed", phase: "other", timedOut: null });
  expect(JSON.stringify(unknownPhaseOutcome)).not.toContain("private phase");
  const malformed = {
    runtime: {
      call: "returned", promise: "fulfilled", failure: "none",
      outcome: { phase: "private phase", timedOut: true, stopped: "bad", exitCode: Infinity, reason: 8, privateId: "private-row-id" },
    },
    terminalPersist: {},
    reopened: { read: "read", nativeCandidates: "bad", nativeCandidatesCapped: "bad" },
  };
  const failure = Error("original malformed DTO"), rows: string[] = [];
  let caught: unknown;
  try { emitCodexDeadlineFailureAndRethrow(failure, malformed, (row) => rows.push(row)); }
  catch (error) { caught = error; }
  expect(caught).toBe(failure);
  const row = rows[0] ?? "";
  const dto = JSON.parse(row.slice("codex-partial-summary-deadline-diagnostic ".length));
  expect(dto.kind).toBe("codex-partial-summary-deadline-diagnostic");
  expect(dto.terminalPersist.attempts).toBeNull();
  expect(dto.terminalPersist.capped).toBeNull();
  expect(dto.terminalPersist.ambiguous).toBeNull();
  expect(dto.reopened.nativeCandidates).toBeNull();
  expect(row).not.toContain("private descriptor trap");
  expect(row).not.toContain("private toJSON payload");
  expect(row).not.toContain("HHHHHHHHHHHH");
  expect(dto.reopened.nativeCandidatesCapped).toBeNull();
  expect(dto.runtime.outcome).toMatchObject({
    state: "observed", phase: "other", stopped: null,
    exitCode: "invalid", reasonPresent: null,
  });
  expect(row).not.toContain("private-row-id");
});

test("malformed hostile facts use one bounded unknown row and preserve the original error", () => {
  const failure = Error("original projection failure");
  const hostile = new Proxy({
    privateBody: "H".repeat(100000),
    toJSON: () => ({ private: "private toJSON payload" }),
  }, {
    getOwnPropertyDescriptor() { throw Error("private descriptor trap"); },
  });
  let calls = 0, caught: unknown, row = "";
  try {
    emitCodexDeadlineFailureAndRethrow(failure, hostile, (value) => {
      calls += 1;
      row = value;
    });
  } catch (error) { caught = error; }
  expect(calls).toBe(1);
  expect(caught).toBe(failure);
  expect(new TextEncoder().encode(row).byteLength).toBeLessThanOrEqual(4096);
  const dto = JSON.parse(row.slice("codex-partial-summary-deadline-diagnostic ".length));
  expect(dto.runtime.call).toBe("not-observed");
  expect(dto.terminalPersist.attempts).toBeNull();
  expect(dto.reopened.nativeCandidates).toBeNull();
});

test("nonterminal persistence passes through unchanged and sync failure identity survives", () => {
  const observer = createDeadlineObserver();
  const event: CodexChatEvent = { kind: "text", itemId: "private-item", text: "private body" };
  const original = Promise.resolve();
  let calls = 0;
  const result = observer.tapPersist(event, () => { calls += 1; return original; });
  expect(result).toBe(original);
  expect(calls).toBe(1);
  const outcomeEvent: CodexChatEvent = { kind: "outcome", outcome: outcome() };
  const failure = Error("original persist failure");
  let caught: unknown;
  try {
    observer.tapPersist(outcomeEvent, () => { throw failure; });
  } catch (error) { caught = error; }
  expect(caught).toBe(failure);
  expect(observer.snapshot().terminalPersist.callback).toBe("sync-threw");
});

test("returned snapshots and hostile outer getters cannot mutate or replace observer state", () => {
  const observer = createDeadlineObserver();
  const first = observer.snapshot();
  first.runtime.call = "sync-threw";
  expect(observer.snapshot().runtime.call).toBe("not-called");
  let reads = 0;
  const hostile = Object.defineProperty({}, "observer", {
    get() { reads += 1; throw Error("private projector failure"); },
  });
  const facts = projectCodexDeadlineFacts(
    hostile as unknown as Parameters<typeof projectCodexDeadlineFacts>[0],
  );
  expect(reads).toBe(1);
  expect(facts.runtime.call).toBe("not-observed");
  expect(JSON.stringify(facts)).not.toContain("private projector failure");
});

test("reopened page absence stays unknown and the projector returns a fresh closed object", () => {
  const observer = createDeadlineObserver();
  const facts = projectCodexDeadlineFacts({
    observer: observer.snapshot(), page: emptyPage(), originalRequestId: "private-id",
  });
  expect(facts.reopened).toEqual({
    read: "read", selectedTurnMatchesOriginal: null, genericPhase: null, genericCode: null,
    genericReasonPresent: null, nativeCandidates: 0,
    nativeCandidatesCapped: false,
    nativeCandidatesAmbiguous: false,
    selectedOutcome: {
      state: "missing", phase: null, timedOut: null, stopped: null,
      exitCode: null, reasonPresent: null,
    },
    bindingProvider: "missing", bindingThread: "missing", versionMatch: null,
    exactSix: false, allPartial: null, lifecycle: "recomputed:empty",
  });
  expect(facts).not.toBe(observer.snapshot());
});

test("caps duplicate native candidates as ambiguity while using the actual selectors", () => {
  const observer = createDeadlineObserver();
  const requestId = "private-request-id";
  const nativeOutcome = outcome({
    threadId: "private-thread-id", turnId: "private-native-turn",
  });
  const frames = [1, 2, 3].map((seq) => ({
    seq, turnId: requestId, at: "2026-01-01T00:00:00.000Z",
    event: {
      kind: "coding-chat", provider: "codex", version: "private-version",
      event: { kind: "outcome", outcome: nativeOutcome },
    },
  }));
  const page = {
    ...emptyPage(),
    binding: { provider: "codex", sessionId: "private-thread-id", version: "private-version" },
    turns: [{
      requestId, hash: "private-hash", phase: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z", reason: null, owner: null,
    }],
    frames,
  } as unknown as ConversationPage;
  const facts = projectCodexDeadlineFacts({
    observer: observer.snapshot(), page, originalRequestId: "earlier-request",
  });
  expect(facts.reopened.selectedTurnMatchesOriginal).toBe(false);
  expect(facts.reopened.nativeCandidates).toBe(2);
  expect(facts.reopened.nativeCandidatesCapped).toBe(true);
  expect(facts.reopened.nativeCandidatesAmbiguous).toBe(true);
  expect(facts.reopened.selectedOutcome.phase).toBe("unknown");
  expect(facts.reopened.versionMatch).toBe(true);
  expect(facts.reopened.genericPhase).toBe("completed");
  expect(facts.reopened.exactSix).toBe(false);
  expect(facts.reopened.allPartial).toBeNull();
  expect(JSON.stringify(facts)).not.toContain("private-thread-id");
  expect(JSON.stringify(facts)).not.toContain("private-version");
});

test("counts the six raw reasoning-summary frames and checks each partial bit", () => {
  const observer = createDeadlineObserver();
  const allPartial = projectCodexDeadlineFacts({
    observer: observer.snapshot(),
    page: observationPage({ summaryPartials: [true, true, true, true, true, true] }),
    originalRequestId: "private-last-request",
  });
  expect(allPartial.reopened.exactSix).toBe(true);
  expect(allPartial.reopened.allPartial).toBe(true);
  const oneComplete = projectCodexDeadlineFacts({
    observer: observer.snapshot(),
    page: observationPage({ summaryPartials: [true, true, false, true, true, true] }),
    originalRequestId: "private-last-request",
  });
  expect(oneComplete.reopened.exactSix).toBe(true);
  expect(oneComplete.reopened.allPartial).toBe(false);
});

test("keeps raw candidate binding checks separate from the actual selector", () => {
  const observer = createDeadlineObserver();
  const foreignThread = projectCodexDeadlineFacts({
    observer: observer.snapshot(),
    page: observationPage({ outcomes: [{ threadId: "private-foreign-thread", version: "private-version" }] }),
    originalRequestId: "private-last-request",
  });
  expect(foreignThread.reopened.bindingThread).toBe("different");
  expect(foreignThread.reopened.selectedOutcome.state).toBe("missing");
  expect(foreignThread.reopened.versionMatch).toBe(true);
  const versionMismatch = projectCodexDeadlineFacts({
    observer: observer.snapshot(),
    page: observationPage({ outcomes: [{ threadId: "private-thread", version: "private-old-version" }] }),
    originalRequestId: "private-last-request",
  });
  expect(versionMismatch.reopened.bindingThread).toBe("same");
  expect(versionMismatch.reopened.versionMatch).toBe(false);
  expect(versionMismatch.reopened.selectedOutcome.state).toBe("observed");
});

test("emits one fixed bounded row, strips extras and preserves the assertion object", () => {
  const observer = createDeadlineObserver();
  const facts = projectCodexDeadlineFacts({
    observer: observer.snapshot(), page: null, originalRequestId: "private-id",
  }) as Record<string, unknown>;
  Object.defineProperty(facts, "toJSON", { value: () => ({ secret: "toJSON leak" }) });
  Object.defineProperty(facts, "privateExtra", { value: "private extra sentinel" });
  Object.defineProperty(facts, "hugePrivateExtra", { value: "S".repeat(10000) });
  const failure = Error("original assertion sentinel"), rows: string[] = [];
  let caught: unknown;
  try {
    emitCodexDeadlineFailureAndRethrow(failure, facts, (row) => rows.push(row));
  } catch (error) { caught = error; }
  expect(caught).toBe(failure);
  expect(rows).toHaveLength(1);
  const row = rows[0] ?? "";
  expect(new TextEncoder().encode(row).byteLength).toBeLessThanOrEqual(4096);
  expect(row).toContain("codex-partial-summary-deadline-diagnostic");
  const dto = JSON.parse(row.slice("codex-partial-summary-deadline-diagnostic ".length));
  expect(Object.keys(dto).sort()).toEqual(["kind", "reopened", "runtime", "terminalPersist"]);
  expect(row).not.toContain("toJSON leak");
  expect(row).not.toContain("private extra sentinel");
  expect(row).not.toContain("SSSSSSSSSSSS");
  expect(row).not.toContain("private-id");
  expect(row).not.toContain("original assertion sentinel");
});

test("a successful observed call leaves a failure-only sink untouched", async () => {
  const observer = createDeadlineObserver();
  const writes: string[] = [];
  const original = Promise.resolve(outcome());
  const run = () => {
    try { return observer.observeRuntime(() => original); }
    catch (error) {
      emitCodexDeadlineFailureAndRethrow(
        error, observer.snapshot(), (row) => writes.push(row),
      );
    }
  };
  const returned = run();
  expect(returned).toBe(original);
  await original;
  await Promise.resolve();
  expect(observer.snapshot().runtime.promise).toBe("fulfilled");
  expect(writes).toEqual([]);
});

test("sink failure is one-shot and rethrows the identical original failure", () => {
  const observer = createDeadlineObserver();
  const facts = observer.snapshot(), failure = Error("same failure");
  let attempts = 0, caught: unknown;
  try {
    emitCodexDeadlineFailureAndRethrow(failure, facts, () => {
      attempts += 1;
      throw Error("private sink failure");
    });
  } catch (error) { caught = error; }
  expect(attempts).toBe(1);
  expect(caught).toBe(failure);
});
