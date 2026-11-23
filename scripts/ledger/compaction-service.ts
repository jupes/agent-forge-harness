import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import {
  type LedgerCompactionRecord,
  type LedgerCompactionStatus,
  ledgerCompactionRecordSchema,
  ledgerCompactionRequestSchema,
} from "../desktop/ledger-compaction-protocol";
import { ensurePrivateHome, readHomeFileBounded } from "../hearth/home-guard";
import { writeOwnerOnly } from "../hearth/token";
import { withQueueLock } from "../scheduler/queue-lock";
import { backupLedger, compact, RETENTION_DAYS } from "./backup";

export class LedgerCompactionError extends Error {
  constructor(
    readonly status: 400 | 409 | 503 | 504,
    message: string,
  ) {
    super(message);
  }
}
export interface LedgerCompactionOptions {
  home: string;
  /** Trusted bound ledger; no request may select a path, cutoff or retention. */
  path: string;
  now?: () => Date;
  /** Synchronous fixture seams only. */
  backup?: typeof backupLedger;
  compact?: typeof compact;
  write?: typeof writeOwnerOnly;
}
const MARKER = "ledger-compaction-v1\n";
const unavailable = () =>
  new LedgerCompactionError(
    503,
    "Ledger compaction history is unavailable. Compaction is held; no automatic reset is permitted.",
  );
const unconfirmed = () =>
  new LedgerCompactionError(
    504,
    "Ledger compaction could not be confirmed. It may have happened. Check compaction status; do not repeat the request.",
  );

/** Durable latest intent, shared by Settings instances using this home. Construction/read are inert. */
export function createLedgerCompactionService(
  options: LedgerCompactionOptions,
) {
  const { home, path } = options;
  const file = join(home, "ledger-compaction.json");
  const marker = join(home, "ledger-compaction.initialized");
  const ledgerKey = createHash("sha256").update(resolve(path)).digest("hex");
  let active = false,
    closed = false,
    held = false;
  const now = options.now ?? (() => new Date());
  function readRecord(): LedgerCompactionRecord {
    try {
      const stored = readHomeFileBounded(home, file, 4096);
      const initialized = readHomeFileBounded(home, marker, 64);
      if (stored.problem || initialized.problem) throw unavailable();
      if (stored.text === null && initialized.text === null)
        return { version: 1, ledgerKey, revision: 0, last: null };
      if (initialized.text !== MARKER || stored.text === null)
        throw unavailable();
      const record = ledgerCompactionRecordSchema.parse(
        JSON.parse(stored.text),
      );
      if (
        record.ledgerKey !== ledgerKey ||
        record.revision === 0 ||
        !record.last ||
        Date.parse(record.last.cutoffAt) !==
          Date.parse(record.last.startedAt) - RETENTION_DAYS * 86_400_000
      )
        throw unavailable();
      return record;
    } catch {
      throw unavailable();
    }
  }
  function read(): LedgerCompactionStatus {
    const record = readRecord();
    return {
      record,
      canCompact:
        active && !closed && !held && record.last?.state !== "pending",
      checkedAt: now().toISOString(),
    };
  }
  function publish(record: LedgerCompactionRecord) {
    const candidate = ledgerCompactionRecordSchema.parse(record);
    (options.write ?? writeOwnerOnly)(file, JSON.stringify(candidate));
    if (JSON.stringify(readRecord()) !== JSON.stringify(candidate))
      throw unconfirmed();
  }
  return {
    start() {
      if (!closed) active = true;
    },
    close() {
      closed = true;
      active = false;
    },
    read,
    async run(raw: unknown): Promise<LedgerCompactionStatus> {
      const parsed = ledgerCompactionRequestSchema.safeParse(raw);
      if (!parsed.success)
        throw new LedgerCompactionError(
          400,
          "Invalid compaction acknowledgement or revision.",
        );
      if (!active || closed)
        throw new LedgerCompactionError(
          503,
          "Hearth is not accepting compaction requests.",
        );
      if (held) throw unconfirmed();
      let attempted = false;
      try {
        ensurePrivateHome(home);
        const result = await withQueueLock(
          join(home, "ledger-compaction.lock"),
          async () => {
            if (!active || closed)
              throw new LedgerCompactionError(
                503,
                "Hearth is not accepting compaction requests.",
              );
            if (held) throw unconfirmed();
            const current = readRecord(),
              request = parsed.data;
            if (request.expectedLedgerKey !== ledgerKey)
              throw new LedgerCompactionError(
                409,
                "The reviewed ledger changed. Check compaction status before reviewing a new acknowledgement.",
              );
            if (current.last?.state === "pending") throw unconfirmed();
            if (
              current.revision !== request.expectedRevision ||
              current.last?.requestId === request.requestId
            )
              throw new LedgerCompactionError(
                409,
                "Compaction status changed. Check status and review a new acknowledgement before another operation.",
              );
            const date = now();
            const pending: LedgerCompactionRecord = {
              version: 1,
              ledgerKey,
              revision: current.revision + 1,
              last: {
                state: "pending",
                requestId: request.requestId,
                startedAt: date.toISOString(),
                cutoffAt: new Date(
                  date.getTime() - RETENTION_DAYS * 86_400_000,
                ).toISOString(),
              },
            };
            // Spend and verify durable intent BEFORE any snapshot or compaction.
            attempted = true;
            (options.write ?? writeOwnerOnly)(marker, MARKER);
            publish(pending);
            const upkeep = { path, now: () => new Date(date.getTime()) };
            if (closed) throw unconfirmed();
            (options.backup ?? backupLedger)(upkeep);
            if (closed) throw unconfirmed();
            const counts = (options.compact ?? compact)(upkeep);
            if (!pending.last) throw unconfirmed();
            publish({
              ...pending,
              last: { ...pending.last, state: "completed", ...counts },
            });
            return read();
          },
          { waitMs: 1000 },
        );
        if (!result.ok)
          throw new LedgerCompactionError(
            503,
            "Compaction is busy or unavailable. No upkeep was started by this request.",
          );
        return result.value;
      } catch (error) {
        if (attempted) {
          held = true;
          throw unconfirmed();
        }
        if (error instanceof LedgerCompactionError) throw error;
        throw unavailable();
      }
    },
  };
}
