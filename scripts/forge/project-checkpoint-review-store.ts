import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync } from "node:fs";
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
  projectCheckpointReviewBindingSchema,
  projectCheckpointReviewIntentJson,
  projectCheckpointReviewMetadataReadSchema,
  projectCheckpointReviewMetadataSchema,
  projectCheckpointReviewOriginalReadSchema,
  projectCheckpointReviewOriginalSchema,
  projectCheckpointReviewReceiptSchema,
  projectCheckpointReviewScopeSchema,
} from "../../types/project-checkpoint-reviews";
import {
  CHECKPOINT_SUBMISSION_MAX_RECORDS,
  CHECKPOINT_WITHDRAW_MAX_RECORD_BYTES,
  type ProjectCheckpointSubmissionOriginal,
  type ProjectCheckpointSubmissionPublish,
  type ProjectCheckpointSubmissionRecord,
  type ProjectCheckpointSubmissionSnapshot,
  type ProjectCheckpointSubmissionWithdraw,
  projectCheckpointSourceVersionSchema,
  projectCheckpointSubmissionOriginalJson,
  projectCheckpointSubmissionOriginalSchema,
  projectCheckpointSubmissionRecordSchema,
  projectCheckpointSubmissionScope,
} from "../../types/project-checkpoint-submissions";
import { ConversationError } from "../conversations/error";
import { ensurePrivateHome, readHomeFileBounded } from "../hearth/home-guard";
import { writeOwnerOnly } from "../hearth/token";
import { workspaceKey } from "../projects/scope";

const JOURNAL_VERSION = 1 as const;
const ANCHOR_DIRECTORY = "checkpoint-review-anchors";
const MAX_REVIEW_RECORD_BYTES =
  PROJECT_CHECKPOINT_REVIEW_MAX_ORIGINAL_BYTES + 4096;
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
type LegacyJournal = {
  version: typeof JOURNAL_VERSION;
  activeRequestId: string | null;
  records: StoredRecord[];
};
type SubmissionJournal = Omit<LegacyJournal, "version"> & {
  version: 2;
  submissionGeneration: number;
  currentSubmissionRequestId: string | null;
  submissionRecords: ProjectCheckpointSubmissionRecord[];
};
type Journal = LegacyJournal | SubmissionJournal;
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

