/** Pure journal transitions over a bounded storage boundary; no filesystem adapter. */
import type {
  SmithConfigEditPreview,
  SmithConfigEditReceipt,
  SmithConfigEditRefusal,
  SmithConfigEditRequest,
} from "../../types/smith-config-edit";
import type {
  SmithCreateJournalEntry,
  SmithCreateJournalStorage,
} from "./smith-create-journal-core";
import {
  SMITH_EDIT_JOURNAL_LIMITS as limits,
  parseSmithEditJournalText,
  SMITH_EDIT_JOURNAL_FILES,
  type SmithEditJournalFile,
  type SmithEditOwner,
  type SmithEditPhase,
  smithEditInputHash,
  smithEditIntentSchema,
  smithEditJournalHash,
  smithEditOwnerHash,
  smithEditOwnerSchema,
  smithEditPhaseSchema,
} from "./smith-edit-journal-protocol";
import {
  smithConfigEditPreviewSchema,
  smithConfigEditReceiptSchema,
  smithConfigEditRequestIdSchema,
  smithConfigEditRequestSchema,
} from "./smith-edit-protocol";

export interface SmithEditJournalWriter {
  readonly original: Readonly<SmithConfigEditRequest>;
  prepare(preview: SmithConfigEditPreview): void;
  attempted(): void;
  confirm(publication: {
    file: string;
    created: boolean;
    sha256: string;
  }): void;
  refuse(reason: SmithConfigEditRefusal): void;
  unconfirmed(): void;
}

