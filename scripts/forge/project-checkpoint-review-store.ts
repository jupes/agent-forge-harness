import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  PROJECT_CHECKPOINT_REVIEW_MAX_JOURNAL_BYTES,
  PROJECT_CHECKPOINT_REVIEW_MAX_JOURNAL_RECORDS,
  PROJECT_CHECKPOINT_REVIEW_MAX_ORIGINAL_BYTES,
  type ProjectCheckpointReviewMetadata,
  type ProjectCheckpointReviewMetadataRead,
  type ProjectCheckpointReviewOriginal,
  type ProjectCheckpointReviewOriginalRead,
  type ProjectCheckpointReviewReceipt,
  type ProjectCheckpointReviewScope,
  type ProjectCheckpointReviewStoredState,
  projectCheckpointReviewIntentJson,
  projectCheckpointReviewMetadataReadSchema,
  projectCheckpointReviewMetadataSchema,
  projectCheckpointReviewOriginalReadSchema,
  projectCheckpointReviewOriginalSchema,
  projectCheckpointReviewReceiptSchema,
  projectCheckpointReviewScopeSchema,
} from "../../types/project-checkpoint-reviews";
import { ConversationError } from "../conversations/error";
import {
  ensurePrivateHome,
  readHomeFileBounded,
} from "../hearth/home-guard";
import { writeOwnerOnly } from "../hearth/token";
import { workspaceKey } from "../projects/scope";

const JOURNAL_VERSION = 1 as const;
const DIRECTORY = "checkpoint-reviews";
const MAX_ORIGINAL_BYTES = PROJECT_CHECKPOINT_REVIEW_MAX_ORIGINAL_BYTES;

type QueueLockResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "busy" | "unusable"; error: string };
export type ProjectCheckpointReviewQueueLock = <T>(
  file: string,
  work: () => Promise<T>,
) => Promise<QueueLockResult<T>>;

