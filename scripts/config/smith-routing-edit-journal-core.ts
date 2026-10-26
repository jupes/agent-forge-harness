/** Durable immutable receipt transitions for Smith routing edits. */
import type {
  SmithRoutingEditPreview,
  SmithRoutingEditReceipt,
  SmithRoutingEditRefusal,
  SmithRoutingEditRequest,
} from "../../types/smith-routing-edit";
import type {
  SmithCreateJournalEntry,
  SmithCreateJournalStorage,
} from "./smith-create-journal-core";
import {
  SMITH_ROUTING_EDIT_JOURNAL_BOUNDS as limits,
  parseSmithRoutingEditJournalRecord,
  SMITH_ROUTING_EDIT_JOURNAL_FILES,
  type SmithRoutingEditJournalFile,
  type SmithRoutingEditJournalIntent,
  type SmithRoutingEditJournalOwner,
  type SmithRoutingEditJournalPhase,
  smithRoutingEditInputHash,
  smithRoutingEditJournalHash,
  smithRoutingEditJournalIntentSchema,
  smithRoutingEditJournalOwnerSchema,
  smithRoutingEditJournalPhaseSchema,
  smithRoutingEditOwnerHash,
  smithRoutingEditReceiptSchema,
} from "./smith-routing-edit-journal-protocol";
import {
  smithRoutingEditPreviewSchema,
  smithRoutingEditRequestIdSchema,
  smithRoutingEditRequestSchema,
  smithRoutingEditSuccessEnvelopeWithin,
} from "./smith-routing-edit-protocol";

export interface SmithRoutingEditJournalWriter {
  readonly original: Readonly<SmithRoutingEditRequest>;
  prepare(preview: SmithRoutingEditPreview): boolean;
  attempted(): void;
  confirm(publication: {
    file: string;
    created: boolean;
    sha256: string;
  }): void;
  refuse(reason: SmithRoutingEditRefusal): void;
  unconfirmed(): void;
}

export class SmithRoutingEditJournalError extends Error {
  constructor(
    readonly reason: "held" | "conflict",
    message: string,
  ) {
    super(message);
  }
}

