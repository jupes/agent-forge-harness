type Signal = "SIGABRT" | "SIGBREAK" | "SIGINT" | "SIGTERM";
type FieldValue =
  | boolean
  | number
  | Signal
  | null
  | "unreported"
  | "nonfinite"
  | "invalid"
  | "other-reported";

export interface WindowsSidLookupDiagnosticInput {
  failed: boolean;
  alias: string;
  elapsedMs: number;
  result: unknown;
}

export type WindowsSidLookupDiagnosticSink = (row: string) => void;

type RecordValue = Record<string, unknown>;

const owns = (record: RecordValue, key: string): boolean =>
  Object.hasOwn(record, key);

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): RecordValue | undefined {
  return isRecord(value) ? value : undefined;
}

function field(
  record: RecordValue,
  key: string,
): { present: boolean; value: unknown } {
  const present = owns(record, key);
  return { present, value: present ? record[key] : undefined };
}

function flag(record: RecordValue, key: string): FieldValue {
  const item = field(record, key);
  if (!item.present) return "unreported";
  if (item.value === null) return null;
  return typeof item.value === "boolean" ? item.value : "invalid";
}

function exitCode(record: RecordValue): FieldValue {
  const item = field(record, "exitCode");
  if (!item.present) return "unreported";
  if (item.value === null) return null;
  if (typeof item.value !== "number") return "invalid";
  if (!Number.isFinite(item.value)) return "nonfinite";
  return Number.isSafeInteger(item.value) ? item.value : "invalid";
}

function signalCode(record: RecordValue): FieldValue {
  const item = field(record, "signalCode");
  if (!item.present) return "unreported";
  if (item.value === null) return null;
  if (typeof item.value !== "string") return "invalid";
  switch (item.value) {
    case "SIGABRT":
    case "SIGBREAK":
    case "SIGINT":
    case "SIGTERM":
      return item.value;
    default:
      return "other-reported";
  }
}

function byteLength(record: RecordValue, key: string): FieldValue {
  const item = field(record, key);
  if (!item.present) return "unreported";
  if (item.value === null) return null;
  if (!(item.value instanceof Uint8Array)) return "invalid";
  const length: unknown = item.value.byteLength;
  return typeof length === "number" &&
    Number.isSafeInteger(length) &&
    length >= 0
    ? length
    : "invalid";
}

function diagnosticRow(
  input: WindowsSidLookupDiagnosticInput,
): string | undefined {
  if (!input.failed || !/^[A-Z]{2}$/.test(input.alias)) return undefined;
  const result = recordValue(input.result);
  if (result === undefined) return undefined;
  const row = {
    phase: "sddl-alias-sid",
    alias: input.alias,
    elapsedMs:
      Number.isFinite(input.elapsedMs) && input.elapsedMs >= 0
        ? input.elapsedMs
        : "invalid",
    exitCode: exitCode(result),
    success: flag(result, "success"),
    signalCode: signalCode(result),
    exitedDueToTimeout: flag(result, "exitedDueToTimeout"),
    exitedDueToMaxBuffer: flag(result, "exitedDueToMaxBuffer"),
    stdoutBytes: byteLength(result, "stdout"),
    stderrBytes: byteLength(result, "stderr"),
  };
  const line = JSON.stringify(row) + "\n";
  return new TextEncoder().encode(line).byteLength <= 2048 ? line : undefined;
}

/** Emits only fixed-schema facts for a failed dynamic Windows SID lookup. */
export function emitWindowsSidLookupDiagnostic(
  input: WindowsSidLookupDiagnosticInput,
  sink: WindowsSidLookupDiagnosticSink,
): void {
  try {
    const row = diagnosticRow(input);
    if (row !== undefined) sink(row);
  } catch {
    // Diagnostic projection and output must not affect the ACL oracle.
  }
}

/** Emits best-effort evidence, then rethrows the exact original failure object. */
export function rethrowWindowsSidLookupFailure(
  error: Error,
  input: WindowsSidLookupDiagnosticInput,
  sink: WindowsSidLookupDiagnosticSink,
): never {
  emitWindowsSidLookupDiagnostic(input, sink);
  throw error;
}
