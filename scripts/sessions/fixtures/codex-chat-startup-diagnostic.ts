import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CodexChatEvent } from "../../../types/codex-chat";
import type { CodexChatStartupPhase } from "../codex-chat-runtime";

export const CODEX_CHAT_STARTUP_DIAGNOSTIC_MAX_BYTES = 1024;
const MAX_EVENTS = 12;

export type CodexChatStartupDiagnosticEvent =
  | {
      kind: "runtime";
      phase: CodexChatStartupPhase;
      signalAborted: boolean;
    }
  | {
      kind: "process-event-persist";
      outcome: "entered" | "completed" | "refused";
    };

export type CodexChatStartupFailureFact = {
  version: 1;
  target: "initial-host-first-run";
  outcome: "failed" | "unknown" | "threw";
  events: CodexChatStartupDiagnosticEvent[];
  eventsCapped: boolean;
};

export function writeFirstCodexChatStartupFailure(options: {
  home: string;
  fact: CodexChatStartupFailureFact;
  writeOwnerOnly(file: string, content: string): void;
}): void {
  const path = join(options.home, "codex-chat-private-startup-failure.json"),
    lock = `${path}.lock`;
  let locked = false;
  try {
    // The owned private home plus this exclusive lock serialize fixture hosts.
    mkdirSync(lock, { mode: 0o700 });
    locked = true;
    if (existsSync(path)) return;
    const text = JSON.stringify(options.fact);
    if (
      Buffer.byteLength(text, "utf8") > CODEX_CHAT_STARTUP_DIAGNOSTIC_MAX_BYTES
    )
      return;
    options.writeOwnerOnly(path, text);
  } catch {
    // A stale lock or failed private write makes the diagnostic unavailable.
  } finally {
    if (locked) {
      try {
        rmSync(lock, { recursive: true });
      } catch {
        // A leftover lock safely prevents later writers from replacing evidence.
      }
    }
  }
}

/** Per-run, fixture-only facts. No runtime event/error/native values are copied. */
export function createCodexChatStartupDiagnostic(options: {
  recordFailure(fact: CodexChatStartupFailureFact): void;
}): {
  observeRuntimePhase(
    phase: CodexChatStartupPhase,
    signalAborted: boolean,
  ): void;
  wrapPersist<T>(
    persist: (event: CodexChatEvent) => Promise<T>,
  ): (event: CodexChatEvent) => Promise<T>;
  finish(outcome: "completed" | "failed" | "unknown" | "threw"): void;
} {
  const events: CodexChatStartupDiagnosticEvent[] = [];
  let eventsCapped = false,
    finished = false;
  const append = (event: CodexChatStartupDiagnosticEvent) => {
    try {
      if (events.length >= MAX_EVENTS) {
        eventsCapped = true;
        return;
      }
      events.push(event);
    } catch {
      eventsCapped = true;
    }
  };

  return {
    observeRuntimePhase(phase, signalAborted) {
      append({ kind: "runtime", phase, signalAborted });
    },
    wrapPersist<T>(persist: (event: CodexChatEvent) => Promise<T>) {
      return async (event) => {
        if (event.kind !== "process") return persist(event);
        append({ kind: "process-event-persist", outcome: "entered" });
        try {
          const result = await persist(event);
          append({ kind: "process-event-persist", outcome: "completed" });
          return result;
        } catch (error) {
          append({ kind: "process-event-persist", outcome: "refused" });
          throw error;
        }
      };
    },
    finish(outcome) {
      if (finished) return;
      finished = true;
      if (outcome === "completed") return;
      try {
        const fact: CodexChatStartupFailureFact = {
          version: 1,
          target: "initial-host-first-run",
          outcome,
          events: [...events],
          eventsCapped,
        };
        if (
          Buffer.byteLength(JSON.stringify(fact), "utf8") <=
          CODEX_CHAT_STARTUP_DIAGNOSTIC_MAX_BYTES
        )
          options.recordFailure(fact);
      } catch {
        // Diagnostic persistence must never replace the run's result or error.
      }
    },
  };
}