function held(): never {
  throw new SmithRoutingEditJournalError(
    "held",
    "The private routing edit original is held or unavailable; it was not replayed.",
  );
}
function conflict(): never {
  throw new SmithRoutingEditJournalError(
    "conflict",
    "The routing edit UUID belongs to another original or owner.",
  );
}
function checkedId(value: string): string {
  const parsed = smithRoutingEditRequestIdSchema.safeParse(value);
  if (!parsed.success) held();
  return parsed.data;
}
function encoded(record: unknown): string {
  const text = JSON.stringify(record);
  if (
    text.length > limits.fileBytes ||
    new TextEncoder().encode(text).byteLength > limits.fileBytes
  )
    held();
  return text;
}
class ReceiptTooLarge extends Error {}
function metadata(entries: Iterable<SmithCreateJournalEntry>) {
  const found = new Map<SmithRoutingEditJournalFile, SmithCreateJournalEntry>();
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
    const name = SMITH_ROUTING_EDIT_JOURNAL_FILES.find(
      (candidate) => candidate === entry.name,
    );
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

type Chain = Readonly<{
  receipt: SmithRoutingEditReceipt;
  intent: SmithRoutingEditJournalIntent;
  hashes: ReadonlyMap<SmithRoutingEditJournalFile, string>;
}>;

export function createSmithRoutingEditJournalCore(
  storage: SmithCreateJournalStorage,
  trustedOwner: SmithRoutingEditJournalOwner,
  now: () => string = () => new Date().toISOString(),
) {
  const parsedOwner =
    smithRoutingEditJournalOwnerSchema.safeParse(trustedOwner);
  if (!parsedOwner.success) held();
  const owner = frozen(parsedOwner.data),
    ownerScopeHash = smithRoutingEditOwnerHash(owner);

  const chain = (requestId: string): Chain | null => {
    const listing = storage.inspect(requestId);
    if (listing === null) return null;
    const files = metadata(listing).found,
      hashes = new Map<SmithRoutingEditJournalFile, string>();
    const read = (file: SmithRoutingEditJournalFile): unknown => {
      const entry = files.get(file);
      if (entry === undefined) held();
      const text = storage.read(requestId, entry, limits.fileBytes);
      if (
        text.length > limits.fileBytes ||
        new TextEncoder().encode(text).byteLength !== entry.bytes
      )
        held();
      const value = parseSmithRoutingEditJournalRecord(text);
      hashes.set(file, smithRoutingEditJournalHash(text));
      return value;
    };
    if (!files.has("intent.json")) held();
    const checkedIntent = smithRoutingEditJournalIntentSchema.safeParse(
      read("intent.json"),
    );
    if (!checkedIntent.success) held();
    const intent = checkedIntent.data;
    if (
      intent.requestId !== requestId ||
      intent.ownerScopeHash !== ownerScopeHash
    )
      conflict();

    const phases: Partial<
      Record<SmithRoutingEditJournalPhase["kind"], SmithRoutingEditJournalPhase>
    > = {};
    for (const file of files.keys()) {
      if (file === "intent.json") continue;
      const checked = smithRoutingEditJournalPhaseSchema.safeParse(read(file));
      if (!checked.success) held();
      const phase = checked.data;
      if (
        `${phase.kind}.json` !== file ||
        phase.requestId !== requestId ||
        phase.ownerScopeHash !== intent.ownerScopeHash ||
        phase.inputHash !== intent.inputHash ||
        phase.intentHash !== hashes.get("intent.json") ||
        phases[phase.kind] !== undefined
      )
        held();
      phases[phase.kind] = phase;
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
      (refused && (prepared || attempted || confirmed || unconfirmed)) ||
      (prepared && refused) ||
      (attempted &&
        (!prepared || attempted.preparedHash !== preparedHash || refused)) ||
      (confirmed &&
        (!prepared ||
          !attempted ||
          confirmed.preparedHash !== preparedHash ||
          confirmed.attemptedHash !== attemptedHash ||
          unconfirmed)) ||
      (unconfirmed &&
        (!prepared ||
          !attempted ||
          unconfirmed.preparedHash !== preparedHash ||
          unconfirmed.attemptedHash !== attemptedHash ||
          confirmed))
    )
      held();

    const preview = prepared?.preview ?? null;
    const result = confirmed
      ? {
          phase: "confirmed" as const,
          completedAt: confirmed.at,
          preview: prepared!.preview,
          publication: confirmed.publication,
        }
      : refused
        ? {
            phase: "refused" as const,
            refusedAt: refused.at,
            reason: refused.reason,
          }
        : {
            phase: "held" as const,
            stage: unconfirmed
              ? ("unconfirmed" as const)
              : attempted
                ? ("attempted" as const)
                : prepared
                  ? ("prepared" as const)
                  : ("intent" as const),
            preview,
          };
    const receipt = smithRoutingEditReceiptSchema.safeParse({
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
        !smithRoutingEditRequestIdSchema.safeParse(operation.requestId)
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
  const safeChain = (requestId: string): Chain | null => {
    try {
      return chain(requestId);
    } catch (error) {
      if (error instanceof SmithRoutingEditJournalError) throw error;
      held();
    }
  };
  const fingerprint = (
    hashes: ReadonlyMap<SmithRoutingEditJournalFile, string>,
  ) =>
    JSON.stringify(
      [...hashes].sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    );

  const readOriginal = (value: string): SmithRoutingEditReceipt | null =>
    safeChain(checkedId(value))?.receipt ?? null;

  const reserve = async (
    value: unknown,
    work: (writer: SmithRoutingEditJournalWriter) => void | Promise<void>,
  ): Promise<SmithRoutingEditReceipt> => {
    const parsed = smithRoutingEditRequestSchema.safeParse(value);
    if (!parsed.success) held();
    const original = frozen(parsed.data),
      requestId = original.requestId,
      inputHash = smithRoutingEditInputHash(original);
    const existing = () => {
      const found = safeChain(requestId);
      if (found && found.intent.inputHash !== inputHash) conflict();
      return found;
    };
    const prior = existing();
    if (prior !== null) return prior.receipt;

    return storage
      .exclusive(async () => {
        const previous = existing();
        if (previous !== null) return previous.receipt;
        assertRoom();
        const at = now();
        const intentCheck = smithRoutingEditJournalIntentSchema.safeParse({
          version: 1,
          kind: "intent",
          requestId,
          ownerScopeHash,
          inputHash,
          owner,
          original,
          at,
        });
        if (!intentCheck.success) held();
        const intent = intentCheck.data,
          intentText = encoded(intent),
          intentHash = smithRoutingEditJournalHash(intentText);
        let active = true,
          started = false,
          attemptedBegan = false,
          persistenceUncertain = false,
          current: Chain | null = null,
          selectedPreview: SmithRoutingEditPreview | null = null,
          completionAt = "";
        const base = () => ({
          version: 1 as const,
          requestId,
          ownerScopeHash,
          inputHash,
          intentHash,
          at: now(),
        });
        const check = (): Chain => {
          if (!active || current === null) held();
          const fresh = safeChain(requestId);
          if (
            fresh === null ||
            fingerprint(fresh.hashes) !== fingerprint(current.hashes)
          )
            held();
          return fresh;
        };
        const writeIntent = (): void => {
          if (started) held();
          started = true;
          try {
            storage.writeOnce(requestId, "intent.json", intentText);
            const fresh = safeChain(requestId);
            if (
              fresh === null ||
              fresh.hashes.get("intent.json") !== intentHash
            )
              held();
            current = fresh;
          } catch (error) {
            persistenceUncertain = true;
            throw error;
          }
        };
        const savePhase = (phase: SmithRoutingEditJournalPhase): Chain => {
          const found = check();
          if (!started || found.hashes.get("intent.json") !== intentHash)
            held();
          const checked = smithRoutingEditJournalPhaseSchema.safeParse(phase);
          if (!checked.success) held();
          const file =
              `${checked.data.kind}.json` as SmithRoutingEditJournalFile,
            text = encoded(checked.data);
          try {
            storage.writeOnce(requestId, file, text);
            const fresh = safeChain(requestId);
            if (
              fresh === null ||
              fresh.hashes.get(file) !== smithRoutingEditJournalHash(text)
            )
              held();
            current = fresh;
            return fresh;
          } catch (error) {
            persistenceUncertain = true;
            throw error;
          }
        };
        const receiptFor = (
          result: SmithRoutingEditReceipt["result"],
        ): SmithRoutingEditReceipt => {
          const value = {
            version: 1,
            requestId,
            ownerScopeHash,
            inputHash,
            createdAt: at,
            original,
            result,
          };
          if (!smithRoutingEditSuccessEnvelopeWithin(value))
            throw new ReceiptTooLarge();
          const checked = smithRoutingEditReceiptSchema.safeParse(value);
          if (!checked.success) held();
          return checked.data;
        };
        const writer: SmithRoutingEditJournalWriter = Object.freeze({
          original,
          prepare(preview: SmithRoutingEditPreview): boolean {
            if (!active || started || selectedPreview !== null) held();
            const checkedPreview =
              smithRoutingEditPreviewSchema.safeParse(preview);
            if (!checkedPreview.success) held();
            const data = checkedPreview.data;
            if (
              data.target !== original.target ||
              data.expectedRevision.user !== original.expectedRevision.user ||
              data.expectedRevision.workspace !==
                original.expectedRevision.workspace ||
              JSON.stringify(data.review.change) !==
                JSON.stringify(original.change)
            )
              held();
            completionAt = now();
            const plannedPublication = {
              file: data.file,
              created: data.candidate.created,
              sha256: data.candidate.sha256,
            };
            try {
              receiptFor({ phase: "held", stage: "prepared", preview: data });
              receiptFor({
                phase: "confirmed",
                completedAt: completionAt,
                preview: data,
                publication: plannedPublication,
              });
            } catch (error) {
              if (!(error instanceof ReceiptTooLarge)) throw error;
              writer.refuse("success-preview-too-large");
              return false;
            }
            const prepared: SmithRoutingEditJournalPhase = {
              ...base(),
              kind: "prepared",
              preview: data,
            };
            encoded(intent);
            encoded(prepared);
            selectedPreview = data;
            writeIntent();
            current = savePhase(prepared);
            return true;
          },
          attempted(): void {
            const found = check();
            if (
              selectedPreview === null ||
              found.receipt.result.phase !== "held" ||
              found.receipt.result.stage !== "prepared"
            )
              held();
            attemptedBegan = true;
            const phase: SmithRoutingEditJournalPhase = {
              ...base(),
              kind: "attempted",
              preparedHash: found.hashes.get("prepared.json")!,
            };
            current = savePhase(phase);
          },
          confirm(publication: {
            file: string;
            created: boolean;
            sha256: string;
          }): void {
            const found = check();
            if (
              !attemptedBegan ||
              selectedPreview === null ||
              found.receipt.result.phase !== "held" ||
              found.receipt.result.stage !== "attempted" ||
              publication.file !== selectedPreview.file ||
              publication.created !== selectedPreview.candidate.created ||
              publication.sha256 !== selectedPreview.candidate.sha256
            )
              held();
            const phase: SmithRoutingEditJournalPhase = {
              ...base(),
              kind: "confirmed",
              preparedHash: found.hashes.get("prepared.json")!,
              attemptedHash: found.hashes.get("attempted.json")!,
              publication,
              at: completionAt,
            };
            current = savePhase(phase);
          },
          refuse(reason: SmithRoutingEditRefusal): void {
            if (!active || started || attemptedBegan) held();
            const refusedReceipt = receiptFor({
              phase: "refused",
              refusedAt: now(),
              reason,
            });
            const phase: SmithRoutingEditJournalPhase = {
              ...base(),
              kind: "refused",
              reason,
            };
            // Prove both the exact original and small refusal fit before either
            // immutable record is written.
            encoded(intent);
            encoded(phase);
            encoded(refusedReceipt);
            writeIntent();
            current = savePhase(phase);
          },
          unconfirmed(): void {
            const found = check();
            if (
              !attemptedBegan ||
              selectedPreview === null ||
              found.receipt.result.phase !== "held" ||
              found.receipt.result.stage !== "attempted"
            )
              held();
            const phase: SmithRoutingEditJournalPhase = {
              ...base(),
              kind: "unconfirmed",
              preparedHash: found.hashes.get("prepared.json")!,
              attemptedHash: found.hashes.get("attempted.json")!,
            };
            current = savePhase(phase);
          },
        });

        try {
          await work(writer);
          if (persistenceUncertain) held();
          const final = safeChain(requestId);
          if (final === null) held();
          return final.receipt;
        } catch (error) {
          if (persistenceUncertain) held();
          if (attemptedBegan) {
            try {
              writer.unconfirmed();
            } catch {
              // The durable attempted record itself is sufficient to stay held.
            }
            const latest = safeChain(requestId);
            if (latest !== null) return latest.receipt;
            held();
          }
          if (started) {
            const latest = safeChain(requestId);
            if (latest !== null) return latest.receipt;
            held();
          }
          throw error;
        } finally {
          active = false;
        }
      })
      .catch((error: unknown) => {
        if (error instanceof SmithRoutingEditJournalError) throw error;
        held();
      });
  };

  return { readOriginal, reserve };
}
