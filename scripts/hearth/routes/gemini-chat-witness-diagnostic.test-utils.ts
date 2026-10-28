import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { geminiChatPrivateFrameSchema } from "../../sessions/gemini-chat-owned-journal";
import type { GeminiChatPrivateFrame } from "../../../types/gemini-owned-chat";

const MAX_LOG_BYTES = 256 * 1024;
const MAX_ROWS = 256;
const MAX_DIAGNOSTIC_BYTES = 8 * 1024;
const PROMPT_MARKER = "PRIVATE-ACP-PROMPT";
const METHODS = [
  "initialize",
  "session/new",
  "session/load",
  "session/prompt",
  "session/cancel",
] as const;
const KINDS = ["version", "help", "start", "wire", "helper"] as const;

type LogState = "missing" | "partial" | "invalid" | "unreadable" | "ok";
type LogReason =
  | "absent"
  | "read-failed"
  | "not-file"
  | "over-limit"
  | "changed-during-read"
  | "invalid-utf8"
  | "incomplete-json"
  | "invalid-json"
  | "wrong-shape"
  | "too-many-rows"
  | "none";

export interface GeminiChatWitnessSummary {
  state: LogState;
  reason: LogReason;
  bytes: number | null;
  rows: number | null;
  kinds: {
    version: number | null;
    help: number | null;
    start: number | null;
    wire: number | null;
    helper: number | null;
    other: number | null;
  };
  methods: {
    initialize: number | null;
    sessionNew: number | null;
    sessionLoad: number | null;
    sessionPrompt: number | null;
    sessionCancel: number | null;
    other: number | null;
  };
  promptMarkerMatched: boolean;
}

type ProtectedTurn = {
  requestId: string;
  phase: string;
  reason: string | null;
};

export type RuntimeProjection = {
  processRecord: "observed" | "not-in-page" | "invalid";
  outcome: "observed" | "not-in-page" | "invalid";
  phase: "completed" | "failed" | "unknown" | "not-observed";
  exitCode: "null" | "zero" | "nonzero" | null;
  stopped: boolean | null;
  timedOut: boolean | null;
  nativeError: "observed" | "not-observed" | "invalid";
  nativeResult: "observed" | "not-observed" | "invalid";
};
type GeminiChatNativeEvent = GeminiChatPrivateFrame["event"];

const noRuntimeFacts = (): RuntimeProjection => ({
  processRecord: "not-in-page",
  outcome: "not-in-page",
  phase: "not-observed",
  exitCode: null,
  stopped: null,
  timedOut: null,
  nativeError: "not-observed",
  nativeResult: "not-observed",
});

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function projectRuntimeFacts(
  frames: readonly { turnId: string; event: unknown }[],
  requestId: string,
): RuntimeProjection {
  const facts = noRuntimeFacts();
  const matches: Array<{
    kind: "process" | "outcome" | "error" | "result";
    event: GeminiChatNativeEvent;
  }> = [];
  let invalidProcess = false,
    invalidOutcome = false,
    invalidError = false,
    invalidResult = false;

  for (const frame of frames) {
    if (frame.turnId !== requestId || !isObject(frame.event)) continue;
    const wrapper = frame.event;
    if (wrapper.kind !== "coding-gemini-chat") continue;
    const native = wrapper.event;
    if (!isObject(native)) continue;
    const kind = native.kind;
    if (
      kind !== "process" &&
      kind !== "outcome" &&
      kind !== "error" &&
      kind !== "result"
    )
      continue;
    const parsed = geminiChatPrivateFrameSchema.safeParse(wrapper);
    if (!parsed.success) {
      if (kind === "process") invalidProcess = true;
      else if (kind === "outcome") invalidOutcome = true;
      else if (kind === "error") invalidError = true;
      else invalidResult = true;
      continue;
    }
    const event = parsed.data.event;
    if (event.kind === "process" && event.requestId !== requestId) {
      invalidProcess = true;
      continue;
    }
    if (
      (event.kind === "error" || event.kind === "result") &&
      event.requestId !== requestId
    ) {
      if (event.kind === "error") invalidError = true;
      else invalidResult = true;
      continue;
    }
    if (
      event.kind === "process" ||
      event.kind === "outcome" ||
      event.kind === "error" ||
      event.kind === "result"
    )
      matches.push({ kind: event.kind, event });
  }

  const processes = matches.filter((item) => item.kind === "process");
  if (invalidProcess || processes.length > 1) facts.processRecord = "invalid";
  else if (processes.length === 1) facts.processRecord = "observed";

  const outcomes = matches.filter((item) => item.kind === "outcome");
  if (invalidOutcome || outcomes.length > 1) {
    facts.outcome = "invalid";
  } else if (outcomes.length === 1) {
    const event = outcomes[0]?.event;
    if (event?.kind === "outcome") {
      facts.outcome = "observed";
      facts.phase = event.outcome.phase;
      facts.exitCode =
        event.exitCode === null
          ? "null"
          : event.exitCode === 0
            ? "zero"
            : "nonzero";
      facts.stopped = event.stopped;
      facts.timedOut = event.timedOut;
    }
  }

  const errors = matches.filter((item) => item.kind === "error");
  facts.nativeError =
    invalidError || errors.length > 1
      ? "invalid"
      : errors.length === 1
        ? "observed"
        : "not-observed";
  const results = matches.filter((item) => item.kind === "result");
  facts.nativeResult =
    invalidResult || results.length > 1
      ? "invalid"
      : results.length === 1
        ? "observed"
        : "not-observed";
  return facts;
}

