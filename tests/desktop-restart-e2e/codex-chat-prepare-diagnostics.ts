import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { isReadOnlyCapabilityRefusal } from "../../scripts/sessions/read-only-capability-refusal";

export const CODEX_CHAT_PREPARE_FACTS_FILE = "codex-chat-prepare-facts.jsonl";
export const CODEX_CHAT_PREPARE_MARKER_FILE = "codex-chat-prepare-active.json";
export const CODEX_CHAT_PREPARE_FACTS_MAX_BYTES = 64 * 1024;
export const CODEX_CHAT_PREPARE_MARKER_MAX_BYTES = 1024;
export const CODEX_CHAT_PREPARE_FACTS_MAX_ROWS = 256;
export const CODEX_CHAT_PREPARE_OPERATIONS_MAX = 32;

export type PrepareOperation = "check" | "prepare";
export type ProbeName = "version" | "help";
export type ProbePhase =
  | "before-probes-or-unobserved"
  | "version-probe"
  | "between-probes"
  | "help-probe"
  | "after-probes"
  | "unknown";
export type ProbeCorrelation = "single" | "overlap";

export type ActiveMarker =
  | { version: 1; state: "idle" }
  | {
      version: 1;
      state: "single";
      ordinal: number;
      operation: PrepareOperation;
    }
  | { version: 1; state: "overlap"; activeCount: number }
  | { version: 1; state: "capped" };

export type PrepareFact =
  | {
      version: 1;
      source: "runtime";
      event: "started";
      ordinal: number;
      operation: PrepareOperation;
    }
  | {
      version: 1;
      source: "runtime";
      event: "settled";
      ordinal: number;
      operation: PrepareOperation;
      outcome: "success" | "failure";
      phase: ProbePhase;
      elapsedMs: number;
      errorClass?: "capability-refusal" | "validation-error" | "other";
    }
  | {
      version: 1;
      source: "probe";
      event: "started" | "completed";
      probe: ProbeName;
      correlation: ProbeCorrelation;
      ordinal?: number;
      elapsedMs?: number;
    }
  | { version: 1; source: "runtime"; event: "saturated" };

const activeMarkerSchema = z.discriminatedUnion("state", [
  z.object({ version: z.literal(1), state: z.literal("idle") }).strict(),
  z
    .object({
      version: z.literal(1),
      state: z.literal("single"),
      ordinal: z.number().int().positive(),
      operation: z.enum(["check", "prepare"]),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      state: z.literal("overlap"),
      activeCount: z.number().int().min(2),
    })
    .strict(),
  z.object({ version: z.literal(1), state: z.literal("capped") }).strict(),
]);
const runtimeFactSchema = z.discriminatedUnion("event", [
  z
    .object({
      version: z.literal(1),
      source: z.literal("runtime"),
      event: z.literal("started"),
      ordinal: z.number().int().positive(),
      operation: z.enum(["check", "prepare"]),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      source: z.literal("runtime"),
      event: z.literal("settled"),
      ordinal: z.number().int().positive(),
      operation: z.enum(["check", "prepare"]),
      outcome: z.enum(["success", "failure"]),
      phase: z.enum([
        "before-probes-or-unobserved",
        "version-probe",
        "between-probes",
        "help-probe",
        "after-probes",
        "unknown",
      ]),
      elapsedMs: z.number().int().min(0).max(600_000),
      errorClass: z
        .enum(["capability-refusal", "validation-error", "other"])
        .optional(),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      source: z.literal("runtime"),
      event: z.literal("saturated"),
    })
    .strict(),
]);
const probeFactSchema = z.union([
  z
    .object({
      version: z.literal(1),
      source: z.literal("probe"),
      event: z.literal("started"),
      probe: z.enum(["version", "help"]),
      correlation: z.literal("single"),
      ordinal: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      source: z.literal("probe"),
      event: z.literal("started"),
      probe: z.enum(["version", "help"]),
      correlation: z.literal("overlap"),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      source: z.literal("probe"),
      event: z.literal("completed"),
      probe: z.enum(["version", "help"]),
      correlation: z.literal("single"),
      ordinal: z.number().int().positive(),
      elapsedMs: z.number().int().min(0).max(600_000),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      source: z.literal("probe"),
      event: z.literal("completed"),
      probe: z.enum(["version", "help"]),
      correlation: z.literal("overlap"),
      elapsedMs: z.number().int().min(0).max(600_000),
    })
    .strict(),
]);
const prepareFactSchema = z.union([runtimeFactSchema, probeFactSchema]);

export type ProbeFactRead =
  | { state: "available"; facts: PrepareFact[] }
  | { state: "unavailable" };

