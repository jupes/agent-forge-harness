/** Pure journal transitions over a bounded storage boundary; no filesystem adapter. */
import type {
  SmithConfigCreateReceipt,
  SmithConfigCreateRefusal,
  SmithConfigCreateRequest,
  SmithConfigPreview,
  SmithCreateIdentityIndex,
} from "../../types/smith-config-create";
import {
  SMITH_CREATE_JOURNAL_LIMITS as limits,
  parseSmithCreateJournalText,
  SMITH_CREATE_JOURNAL_FILES,
  type SmithCreateJournalFile,
  type SmithCreateOwner,
  type SmithCreatePhase,
  smithCreateInputHash,
  smithCreateIntentSchema,
  smithCreateJournalHash,
  smithCreateOwnerHash,
  smithCreateOwnerSchema,
  smithCreatePhaseSchema,
} from "./smith-create-journal-protocol";
import {
  smithConfigCreateReceiptSchema,
  smithConfigCreateRequestSchema,
  smithConfigPreviewSchema,
  smithConfigRequestIdSchema,
  smithCreateIdentityIndexSchema,
} from "./smith-create-protocol";

export interface SmithCreateJournalEntry {
  name: string;
  bytes: number;
  plain: boolean;
}
/**
 * Metadata iterators must stream, never preallocate an unbounded listing. Reads
 * must verify a private plain file and enforce the supplied cap before allocation
 * through that same opened object. Writes are synchronous, atomic, owner-only and
 * create-once. exclusive owns one checked persistent private mutex. Only a new
 * reserve calls it; GET never initializes storage or opens a database.
 */
export interface SmithCreateJournalStorage {
  inspect(requestId: string): Iterable<SmithCreateJournalEntry> | null;
  operations(): Iterable<{
    requestId: string;
    entries: Iterable<SmithCreateJournalEntry>;
  }>;
  read(
    requestId: string,
    entry: SmithCreateJournalEntry,
    maxBytes: number,
  ): string;
  writeOnce(
    requestId: string,
    file: SmithCreateJournalFile,
    text: string,
  ): void;
  exclusive<T>(work: () => Promise<T>): Promise<T>;
}

export interface SmithCreateJournalWriter {
  readonly original: Readonly<SmithConfigCreateRequest>;
  prepare(preview: SmithConfigPreview): void;
  attempted(): void;
  confirm(publication: {
    file: string;
    created: boolean;
    sha256: string;
  }): void;
  refuse(reason: SmithConfigCreateRefusal): void;
  unconfirmed(): void;
}

export class SmithCreateJournalError extends Error {
  constructor(
    readonly reason: "held" | "conflict",
    message: string,
  ) {
    super(message);
  }
}
function held(): never {
  throw new SmithCreateJournalError(
    "held",
    "The private Smith create original is held or unavailable; it was not replayed.",
  );
}
function conflict(): never {
  throw new SmithCreateJournalError(
    "conflict",
    "The Smith create UUID belongs to another original or owner.",
  );
}
function checkedId(value: string): string {
  const checked = smithConfigRequestIdSchema.safeParse(value);
  if (!checked.success) held();
  return checked.data;
}
function metadata(entries: Iterable<SmithCreateJournalEntry>) {
  const found = new Map<SmithCreateJournalFile, SmithCreateJournalEntry>();
  let count = 0,
    bytes = 0;
  for (const entry of entries) {
    if (
      ++count > limits.filesPerOperation ||
      !entry.plain ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      entry.bytes > limits.fileBytes
    )
      held();
    const name = SMITH_CREATE_JOURNAL_FILES.find((name) => name === entry.name);
    if (!name || found.has(name)) held();
    bytes += entry.bytes;
    if (bytes > limits.operationBytes) held();
    found.set(name, { ...entry });
  }
  return { found, count, bytes };
}
function frozen<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const part of Object.values(value)) frozen(part);
    Object.freeze(value);
  }
  return value;
}