type StoredRecord = {
  scope: ProjectCheckpointReviewScope;
  original: ProjectCheckpointReviewOriginal;
  state: ProjectCheckpointReviewStoredState;
  receipt: ProjectCheckpointReviewReceipt;
};
type Journal = {
  version: typeof JOURNAL_VERSION;
  activeRequestId: string | null;
  records: StoredRecord[];
};
export type ProjectCheckpointReviewClaimPermit = Readonly<{
  token: string;
  scope: ProjectCheckpointReviewScope;
  requestId: string;
  intentHash: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isoNow(now: () => Date): string {
  const value = now().toISOString();
  if (!/^\d{4}-\d\d-\d\dT/.test(value))
    throw new ConversationError(503, "The checkpoint review clock is invalid.");
  return value;
}

function scopeOf(original: ProjectCheckpointReviewOriginal): ProjectCheckpointReviewScope {
  return {
    projectId: original.binding.projectId,
    workspacePath: original.binding.workspacePath,
    runSlug: original.binding.runSlug,
    beadId: original.binding.beadId,
  };
}

function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function isActive(state: ProjectCheckpointReviewStoredState): boolean {
  return state === "prepared" || state === "dispatching" || state === "unknown";
}

function isStoredState(value: unknown): value is ProjectCheckpointReviewStoredState {
  return ["prepared", "dispatching", "confirmed", "refused", "unknown", "retired"].includes(String(value));
}

function validCommentId(value: string | null): boolean {
  return value === null || (
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function exposedState(state: ProjectCheckpointReviewStoredState) {
  return state === "dispatching" ? "unknown" : state;
}

function failClosed(message = "The private checkpoint review journal is invalid. Saved reviews have been kept."): never {
  throw new ConversationError(503, message);
}

function checkedPaths(home: string, journalKey: string) {
  const directory = join(home, DIRECTORY);
  const file = join(directory, `${journalKey}.json`);
  const lock = join(directory, `${journalKey}.lock.db`);
  for (const [path, folder] of [
    [directory, true],
    [file, false],
    [lock, false],
  ] as const) {
    try {
      const info = lstatSync(path);
      if (
        info.isSymbolicLink() ||
        (folder ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)
      )
        failClosed("The private checkpoint review path is linked or invalid. Saved reviews have been kept.");
    } catch (error) {
      if (error instanceof ConversationError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        failClosed("The private checkpoint review path could not be checked.");
    }
  }
  return { directory, file, lock };
}

function metadataFor(record: StoredRecord): ProjectCheckpointReviewMetadata {
  return projectCheckpointReviewMetadataSchema.parse({
    schemaVersion: 1,
    requestId: record.original.requestId,
    intentHash: record.original.intentHash,
    scope: record.scope,
    state: exposedState(record.state),
    commentId: record.receipt.commentId,
    createdAt: record.original.createdAt,
    updatedAt: record.receipt.updatedAt,
  });
}

function readFor(record: StoredRecord): ProjectCheckpointReviewOriginalRead {
  return projectCheckpointReviewOriginalReadSchema.parse({
    metadata: metadataFor(record),
    original: record.original,
    receipt: record.receipt,
  });
}

function verifyRecord(value: unknown): StoredRecord | null {
  if (!isRecord(value) || Object.keys(value).length !== 4) return null;
  const scope = projectCheckpointReviewScopeSchema.safeParse(value.scope);
  const original = projectCheckpointReviewOriginalSchema.safeParse(value.original);
  const receipt = projectCheckpointReviewReceiptSchema.safeParse(value.receipt);
  if (
    !scope.success ||
    !original.success ||
    !receipt.success ||
    !isStoredState(value.state)
  )
    return null;
  const record: StoredRecord = {
    scope: scope.data,
    original: original.data,
    state: value.state,
    receipt: receipt.data,
  };
  try {
    if (
      !same(record.scope, scopeOf(record.original)) ||
      record.original.intentHash !== hash(projectCheckpointReviewIntentJson(record.original)) ||
      Buffer.byteLength(JSON.stringify(record.original), "utf8") > MAX_ORIGINAL_BYTES ||
      record.receipt.requestId !== record.original.requestId ||
      record.receipt.intentHash !== record.original.intentHash ||
      record.receipt.createdAt !== record.original.createdAt ||
      record.receipt.state !== exposedState(record.state)
    )
      return null;
    readFor(record);
    return record;
  } catch {
    return null;
  }
}

export function createProjectCheckpointReviewStore(options: {
  home: string;
  withQueueLock: ProjectCheckpointReviewQueueLock;
  now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());
  const permits = new Map<string, ProjectCheckpointReviewClaimPermit>();

  function keyFor(scope: ProjectCheckpointReviewScope): string {
    const parsed = projectCheckpointReviewScopeSchema.safeParse(scope);
    if (!parsed.success)
      throw new ConversationError(400, "A trusted checkpoint review scope is required.");
    return hash(JSON.stringify([workspaceKey(parsed.data.workspacePath), parsed.data.beadId]));
  }

  function readJournal(scope: ProjectCheckpointReviewScope): Journal {
    const journalKey = keyFor(scope);
    const { file } = checkedPaths(options.home, journalKey);
    const found = readHomeFileBounded(
      options.home,
      file,
      PROJECT_CHECKPOINT_REVIEW_MAX_JOURNAL_BYTES,
    );
    if (found.problem !== null)
      failClosed("The private checkpoint review journal could not be read. Saved reviews have been kept.");
    if (found.text === null)
      return { version: JOURNAL_VERSION, activeRequestId: null, records: [] };
    let raw: unknown;
    try {
      raw = JSON.parse(found.text);
    } catch {
      return failClosed();
    }
    if (
      !isRecord(raw) ||
      Object.keys(raw).length !== 3 ||
      raw.version !== JOURNAL_VERSION ||
      !(raw.activeRequestId === null || typeof raw.activeRequestId === "string") ||
      !Array.isArray(raw.records) ||
      raw.records.length > PROJECT_CHECKPOINT_REVIEW_MAX_JOURNAL_RECORDS ||
      Buffer.byteLength(found.text, "utf8") > PROJECT_CHECKPOINT_REVIEW_MAX_JOURNAL_BYTES
    )
      return failClosed("The private checkpoint review journal is invalid or full. Saved reviews have been kept.");
    const records = raw.records.map(verifyRecord);
    if (records.some((record) => record === null)) return failClosed();
    const checked = records.filter((record): record is StoredRecord => record !== null);
    const identitiesValid = checked.every((record) =>
      workspaceKey(record.scope.workspacePath) === workspaceKey(scope.workspacePath) &&
      record.scope.beadId === scope.beadId
    );
    const active = checked.filter((record) => isActive(record.state));
    const computedActiveId = active[0]?.original.requestId ?? null;
    if (
      !identitiesValid ||
      new Set(checked.map((record) => record.original.requestId)).size !== checked.length ||
      active.length > 1 ||
      raw.activeRequestId !== computedActiveId ||
      checked.some((record) => Buffer.byteLength(JSON.stringify(record), "utf8") > MAX_ORIGINAL_BYTES + 4096)
    )
      return failClosed("The private checkpoint review journal failed identity or active-slot verification. Saved reviews have been kept.");
    return { version: JOURNAL_VERSION, activeRequestId: computedActiveId, records: checked };
  }

  function saveJournal(scope: ProjectCheckpointReviewScope, journal: Journal): void {
    const journalKey = keyFor(scope);
    const active = journal.records.filter((record) => isActive(record.state));
    if (
      journal.version !== JOURNAL_VERSION ||
      journal.records.length > PROJECT_CHECKPOINT_REVIEW_MAX_JOURNAL_RECORDS ||
      active.length > 1 ||
      journal.activeRequestId !== (active[0]?.original.requestId ?? null) ||
      journal.records.some((record) => workspaceKey(record.scope.workspacePath) !== workspaceKey(scope.workspacePath) || record.scope.beadId !== scope.beadId) ||
      journal.records.some((record) => verifyRecord(record) === null)
    )
      failClosed("The checkpoint review update failed journal invariants. Saved reviews have been kept.");
    const text = JSON.stringify(journal);
    if (Buffer.byteLength(text, "utf8") > PROJECT_CHECKPOINT_REVIEW_MAX_JOURNAL_BYTES)
      throw new ConversationError(413, "The checkpoint review journal is full; existing reviews were preserved.");
    ensurePrivateHome(options.home);
    const { directory, file } = checkedPaths(options.home, journalKey);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    ensurePrivateHome(directory);
    try {
      writeOwnerOnly(file, text);
    } catch {
      failClosed("The private checkpoint review update could not be confirmed. Saved reviews have been kept.");
    }
    const reread = readJournal(scope);
    if (canonical(reread) !== canonical(journal))
      failClosed("The private checkpoint review update did not verify after writing. Saved reviews have been kept.");
  }

  async function locked<T>(scope: ProjectCheckpointReviewScope, work: (journal: Journal) => Promise<T> | T): Promise<T> {
    const journalKey = keyFor(scope);
    ensurePrivateHome(options.home);
    const { directory, lock } = checkedPaths(options.home, journalKey);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    ensurePrivateHome(directory);
    const result = await options.withQueueLock(lock, async () => work(readJournal(scope)));
    if (!result.ok)
      throw new ConversationError(503, "The private checkpoint review journal is busy or unavailable. Read its saved state before retrying.");
    return result.value;
  }

  function requireRecord(journal: Journal, scope: ProjectCheckpointReviewScope, requestId: string, intentHash: string): StoredRecord {
    const found = journal.records.find((record) => record.original.requestId === requestId);
    if (!found || !same(found.scope, scope))
      throw new ConversationError(404, "This checkpoint review is not retained in this scope.");
    if (found.original.intentHash !== intentHash)
      throw new ConversationError(409, "The checkpoint review hash does not match its saved original.");
    return found;
  }

  function newReceipt(
    original: ProjectCheckpointReviewOriginal,
    state: ProjectCheckpointReviewReceipt["state"],
    auditEventId: number,
    updatedAt: string,
    values: Pick<ProjectCheckpointReviewReceipt, "commentId" | "reportedCommentId" | "readback"> = {
      commentId: null,
      reportedCommentId: null,
      readback: "not-checked",
    },
  ): ProjectCheckpointReviewReceipt {
    return projectCheckpointReviewReceiptSchema.parse({
      schemaVersion: 1,
      requestId: original.requestId,
      intentHash: original.intentHash,
      state,
      ...values,
      auditEventId,
      createdAt: original.createdAt,
      updatedAt,
    });
  }

  async function metadata(scope: ProjectCheckpointReviewScope): Promise<ProjectCheckpointReviewMetadataRead> {
    const journal = readJournal(scope);
    const active = journal.activeRequestId === null
      ? null
      : journal.records.find((record) => record.original.requestId === journal.activeRequestId) ?? null;
    const blocked = active !== null && !same(active.scope, scope);
    const items = blocked
      ? []
      : journal.records.filter((record) => same(record.scope, scope)).map(metadataFor);
    return projectCheckpointReviewMetadataReadSchema.parse({
      schemaVersion: 1,
      scope,
      activeRequestId: blocked ? null : active?.original.requestId ?? null,
      blocked,
      items,
    });
  }

  return {
    async prepare(original: ProjectCheckpointReviewOriginal, auditEventId: number) {
      const parsed = projectCheckpointReviewOriginalSchema.safeParse(original);
      if (!parsed.success || parsed.data.intentHash !== hash(projectCheckpointReviewIntentJson(parsed.data)))
        throw new ConversationError(400, "The checkpoint review original failed its immutable identity check.");
      const saved = parsed.data;
      const scope = scopeOf(saved);
      const preparedAt = isoNow(now);
      return locked(scope, (journal) => {
        const existing = journal.records.find((record) => record.original.requestId === saved.requestId);
        if (existing) {
          if (!same(existing.scope, scope) || !same(existing.original, saved))
            throw new ConversationError(409, "This checkpoint review request ID is already bound to another immutable original.");
          return { created: false, ...readFor(existing), metadata: metadataFor(existing) };
        }
        if (journal.activeRequestId !== null)
          throw new ConversationError(409, "This bead has an unresolved checkpoint review. Read or resolve that exact review before preparing another.");
        if (journal.records.length >= PROJECT_CHECKPOINT_REVIEW_MAX_JOURNAL_RECORDS)
          throw new ConversationError(413, "The checkpoint review journal is full; existing reviews were preserved.");
        const receipt = newReceipt(saved, "prepared", auditEventId, preparedAt);
        const record: StoredRecord = { scope, original: saved, state: "prepared", receipt };
        journal.records.push(record);
        journal.activeRequestId = saved.requestId;
        saveJournal(scope, journal);
        return { created: true, ...readFor(record), metadata: metadataFor(record) };
      });
    },

    metadata,

    async original(scope: ProjectCheckpointReviewScope, requestId: string): Promise<ProjectCheckpointReviewOriginalRead | null> {
      const journal = readJournal(scope);
      const found = journal.records.find((record) => record.original.requestId === requestId);
      if (!found || !same(found.scope, scope)) return null;
      return readFor(found);
    },

    async claim(scope: ProjectCheckpointReviewScope, requestId: string, intentHash: string, auditEventId: number) {
      return locked(scope, (journal) => {
        const record = requireRecord(journal, scope, requestId, intentHash);
        if (record.state !== "prepared" || journal.activeRequestId !== requestId)
          return { kind: "held" as const, metadata: metadataFor(record), receipt: record.receipt };
        const updatedAt = isoNow(now);
        record.state = "dispatching";
        record.receipt = newReceipt(record.original, "unknown", auditEventId, updatedAt);
        saveJournal(scope, journal);
        const permit: ProjectCheckpointReviewClaimPermit = Object.freeze({
          token: randomUUID(),
          scope: structuredClone(scope),
          requestId,
          intentHash,
        });
        permits.set(permit.token, permit);
        return { kind: "claimed" as const, permit, metadata: metadataFor(record), receipt: record.receipt };
      });
    },

    async finish(
      permit: ProjectCheckpointReviewClaimPermit,
      outcome: { kind: "refused-before-dispatch" } | { kind: "unknown"; reportedCommentId: string | null },
      auditEventId: number,
    ) {
      if (permits.get(permit.token) !== permit)
        throw new ConversationError(409, "The checkpoint review claim is not owned by this live service instance.");
      return locked(permit.scope, (journal) => {
        const record = requireRecord(journal, permit.scope, permit.requestId, permit.intentHash);
        if (record.state !== "dispatching" || journal.activeRequestId !== permit.requestId)
          throw new ConversationError(409, "The checkpoint review claim is no longer current.");
        const updatedAt = isoNow(now);
        if (outcome.kind === "refused-before-dispatch") {
          record.state = "refused";
          record.receipt = newReceipt(record.original, "refused", auditEventId, updatedAt);
          journal.activeRequestId = null;
        } else {
          const reportedCommentId = validCommentId(outcome.reportedCommentId)
            ? outcome.reportedCommentId
            : null;
          record.state = "unknown";
          record.receipt = newReceipt(record.original, "unknown", auditEventId, updatedAt, {
            commentId: null,
            reportedCommentId,
            readback: "not-checked",
          });
        }
        saveJournal(permit.scope, journal);
        permits.delete(permit.token);
        return readFor(record);
      });
    },

    async retire(scope: ProjectCheckpointReviewScope, requestId: string, intentHash: string, auditEventId: number) {
      return locked(scope, (journal) => {
        const record = requireRecord(journal, scope, requestId, intentHash);
        if (record.state !== "prepared" || journal.activeRequestId !== requestId)
          throw new ConversationError(409, "Only a prepared checkpoint review can be retired.");
        const updatedAt = isoNow(now);
        record.state = "retired";
        record.receipt = newReceipt(record.original, "retired", auditEventId, updatedAt);
        journal.activeRequestId = null;
        saveJournal(scope, journal);
        return readFor(record);
      });
    },

    async recordReadback(
      scope: ProjectCheckpointReviewScope,
      requestId: string,
      intentHash: string,
      evidence:
        | { kind: "found"; commentId: string; body: string }
        | { kind: "absent" | "incomplete" | "mismatch" },
      auditEventId: number,
    ) {
      return locked(scope, (journal) => {
        const record = requireRecord(journal, scope, requestId, intentHash);
        if (["confirmed", "refused", "retired"].includes(record.state)) return readFor(record);
        if (record.state !== "unknown" && record.state !== "dispatching")
          throw new ConversationError(409, "Only an uncertain checkpoint review can receive a readback.");
        const updatedAt = isoNow(now);
        const validFound = evidence.kind === "found" && validCommentId(evidence.commentId);
        if (
          validFound &&
          evidence.kind === "found" &&
          evidence.body === record.original.commentText &&
          (record.receipt.reportedCommentId === null || record.receipt.reportedCommentId === evidence.commentId)
        ) {
          record.state = "confirmed";
          record.receipt = newReceipt(record.original, "confirmed", auditEventId, updatedAt, {
            commentId: evidence.commentId,
            reportedCommentId: record.receipt.reportedCommentId,
            readback: "found",
          });
          journal.activeRequestId = null;
        } else {
          record.state = "unknown";
          record.receipt = newReceipt(record.original, "unknown", auditEventId, updatedAt, {
            commentId: null,
            reportedCommentId: record.receipt.reportedCommentId,
            readback: evidence.kind === "found" ? "mismatch" : evidence.kind,
          });
        }
        saveJournal(scope, journal);
        return readFor(record);
      });
    },
  };
}