export interface PrepareDiagnosticIo {
  now(): number;
  writeMarker(marker: ActiveMarker): void;
  appendFact(fact: PrepareFact): void;
  readFacts(): ProbeFactRead;
}

function safeElapsed(start: number, end: number): number {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.min(600_000, Math.round(end - start)));
}

function errorClass(
  error: unknown,
): "capability-refusal" | "validation-error" | "other" {
  if (isReadOnlyCapabilityRefusal(error)) return "capability-refusal";
  if (
    error instanceof Error &&
    (error.name === "ZodError" || error.name === "ZodValidationError")
  )
    return "validation-error";
  return "other";
}

export function classifyProbePhase(
  facts: ProbeFactRead,
  ordinal: number,
): ProbePhase {
  if (facts.state !== "available") return "unknown";
  const rows = facts.facts.filter(
    (fact): fact is Extract<PrepareFact, { source: "probe" }> =>
      fact.source === "probe" && fact.ordinal === ordinal,
  );
  if (rows.length === 0) {
    return facts.facts.some(
      (fact) => fact.source === "probe" && fact.correlation === "overlap",
    )
      ? "unknown"
      : "before-probes-or-unobserved";
  }
  const has = (probe: ProbeName, event: "started" | "completed") =>
    rows.some((fact) => fact.probe === probe && fact.event === event);
  if (has("help", "started") && !has("help", "completed")) return "help-probe";
  if (has("help", "completed")) return "after-probes";
  if (has("version", "started") && !has("version", "completed"))
    return "version-probe";
  if (has("version", "completed")) return "between-probes";
  return "unknown";
}

/** Test-fixture wrapper. It records safe facts and preserves the exact result/error. */
export function createCodexChatPrepareDiagnostics(io: PrepareDiagnosticIo) {
  let nextOrdinal = 0;
  const active = new Map<number, PrepareOperation>();
  let saturated = false,
    cohortAmbiguous = false;

  const publishMarker = () => {
    const entries = [...active.entries()];
    const marker: ActiveMarker = saturated
      ? { version: 1, state: "capped" }
      : entries.length === 0
        ? { version: 1, state: "idle" }
        : entries.length === 1 && !cohortAmbiguous
          ? {
              version: 1,
              state: "single",
              ordinal: entries[0]![0],
              operation: entries[0]![1],
            }
          : {
              version: 1,
              state: "overlap",
              activeCount: Math.max(2, entries.length),
            };
    try {
      io.writeMarker(marker);
    } catch {
      // Fixture diagnostics must not change the operation being observed.
    }
  };
  const safeNow = () => {
    try {
      return io.now();
    } catch {
      return 0;
    }
  };
  const safePhase = (ordinal: number): ProbePhase => {
    try {
      return classifyProbePhase(io.readFacts(), ordinal);
    } catch {
      return "unknown";
    }
  };

  return {
    activeMarker(): ActiveMarker {
      const entries = [...active.entries()];
      if (saturated) return { version: 1, state: "capped" };
      if (entries.length === 0) return { version: 1, state: "idle" };
      if (entries.length === 1 && !cohortAmbiguous)
        return {
          version: 1,
          state: "single",
          ordinal: entries[0]![0],
          operation: entries[0]![1],
        };
      return {
        version: 1,
        state: "overlap",
        activeCount: Math.max(2, entries.length),
      };
    },

    async observe<T>(
      operation: PrepareOperation,
      run: () => Promise<T>,
    ): Promise<T> {
      if (nextOrdinal >= CODEX_CHAT_PREPARE_OPERATIONS_MAX) {
        if (!saturated) {
          saturated = true;
          try {
            io.appendFact({
              version: 1,
              source: "runtime",
              event: "saturated",
            });
          } catch {
            // Best effort only.
          }
          publishMarker();
        }
        return run();
      }
      const ordinal = ++nextOrdinal,
        startedAt = safeNow();
      active.set(ordinal, operation);
      if (active.size > 1) cohortAmbiguous = true;
      publishMarker();
      try {
        io.appendFact({
          version: 1,
          source: "runtime",
          event: "started",
          ordinal,
          operation,
        });
      } catch {
        // Best effort only.
      }
      try {
        const result = await run();
        const settled: PrepareFact = {
          version: 1,
          source: "runtime",
          event: "settled",
          ordinal,
          operation,
          outcome: "success",
          phase: safePhase(ordinal),
          elapsedMs: safeElapsed(startedAt, safeNow()),
        };
        try {
          io.appendFact(settled);
        } catch {
          // Best effort only.
        }
        return result;
      } catch (error) {
        const settled: PrepareFact = {
          version: 1,
          source: "runtime",
          event: "settled",
          ordinal,
          operation,
          outcome: "failure",
          phase: safePhase(ordinal),
          elapsedMs: safeElapsed(startedAt, safeNow()),
          errorClass: errorClass(error),
        };
        try {
          io.appendFact(settled);
        } catch {
          // Preserve the original thrown value exactly.
        }
        throw error;
      } finally {
        active.delete(ordinal);
        if (active.size === 0) cohortAmbiguous = false;
        publishMarker();
      }
    },
  };
}

