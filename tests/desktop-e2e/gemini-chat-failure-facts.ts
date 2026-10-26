const phases = [
  "accepted",
  "running",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "unknown",
] as const;
const stopReasons = [
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
] as const;
const readStates = [
  "ok",
  "missing",
  "oversize",
  "invalid",
  "unavailable",
] as const;
const methodNames = [
  "initialize",
  "session/new",
  "session/load",
  "session/prompt",
  "session/cancel",
] as const;

export const GEMINI_CHAT_FAILURE_FACTS_MAX_BYTES = 8 * 1024;

export interface GeminiChatFailureFactsInput {
  stateRead?: unknown;
  callsRead?: unknown;
  turnPhase?: unknown;
  turnReason?: unknown;
  outcome?: unknown;
  hasBinding?: unknown;
  nativeOutcomeCount?: unknown;
  approvalOffers?: unknown;
  permissionIntents?: unknown;
  methodCounts?: unknown;
  permissionResponses?: unknown;
  providerAlive?: unknown;
  helperAlive?: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function enumValue<T extends readonly string[]>(value: unknown, values: T) {
  return typeof value === "string" && values.some((item) => item === value)
    ? value
    : null;
}

function boundedCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, 1_000_000)
    : null;
}

function reasonCategory(value: unknown): string | null {
  if (value === null) return "none";
  if (typeof value !== "string") return "unavailable";
  const exact: Readonly<Record<string, string>> = {
    "The Gemini Chat protocol, cancellation or private save was interrupted. The prompt was not resent.":
      "protocol_or_private_save_interrupted",
    "The final Gemini Chat outcome could not be saved. The prompt was not resent.":
      "final_outcome_save_failed",
    "The Gemini Chat prompt timed out.": "prompt_timed_out",
    "The Gemini Chat prompt was stopped.": "prompt_stopped",
    "The provider did not report a confirmed outcome. This turn was not resent.":
      "provider_outcome_unconfirmed",
    "The supervised turn was stopped.": "supervised_turn_stopped",
  };
  if (exact[value]) return exact[value] ?? "other";
  if (value.startsWith("Gemini exited with code "))
    return "provider_exit_failure";
  if (value.startsWith("Gemini stopped with "))
    return "provider_stop_reason_failure";
  return "other";
}

/** Projects only fixed, non-sensitive diagnostic facts from untrusted test input. */
export function normalizeGeminiChatFailureFacts(input: unknown) {
  const source = record(input) ?? {};
  const rawOutcome = record(source.outcome);
  const rawMethods = record(source.methodCounts);
  const methods = Object.fromEntries(
    methodNames.map((name) => [name, boundedCount(rawMethods?.[name])]),
  );
  return {
    version: 1,
    stateRead: enumValue(source.stateRead, readStates) ?? "unavailable",
    callsRead: enumValue(source.callsRead, readStates) ?? "unavailable",
    turnPhase: enumValue(source.turnPhase, phases),
    turnReasonCategory: reasonCategory(source.turnReason),
    hasBinding:
      typeof source.hasBinding === "boolean" ? source.hasBinding : null,
    nativeOutcomeCount: boundedCount(source.nativeOutcomeCount),
    nativeOutcome: rawOutcome
      ? {
          phase: enumValue(rawOutcome.phase, [
            "completed",
            "failed",
            "unknown",
          ] as const),
          reasonCategory: reasonCategory(rawOutcome.reason),
          stopReason: enumValue(rawOutcome.stopReason, stopReasons),
          exitCode:
            rawOutcome.exitCode === null ||
            (typeof rawOutcome.exitCode === "number" &&
              Number.isSafeInteger(rawOutcome.exitCode) &&
              rawOutcome.exitCode >= -0x80000000 &&
              rawOutcome.exitCode <= 0xffffffff)
              ? rawOutcome.exitCode
              : null,
          stopped:
            typeof rawOutcome.stopped === "boolean" ? rawOutcome.stopped : null,
          timedOut:
            typeof rawOutcome.timedOut === "boolean"
              ? rawOutcome.timedOut
              : null,
        }
      : null,
    approvals: {
      offers: boundedCount(source.approvalOffers),
      intents: boundedCount(source.permissionIntents),
    },
    fixture: {
      methodCounts: methods,
      permissionResponses: boundedCount(source.permissionResponses),
      providerAlive:
        typeof source.providerAlive === "boolean" ? source.providerAlive : null,
      helperAlive:
        typeof source.helperAlive === "boolean" ? source.helperAlive : null,
    },
  };
}

/** Best-effort failure attachment that preserves the exact primary error object. */
export async function withGeminiChatFailureFacts<T>(options: {
  operation(): Promise<T>;
  collect(): unknown;
  attach(body: Uint8Array): Promise<unknown>;
}): Promise<T> {
  try {
    return await options.operation();
  } catch (original) {
    try {
      const body = new TextEncoder().encode(
        JSON.stringify(normalizeGeminiChatFailureFacts(options.collect())),
      );
      if (body.byteLength <= GEMINI_CHAT_FAILURE_FACTS_MAX_BYTES)
        await options.attach(body);
    } catch {
      // The diagnostic must not replace or annotate the original failure with sensitive input.
    }
    throw original;
  }
}

/** Strictly bounds UTF-8 JSON text before parsing a diagnostic source file. */
export function parseBoundedGeminiDiagnosticJson(
  text: string,
  maxBytes: number,
):
  | { ok: true; value: unknown }
  | { ok: false; reason: "oversize" | "invalid" } {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    new TextEncoder().encode(text).byteLength > maxBytes
  )
    return { ok: false, reason: "oversize" };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}
