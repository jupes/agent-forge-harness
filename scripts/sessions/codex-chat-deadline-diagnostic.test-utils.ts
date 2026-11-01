import type { CodexChatEvent } from "../../types/codex-chat";
import type { ConversationPage } from "../../types/conversation";
import {
  ownedCodexChatOutcome,
  ownedSessionLifecycle,
  ownedSessionTurn,
} from "../../apps/desktop/src/session-activity";

export type SafeOutcome = {
  state: "observed" | "missing" | "invalid" | "not-observed";
  phase: "completed" | "failed" | "unknown" | "other" | null;
  timedOut: boolean | null;
  stopped: boolean | null;
  exitCode: "null" | "zero" | "nonzero" | "invalid" | null;
  reasonPresent: boolean | null;
};
export type CallState = "not-called" | "returned" | "sync-threw" | "not-observed";
export type PromiseState = "not-promise" | "pending" | "fulfilled" | "rejected" | "not-observed";
export type RuntimeFacts = {
  call: CallState;
  promise: PromiseState;
  failure: "none" | "sync-throw" | "rejection" | "unknown";
  outcome: SafeOutcome;
};
export type PersistFacts = {
  attempts: 0 | 1 | 2 | null;
  capped: boolean | null;
  ambiguous: boolean | null;
  callback: "not-attempted" | "returned" | "sync-threw" | "ambiguous" | PromiseState;
  outcome: SafeOutcome;
};
export type ReopenedFacts = {
  read: "not-read" | "read" | "failed" | "not-observed";
  selectedTurnMatchesOriginal: boolean | null;
  genericPhase: "accepted" | "running" | "cancelling" | "completed" | "cancelled" | "failed" | "unknown" | null;
  genericCode: string | null;
  genericReasonPresent: boolean | null;
  nativeCandidates: 0 | 1 | 2 | null;
  nativeCandidatesCapped: boolean | null;
  nativeCandidatesAmbiguous: boolean | null;
  selectedOutcome: SafeOutcome;
  bindingProvider: "codex" | "other" | "missing" | "unknown";
  bindingThread: "same" | "different" | "missing" | "unknown";
  versionMatch: boolean | null;
  exactSix: boolean | null;
  allPartial: boolean | null;
  lifecycle: string;
};
export type CodexDeadlineDiagnosticFacts = {
  runtime: RuntimeFacts;
  terminalPersist: PersistFacts;
  reopened: ReopenedFacts;
};

const nativeThen = Promise.prototype.then;
const nativePromisePrototype = Promise.prototype;
const nativePromiseConstructor = Promise;
const apply = Reflect.apply;
const phases = ["completed", "failed", "unknown"] as const;
const conversationPhases = ["accepted", "running", "cancelling", "completed", "cancelled", "failed", "unknown"] as const;
const genericCodes = [
  "completed", "stopped", "timed-out", "provider-error", "auth-error",
  "rate-limited", "cli-exit", "protocol-error", "storage-error",
] as const;
const lifecycleStates = [
  "loading", "empty", "starting", "running", "needs-permission", "idle",
  "ended", "error", "stopped", "timed-out", "stale", "unknown",
] as const;

