import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const MAX_LOG_BYTES = 8 * 1024 * 1024;
const MAX_LOG_ROWS = 4096;
const MAX_EVENTS = 4096;
const MAX_EVENT_ORDER = 32;
const MAX_DIAGNOSTIC_BYTES = 8 * 1024;

const EVENT_KINDS = [
  "process",
  "identity",
  "configuration",
  "turn",
  "text",
  "command",
  "reasoning-summary",
  "turn-plan",
  "file-change",
  "mcp-tool-call",
  "web-search",
  "usage",
  "outcome",
  "reroute",
  "approval-request",
  "approval-decision",
  "approval-resolved",
] as const;
type EventKind = (typeof EVENT_KINDS)[number];
const eventKinds = new Set<string>(EVENT_KINDS);

const REASON_CATEGORIES = new Map<string, string>([
  ["The native Chat protocol was malformed or changed identity.", "protocol"],
  ["Codex exited before a confirmed terminal turn.", "exit-before-terminal"],
  [
    "The native approval was unsupported or exceeded its decision deadline.",
    "approval-unavailable-or-deadline",
  ],
  ["The native approval did not offer that decision.", "decision-not-offered"],
  ["The native approval decision did not settle.", "decision-deadline"],
  ["The native approval reply did not settle.", "reply-deadline"],
  ["Codex refused a native protocol request.", "native-request-refused"],
  ["The native Chat output reader failed.", "output-reader"],
  ["The private Chat writer failed.", "private-writer"],
  ["The private Chat writer exceeded its deadline.", "private-writer-deadline"],
  ["The Codex Chat turn was stopped.", "stopped"],
  ["The Codex Chat turn exceeded its deadline.", "turn-deadline"],
]);

export type CodexChatFixtureLogState =
  | "ok"
  | "missing"
  | "unreadable"
  | "not-file"
  | "oversized"
  | "changed-during-read"
  | "invalid-utf8"
  | "partial"
  | "invalid-json"
  | "wrong-shape"
  | "too-many-rows";

export interface CodexChatFixtureLogFacts {
  state: CodexChatFixtureLogState;
  bytes: number | null;
  rows: number | null;
  stages: {
    process: number | null;
    initialize: number | null;
    threadStart: number | null;
    turnStart: number | null;
    answer: number | null;
    other: number | null;
  };
  answerIds: {
    string: number | null;
    number: number | null;
    other: number | null;
  };
  decisions: {
    accept: number | null;
    decline: number | null;
    cancel: number | null;
    other: number | null;
  };
}

export interface CodexChatApprovalFailureFacts {
  outcome: {
    state: "available" | "unavailable";
    phase: "completed" | "failed" | "unknown" | "other" | "unavailable";
    reason: string;
    exit: "zero" | "nonzero" | "unavailable";
    stopped: boolean | null;
    timedOut: boolean | null;
  };
  events: {
    state: "available" | "unavailable" | "over-limit";
    count: number | null;
    order: string[] | null;
    truncated: boolean | null;
    counts: (Record<EventKind, number> & { other: number }) | null;
  };
  fixture: CodexChatFixtureLogFacts;
  ownedProcessAlive: boolean | null;
}

function emptyFixture(
  state: CodexChatFixtureLogState,
  bytes: number | null,
  rows: number | null = null,
): CodexChatFixtureLogFacts {
  return {
    state,
    bytes,
    rows,
    stages: {
      process: null,
      initialize: null,
      threadStart: null,
      turnStart: null,
      answer: null,
      other: null,
    },
    answerIds: { string: null, number: null, other: null },
    decisions: { accept: null, decline: null, cancel: null, other: null },
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Projects complete fixture rows to fixed stages, never copying params, IDs, or output. */
export function summarizeCodexChatFixtureText(
  text: string,
  bytes = Buffer.byteLength(text, "utf8"),
): CodexChatFixtureLogFacts {
  if (!Number.isSafeInteger(bytes) || bytes < 0)
    return emptyFixture("wrong-shape", null);
  if (bytes > MAX_LOG_BYTES) return emptyFixture("oversized", bytes);
  if (text.length === 0) return emptyFixture("partial", bytes, 0);
  if (!text.endsWith("\n")) return emptyFixture("partial", bytes);

  const lines = text.slice(0, -1).split("\n");
  if (lines.length > MAX_LOG_ROWS) return emptyFixture("too-many-rows", bytes);

  const stages = {
      process: 0,
      initialize: 0,
      threadStart: 0,
      turnStart: 0,
      answer: 0,
      other: 0,
    },
    answerIds = { string: 0, number: 0, other: 0 },
    decisions = { accept: 0, decline: 0, cancel: 0, other: 0 };

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return emptyFixture("invalid-json", bytes);
    }
    const row = record(parsed);
    if (!row || typeof row.kind !== "string")
      return emptyFixture("wrong-shape", bytes);
    switch (row.kind) {
      case "process":
        stages.process++;
        break;
      case "rpc":
        switch (row.method) {
          case "initialize":
            stages.initialize++;
            break;
          case "thread/start":
            stages.threadStart++;
            break;
          case "turn/start":
            stages.turnStart++;
            break;
          default:
            stages.other++;
        }
        break;
      case "answer": {
        stages.answer++;
        const idType = typeof row.id;
        if (idType === "string") answerIds.string++;
        else if (idType === "number") answerIds.number++;
        else answerIds.other++;
        const answer = record(row.result),
          decision = answer?.decision;
        if (decision === "accept") decisions.accept++;
        else if (decision === "decline") decisions.decline++;
        else if (decision === "cancel") decisions.cancel++;
        else decisions.other++;
        break;
      }
      default:
        stages.other++;
    }
  }

  return {
    state: "ok",
    bytes,
    rows: lines.length,
    stages,
    answerIds,
    decisions,
  };
}