export function createSmithCreateJournalCore(
  storage: SmithCreateJournalStorage,
  trustedOwner: SmithCreateOwner,
  now: () => string = () => new Date().toISOString(),
) {
  const checkedOwner = smithCreateOwnerSchema.safeParse(trustedOwner);
  if (!checkedOwner.success) held();
  const owner = frozen(checkedOwner.data),
    ownerScopeHash = smithCreateOwnerHash(owner);

  const chain = (requestId: string, allowOtherOwner = false) => {
    const listing = storage.inspect(requestId);
    if (listing === null) return null;
    const files = metadata(listing).found,
      hashes = new Map<SmithCreateJournalFile, string>();
    const read = (file: SmithCreateJournalFile): unknown => {
      const entry = files.get(file);
      if (!entry) held();
      const text = storage.read(requestId, entry, limits.fileBytes);
      if (
        text.length > limits.fileBytes ||
        new TextEncoder().encode(text).byteLength !== entry.bytes
      )
        held();
      const value = parseSmithCreateJournalText(text);
      hashes.set(file, smithCreateJournalHash(text));
      return value;
    };
    if (!files.has("intent.json")) held();
    const checkedIntent = smithCreateIntentSchema.safeParse(
      read("intent.json"),
    );
    if (!checkedIntent.success) held();
    const intent = checkedIntent.data;
    if (
      intent.requestId !== requestId ||
      intent.ownerScopeHash !== smithCreateOwnerHash(intent.owner)
    )
      held();
    const belongsToOwner = intent.ownerScopeHash === ownerScopeHash;
    if (!belongsToOwner && !allowOtherOwner) conflict();
    const phases: Partial<Record<SmithCreatePhase["kind"], SmithCreatePhase>> =
      {};
    for (const file of files.keys()) {
      if (file === "intent.json") continue;
      const checked = smithCreatePhaseSchema.safeParse(read(file));
      if (!checked.success) held();
      const value = checked.data;
      if (
        `${value.kind}.json` !== file ||
        value.requestId !== requestId ||
        value.ownerScopeHash !== intent.ownerScopeHash ||
        value.inputHash !== intent.inputHash ||
        value.intentHash !== hashes.get("intent.json")
      )
        held();
      phases[value.kind] = value;
    }
    const claimed = phases.claimed?.kind === "claimed" ? phases.claimed : null,
      prepared = phases.prepared?.kind === "prepared" ? phases.prepared : null,
      attempted =
        phases.attempted?.kind === "attempted" ? phases.attempted : null,
      confirmed =
        phases.confirmed?.kind === "confirmed" ? phases.confirmed : null,
      refused = phases.refused?.kind === "refused" ? phases.refused : null,
      unconfirmed =
        phases.unconfirmed?.kind === "unconfirmed" ? phases.unconfirmed : null,
      preparedHash = hashes.get("prepared.json") ?? null,
      attemptedHash = hashes.get("attempted.json") ?? null;
    if (
      (claimed && intent.version !== 2) ||
      (intent.version === 2 && prepared && !claimed) ||
      (intent.version === 2 && attempted && !claimed) ||
      (attempted && (!prepared || attempted.preparedHash !== preparedHash)) ||
      (confirmed &&
        (!prepared ||
          !attempted ||
          confirmed.preparedHash !== preparedHash ||
          confirmed.attemptedHash !== attemptedHash)) ||
      (refused &&
        (attempted || unconfirmed || refused.preparedHash !== preparedHash)) ||
      (intent.version === 2 &&
        refused &&
        !claimed &&
        (refused.reason !== "cancelled-before-attempt" ||
          refused.preparedHash !== null)) ||
      (unconfirmed &&
        (!prepared ||
          unconfirmed.preparedHash !== preparedHash ||
          unconfirmed.attemptedHash !== attemptedHash)) ||
      (confirmed && (refused || unconfirmed))
    )
      held();
    const preview = prepared?.preview ?? null;
    const result = confirmed
      ? {
          phase: "confirmed",
          completedAt: confirmed.at,
          preview,
          publication: confirmed.publication,
        }
      : refused
        ? {
            phase: "refused",
            refusedAt: refused.at,
            reason: refused.reason,
            preview,
          }
        : {
            phase: "held",
            stage: unconfirmed
              ? "unconfirmed"
              : attempted
                ? "attempted"
                : prepared
                  ? "prepared"
                  : claimed
                    ? "claimed"
                    : intent.version === 2
                      ? "reserved"
                      : "intent",
            preview,
          };
    const receipt = smithConfigCreateReceiptSchema.safeParse({
      version: 1,
      requestId,
      ownerScopeHash: intent.ownerScopeHash,
      inputHash: intent.inputHash,
      createdAt: intent.at,
      original: intent.original,
      result,
    });
    if (!receipt.success) held();
    return { receipt: receipt.data, intent, hashes, belongsToOwner };
  };

  const assertRoom = () => {
    let count = 0,
      entries = 0,
      bytes = 0;
    const seen = new Set<string>();
    for (const operation of storage.operations()) {
      if (
        ++count >= limits.operations ||
        !smithConfigRequestIdSchema.safeParse(operation.requestId).success ||
        seen.has(operation.requestId)
      )
        held();
      seen.add(operation.requestId);
      const found = metadata(operation.entries);
      entries += found.count;
      bytes += found.bytes;
      if (entries > limits.entries || bytes > limits.bytes) held();
    }
  };

  const safeChain = (requestId: string, allowOtherOwner = false) => {
    try {
      return chain(requestId, allowOtherOwner);
    } catch (error) {
      if (error instanceof SmithCreateJournalError) throw error;
      held();
    }
  };
  const fingerprint = (hashes: ReadonlyMap<SmithCreateJournalFile, string>) =>
    JSON.stringify(
      [...hashes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );

  const readOriginal = (requestId: string): SmithConfigCreateReceipt | null =>
    safeChain(checkedId(requestId))?.receipt ?? null;

  const scan = () => {
    let count = 0,
      entries = 0,
      bytes = 0;
    const seen = new Set<string>(),
      rows: NonNullable<ReturnType<typeof chain>>[] = [];
    for (const operation of storage.operations()) {
      if (
        ++count > limits.operations ||
        !smithConfigRequestIdSchema.safeParse(operation.requestId).success ||
        seen.has(operation.requestId)
      )
        held();
      seen.add(operation.requestId);
      const found = metadata(operation.entries);
      entries += found.count;
      bytes += found.bytes;
      if (entries > limits.entries || bytes > limits.bytes) held();
      const row = safeChain(operation.requestId, true);
      if (!row) held();
      rows.push(row);
    }
    return rows;
  };

  const listOriginals = (): SmithCreateIdentityIndex => {
    const entries = scan()
      .filter((row) => row.belongsToOwner)
      .map(({ receipt, intent }) => {
        const result = receipt.result;
        const state =
          result.phase === "confirmed" || result.phase === "refused"
            ? result.phase
            : result.stage === "reserved"
              ? "reserved"
              : "held";
        const stage =
          result.phase !== "held"
            ? "terminal"
            : result.stage === "intent"
              ? "legacy"
              : result.stage;
        return {
          requestId: intent.requestId,
          ownerScopeHash: intent.ownerScopeHash,
          inputHash: intent.inputHash,
          target: intent.original.target,
          state,
          stage,
          createdAt: intent.at,
        };
      })
      .sort((a, b) => a.requestId.localeCompare(b.requestId));
    const checked = smithCreateIdentityIndexSchema.safeParse({
      version: 1,
      complete: true,
      ownerScopeHash,
      entries,
    });
    if (!checked.success) held();
    return checked.data;
  };

  const assertOwnerSlotAvailable = (except?: string) => {
    for (const row of scan()) {
      if (!row.belongsToOwner || row.intent.requestId === except) continue;
      if (row.receipt.result.phase === "held") conflict();
    }
  };

  const encode = (record: unknown) => {
    const text = JSON.stringify(record);
    if (
      text.length > limits.fileBytes ||
      new TextEncoder().encode(text).byteLength > limits.fileBytes
    )
      held();
    return text;
  };

  const makeIntent = (original: Readonly<SmithConfigCreateRequest>) => {
    const intent = smithCreateIntentSchema.safeParse({
      version: 2,
      kind: "intent",
      admission: "reserved",
      requestId: original.requestId,
      ownerScopeHash,
      inputHash: smithCreateInputHash(original),
      owner,
      original,
      at: now(),
    });
    if (!intent.success) held();
    return intent.data;
  };

  const reserveOriginal = async (
    value: unknown,
  ): Promise<SmithConfigCreateReceipt> => {
    const parsed = smithConfigCreateRequestSchema.safeParse(value);
    if (!parsed.success) held();
    const original = frozen(parsed.data),
      requestId = original.requestId,
      inputHash = smithCreateInputHash(original);
    const existing = () => {
      const found = safeChain(requestId);
      if (found && found.intent.inputHash !== inputHash) conflict();
      return found;
    };
    const prior = existing();
    if (prior) return prior.receipt;
    return storage
      .exclusive(async () => {
        const previous = existing();
        if (previous) return previous.receipt;
        assertOwnerSlotAvailable(requestId);
        assertRoom();
        const initial = encode(makeIntent(original));
        storage.writeOnce(requestId, "intent.json", initial);
        const confirmed = existing();
        if (
          !confirmed ||
          confirmed.hashes.get("intent.json") !==
            smithCreateJournalHash(initial)
        )
          held();
        return confirmed.receipt;
      })
      .catch((error: unknown) => {
        if (error instanceof SmithCreateJournalError) throw error;
        held();
      });
  };

  const retireReserved = async (
    requestIdValue: string,
    inputHash: string,
  ): Promise<SmithConfigCreateReceipt> => {
    const requestId = checkedId(requestIdValue);
    if (!/^[a-f0-9]{64}$/.test(inputHash)) held();
    return storage
      .exclusive(async () => {
        const found = safeChain(requestId);
        if (!found || found.intent.inputHash !== inputHash) conflict();
        if (
          found.receipt.result.phase !== "held" ||
          found.receipt.result.stage !== "reserved" ||
          found.intent.version !== 2
        )
          return found.receipt;
        const text = encode({
          version: 1,
          kind: "refused",
          requestId,
          ownerScopeHash,
          inputHash,
          intentHash: found.hashes.get("intent.json"),
          at: now(),
          preparedHash: null,
          reason: "cancelled-before-attempt",
        });
        storage.writeOnce(requestId, "refused.json", text);
        const result = safeChain(requestId);
        if (
          !result ||
          result.hashes.get("refused.json") !== smithCreateJournalHash(text)
        )
          held();
        return result.receipt;
      })
      .catch((error: unknown) => {
        if (error instanceof SmithCreateJournalError) throw error;
        held();
      });
  };

  const claim = async (
    value: unknown,
    work: (writer: SmithCreateJournalWriter) => void | Promise<void>,
  ): Promise<SmithConfigCreateReceipt> => {
    const parsed = smithConfigCreateRequestSchema.safeParse(value);
    if (!parsed.success) held();
    const original = frozen(parsed.data),
      requestId = original.requestId,
      inputHash = smithCreateInputHash(original);
    const existing = () => {
      const found = safeChain(requestId);
      if (found && found.intent.inputHash !== inputHash) conflict();
      return found;
    };
    const prior = existing();
    if (
      prior &&
      (prior.receipt.result.phase !== "held" ||
        prior.receipt.result.stage !== "reserved" ||
        prior.intent.version !== 2)
    )
      return prior.receipt;
    return storage
      .exclusive(async () => {
        let previous = existing();
        if (
          previous &&
          (previous.receipt.result.phase !== "held" ||
            previous.receipt.result.stage !== "reserved" ||
            previous.intent.version !== 2)
        )
          return previous.receipt;
        if (!previous) {
          assertOwnerSlotAvailable(requestId);
          assertRoom();
          const initial = encode(makeIntent(original));
          storage.writeOnce(requestId, "intent.json", initial);
          previous = existing();
          if (
            !previous ||
            previous.hashes.get("intent.json") !==
              smithCreateJournalHash(initial)
          )
            held();
        }
        if (
          previous.receipt.result.phase !== "held" ||
          previous.receipt.result.stage !== "reserved"
        )
          return previous.receipt;
        assertOwnerSlotAvailable(requestId);
        const claimText = encode({
          version: 1,
          kind: "claimed",
          requestId,
          ownerScopeHash,
          inputHash,
          intentHash: previous.hashes.get("intent.json"),
          at: now(),
        });
        storage.writeOnce(requestId, "claimed.json", claimText);
        let current = safeChain(requestId);
        if (
          !current ||
          current.hashes.get("claimed.json") !==
            smithCreateJournalHash(claimText)
        )
          held();
        let active = true,
          poisoned = false,
          attemptedBegan = false;
        const check = () => {
          try {
            const owned = current;
            if (
              !active ||
              poisoned ||
              !owned ||
              owned.receipt.result.phase !== "held"
            )
              held();
            const fresh = existing();
            if (
              !fresh ||
              fingerprint(fresh.hashes) !== fingerprint(owned.hashes)
            )
              held();
            return fresh;
          } catch {
            poisoned = true;
            held();
          }
        };
        const save = (record: unknown) => {
          try {
            const checked = smithCreatePhaseSchema.safeParse(record);
            if (!checked.success) held();
            const file: SmithCreateJournalFile = `${checked.data.kind}.json`,
              text = encode(checked.data);
            storage.writeOnce(requestId, file, text);
            const next = safeChain(requestId);
            if (!next || next.hashes.get(file) !== smithCreateJournalHash(text))
              held();
            current = next;
          } catch {
            poisoned = true;
            held();
          }
        };
        const base = () => ({
          version: 1,
          requestId,
          ownerScopeHash,
          inputHash,
          intentHash: current?.hashes.get("intent.json"),
          at: now(),
        });
        const writer: SmithCreateJournalWriter =
          Object.freeze<SmithCreateJournalWriter>({
            original,
            prepare(preview: SmithConfigPreview) {
              const found = check(),
                checked = smithConfigPreviewSchema.safeParse(preview);
              if (
                found.receipt.result.phase !== "held" ||
                found.receipt.result.stage !== "claimed" ||
                !checked.success
              )
                held();
              if (
                !smithConfigCreateReceiptSchema.safeParse({
                  ...found.receipt,
                  result: {
                    phase: "held",
                    stage: "prepared",
                    preview: checked.data,
                  },
                }).success
              )
                held();
              save({ ...base(), kind: "prepared", preview: checked.data });
            },
            attempted() {
              const found = check();
              if (
                found.receipt.result.phase !== "held" ||
                found.receipt.result.stage !== "prepared"
              )
                held();
              attemptedBegan = true;
              save({
                ...base(),
                kind: "attempted",
                preparedHash: found.hashes.get("prepared.json"),
              });
            },
            confirm(publication) {
              const found = check();
              if (
                !attemptedBegan ||
                found.receipt.result.phase !== "held" ||
                found.receipt.result.stage !== "attempted"
              )
                held();
              if (
                !smithConfigCreateReceiptSchema.safeParse({
                  ...found.receipt,
                  result: {
                    phase: "confirmed",
                    completedAt: now(),
                    preview: found.receipt.result.preview,
                    publication,
                  },
                }).success
              )
                held();
              save({
                ...base(),
                kind: "confirmed",
                preparedHash: found.hashes.get("prepared.json"),
                attemptedHash: found.hashes.get("attempted.json"),
                publication,
              });
            },
            refuse(reason) {
              const found = check();
              if (
                attemptedBegan ||
                found.hashes.has("attempted.json") ||
                found.hashes.has("unconfirmed.json")
              )
                held();
              save({
                ...base(),
                kind: "refused",
                preparedHash: found.hashes.get("prepared.json") ?? null,
                reason,
              });
            },
            unconfirmed() {
              const found = check();
              if (
                !attemptedBegan ||
                found.receipt.result.phase !== "held" ||
                found.receipt.result.stage !== "attempted"
              )
                held();
              save({
                ...base(),
                kind: "unconfirmed",
                preparedHash: found.hashes.get("prepared.json"),
                attemptedHash: found.hashes.get("attempted.json") ?? null,
              });
            },
          });
        try {
          await work(writer);
          return safeChain(requestId)?.receipt ?? held();
        } finally {
          active = false;
        }
      })
      .catch((error: unknown) => {
        if (error instanceof SmithCreateJournalError) throw error;
        held();
      });
  };
  return {
    readOriginal,
    listOriginals,
    reserveOriginal,
    retireReserved,
    claim,
    /** Existing in-process callers claim atomically; new UI callers reserve first. */
    reserve: claim,
  };
}