type DataRead = { present: boolean; value: unknown };
function readData(value: unknown, key: string): DataRead {
  if (typeof value !== "object" || value === null) return { present: false, value: undefined };
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor
    ? { present: true, value: descriptor.value }
    : { present: false, value: undefined };
}
function own(value: unknown, key: string): unknown {
  return readData(value, key).value;
}
function unobservedOutcome(): SafeOutcome {
  return {
    state: "not-observed", phase: null, timedOut: null, stopped: null,
    exitCode: null, reasonPresent: null,
  };
}
function invalidOutcome(): SafeOutcome {
  return {
    state: "invalid", phase: null, timedOut: null, stopped: null,
    exitCode: null, reasonPresent: null,
  };
}
function safeOutcome(value: unknown): SafeOutcome {
  if (value == null) return {
    state: "missing", phase: null, timedOut: null, stopped: null,
    exitCode: null, reasonPresent: null,
  };
  try {
    if (typeof value !== "object" || Array.isArray(value)) return invalidOutcome();
    const phaseRead = readData(value, "phase");
    const timedOutRead = readData(value, "timedOut");
    const stoppedRead = readData(value, "stopped");
    const exitCodeRead = readData(value, "exitCode");
    const reasonRead = readData(value, "reason");
    if (!phaseRead.present || typeof phaseRead.value !== "string") return invalidOutcome();
    const phase = phases.includes(phaseRead.value as (typeof phases)[number])
      ? phaseRead.value as SafeOutcome["phase"] : "other";
    const exitCodeValue = exitCodeRead.value;
    const exitCode =
      exitCodeValue === null ? "null" :
      exitCodeValue === 0 ? "zero" :
      typeof exitCodeValue === "number" && Number.isFinite(exitCodeValue)
        ? "nonzero" : "invalid";
    return {
      state: "observed", phase,
      timedOut: typeof timedOutRead.value === "boolean" ? timedOutRead.value : null,
      stopped: typeof stoppedRead.value === "boolean" ? stoppedRead.value : null,
      exitCode,
      reasonPresent: typeof reasonRead.value === "string"
        ? reasonRead.value.length > 0 : reasonRead.value === null ? false : null,
    };
  } catch {
    return invalidOutcome();
  }
}
function freshRuntime(): RuntimeFacts {
  return {
    call: "not-called", promise: "not-promise", failure: "none",
    outcome: unobservedOutcome(),
  };
}
function freshPersist(): PersistFacts {
  return {
    attempts: 0, capped: false, ambiguous: false,
    callback: "not-attempted", outcome: unobservedOutcome(),
  };
}
function freshReopened(): ReopenedFacts {
  return {
    read: "not-read", selectedTurnMatchesOriginal: null,
    genericPhase: null, genericCode: null, genericReasonPresent: null,
    nativeCandidates: null, nativeCandidatesCapped: null, nativeCandidatesAmbiguous: null,
    selectedOutcome: unobservedOutcome(),
    bindingProvider: "unknown", bindingThread: "unknown", versionMatch: null,
    exactSix: null, allPartial: null, lifecycle: "not-recomputed",
  };
}
function freshFacts(): CodexDeadlineDiagnosticFacts {
  return {
    runtime: freshRuntime(),
    terminalPersist: freshPersist(),
    reopened: freshReopened(),
  };
}
function unknownFacts(): CodexDeadlineDiagnosticFacts {
  return {
    runtime: {
      call: "not-observed", promise: "not-observed", failure: "unknown",
      outcome: invalidOutcome(),
    },
    terminalPersist: {
      attempts: null, capped: null, ambiguous: null,
      callback: "not-observed", outcome: invalidOutcome(),
    },
    reopened: {
      read: "not-observed", selectedTurnMatchesOriginal: null,
      genericPhase: null, genericCode: null, genericReasonPresent: null,
      nativeCandidates: null, nativeCandidatesCapped: null,
      nativeCandidatesAmbiguous: null,
      selectedOutcome: invalidOutcome(),
      bindingProvider: "unknown", bindingThread: "unknown", versionMatch: null,
      exactSix: null, allPartial: null, lifecycle: "not-recomputed",
    },
  };
}
function observeNativePromise<T>(
  value: T,
  onFulfilled: (result: unknown) => void,
  onRejected: () => void,
): "observed" | "sync-value" | "not-observed" {
  try {
    if (typeof value !== "object" || value === null) return "sync-value";
    if (Array.isArray(value)) return "sync-value";
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== nativePromisePrototype) {
      let isPromise = false;
      try { isPromise = value instanceof nativePromiseConstructor; } catch { /* keep uncertain values unobserved */ }
      if (isPromise || (prototype !== Object.prototype && prototype !== null))
        return "not-observed";
      return "sync-value";
    }
    const constructor = Object.getOwnPropertyDescriptor(value, "constructor");
    if (constructor) return "not-observed";
    const chained = apply(nativeThen, value, [
      (result: unknown) => { try { onFulfilled(result); } catch { /* isolate observer */ } },
      () => { try { onRejected(); } catch { /* isolate observer */ } },
    ]);
    try { apply(nativeThen, chained, [undefined, () => undefined]); } catch { /* contain any secondary reaction failure */ }
    return "observed";
  } catch {
    return "not-observed";
  }
}