function scopeOf(
  original: ProjectCheckpointReviewOriginal,
): ProjectCheckpointReviewScope {
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

export function readProjectCheckpointReviewInventory(
  home: string,
  files: readonly string[],
  projectId: string,
): StoredRecord[] {
  const all: StoredRecord[] = [];
  const anchorDirectory = join(home, ANCHOR_DIRECTORY);
  try {
    const info = lstatSync(anchorDirectory);
    if (info.isSymbolicLink() || !info.isDirectory()) return failClosed();
    for (const name of readdirSync(anchorDirectory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) return failClosed();
      const key = name.slice(0, -5);
      if (
        !readAnchor(home, key) ||
        !files.includes(join(home, DIRECTORY, name))
      )
        return failClosed();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return failClosed();
  }
  for (const file of files) {
    const name = file.slice(join(home, DIRECTORY).length + 1);
    if (
      !/^[a-f0-9]{64}\.json$/.test(name) ||
      file !== join(home, DIRECTORY, name)
    )
      return failClosed();
    const journal = readJournalFile(home, name.slice(0, -5));
    all.push(
      ...journal.records.filter((row) => row.scope.projectId === projectId),
    );
  }
  if (new Set(all.map((row) => row.original.requestId)).size !== all.length)
    return failClosed();
  return structuredClone(all);
}

function isStoredState(
  value: unknown,
): value is ProjectCheckpointReviewStoredState {
  return [
    "prepared",
    "dispatching",
    "confirmed",
    "refused",
    "unknown",
    "retired",
  ].includes(String(value));
}

function validCommentId(value: string | null): boolean {
  return (
    value === null ||
    (value.length > 0 &&
      value.length <= 256 &&
      value === value.trim() &&
      !hasControlCharacters(value))
  );
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function exposedState(state: ProjectCheckpointReviewStoredState) {
  return state === "dispatching" ? "unknown" : state;
}

function failClosed(
  message = "The private checkpoint review journal is invalid. Saved reviews have been kept.",
): never {
  throw new ConversationError(503, message);
}

function checkedPaths(home: string, journalKey: string) {
  const directory = join(home, DIRECTORY);
  const file = join(directory, `${journalKey}.json`);
  const lock = join(directory, `${journalKey}.lock.db`);
  const anchorDirectory = join(home, ANCHOR_DIRECTORY);
  const anchor = join(anchorDirectory, `${journalKey}.json`);
  for (const [path, folder] of [
    [directory, true],
    [file, false],
    [lock, false],
    [anchorDirectory, true],
    [anchor, false],
  ] as const) {
    try {
      const info = lstatSync(path);
      if (
        info.isSymbolicLink() ||
        (folder ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)
      )
        failClosed(
          "The private checkpoint review path is linked or invalid. Saved reviews have been kept.",
        );
    } catch (error) {
      if (error instanceof ConversationError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        failClosed("The private checkpoint review path could not be checked.");
    }
  }
  return { directory, file, lock, anchorDirectory, anchor };
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
  const original = projectCheckpointReviewOriginalSchema.safeParse(
    value.original,
  );
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
      record.original.intentHash !==
        hash(projectCheckpointReviewIntentJson(record.original)) ||
      Buffer.byteLength(JSON.stringify(record.original), "utf8") >
        MAX_ORIGINAL_BYTES ||
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

function keyFor(scope: ProjectCheckpointReviewScope): string {
  const parsed = projectCheckpointReviewScopeSchema.safeParse(scope);
  if (!parsed.success)
    throw new ConversationError(
      400,
      "A trusted checkpoint review scope is required.",
    );
  return hash(
    JSON.stringify([
      workspaceKey(parsed.data.workspacePath),
      parsed.data.beadId,
    ]),
  );
}
function sourceReviewHash(originalHash: string): string {
  return hash(
    canonical({
      family: "checkpoint-source-submission",
      schemaVersion: 1,
      originalHash,
    }),
  );
}
function currentSubmission(journal: Journal) {
  return journal.version === 2
    ? (journal.submissionRecords.find(
        (row) => row.original.requestId === journal.currentSubmissionRequestId,
      ) ?? null)
    : null;
}
function submittedBinding(record: ProjectCheckpointSubmissionRecord) {
  if (
    record.original.kind !== "publish" ||
    record.receipt.reviewScopeHash === null
  )
    return failClosed();
  return {
    ...record.original.binding,
    scopeHash: record.receipt.reviewScopeHash,
  };
}
function requireCapacity(journal: Journal, bytes: number) {
  let reserve = 0;
  if (journal.version === 2) {
    const current = currentSubmission(journal);
    if (current) {
      reserve += CHECKPOINT_WITHDRAW_MAX_RECORD_BYTES + 64;
      if (journal.submissionRecords.length >= CHECKPOINT_SUBMISSION_MAX_RECORDS)
        throw new ConversationError(
          413,
          "The source journal must retain its withdrawal slot.",
        );
      if (
        !journal.records.some((row) =>
          same(row.original.binding, submittedBinding(current)),
        )
      ) {
        if (
          journal.records.length >=
          PROJECT_CHECKPOINT_REVIEW_MAX_JOURNAL_RECORDS
        )
          throw new ConversationError(
            413,
            "The source journal must retain a review slot.",
          );
        reserve += MAX_REVIEW_RECORD_BYTES + 64;
      }
    }
    for (const row of journal.records.filter((record) =>
      isActive(record.state),
    ))
      reserve +=
        MAX_REVIEW_RECORD_BYTES -
        Buffer.byteLength(JSON.stringify(row), "utf8");
  }
  if (bytes + reserve > PROJECT_CHECKPOINT_REVIEW_MAX_JOURNAL_BYTES)
    throw new ConversationError(
      413,
      "The checkpoint review journal is full; existing originals were preserved.",
    );
}
function decodeJournal(text: string, journalKey: string): Journal {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return failClosed();
  }
  if (
    !isRecord(raw) ||
    !(raw.version === 1 || raw.version === 2) ||
    Object.keys(raw).length !== (raw.version === 1 ? 3 : 6) ||
    !Array.isArray(raw.records) ||
    raw.records.length > PROJECT_CHECKPOINT_REVIEW_MAX_JOURNAL_RECORDS
  )
    return failClosed();
  const records = raw.records.map(verifyRecord);
  if (records.some((row) => row === null)) return failClosed();
  const checked = records.filter((row): row is StoredRecord => row !== null);
  const active = checked.filter((row) => isActive(row.state));
  if (
    active.length > 1 ||
    raw.activeRequestId !== (active[0]?.original.requestId ?? null) ||
    checked.some(
      (row) =>
        keyFor(row.scope) !== journalKey ||
        Buffer.byteLength(JSON.stringify(row), "utf8") >
          MAX_REVIEW_RECORD_BYTES,
    )
  )
    return failClosed();
  let journal: Journal = {
    version: 1,
    activeRequestId: active[0]?.original.requestId ?? null,
    records: checked,
  };
  const ids = checked.map((row) => row.original.requestId);
  if (raw.version === 2) {
    if (
      !Array.isArray(raw.submissionRecords) ||
      raw.submissionRecords.length < 1 ||
      raw.submissionRecords.length > CHECKPOINT_SUBMISSION_MAX_RECORDS
    )
      return failClosed();
    const submissions: ProjectCheckpointSubmissionRecord[] = [];
    let generation = 0;
    let current: ProjectCheckpointSubmissionRecord | null = null;
    for (const value of raw.submissionRecords) {
      const parsed = projectCheckpointSubmissionRecordSchema.safeParse(value);
      if (!parsed.success) return failClosed();
      const row = parsed.data;
      if (
        keyFor(projectCheckpointSubmissionScope(row.original)) !== journalKey ||
        row.originalHash !==
          hash(projectCheckpointSubmissionOriginalJson(row.original)) ||
        row.receipt.observedGeneration !== generation
      )
        return failClosed();
      if (row.original.kind === "publish") {
        if (row.receipt.reviewScopeHash !== sourceReviewHash(row.originalHash))
          return failClosed();
        current = row;
      } else {
        if (
          current === null ||
          row.original.targetSubmissionRequestId !==
            current.original.requestId ||
          row.original.targetOriginalHash !== current.originalHash ||
          !same(
            row.original.scope,
            projectCheckpointSubmissionScope(current.original),
          )
        )
          return failClosed();
        current = null;
      }
      generation = row.receipt.resultingGeneration;
      submissions.push(row);
      ids.push(row.original.requestId);
    }
    if (
      raw.submissionGeneration !== generation ||
      raw.currentSubmissionRequestId !== (current?.original.requestId ?? null)
    )
      return failClosed();
    journal = {
      ...journal,
      version: 2,
      submissionGeneration: generation,
      currentSubmissionRequestId: current?.original.requestId ?? null,
      submissionRecords: submissions,
    };
  }
  if (new Set(ids).size !== ids.length) return failClosed();
  requireCapacity(journal, Buffer.byteLength(text, "utf8"));
  return journal;
}
function readAnchor(home: string, key: string) {
  const { anchor } = checkedPaths(home, key);
  const found = readHomeFileBounded(home, anchor, 16 * 1024);
  if (found.problem !== null) return failClosed();
  if (found.text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(found.text);
  } catch {
    return failClosed();
  }
  if (
    !isRecord(raw) ||
    Object.keys(raw).length !== 4 ||
    raw.version !== 1 ||
    raw.key !== key ||
    typeof raw.workspace !== "string" ||
    !projectCheckpointReviewScopeSchema.shape.workspacePath.safeParse(
      raw.workspace,
    ).success ||
    !projectCheckpointReviewScopeSchema.shape.beadId.safeParse(raw.beadId)
      .success ||
    workspaceKey(raw.workspace) !== raw.workspace ||
    hash(JSON.stringify([raw.workspace, raw.beadId])) !== key
  )
    return failClosed();
  return raw;
}
function readJournalRead(
  home: string,
  key: string,
): { journal: Journal; present: boolean } {
  const { file } = checkedPaths(home, key);
  const anchor = readAnchor(home, key);
  const found = readHomeFileBounded(
    home,
    file,
    PROJECT_CHECKPOINT_REVIEW_MAX_JOURNAL_BYTES,
  );
  if (found.problem !== null || (found.text === null && anchor !== null))
    return failClosed();
  if (found.text === null)
    return {
      journal: { version: 1, activeRequestId: null, records: [] },
      present: false,
    };
  try {
    const journal = decodeJournal(found.text, key);
    if (journal.version === 2 && anchor === null) return failClosed();
    return { journal, present: true };
  } catch {
    return failClosed();
  }
}
function readJournalFile(home: string, key: string): Journal {
  return readJournalRead(home, key).journal;
}

function immutable<T>(value: T): T {
  const clone = structuredClone(value);
  function freeze(item: unknown) {
    if (typeof item !== "object" || item === null || Object.isFrozen(item))
      return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  }
  freeze(clone);
  return clone;
}

export function createProjectCheckpointReviewStore(options: {
  home: string;
  admit?: import("../projects/project-lifecycle-protocol").ProjectAdmissionFence;
  withQueueLock: ProjectCheckpointReviewQueueLock;
  now?: () => Date;
  submission?: {
    resolveSnapshot: (
      scope: ProjectCheckpointReviewScope,
    ) => Promise<ProjectCheckpointSubmissionSnapshot>;
  };
}) {
  const now = options.now ?? (() => new Date());
  const admission = options.admit;
  const resolveSnapshot = options.submission?.resolveSnapshot;
  const permits = new Map<string, ProjectCheckpointReviewClaimPermit>();

  function readJournal(scope: ProjectCheckpointReviewScope): Journal {
    return readJournalFile(options.home, keyFor(scope));
  }

  function saveJournal(
    scope: ProjectCheckpointReviewScope,
    journal: Journal,
  ): void {
    const journalKey = keyFor(scope);
    const text = JSON.stringify(journal);
    decodeJournal(text, journalKey);
    ensurePrivateHome(options.home);
    const { directory, file, anchorDirectory, anchor } = checkedPaths(
      options.home,
      journalKey,
    );
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    ensurePrivateHome(directory);
    if (readAnchor(options.home, journalKey) === null) {
      mkdirSync(anchorDirectory, { recursive: true, mode: 0o700 });
      ensurePrivateHome(anchorDirectory);
      writeOwnerOnly(
        anchor,
        JSON.stringify({
          version: 1,
          key: journalKey,
          workspace: workspaceKey(scope.workspacePath),
          beadId: scope.beadId,
        }),
      );
      if (readAnchor(options.home, journalKey) === null) failClosed();
    }
    try {
      writeOwnerOnly(file, text);
    } catch {
      failClosed();
    }
    if (!same(readJournal(scope), journal)) failClosed();
  }

  async function locked<T>(
    scope: ProjectCheckpointReviewScope,
    work: (journal: Journal) => Promise<T> | T,
  ): Promise<T> {
    const journalKey = keyFor(scope);
    ensurePrivateHome(options.home);
    const { directory, lock } = checkedPaths(options.home, journalKey);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    ensurePrivateHome(directory);
    const result = await options.withQueueLock(lock, async () =>
      work(readJournal(scope)),
    );
    if (!result.ok)
      throw new ConversationError(
        503,
        "The private checkpoint review journal is busy or unavailable. Read its saved state before retrying.",
      );
    return result.value;
  }

  function requireRecord(
    journal: Journal,
    scope: ProjectCheckpointReviewScope,
    requestId: string,
    intentHash: string,
  ): StoredRecord {
    const found = journal.records.find(
      (record) => record.original.requestId === requestId,
    );
    if (!found || !same(found.scope, scope))
      throw new ConversationError(
        404,
        "This checkpoint review is not retained in this scope.",
      );
    if (found.original.intentHash !== intentHash)
      throw new ConversationError(
        409,
        "The checkpoint review hash does not match its saved original.",
      );
    return found;
  }

  function newReceipt(
    original: ProjectCheckpointReviewOriginal,
    state: ProjectCheckpointReviewReceipt["state"],
    auditEventId: number,
    updatedAt: string,
    values: Pick<
      ProjectCheckpointReviewReceipt,
      "commentId" | "reportedCommentId" | "readback"
    > = {
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

  async function metadata(
    scope: ProjectCheckpointReviewScope,
  ): Promise<ProjectCheckpointReviewMetadataRead> {
    const journal = readJournal(scope);
    const active =
      journal.activeRequestId === null
        ? null
        : (journal.records.find(
            (record) => record.original.requestId === journal.activeRequestId,
          ) ?? null);
    const blocked = active !== null && !same(active.scope, scope);
    const items = blocked
      ? []
      : journal.records
          .filter((record) => same(record.scope, scope))
          .map(metadataFor);
    return projectCheckpointReviewMetadataReadSchema.parse({
      schemaVersion: 1,
      scope,
      activeRequestId: blocked ? null : (active?.original.requestId ?? null),
      blocked,
      items,
    });
  }

  async function snapshotFor(scope: ProjectCheckpointReviewScope) {
    if (!resolveSnapshot)
      throw new ConversationError(
        503,
        "The checkpoint source context is unavailable.",
      );
    try {
      const value = await resolveSnapshot(immutable(scope));
      const binding = projectCheckpointReviewBindingSchema.parse(value.binding);
      const sourceVersion = projectCheckpointSourceVersionSchema.parse(
        value.sourceVersion,
      );
      if (
        !same(
          {
            projectId: binding.projectId,
            workspacePath: binding.workspacePath,
            runSlug: binding.runSlug,
            beadId: binding.beadId,
          },
          scope,
        )
      )
        throw Error("Scope mismatch");
      return immutable({ binding, sourceVersion });
    } catch {
      throw new ConversationError(
        503,
        "The checkpoint source context is unavailable.",
      );
    }
  }
  function matchesSnapshot(
    record: ProjectCheckpointSubmissionRecord,
    snapshot: ProjectCheckpointSubmissionSnapshot,
  ) {
    return (
      record.original.kind === "publish" &&
      same(record.original.binding, snapshot.binding) &&
      same(record.original.sourceVersion, snapshot.sourceVersion)
    );
  }
  async function requireSubmittedReview(
    journal: Journal,
    binding: import("../../types/project-checkpoint-reviews").ProjectCheckpointReviewBinding,
  ) {
    if (journal.version !== 2) return;
    const current = currentSubmission(journal);
    if (!admission || !current || !same(submittedBinding(current), binding))
      throw new ConversationError(
        409,
        "Read the exact current source submission before preparing or committing a review.",
      );
    const scope = projectCheckpointSubmissionScope(current.original);
    if (!matchesSnapshot(current, await snapshotFor(scope)))
      throw new ConversationError(
        409,
        "The submitted checkpoint source is no longer current.",
      );
  }
  function captureSubmission(value: unknown) {
    try {
      return immutable(projectCheckpointSubmissionOriginalSchema.parse(value));
    } catch {
      throw new ConversationError(
        400,
        "A valid immutable checkpoint source original is required.",
      );
    }
  }
  function applySubmission(
    saved: ProjectCheckpointSubmissionOriginal,
    auditEventId: number,
  ) {
    const scope = projectCheckpointSubmissionScope(saved);
    const originalHash = hash(projectCheckpointSubmissionOriginalJson(saved));
    return locked(scope, async (journal) => {
      const prior =
        journal.version === 2
          ? journal.submissionRecords.find(
              (row) => row.original.requestId === saved.requestId,
            )
          : null;
      if (prior) {
        if (prior.originalHash !== originalHash || !same(prior.original, saved))
          throw new ConversationError(
            409,
            "This source request ID already names another immutable original.",
          );
        return immutable({ created: false, record: prior });
      }
      if (
        journal.version === 2 &&
        journal.submissionRecords.length >= CHECKPOINT_SUBMISSION_MAX_RECORDS
      )
        throw new ConversationError(
          413,
          "The source journal is full; exact history remains available.",
        );
      if (
        journal.records.some(
          (row) => row.original.requestId === saved.requestId,
        )
      )
        throw new ConversationError(
          409,
          "This request ID already belongs to a checkpoint review.",
        );
      if (journal.records.some((row) => isActive(row.state)))
        throw new ConversationError(
          409,
          "Resolve the exact outstanding checkpoint review before changing its source submission.",
        );
      const generation =
        journal.version === 2 ? journal.submissionGeneration : 0;
      if (saved.expectedSubmissionGeneration !== generation)
        throw new ConversationError(
          409,
          "The source submission generation changed. Read the saved state.",
        );
      const current = currentSubmission(journal);
      const persist = () => {
        let appliedAt: string;
        try {
          appliedAt = isoNow(now);
        } catch {
          throw new ConversationError(
            503,
            "The checkpoint submission clock is unavailable.",
          );
        }
        const record = projectCheckpointSubmissionRecordSchema.parse({
          original: saved,
          originalHash,
          receipt: {
            schemaVersion: 1,
            requestId: saved.requestId,
            originalHash,
            scope,
            state: "applied",
            observedGeneration: generation,
            resultingGeneration: generation + 1,
            auditEventId,
            appliedAt,
            reviewScopeHash:
              saved.kind === "publish" ? sourceReviewHash(originalHash) : null,
          },
        });
        const next: SubmissionJournal = {
          version: 2,
          activeRequestId: journal.activeRequestId,
          records: journal.records,
          submissionGeneration: generation + 1,
          currentSubmissionRequestId:
            saved.kind === "publish" ? saved.requestId : null,
          submissionRecords: [
            ...(journal.version === 2 ? journal.submissionRecords : []),
            record,
          ],
        };
        saveJournal(scope, next);
        return immutable({ created: true, record });
      };
      if (saved.kind === "withdraw") {
        if (
          !current ||
          current.original.requestId !== saved.targetSubmissionRequestId ||
          current.originalHash !== saved.targetOriginalHash ||
          !same(projectCheckpointSubmissionScope(current.original), scope)
        )
          throw new ConversationError(
            409,
            "Withdraw must name the exact current source original and generation.",
          );
        return persist();
      }
      if (!admission || !resolveSnapshot)
        throw new ConversationError(
          503,
          "Protected checkpoint source admission is unavailable.",
        );
      return admission(scope.projectId, async () => {
        const snapshot = await snapshotFor(scope);
        if (
          !same(snapshot.binding, saved.binding) ||
          !same(snapshot.sourceVersion, saved.sourceVersion)
        )
          throw new ConversationError(
            409,
            "The checked checkpoint source changed before publication.",
          );
        if (
          current &&
          !journal.records.some(
            (row) =>
              row.state === "confirmed" &&
              same(row.original.binding, submittedBinding(current)),
          )
        )
          throw new ConversationError(
            409,
            "Review or explicitly withdraw the exact retained source before replacing it.",
          );
        return persist();
      });
    });
  }

  return {
    publishSubmission(
      original: ProjectCheckpointSubmissionPublish,
      auditEventId: number,
    ) {
      const saved = captureSubmission(original);
      if (saved.kind !== "publish")
        throw new ConversationError(
          400,
          "A source publication original is required.",
        );
      return applySubmission(saved, auditEventId);
    },
    withdrawSubmission(
      original: ProjectCheckpointSubmissionWithdraw,
      auditEventId: number,
    ) {
      const saved = captureSubmission(original);
      if (saved.kind !== "withdraw")
        throw new ConversationError(
          400,
          "A source withdrawal original is required.",
        );
      return applySubmission(saved, auditEventId);
    },
    async submissionContext(scope: ProjectCheckpointReviewScope) {
      const checked = immutable(
        projectCheckpointReviewScopeSchema.parse(scope),
      );
      const snapshot = await snapshotFor(checked);
      const journal = readJournal(checked);
      const current = currentSubmission(journal);
      const foreign =
        current !== null &&
        !same(projectCheckpointSubmissionScope(current.original), checked);
      const state =
        journal.version === 1
          ? "unbound"
          : current === null
            ? "withdrawn"
            : foreign
              ? "foreign"
              : matchesSnapshot(current, snapshot)
                ? "current"
                : "stale";
      return immutable({
        state,
        generation: journal.version === 2 ? journal.submissionGeneration : 0,
        continuity: journal.version === 2 ? "anchored" : "legacy-unverified",
        baseBinding: snapshot.binding,
        sourceVersion: snapshot.sourceVersion,
        reviewBinding:
          state === "current" && current ? submittedBinding(current) : null,
        record: foreign ? null : current,
        foreign:
          foreign && current
            ? {
                projectId: projectCheckpointSubmissionScope(current.original)
                  .projectId,
                runSlug: projectCheckpointSubmissionScope(current.original)
                  .runSlug,
                beadId: projectCheckpointSubmissionScope(current.original)
                  .beadId,
              }
            : null,
      });
    },
    submissionOriginal(scope: ProjectCheckpointReviewScope, requestId: string) {
      const journal = readJournal(scope);
      const found =
        journal.version === 2
          ? journal.submissionRecords.find(
              (row) =>
                row.original.requestId === requestId &&
                same(projectCheckpointSubmissionScope(row.original), scope),
            )
          : null;
      return immutable(found ?? null);
    },
    submissionInventory(scope: ProjectCheckpointReviewScope) {
      const read = readJournalRead(options.home, keyFor(scope));
      const journal = read.journal;
      const current = currentSubmission(journal);
      const blocked =
        current !== null &&
        !same(projectCheckpointSubmissionScope(current.original), scope);
      return immutable({
        generation: journal.version === 2 ? journal.submissionGeneration : 0,
        everBound: journal.version === 2,
        legacySource:
          journal.version === 2
            ? null
            : read.present
              ? "verified-v1"
              : "missing-context",
        blocked,
        currentRequestId: blocked
          ? null
          : (current?.original.requestId ?? null),
        items:
          journal.version === 2
            ? journal.submissionRecords.filter((row) =>
                same(projectCheckpointSubmissionScope(row.original), scope),
              )
            : [],
      });
    },
    inventory: (scope: ProjectCheckpointReviewScope) =>
      structuredClone(readJournal(scope).records),
    async prepare(
      original: ProjectCheckpointReviewOriginal,
      auditEventId: number,
    ) {
      const parsed = projectCheckpointReviewOriginalSchema.safeParse(original);
      if (
        !parsed.success ||
        parsed.data.intentHash !==
          hash(projectCheckpointReviewIntentJson(parsed.data))
      )
        throw new ConversationError(
          400,
          "The checkpoint review original failed its immutable identity check.",
        );
      const saved = parsed.data;
      const scope = scopeOf(saved);
      const preparedAt = isoNow(now);
      return locked(scope, async (journal) => {
        const existing = journal.records.find(
          (record) => record.original.requestId === saved.requestId,
        );
        if (existing) {
          if (!same(existing.scope, scope) || !same(existing.original, saved))
            throw new ConversationError(
              409,
              "This checkpoint review request ID is already bound to another immutable original.",
            );
          return {
            created: false,
            ...readFor(existing),
            metadata: metadataFor(existing),
          };
        }
        if (
          journal.version === 2 &&
          journal.submissionRecords.some(
            (row) => row.original.requestId === saved.requestId,
          )
        )
          throw new ConversationError(
            409,
            "This request ID already belongs to a source original.",
          );
        if (journal.activeRequestId !== null)
          throw new ConversationError(
            409,
            "This bead has an unresolved checkpoint review. Read or resolve that exact review before preparing another.",
          );
        if (
          journal.records.length >=
          PROJECT_CHECKPOINT_REVIEW_MAX_JOURNAL_RECORDS
        )
          throw new ConversationError(
            413,
            "The checkpoint review journal is full; existing reviews were preserved.",
          );
        const receipt = newReceipt(saved, "prepared", auditEventId, preparedAt);
        const record: StoredRecord = {
          scope,
          original: saved,
          state: "prepared",
          receipt,
        };
        journal.records.push(record);
        journal.activeRequestId = saved.requestId;
        const persistReview = async () => {
          await requireSubmittedReview(journal, saved.binding);
          saveJournal(scope, journal);
        };
        if (admission) await admission(scope.projectId, persistReview);
        else await persistReview();
        return {
          created: true,
          ...readFor(record),
          metadata: metadataFor(record),
        };
      });
    },

    metadata,

    async original(
      scope: ProjectCheckpointReviewScope,
      requestId: string,
    ): Promise<ProjectCheckpointReviewOriginalRead | null> {
      const journal = readJournal(scope);
      const found = journal.records.find(
        (record) => record.original.requestId === requestId,
      );
      if (!found || !same(found.scope, scope)) return null;
      return readFor(found);
    },

    async claim(
      scope: ProjectCheckpointReviewScope,
      requestId: string,
      intentHash: string,
      auditEventId: number,
    ) {
      return locked(scope, async (journal) => {
        const record = requireRecord(journal, scope, requestId, intentHash);
        if (
          record.state !== "prepared" ||
          journal.activeRequestId !== requestId
        )
          return {
            kind: "held" as const,
            metadata: metadataFor(record),
            receipt: record.receipt,
          };
        const updatedAt = isoNow(now);
        record.state = "dispatching";
        record.receipt = newReceipt(
          record.original,
          "unknown",
          auditEventId,
          updatedAt,
        );
        const persistReview = async () => {
          await requireSubmittedReview(journal, record.original.binding);
          saveJournal(scope, journal);
        };
        if (admission) await admission(scope.projectId, persistReview);
        else await persistReview();
        const permit: ProjectCheckpointReviewClaimPermit = Object.freeze({
          token: randomUUID(),
          scope: structuredClone(scope),
          requestId,
          intentHash,
        });
        permits.set(permit.token, permit);
        return {
          kind: "claimed" as const,
          permit,
          metadata: metadataFor(record),
          receipt: record.receipt,
        };
      });
    },

    async finish(
      permit: ProjectCheckpointReviewClaimPermit,
      outcome:
        | { kind: "refused-before-dispatch" }
        | { kind: "unknown"; reportedCommentId: string | null },
      auditEventId: number,
    ) {
      if (permits.get(permit.token) !== permit)
        throw new ConversationError(
          409,
          "The checkpoint review claim is not owned by this live service instance.",
        );
      return locked(permit.scope, (journal) => {
        const record = requireRecord(
          journal,
          permit.scope,
          permit.requestId,
          permit.intentHash,
        );
        if (
          record.state !== "dispatching" ||
          journal.activeRequestId !== permit.requestId
        )
          throw new ConversationError(
            409,
            "The checkpoint review claim is no longer current.",
          );
        const updatedAt = isoNow(now);
        if (outcome.kind === "refused-before-dispatch") {
          record.state = "refused";
          record.receipt = newReceipt(
            record.original,
            "refused",
            auditEventId,
            updatedAt,
          );
          journal.activeRequestId = null;
        } else {
          const reportedCommentId = validCommentId(outcome.reportedCommentId)
            ? outcome.reportedCommentId
            : null;
          record.state = "unknown";
          record.receipt = newReceipt(
            record.original,
            "unknown",
            auditEventId,
            updatedAt,
            {
              commentId: null,
              reportedCommentId,
              readback: "not-checked",
            },
          );
        }
        saveJournal(permit.scope, journal);
        permits.delete(permit.token);
        return readFor(record);
      });
    },

    async retire(
      scope: ProjectCheckpointReviewScope,
      requestId: string,
      intentHash: string,
      auditEventId: number,
    ) {
      return locked(scope, (journal) => {
        const record = requireRecord(journal, scope, requestId, intentHash);
        if (
          record.state !== "prepared" ||
          journal.activeRequestId !== requestId
        )
          throw new ConversationError(
            409,
            "Only a prepared checkpoint review can be retired.",
          );
        const updatedAt = isoNow(now);
        record.state = "retired";
        record.receipt = newReceipt(
          record.original,
          "retired",
          auditEventId,
          updatedAt,
        );
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
        if (["confirmed", "refused", "retired"].includes(record.state))
          return readFor(record);
        if (record.state !== "unknown" && record.state !== "dispatching")
          throw new ConversationError(
            409,
            "Only an uncertain checkpoint review can receive a readback.",
          );
        const updatedAt = isoNow(now);
        const validFound =
          evidence.kind === "found" && validCommentId(evidence.commentId);
        if (
          validFound &&
          evidence.kind === "found" &&
          evidence.body === record.original.commentText &&
          (record.receipt.reportedCommentId === null ||
            record.receipt.reportedCommentId === evidence.commentId)
        ) {
          record.state = "confirmed";
          record.receipt = newReceipt(
            record.original,
            "confirmed",
            auditEventId,
            updatedAt,
            {
              commentId: evidence.commentId,
              reportedCommentId: record.receipt.reportedCommentId,
              readback: "found",
            },
          );
          journal.activeRequestId = null;
        } else {
          record.state = "unknown";
          record.receipt = newReceipt(
            record.original,
            "unknown",
            auditEventId,
            updatedAt,
            {
              commentId: null,
              reportedCommentId: record.receipt.reportedCommentId,
              readback: evidence.kind === "found" ? "mismatch" : evidence.kind,
            },
          );
        }
        saveJournal(scope, journal);
        return readFor(record);
      });
    },
  };
}