/** Opens the known fixture log, checks metadata before reading, and returns no path or bytes. */
export function readCodexChatFixtureLog(
  path: string,
): CodexChatFixtureLogFacts {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    const code = record(error)?.code;
    return emptyFixture(code === "ENOENT" ? "missing" : "unreadable", null);
  }

  try {
    const before = fstatSync(fd);
    if (!before.isFile()) return emptyFixture("not-file", null);
    if (before.size > MAX_LOG_BYTES)
      return emptyFixture("oversized", before.size);
    const buffer = Buffer.alloc(MAX_LOG_BYTES + 1),
      length = readSync(fd, buffer, 0, buffer.length, 0),
      after = fstatSync(fd),
      observedBytes = Math.max(before.size, after.size, length);
    if (observedBytes > MAX_LOG_BYTES)
      return emptyFixture("oversized", observedBytes);
    if (before.size !== after.size || length !== after.size)
      return emptyFixture("changed-during-read", observedBytes);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, length),
      );
    } catch {
      return emptyFixture("invalid-utf8", observedBytes);
    }
    return summarizeCodexChatFixtureText(text, observedBytes);
  } catch {
    return emptyFixture("unreadable", null);
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Closing this observer descriptor cannot replace the original test failure.
    }
  }
}

export function summarizeCodexChatApprovalFailureFacts(input: {
  events: readonly unknown[] | null;
  outcome: unknown;
  fixture: CodexChatFixtureLogFacts;
  ownedProcessAlive: boolean | null;
}): CodexChatApprovalFailureFacts {
  const outcome = record(input.outcome),
    rawPhase = outcome?.phase,
    phase =
      rawPhase === "completed" ||
      rawPhase === "failed" ||
      rawPhase === "unknown"
        ? rawPhase
        : input.outcome === null
          ? "unavailable"
          : "other",
    rawReason = outcome?.reason,
    reason =
      typeof rawReason === "string"
        ? (REASON_CATEGORIES.get(rawReason) ?? "other")
        : "unavailable",
    rawExit = outcome?.exitCode,
    exit =
      rawExit === 0
        ? "zero"
        : typeof rawExit === "number"
          ? "nonzero"
          : "unavailable",
    rawStopped = outcome?.stopped,
    rawTimedOut = outcome?.timedOut;

  if (input.events === null)
    return {
      outcome: {
        state: input.outcome === null ? "unavailable" : "available",
        phase,
        reason,
        exit,
        stopped: typeof rawStopped === "boolean" ? rawStopped : null,
        timedOut: typeof rawTimedOut === "boolean" ? rawTimedOut : null,
      },
      events: {
        state: "unavailable",
        count: null,
        order: null,
        truncated: null,
        counts: null,
      },
      fixture: input.fixture,
      ownedProcessAlive: input.ownedProcessAlive,
    };

  if (input.events.length > MAX_EVENTS)
    return {
      outcome: {
        state: input.outcome === null ? "unavailable" : "available",
        phase,
        reason,
        exit,
        stopped: typeof rawStopped === "boolean" ? rawStopped : null,
        timedOut: typeof rawTimedOut === "boolean" ? rawTimedOut : null,
      },
      events: {
        state: "over-limit",
        count: null,
        order: null,
        truncated: null,
        counts: null,
      },
      fixture: input.fixture,
      ownedProcessAlive: input.ownedProcessAlive,
    };

  const counts = Object.assign(
      Object.fromEntries(EVENT_KINDS.map((kind) => [kind, 0])) as Record<
        EventKind,
        number
      >,
      { other: 0 },
    ),
    order: string[] = [];
  for (const rawEvent of input.events) {
    const event = record(rawEvent),
      kind = event?.kind;
    if (typeof kind !== "string" || !eventKinds.has(kind)) {
      counts.other++;
      if (order.length < MAX_EVENT_ORDER) order.push("other");
      continue;
    }
    counts[kind as EventKind]++;
    if (order.length < MAX_EVENT_ORDER) order.push(kind);
  }

  return {
    outcome: {
      state: input.outcome === null ? "unavailable" : "available",
      phase,
      reason,
      exit,
      stopped: typeof rawStopped === "boolean" ? rawStopped : null,
      timedOut: typeof rawTimedOut === "boolean" ? rawTimedOut : null,
    },
    events: {
      state: "available",
      count: input.events.length,
      order,
      truncated: input.events.length > MAX_EVENT_ORDER,
      counts,
    },
    fixture: input.fixture,
    ownedProcessAlive: input.ownedProcessAlive,
  };
}

/** Best-effort bounded facts, then rethrow the original test assertion object. */
export async function emitCodexChatApprovalFailureFactsAndRethrow(
  error: unknown,
  collect: () => Promise<unknown>,
  write: (line: string) => unknown,
): Promise<never> {
  try {
    const serialized = JSON.stringify(await collect());
    if (serialized !== undefined) {
      const prefix = "[codex-chat-approval-diagnostic] ";
      const line =
        Buffer.byteLength(`${prefix}${serialized}\n`, "utf8") <=
        MAX_DIAGNOSTIC_BYTES
          ? serialized
          : JSON.stringify({ observer: "facts-over-limit" });
      await Promise.resolve(write(`${prefix}${line}\n`));
    }
  } catch {
    // Observer and stderr failures must not replace the original test failure.
  }
  throw error;
}