export function createDeadlineObserver() {
  const runtime = freshRuntime();
  const terminalPersist = freshPersist();
  function observeRuntime<T>(invoke: () => T): T {
    let result: T;
    try {
      result = invoke();
    } catch (error) {
      runtime.call = "sync-threw";
      runtime.failure = "sync-throw";
      throw error;
    }
    runtime.call = "returned";
    const promiseObservation = observeNativePromise(
      result,
      (outcome) => {
        runtime.promise = "fulfilled";
        runtime.outcome = safeOutcome(outcome);
      },
      () => {
        runtime.promise = "rejected";
        runtime.failure = "rejection";
      },
    );
    if (promiseObservation === "observed") runtime.promise = "pending";
    else if (promiseObservation === "sync-value") {
      runtime.promise = "not-promise";
      runtime.outcome = safeOutcome(result);
    } else runtime.promise = "not-observed";
    return result;
  }
  function markUnknownPersist(): void {
    terminalPersist.attempts = null;
    terminalPersist.capped = null;
    terminalPersist.ambiguous = true;
    terminalPersist.callback = "ambiguous";
    terminalPersist.outcome = invalidOutcome();
  }
  function tapPersist(
    event: CodexChatEvent,
    persist: (event: CodexChatEvent) => Promise<void>,
  ): Promise<void> {
    let kind: unknown;
    let kindWasReadable = false;
    try {
      const kindRead = readData(event, "kind");
      kind = kindRead.value;
      kindWasReadable = kindRead.present;
    } catch { kind = undefined; }
    if (kind !== "outcome") {
      if (kindWasReadable && typeof kind === "string") return persist(event);
      markUnknownPersist();
      try {
        return persist(event);
      } catch (error) {
        terminalPersist.callback = "sync-threw";
        throw error;
      }
    }
    let safeAttempt = invalidOutcome();
    try {
      const reported = readData(event, "outcome");
      safeAttempt = reported.present ? safeOutcome(reported.value) : invalidOutcome();
    } catch { /* still call persistence once with fixed invalid facts */ }
    if (terminalPersist.attempts === null) {
      terminalPersist.ambiguous = true;
      terminalPersist.callback = "ambiguous";
    } else if (terminalPersist.attempts === 0) {
      terminalPersist.attempts = 1;
      terminalPersist.callback = "returned";
    } else if (terminalPersist.attempts === 1) {
      terminalPersist.attempts = 2;
      terminalPersist.ambiguous = true;
      terminalPersist.callback = "ambiguous";
    } else {
      terminalPersist.capped = true;
      terminalPersist.ambiguous = true;
      terminalPersist.callback = "ambiguous";
    }
    terminalPersist.outcome = safeAttempt;
    let result: Promise<void>;
    try {
      result = persist(event);
    } catch (error) {
      terminalPersist.callback = terminalPersist.ambiguous ? "ambiguous" : "sync-threw";
      throw error;
    }
    if (terminalPersist.ambiguous) return result;
    const attempt = terminalPersist.attempts;
    const callbackObservation = observeNativePromise(
      result,
      () => {
        if (attempt === 1 && !terminalPersist.ambiguous)
          terminalPersist.callback = "fulfilled";
      },
      () => {
        if (attempt === 1 && !terminalPersist.ambiguous)
          terminalPersist.callback = "rejected";
      },
    );
    if (attempt === 1 && !terminalPersist.ambiguous)
      terminalPersist.callback = callbackObservation === "observed"
        ? "pending"
        : callbackObservation === "sync-value" ? "not-promise" : "not-observed";
    return result;
  }
  function copyOutcome(value: SafeOutcome): SafeOutcome {
    return {
      state: value.state,
      phase: value.phase,
      timedOut: value.timedOut,
      stopped: value.stopped,
      exitCode: value.exitCode,
      reasonPresent: value.reasonPresent,
    };
  }
  function snapshot(): CodexDeadlineDiagnosticFacts {
    return {
      runtime: {
        call: runtime.call,
        promise: runtime.promise,
        failure: runtime.failure,
        outcome: copyOutcome(runtime.outcome),
      },
      terminalPersist: {
        attempts: terminalPersist.attempts,
        capped: terminalPersist.capped,
        ambiguous: terminalPersist.ambiguous,
        callback: terminalPersist.callback,
        outcome: copyOutcome(terminalPersist.outcome),
      },
      reopened: freshReopened(),
    };
  }
  return { observeRuntime, tapPersist, snapshot };
}
function outcomeCode(value: unknown): string | null {
  const code = own(value, "code");
  return genericCodes.includes(code as (typeof genericCodes)[number]) ? code as string : null;
}
function closeOutcome(value: unknown): SafeOutcome {
  if (value == null) return safeOutcome(null);
  const state = own(value, "state");
  if (state === "observed" || state === "missing" || state === "invalid" || state === "not-observed") {
    const phaseValue = own(value, "phase");
    const timedOutValue = own(value, "timedOut");
    const stoppedValue = own(value, "stopped");
    const exitCodeValue = own(value, "exitCode");
    const reasonPresentValue = own(value, "reasonPresent");
    const phase = phases.includes(phaseValue as (typeof phases)[number])
      ? phaseValue as SafeOutcome["phase"] : phaseValue === null ? null : "other";
    const exitCodes = ["null", "zero", "nonzero", "invalid"] as const;
    const exitCode = exitCodes.includes(exitCodeValue as (typeof exitCodes)[number])
      ? exitCodeValue as SafeOutcome["exitCode"] : null;
    return {
      state, phase,
      timedOut: typeof timedOutValue === "boolean" ? timedOutValue : null,
      stopped: typeof stoppedValue === "boolean" ? stoppedValue : null,
      exitCode,
      reasonPresent: typeof reasonPresentValue === "boolean" ? reasonPresentValue : null,
    };
  }
  const closed = {
    phase: own(value, "phase"), timedOut: own(value, "timedOut"),
    stopped: own(value, "stopped"), exitCode: own(value, "exitCode"),
    reason: own(value, "reason"),
  };
  return safeOutcome(closed);
}
function closeFacts(value: unknown): CodexDeadlineDiagnosticFacts {
  try {
    const runtimeRead = readData(value, "runtime");
    const persistRead = readData(value, "terminalPersist");
    const reopenedRead = readData(value, "reopened");
    if (!runtimeRead.present || !persistRead.present || !reopenedRead.present)
      return unknownFacts();
    const runtimeInput = runtimeRead.value;
    const persistInput = persistRead.value;
    const reopenedInput = reopenedRead.value;
    const runtimeCall = own(runtimeInput, "call");
    const runtimePromise = own(runtimeInput, "promise");
    const runtimeFailure = own(runtimeInput, "failure");
    const runtimeOutcome = readData(runtimeInput, "outcome");
    const persistAttempts = readData(persistInput, "attempts");
    const persistCapped = readData(persistInput, "capped");
    const persistAmbiguous = readData(persistInput, "ambiguous");
    const persistCallback = own(persistInput, "callback");
    const persistOutcome = readData(persistInput, "outcome");
    const reopenState = own(reopenedInput, "read");
    const selectedMatches = own(reopenedInput, "selectedTurnMatchesOriginal");
    const genericPhaseValue = own(reopenedInput, "genericPhase");
    const genericCodeValue = own(reopenedInput, "genericCode");
    const genericReason = own(reopenedInput, "genericReasonPresent");
    const count = readData(reopenedInput, "nativeCandidates");
    const candidatesCapped = readData(reopenedInput, "nativeCandidatesCapped");
    const candidatesAmbiguous = readData(reopenedInput, "nativeCandidatesAmbiguous");
    const selectedOutcome = readData(reopenedInput, "selectedOutcome");
    const bindingProviderValue = own(reopenedInput, "bindingProvider");
    const bindingThreadValue = own(reopenedInput, "bindingThread");
    const versionMatchValue = own(reopenedInput, "versionMatch");
    const exactSixValue = own(reopenedInput, "exactSix");
    const allPartialValue = own(reopenedInput, "allPartial");
    const lifecycleValue = own(reopenedInput, "lifecycle");
    const safeRuntime: RuntimeFacts = {
      call: ["returned", "sync-threw", "not-called"].includes(runtimeCall as string)
        ? runtimeCall as CallState : "not-observed",
      promise: ["not-promise", "pending", "fulfilled", "rejected", "not-observed"].includes(runtimePromise as string)
        ? runtimePromise as PromiseState : "not-observed",
      failure: ["none", "sync-throw", "rejection"].includes(runtimeFailure as string)
        ? runtimeFailure as RuntimeFacts["failure"] : "unknown",
      outcome: runtimeOutcome.present ? closeOutcome(runtimeOutcome.value) : invalidOutcome(),
    };
    const safePersist: PersistFacts = {
      attempts: persistAttempts.present &&
        (persistAttempts.value === 0 || persistAttempts.value === 1 || persistAttempts.value === 2)
        ? persistAttempts.value : null,
      capped: persistCapped.present && typeof persistCapped.value === "boolean"
        ? persistCapped.value : null,
      ambiguous: persistAmbiguous.present && typeof persistAmbiguous.value === "boolean"
        ? persistAmbiguous.value : null,
      callback: ["not-attempted", "returned", "sync-threw", "ambiguous", "not-promise", "pending", "fulfilled", "rejected", "not-observed"].includes(persistCallback as string)
        ? persistCallback as PersistFacts["callback"] : "not-observed",
      outcome: persistOutcome.present ? closeOutcome(persistOutcome.value) : invalidOutcome(),
    };
    const safeRead = ["not-read", "read", "failed"].includes(reopenState as string)
      ? reopenState as ReopenedFacts["read"] : "not-observed";
    const safePhase = conversationPhases.includes(genericPhaseValue as (typeof conversationPhases)[number])
      ? genericPhaseValue as ReopenedFacts["genericPhase"] : null;
    const safeCode = typeof genericCodeValue === "string" &&
      genericCodes.includes(genericCodeValue as (typeof genericCodes)[number])
      ? genericCodeValue : null;
    const safeProvider = ["codex", "other", "missing", "unknown"].includes(bindingProviderValue as string)
      ? bindingProviderValue as ReopenedFacts["bindingProvider"] : "unknown";
    const safeThread = ["same", "different", "missing"].includes(bindingThreadValue as string)
      ? bindingThreadValue as ReopenedFacts["bindingThread"] : "unknown";
    const safeLifecycle = typeof lifecycleValue === "string" &&
      lifecycleStates.some((state) => lifecycleValue === "recomputed:" + state)
      ? lifecycleValue : "not-recomputed";
    const safeReopened: ReopenedFacts = {
      read: safeRead,
      selectedTurnMatchesOriginal: typeof selectedMatches === "boolean" ? selectedMatches : null,
      genericPhase: safePhase,
      genericCode: safeCode,
      genericReasonPresent: typeof genericReason === "boolean" ? genericReason : null,
      nativeCandidates: count.present &&
        (count.value === 0 || count.value === 1 || count.value === 2)
        ? count.value : null,
      nativeCandidatesCapped: candidatesCapped.present &&
        typeof candidatesCapped.value === "boolean" ? candidatesCapped.value : null,
      nativeCandidatesAmbiguous: candidatesAmbiguous.present &&
        typeof candidatesAmbiguous.value === "boolean" ? candidatesAmbiguous.value : null,
      selectedOutcome: selectedOutcome.present
        ? closeOutcome(selectedOutcome.value) : invalidOutcome(),
      bindingProvider: safeProvider,
      bindingThread: safeThread,
      versionMatch: typeof versionMatchValue === "boolean" ? versionMatchValue : null,
      exactSix: typeof exactSixValue === "boolean" ? exactSixValue : null,
      allPartial: typeof allPartialValue === "boolean" ? allPartialValue : null,
      lifecycle: safeLifecycle,
    };
    return {
      runtime: safeRuntime,
      terminalPersist: safePersist,
      reopened: safeReopened,
    };
  } catch {
    return unknownFacts();
  }
}
export function projectCodexDeadlineFacts(input: {
  observer: CodexDeadlineDiagnosticFacts;
  page: ConversationPage | null;
  originalRequestId: string;
}): CodexDeadlineDiagnosticFacts {
  let facts = unknownFacts();
  try {
    const observer = input.observer;
    const page = input.page;
    const originalRequestId = input.originalRequestId;
    facts = closeFacts(observer);
    if (!page) return facts;
    const lastTurn = page.turns.at(-1);
    if (!lastTurn) {
      facts.reopened.read = "read";
      if (page.turns.length === 0 && page.frames.length === 0) {
        facts.reopened.selectedOutcome = safeOutcome(null);
        facts.reopened.nativeCandidates = 0;
        facts.reopened.nativeCandidatesCapped = false;
        facts.reopened.nativeCandidatesAmbiguous = false;
        facts.reopened.exactSix = false;
      }
      facts.reopened.bindingProvider = page.binding?.provider === "codex"
        ? "codex" : page.binding ? "other" : "missing";
      facts.reopened.bindingThread = "missing";
      const emptyLifecycle = ownedSessionLifecycle(page, {
        mode: "chat", loaded: true, live: false, stopping: false,
        feedInterrupted: false, readError: "",
      });
      facts.reopened.lifecycle = "recomputed:" + emptyLifecycle.state;
      return closeFacts(facts);
    }
    const turnId = lastTurn.requestId;
    const generic = ownedSessionTurn(page, turnId);
    const nativeOutcome = ownedCodexChatOutcome(page, turnId);
    const candidates = page.frames.filter(
      (frame) =>
        frame.turnId === turnId &&
        frame.event.kind === "coding-chat" &&
        frame.event.event.kind === "outcome",
    );
    const candidate = candidates.at(-1);
    const binding = page.binding;
    const selectedEvent =
      candidate?.event.kind === "coding-chat" &&
      candidate.event.event.kind === "outcome"
        ? candidate.event
        : null;
    const rawCandidateOutcome = selectedEvent?.event.kind === "outcome"
      ? selectedEvent.event.outcome
      : null;
    const rawCandidateThread = rawCandidateOutcome?.threadId;
    const summaryFrames = page.frames.filter(
      (frame) =>
        frame.turnId === turnId &&
        frame.event.kind === "coding-chat" &&
        frame.event.event.kind === "reasoning-summary",
    );
    const genericMessage = generic.outcome?.message;
    const lifecycle = ownedSessionLifecycle(page, {
      mode: "chat", loaded: true, live: false, stopping: false,
      feedInterrupted: false, readError: "",
    });
    facts.reopened = {
      read: "read",
      selectedTurnMatchesOriginal: turnId === originalRequestId,
      genericPhase: lastTurn.phase,
      genericCode: outcomeCode(generic.outcome),
      genericReasonPresent: generic.outcome
        ? genericMessage === null ? false : genericMessage === undefined ? null : true
        : null,
      nativeCandidates: Math.min(candidates.length, 2) as 0 | 1 | 2,
      nativeCandidatesCapped: candidates.length > 2,
      nativeCandidatesAmbiguous: candidates.length > 1,
      selectedOutcome: closeOutcome(nativeOutcome),
      bindingProvider:
        binding?.provider === "codex" ? "codex" : binding ? "other" : "missing",
      bindingThread:
        rawCandidateOutcome === null
          ? candidates.length === 0 ? "missing" : "unknown"
          : typeof rawCandidateThread !== "string" ? "unknown"
          : binding?.provider !== "codex" ? "unknown"
          : rawCandidateThread === binding.sessionId ? "same" : "different",
      versionMatch:
        selectedEvent && binding?.provider === "codex"
          ? selectedEvent.version === binding.version
          : null,
      exactSix: summaryFrames.length === 6,
      allPartial: summaryFrames.length === 6
        ? summaryFrames.every(
            (frame) =>
              frame.event.kind === "coding-chat" &&
              frame.event.event.kind === "reasoning-summary" &&
              frame.event.event.partial,
          )
        : null,
      lifecycle: "recomputed:" + lifecycle.state,
    };
    return closeFacts(facts);
  } catch {
    const failed = unknownFacts();
    failed.runtime = facts.runtime;
    failed.terminalPersist = facts.terminalPersist;
    failed.reopened.read = "failed";
    return failed;
  }
}
export function emitCodexDeadlineFailureAndRethrow<T>(
  error: T,
  facts: unknown,
  sink: (row: string) => void,
): never {
  const prefix = "codex-partial-summary-deadline-diagnostic ";
  const fallback = prefix + "{\"kind\":\"codex-partial-summary-deadline-diagnostic\",\"runtime\":{\"call\":\"not-observed\",\"promise\":\"not-observed\",\"failure\":\"unknown\",\"outcome\":{\"state\":\"invalid\",\"phase\":null,\"timedOut\":null,\"stopped\":null,\"exitCode\":null,\"reasonPresent\":null}},\"terminalPersist\":{\"attempts\":null,\"capped\":null,\"ambiguous\":null,\"callback\":\"not-observed\",\"outcome\":{\"state\":\"invalid\",\"phase\":null,\"timedOut\":null,\"stopped\":null,\"exitCode\":null,\"reasonPresent\":null}},\"reopened\":{\"read\":\"not-observed\",\"selectedTurnMatchesOriginal\":null,\"genericPhase\":null,\"genericCode\":null,\"genericReasonPresent\":null,\"nativeCandidates\":null,\"nativeCandidatesCapped\":null,\"nativeCandidatesAmbiguous\":null,\"selectedOutcome\":{\"state\":\"invalid\",\"phase\":null,\"timedOut\":null,\"stopped\":null,\"exitCode\":null,\"reasonPresent\":null},\"bindingProvider\":\"unknown\",\"bindingThread\":\"unknown\",\"versionMatch\":null,\"exactSix\":null,\"allPartial\":null,\"lifecycle\":\"not-recomputed\"}}" + "\n";
  let row = fallback;
  try {
    const closed = closeFacts(facts);
    row = prefix + JSON.stringify({ kind: "codex-partial-summary-deadline-diagnostic", runtime: closed.runtime, terminalPersist: closed.terminalPersist, reopened: closed.reopened }) + "\n";
    if (new TextEncoder().encode(row).byteLength > 4096) row = fallback;
  } catch { row = fallback; }
  try { sink(row); } catch { /* keep original assertion failure; never retry */ }
  throw error;
}