export class SmithEditJournalError extends Error {
  constructor(
    readonly reason: "held" | "conflict",
    message: string,
  ) {
    super(message);
  }
}
function held(): never {
  throw new SmithEditJournalError(
    "held",
    "The private Smith edit original is held or unavailable; it was not replayed.",
  );
}
function conflict(): never {
  throw new SmithEditJournalError(
    "conflict",
    "The Smith edit UUID belongs to another original or owner.",
  );
}
function checkedId(value: string): string {
  const checked = smithConfigEditRequestIdSchema.safeParse(value);
  if (!checked.success) held();
  return checked.data;
}
function metadata(entries: Iterable<SmithCreateJournalEntry>) {
  const found = new Map<SmithEditJournalFile, SmithCreateJournalEntry>();
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
    const name = SMITH_EDIT_JOURNAL_FILES.find((name) => name === entry.name);
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

export function createSmithEditJournalCore(
  storage: SmithCreateJournalStorage,
  trustedOwner: SmithEditOwner,
  now: () => string = () => new Date().toISOString(),
) {
  const checkedOwner = smithEditOwnerSchema.safeParse(trustedOwner);
  if (!checkedOwner.success) held();
  const owner = frozen(checkedOwner.data),
    ownerScopeHash = smithEditOwnerHash(owner);

  const chain = (requestId: string) => {
    const listing = storage.inspect(requestId);
    if (listing === null) return null;
    const files = metadata(listing).found,
      hashes = new Map<SmithEditJournalFile, string>();
    const read = (file: SmithEditJournalFile): unknown => {
      const entry = files.get(file);
      if (!entry) held();
      const text = storage.read(requestId, entry, limits.fileBytes);
      if (
        text.length > limits.fileBytes ||
        new TextEncoder().encode(text).byteLength !== entry.bytes
      )
        held();
      const value = parseSmithEditJournalText(text);
      hashes.set(file, smithEditJournalHash(text));
      return value;
    };
    if (!files.has("intent.json")) held();
    const checkedIntent = smithEditIntentSchema.safeParse(read("intent.json"));
    if (!checkedIntent.success) held();
    const intent = checkedIntent.data;
    if (
      intent.requestId !== requestId ||
      intent.ownerScopeHash !== ownerScopeHash
    )
      conflict();
    const phases: Partial<Record<SmithEditPhase["kind"], SmithEditPhase>> = {};
    for (const file of files.keys()) {
      if (file === "intent.json") continue;
      const checked = smithEditPhaseSchema.safeParse(read(file));
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
    const prepared =
        phases.prepared?.kind === "prepared" ? phases.prepared : null,
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
      (attempted && (!prepared || attempted.preparedHash !== preparedHash)) ||
      (confirmed &&
        (!prepared ||
          !attempted ||
          confirmed.preparedHash !== preparedHash ||
          confirmed.attemptedHash !== attemptedHash)) ||
      (refused &&
        (attempted || unconfirmed || refused.preparedHash !== preparedHash)) ||
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
                  : "intent",
            preview,
          };
    const receipt = smithConfigEditReceiptSchema.safeParse({
      version: 1,
      requestId,
      ownerScopeHash: intent.ownerScopeHash,
      inputHash: intent.inputHash,
      createdAt: intent.at,
      original: intent.original,
      result,
    });
    if (!receipt.success) held();
    return { receipt: receipt.data, intent, hashes };
  };

  const assertRoom = () => {
    let count = 0,
      entries = 0,
      bytes = 0;
    const seen = new Set<string>();
    for (const operation of storage.operations()) {
      if (
        ++count >= limits.operations ||
        !smithConfigEditRequestIdSchema.safeParse(operation.requestId)
          .success ||
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

  const safeChain = (requestId: string) => {
    try {
      return chain(requestId);
    } catch (error) {
      if (error instanceof SmithEditJournalError) throw error;
      held();
    }
  };
  const fingerprint = (hashes: ReadonlyMap<SmithEditJournalFile, string>) =>
    JSON.stringify(
      [...hashes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );

  const readOriginal = (requestId: string): SmithConfigEditReceipt | null =>
    safeChain(checkedId(requestId))?.receipt ?? null;

  const reserve = async (
    value: unknown,
    work: (writer: SmithEditJournalWriter) => void | Promise<void>,
  ): Promise<SmithConfigEditReceipt> => {
    const parsed = smithConfigEditRequestSchema.safeParse(value);
    if (!parsed.success) held();
    const original = frozen(parsed.data),
      requestId = original.requestId,
      inputHash = smithEditInputHash(original);
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
        assertRoom();
        const intent = smithEditIntentSchema.safeParse({
          version: 1,
          kind: "intent",
          requestId,
          ownerScopeHash,
          inputHash,
          owner,
          original,
          at: now(),
        });
        if (!intent.success) held();
        const encode = (record: unknown) => {
          const text = JSON.stringify(record);
          if (
            text.length > limits.fileBytes ||
            new TextEncoder().encode(text).byteLength > limits.fileBytes
          )
            held();
          return text;
        };
        const initial = encode(intent.data);
        storage.writeOnce(requestId, "intent.json", initial);
        let current = safeChain(requestId);
        if (
          !current ||
          current.hashes.get("intent.json") !== smithEditJournalHash(initial)
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
            const checked = smithEditPhaseSchema.safeParse(record);
            if (!checked.success) held();
            const file: SmithEditJournalFile = `${checked.data.kind}.json`,
              text = encode(checked.data);
            storage.writeOnce(requestId, file, text);
            const next = safeChain(requestId);
            if (!next || next.hashes.get(file) !== smithEditJournalHash(text))
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
        const writer: SmithEditJournalWriter =
          Object.freeze<SmithEditJournalWriter>({
            original,
            prepare(preview: SmithConfigEditPreview) {
              const found = check(),
                checked = smithConfigEditPreviewSchema.safeParse(preview);
              if (
                found.receipt.result.phase !== "held" ||
                found.receipt.result.stage !== "intent" ||
                !checked.success
              )
                held();
              if (
                !smithConfigEditReceiptSchema.safeParse({
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
                !smithConfigEditReceiptSchema.safeParse({
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
        if (error instanceof SmithEditJournalError) throw error;
        held();
      });
  };
  return { readOriginal, reserve };
}
