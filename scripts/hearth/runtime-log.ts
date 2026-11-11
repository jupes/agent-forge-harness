import { randomUUID } from "node:crypto";
import {
  LEDGER_EVENT_KINDS,
  type LedgerEventInput,
  type LedgerEventKind,
} from "../../types/hearth";
import {
  HEARTH_LOG_LIMITS,
  type HearthLogCode,
  type HearthLogEntry,
  type HearthLogSnapshot,
  hearthLogCodeSchema,
  hearthLogEntrySchema,
  hearthLogLevel,
  hearthLogSnapshotSchema,
} from "../desktop/app-hearth-log-protocol";
import type { AppendResult } from "../ledger/append";

const unavailable = () => Error("Hearth service log could not be verified.");
/** Observational, bounded and current-instance only; never writes to the ledger or disk. */
export function createHearthRuntimeLog(
  controls: { now?: () => Date; generation?: () => string } = {},
) {
  const now = controls.now ?? (() => new Date()),
    entries: HearthLogEntry[] = [];
  let generation = "",
    startedAt = "",
    latestSequence = 0,
    failed = false;
  try {
    generation = (controls.generation ?? randomUUID)();
    startedAt = now().toISOString();
    hearthLogSnapshotSchema.parse({
      version: 1,
      generation,
      startedAt,
      checkedAt: startedAt,
      latestSequence: 0,
      retainedCount: 0,
      evictedCount: 0,
      omittedRetainedCount: 0,
      entries: [],
    });
  } catch {
    failed = true;
  }
  return {
    markUnavailable() {
      failed = true;
    },
    record(rawCode: HearthLogCode, eventKind: LedgerEventKind | null = null) {
      if (failed) return;
      try {
        if (latestSequence >= Number.MAX_SAFE_INTEGER) throw unavailable();
        const code = hearthLogCodeSchema.parse(rawCode),
          entry = hearthLogEntrySchema.parse({
            sequence: latestSequence + 1,
            at: now().toISOString(),
            code,
            level: hearthLogLevel(code),
            eventKind,
          });
        entries.push(entry);
        latestSequence++;
        if (entries.length > HEARTH_LOG_LIMITS.retained) entries.shift();
      } catch {
        failed = true;
      }
    },
    read(): HearthLogSnapshot {
      if (failed) throw unavailable();
      try {
        const returned = entries
          .slice(-HEARTH_LOG_LIMITS.returned)
          .map((entry) => ({ ...entry }));
        return hearthLogSnapshotSchema.parse({
          version: 1,
          generation,
          startedAt,
          checkedAt: now().toISOString(),
          latestSequence,
          retainedCount: entries.length,
          evictedCount: latestSequence - entries.length,
          omittedRetainedCount: entries.length - returned.length,
          entries: returned,
        });
      } catch {
        failed = true;
        throw unavailable();
      }
    },
  };
}
type Log = ReturnType<typeof createHearthRuntimeLog>;
function ownData(value: unknown, key: string) {
  if (!value || typeof value !== "object")
    return { present: false, data: false, value: undefined };
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return {
    present: descriptor !== undefined,
    data: descriptor !== undefined && Object.hasOwn(descriptor, "value"),
    value:
      descriptor !== undefined && Object.hasOwn(descriptor, "value")
        ? (descriptor.value as unknown)
        : undefined,
  };
}
function classification(result: unknown): HearthLogCode {
  const ok = ownData(result, "ok"),
    id = ownData(result, "id"),
    duplicate = ownData(result, "duplicate");
  if (
    !ok.data ||
    (id.present && !id.data) ||
    (duplicate.present && !duplicate.data)
  )
    return "ledger.unverified";
  if (
    ok.value === true &&
    id.data &&
    typeof id.value === "number" &&
    Number.isSafeInteger(id.value) &&
    id.value > 0 &&
    !duplicate.present
  )
    return "ledger.inserted";
  if (
    ok.value === true &&
    !id.present &&
    duplicate.data &&
    duplicate.value === true
  )
    return "ledger.duplicate";
  if (ok.value === false && !id.present && !duplicate.present)
    return "ledger.failed";
  return "ledger.unverified";
}
/** No getters, payloads or error messages are evaluated for log classification. */
export function observeLedgerAppender(
  append: (event: LedgerEventInput) => AppendResult,
  log: Log,
): typeof append {
  const report = (event: LedgerEventInput, result: unknown, threw: boolean) => {
    try {
      const kind = ownData(event, "kind"),
        eventKind = kind.data
          ? (LEDGER_EVENT_KINDS.find((value) => value === kind.value) ?? null)
          : null;
      log.record(
        threw
          ? "ledger.thrown"
          : eventKind === null
            ? "ledger.unverified"
            : classification(result),
        eventKind,
      );
    } catch {
      try {
        log.markUnavailable();
      } catch {
        /* Even broken diagnostic observers cannot replace the original result. */
      }
    }
  };
  return (event) => {
    let result: AppendResult;
    try {
      result = append(event);
    } catch (error) {
      report(event, undefined, true);
      throw error;
    }
    report(event, result, false);
    return result;
  };
}