/** Project safe facts from only the exact saved turn and its correlated frames. */
export function projectGeminiChatFailureFacts(
  page: {
    request: ProtectedTurn | null;
    turns: readonly ProtectedTurn[];
    frames: readonly { turnId: string; event: unknown }[];
  },
  requestId: string,
) {
  const turn =
    page.request?.requestId === requestId
      ? page.request
      : (page.turns.find((item) => item.requestId === requestId) ?? null);
  return {
    original: {
      phase: turn?.phase ?? "unknown",
      reason:
        turn === null
          ? ("no-turn" as const)
          : turn.reason === null
            ? ("none" as const)
            : ("present" as const),
    },
    runtime:
      turn === null
        ? noRuntimeFacts()
        : projectRuntimeFacts(page.frames, requestId),
  };
}

function empty(
  state: LogState,
  reason: LogReason,
  bytes: number | null,
): GeminiChatWitnessSummary {
  return {
    state,
    reason,
    bytes,
    rows: null,
    kinds: {
      version: null,
      help: null,
      start: null,
      wire: null,
      helper: null,
      other: null,
    },
    methods: {
      initialize: null,
      sessionNew: null,
      sessionLoad: null,
      sessionPrompt: null,
      sessionCancel: null,
      other: null,
    },
    promptMarkerMatched: false,
  };
}

export function unavailableGeminiChatWitnessLog(
  state: "missing" | "unreadable",
): GeminiChatWitnessSummary {
  return empty(state, state === "missing" ? "absent" : "read-failed", null);
}

/** Summarize an already bounded read of the fixture's private JSON log. */
export function summarizeGeminiChatWitnessText(
  text: string,
  bytes = Buffer.byteLength(text),
): GeminiChatWitnessSummary {
  if (!Number.isSafeInteger(bytes) || bytes < 0)
    return empty("invalid", "wrong-shape", null);
  if (bytes > MAX_LOG_BYTES) return empty("invalid", "over-limit", bytes);
  if (!text.trimEnd().endsWith("]"))
    return empty("partial", "incomplete-json", bytes);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return empty("invalid", "invalid-json", bytes);
  }
  if (!Array.isArray(parsed)) return empty("invalid", "wrong-shape", bytes);
  if (parsed.length > MAX_ROWS) return empty("invalid", "too-many-rows", bytes);

  const kinds = { version: 0, help: 0, start: 0, wire: 0, helper: 0, other: 0 };
  const methods = {
    initialize: 0,
    sessionNew: 0,
    sessionLoad: 0,
    sessionPrompt: 0,
    sessionCancel: 0,
    other: 0,
  };
  let promptMarkerMatched = false;
  for (const row of parsed) {
    if (typeof row !== "object" || row === null || Array.isArray(row))
      return empty("invalid", "wrong-shape", bytes);
    const kind = "kind" in row ? row.kind : undefined;
    if (
      typeof kind !== "string" ||
      !KINDS.includes(kind as (typeof KINDS)[number])
    )
      kinds.other++;
    else kinds[kind as keyof typeof kinds]++;

    if (kind !== "wire") continue;
    const value = "value" in row ? row.value : undefined;
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !("method" in value) ||
      typeof value.method !== "string"
    ) {
      methods.other++;
    } else {
      switch (value.method) {
        case "initialize":
          methods.initialize++;
          break;
        case "session/new":
          methods.sessionNew++;
          break;
        case "session/load":
          methods.sessionLoad++;
          break;
        case "session/prompt":
          methods.sessionPrompt++;
          try {
            promptMarkerMatched ||= JSON.stringify(row).includes(PROMPT_MARKER);
          } catch {
            // JSON.parse creates acyclic data, but diagnostics must not affect the test.
          }
          break;
        case "session/cancel":
          methods.sessionCancel++;
          break;
        default:
          methods.other++;
      }
    }
  }

  return {
    state: "ok",
    reason: "none",
    bytes,
    rows: parsed.length,
    kinds,
    methods,
    promptMarkerMatched,
  };
}

/** Emit failure facts best-effort, then preserve the original failure object. */
export async function emitGeminiChatWitnessFailureFactsAndRethrow(
  error: unknown,
  collect: () => Promise<unknown>,
  write: (line: string) => unknown,
): Promise<never> {
  try {
    const serialized = JSON.stringify(await collect());
    if (serialized !== undefined) {
      const bounded =
        Buffer.byteLength(serialized) <= MAX_DIAGNOSTIC_BYTES
          ? serialized
          : JSON.stringify({ observer: "facts-over-limit" });
      write(`[gemini-chat-witness-diagnostic] ${bounded}\n`);
    }
  } catch {
    // An observer or stderr failure must not replace the original test failure.
  }
  throw error;
}

/** Read at most MAX_LOG_BYTES plus one byte; never return file contents or paths. */
export function readGeminiChatWitnessLog(
  path: string,
): GeminiChatWitnessSummary {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    return unavailableGeminiChatWitnessLog(
      code === "ENOENT" ? "missing" : "unreadable",
    );
  }

  try {
    const before = fstatSync(fd);
    if (!before.isFile()) return empty("invalid", "not-file", null);
    if (before.size > MAX_LOG_BYTES)
      return empty("invalid", "over-limit", before.size);
    const buffer = Buffer.alloc(MAX_LOG_BYTES + 1);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    const after = fstatSync(fd);
    const observedBytes = Math.max(before.size, after.size, length);
    if (observedBytes > MAX_LOG_BYTES)
      return empty("invalid", "over-limit", observedBytes);
    if (before.size !== after.size || length !== after.size)
      return empty("partial", "changed-during-read", observedBytes);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, length),
      );
    } catch {
      return empty("invalid", "invalid-utf8", observedBytes);
    }
    return summarizeGeminiChatWitnessText(text, observedBytes);
  } catch {
    return empty("unreadable", "read-failed", null);
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Closing a diagnostic descriptor must not replace the test failure.
    }
  }
}
