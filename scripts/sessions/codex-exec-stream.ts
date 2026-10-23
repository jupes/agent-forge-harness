import type {
  CodexExecOutcome,
  CodexExecPrivateEvent,
  CodexExecUsage,
} from "../../types/codex-task";
import type { ChildExit } from "../executors/types";

export const CODEX_EXEC_STREAM_LIMITS = {
  lines: 4096,
  lineBytes: 1_048_576,
  totalBytes: 8_388_608,
  items: 2048,
  textBytes: 524_288,
} as const;
const encoder = new TextEncoder();
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isCodexThreadId = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const bad = () =>
  new Error("The Codex exec stream did not match the private Task protocol.");
const token = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(value);

function usageFor(value: unknown): CodexExecUsage | null {
  if (value === undefined) return null;
  if (!record(value)) throw bad();
  const usage: CodexExecUsage = {};
  const fields = [
    ["input_tokens", "inputTokens"],
    ["output_tokens", "outputTokens"],
    ["cached_input_tokens", "cachedInputTokens"],
    ["cache_write_input_tokens", "cacheWriteInputTokens"],
    ["reasoning_output_tokens", "reasoningOutputTokens"],
  ] as const;
  for (const [wire, field] of fields) {
    const count = value[wire];
    if (count === undefined) continue;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
      throw bad();
    usage[field] = count;
  }
  return Object.keys(usage).length === 0 ? null : usage;
}

/** Independent snake_case exec decoder. It grants no execution, scope or approval authority. */
export function createCodexExecParser(options: { version: string }) {
  if (
    !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(options.version) ||
    options.version.length > 100
  )
    throw bad();
  const version = options.version;
  let threadId: string | null = null;
  let started = false;
  let terminal: "completed" | "failed" | null = null;
  let providerError = false;
  let broken = false;
  let finished = false;
  let lines = 0;
  let bytes = 0;
  let textBytes = 0;
  let usage: CodexExecUsage | null = null;
  const items = new Map<
    string,
    { type: string; complete: boolean; text: string | null }
  >();
  const read = (line: string): CodexExecPrivateEvent[] => {
    if (finished) throw bad();
    const size = encoder.encode(line).byteLength;
    bytes += size;
    if (
      ++lines > CODEX_EXEC_STREAM_LIMITS.lines ||
      size > CODEX_EXEC_STREAM_LIMITS.lineBytes ||
      bytes > CODEX_EXEC_STREAM_LIMITS.totalBytes
    )
      throw bad();
    if (!line.trim()) return [];
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw bad();
    }
    if (!record(value) || typeof value.type !== "string" || terminal !== null)
      throw bad();
    if (
      value.thread_id !== undefined &&
      (!isCodexThreadId(value.thread_id) ||
        (threadId !== null && value.thread_id.toLowerCase() !== threadId))
    )
      throw bad();
    if (value.type === "thread.started") {
      if (!isCodexThreadId(value.thread_id)) throw bad();
      if (threadId !== null) return [];
      threadId = value.thread_id.toLowerCase();
      return [{ kind: "identity", provider: "codex", threadId, version }];
    }
    if (value.type === "error") {
      providerError = true;
      return [];
    }
    if (threadId === null) throw bad();
    if (value.type === "turn.started") {
      if (started) throw bad();
      started = true;
      return [];
    }
    if (!started) throw bad();
    if (value.type === "turn.completed") {
      usage = usageFor(value.usage);
      terminal = "completed";
      return usage === null ? [] : [{ kind: "usage", usage: { ...usage } }];
    }
    if (value.type === "turn.failed") {
      terminal = "failed";
      return [];
    }
    if (
      !["item.started", "item.updated", "item.completed"].includes(
        value.type,
      ) ||
      !record(value.item) ||
      !token(value.item.id) ||
      !token(value.item.type)
    )
      throw bad();
    let item = items.get(value.item.id);
    if (!item) {
      if (items.size >= CODEX_EXEC_STREAM_LIMITS.items) throw bad();
      item = { type: value.item.type, complete: false, text: null };
      items.set(value.item.id, item);
    }
    if (
      item.type !== value.item.type ||
      (item.complete && value.type !== "item.completed")
    )
      throw bad();
    if (value.item.type === "error") providerError = true;
    if (value.type !== "item.completed") return [];
    if (value.item.type !== "agent_message") {
      item.complete = true;
      return [];
    }
    const text = value.item.text;
    if (
      typeof text !== "string" ||
      text.includes("\0") ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
        text,
      )
    )
      throw bad();
    if (item.complete) {
      if (item.text !== text) throw bad();
      return [];
    }
    item.complete = true;
    item.text = text;
    textBytes += encoder.encode(text).byteLength;
    if (textBytes > CODEX_EXEC_STREAM_LIMITS.textBytes) throw bad();
    const events: CodexExecPrivateEvent[] = [];
    for (let start = 0; start < text.length; ) {
      let end = Math.min(start + 16_000, text.length);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? ""))
        end--;
      events.push({
        kind: "text",
        itemId: value.item.id,
        text: text.slice(start, end),
      });
      start = end;
    }
    return events;
  };
  return {
    line(line: string): CodexExecPrivateEvent[] {
      try {
        if (broken) throw bad();
        return read(line);
      } catch {
        broken = true;
        throw bad();
      }
    },
    finish(
      exit: Pick<ChildExit, "exitCode" | "timedOut" | "stopped">,
    ): CodexExecOutcome {
      finished = true;
      const outcome = (
        phase: CodexExecOutcome["phase"],
        reason: string | null,
      ): CodexExecOutcome => ({
        phase,
        reason,
        threadId,
        observedModel: null,
        usage: usage === null ? null : { ...usage },
      });
      if (broken)
        return outcome(
          "unknown",
          "The private Codex Task protocol was incomplete or invalid.",
        );
      if (exit.timedOut) return outcome("unknown", "The Codex Task timed out.");
      if (exit.stopped) return outcome("failed", "The Codex Task was stopped.");
      if (providerError || terminal === "failed")
        return outcome("failed", "The provider reported a Codex Task failure.");
      if (
        threadId === null ||
        !started ||
        terminal !== "completed" ||
        exit.exitCode !== 0
      )
        return outcome(
          "unknown",
          "The Codex Task did not confirm both a terminal result and successful process exit.",
        );
      return outcome("completed", null);
    },
  };
}