function appendFact(home: string, fact: PrepareFact): void {
  const path = join(home, CODEX_CHAT_PREPARE_FACTS_FILE),
    line = `${JSON.stringify(fact)}\n`,
    lineBytes = Buffer.byteLength(line, "utf8");
  if (lineBytes > 384) return;
  try {
    if (!existsSync(path)) return;
    const size = statSync(path).size;
    if (size + lineBytes > CODEX_CHAT_PREPARE_FACTS_MAX_BYTES) return;
    const existing = readFileSync(path, "utf8");
    if (
      existing.length > CODEX_CHAT_PREPARE_FACTS_MAX_BYTES ||
      existing.split("\n").filter(Boolean).length >=
        CODEX_CHAT_PREPARE_FACTS_MAX_ROWS
    )
      return;
    appendFileSync(path, line, { encoding: "utf8" });
  } catch {
    // Diagnostic persistence is deliberately best effort.
  }
}

function readFacts(home: string): ProbeFactRead {
  const path = join(home, CODEX_CHAT_PREPARE_FACTS_FILE);
  try {
    const size = statSync(path).size;
    if (size > CODEX_CHAT_PREPARE_FACTS_MAX_BYTES)
      return { state: "unavailable" };
    const text = readFileSync(path, "utf8"),
      lines = text.split("\n").filter(Boolean);
    if (lines.length > CODEX_CHAT_PREPARE_FACTS_MAX_ROWS)
      return { state: "unavailable" };
    const facts: PrepareFact[] = [];
    for (const line of lines) {
      const parsed = prepareFactSchema.safeParse(JSON.parse(line));
      if (!parsed.success) return { state: "unavailable" };
      facts.push(parsed.data as PrepareFact);
    }
    return { state: "available", facts };
  } catch {
    return { state: "unavailable" };
  }
}

export type WriteFixtureOwnerOnly = (file: string, content: string) => void;

export function createFilePrepareDiagnosticIo(
  home: string,
  writeOwnerOnly: WriteFixtureOwnerOnly,
): PrepareDiagnosticIo {
  const markerPath = join(home, CODEX_CHAT_PREPARE_MARKER_FILE);
  return {
    now: () => performance.now(),
    writeMarker(marker) {
      const text = JSON.stringify(marker);
      if (Buffer.byteLength(text, "utf8") > CODEX_CHAT_PREPARE_MARKER_MAX_BYTES)
        throw new Error("Diagnostic marker exceeded its bound.");
      writeOwnerOnly(markerPath, text);
    },
    appendFact: (fact) => appendFact(home, fact),
    readFacts: () => readFacts(home),
  };
}

export function initializePrepareDiagnosticFiles(
  home: string,
  writeOwnerOnly: WriteFixtureOwnerOnly,
): void {
  try {
    writeOwnerOnly(
      join(home, CODEX_CHAT_PREPARE_MARKER_FILE),
      JSON.stringify({ version: 1, state: "idle" }),
    );
    writeOwnerOnly(join(home, CODEX_CHAT_PREPARE_FACTS_FILE), "");
  } catch {
    // The restart fixture must remain usable when diagnostics cannot be saved.
  }
}

function readCurrentMarker(home: string): ActiveMarker | null {
  const path = join(home, CODEX_CHAT_PREPARE_MARKER_FILE);
  try {
    const size = statSync(path).size;
    if (size > CODEX_CHAT_PREPARE_MARKER_MAX_BYTES) return null;
    const parsed = activeMarkerSchema.safeParse(
      JSON.parse(readFileSync(path, "utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Called only by the inert CLI stand-in for its fixed version/help branches. */
export function recordProbeFact(
  home: string,
  probe: ProbeName,
  event: "started" | "completed",
  elapsedMs?: number,
): void {
  const marker = readCurrentMarker(home),
    correlation: ProbeCorrelation | null =
      marker?.state === "single"
        ? "single"
        : marker?.state === "overlap"
          ? "overlap"
          : null;
  if (correlation === null) return;
  appendFact(home, {
    version: 1,
    source: "probe",
    event,
    probe,
    correlation,
    ...(correlation === "single" && marker?.state === "single"
      ? { ordinal: marker.ordinal }
      : {}),
    ...(event === "completed"
      ? {
          elapsedMs: Math.max(0, Math.min(600_000, Math.round(elapsedMs ?? 0))),
        }
      : {}),
  });
}
