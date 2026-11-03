import { lstatSync } from "node:fs";
import { join } from "node:path";
import {
  type InboxDispositionEntry,
  type InboxDispositionOriginal,
  type InboxDispositionReceipt,
  type InboxDispositionRecovery,
  type InboxDispositionStore,
  type InboxDispositionStoredOriginal,
  inboxDispositionEntrySchema,
  inboxDispositionReceiptSchema,
  inboxDispositionRecoverySchema,
  inboxDispositionStoreSchema,
} from "../../types/inbox";
import type { ProjectCatalog } from "../../types/projects";
import {
  ensurePrivateHome,
  readHomeFile,
  readHomeFileBounded,
} from "../hearth/home-guard";
import { writeOwnerOnly } from "../hearth/token";
import { resolveCheckout } from "../ledger/workspace";
import { workspaceKey } from "../projects/scope";
import {
  createProjectStore,
  isProjectId,
  ProjectStoreError,
  projectWriteLockPath,
} from "../projects/store";
import { withQueueLock } from "../scheduler/queue-lock";

export const MAX_INBOX_DISPOSITION_BYTES = 4 * 1024 * 1024;
export const MAX_INBOX_DISPOSITION_ENTRIES = 1000;
export const MAX_INBOX_DISPOSITION_ORIGINALS = 4096;
export const MAX_INBOX_DISPOSITION_POST_BYTES = 4096;

export class InboxDispositionError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 503 | 504,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface InboxDispositionRecord {
  entry: InboxDispositionEntry | null;
  receipt: InboxDispositionReceipt;
}

const emptyStore = (): InboxDispositionStore => ({
  version: 1,
  entries: [],
  receipts: [],
});
const statePath = (home: string) =>
  join(home, "inbox-dispositions", "state.json");
const stateDirectory = (home: string) => join(home, "inbox-dispositions");
const initializedPath = (home: string) =>
  join(home, "projects", "inbox-dispositions.initialized");
const INITIALIZED = "inbox-dispositions-v1\n";
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
};
const same = (left: unknown, right: unknown) => stable(left) === stable(right);

/** Versioned acknowledgment identity includes the producer's source revision. */
function inboxDispositionIdentityKey(
  original: Pick<
    InboxDispositionStoredOriginal,
    "projectId" | "workspace" | "item"
  >,
): string {
  return stable([
    1,
    original.projectId,
    workspaceKey(original.workspace),
    original.item.sourceKind,
    original.item.stableItemId,
    original.item.sourceRevision,
  ]);
}

function pendingReservationFenceKey(
  original: Pick<
    InboxDispositionStoredOriginal,
    "projectId" | "workspace" | "item"
  >,
): string {
  return stable([
    1,
    original.projectId,
    workspaceKey(original.workspace),
    original.item.sourceKind,
    original.item.stableItemId,
  ]);
}

function entryKey(entry: InboxDispositionEntry): string {
  return inboxDispositionIdentityKey({
    projectId: entry.projectId,
    workspace: entry.workspace,
    item: entry.item,
  });
}

export function createInboxDispositionStore(
  home: string,
  options: {
    now?: () => Date;
    afterWrite?: () => void;
  } = {},
) {
  const file = statePath(home);
  const now = options.now ?? (() => new Date());
  const projectStore = createProjectStore(home);

  function read(): InboxDispositionStore {
    const found = readHomeFileBounded(home, file, MAX_INBOX_DISPOSITION_BYTES);
    if (found.problem !== null)
      throw new InboxDispositionError(
        503,
        "storage-unavailable",
        "Inbox disposition storage could not be read safely.",
      );
    if (found.text === null) {
      let initialized = false;
      try {
        lstatSync(stateDirectory(home));
        initialized = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw new InboxDispositionError(
            503,
            "storage-unavailable",
            "Inbox disposition storage could not be checked safely.",
          );
      }
      const marker = readHomeFile(home, initializedPath(home));
      if (marker.problem !== null)
        throw new InboxDispositionError(
          503,
          "storage-marker-unavailable",
          "Inbox disposition initialization state could not be checked safely.",
        );
      if (marker.text !== null && marker.text !== INITIALIZED)
        throw new InboxDispositionError(
          503,
          "storage-marker-corrupt",
          "Inbox disposition initialization state is corrupt.",
        );
      if (initialized || marker.text !== null)
        throw new InboxDispositionError(
          503,
          "storage-missing",
          "Inbox disposition storage is missing from an initialized store.",
        );
      return emptyStore();
    }
    let raw: unknown;
    try {
      raw = JSON.parse(found.text);
    } catch {
      throw new InboxDispositionError(
        503,
        "storage-corrupt",
        "Inbox disposition storage is not valid JSON.",
      );
    }
    const parsed = inboxDispositionStoreSchema.safeParse(raw);
    if (!parsed.success)
      throw new InboxDispositionError(
        503,
        "storage-corrupt",
        "Inbox disposition storage failed its versioned schema.",
      );
    const entryKeys = parsed.data.entries.map(entryKey);
    const pendingKeys = parsed.data.receipts
      .filter((receipt) => receipt.phase === "reserved")
      .map((receipt) => pendingReservationFenceKey(receipt.original));
    if (
      new Set(entryKeys).size !== entryKeys.length ||
      new Set(pendingKeys).size !== pendingKeys.length
    )
      throw new InboxDispositionError(
        503,
        "storage-duplicate-identity",
        "Inbox disposition storage contains duplicate identities and cannot be trusted.",
      );
    return parsed.data;
  }

  function write(next: InboxDispositionStore): InboxDispositionStore {
    if (next.entries.length > MAX_INBOX_DISPOSITION_ENTRIES)
      throw new InboxDispositionError(
        400,
        "entry-limit",
        "The retained Inbox disposition entry limit is full; no entry was evicted.",
      );
    const parsed = inboxDispositionStoreSchema.safeParse(next);
    if (!parsed.success)
      throw new InboxDispositionError(
        503,
        "storage-invalid",
        "The disposition update failed its storage schema.",
      );
    const contents = `${JSON.stringify(parsed.data, null, 2)}\n`;
    if (Buffer.byteLength(contents, "utf8") > MAX_INBOX_DISPOSITION_BYTES)
      throw new InboxDispositionError(
        400,
        "storage-full",
        "Inbox disposition storage is full; no entry was changed.",
      );
    const marker = readHomeFile(home, initializedPath(home));
    if (marker.problem !== null)
      throw new InboxDispositionError(
        503,
        "storage-marker-unavailable",
        "Inbox disposition initialization state could not be checked safely.",
      );
    if (marker.text === null) {
      try {
        writeOwnerOnly(initializedPath(home), INITIALIZED);
      } catch {
        const confirmed = readHomeFile(home, initializedPath(home));
        if (confirmed.problem !== null || confirmed.text !== INITIALIZED)
          throw new InboxDispositionError(
            504,
            "initialization-uncertain",
            "Inbox disposition initialization could not be confirmed. Read the exact saved request before continuing.",
          );
      }
    } else if (marker.text !== INITIALIZED)
      throw new InboxDispositionError(
        503,
        "storage-marker-corrupt",
        "Inbox disposition initialization state is corrupt.",
      );
    try {
      writeOwnerOnly(file, contents);
      options.afterWrite?.();
    } catch {
      try {
        const confirmed = read();
        if (same(confirmed, parsed.data)) return confirmed;
      } catch {
        // A missing or unreadable readback cannot prove the write's outcome.
      }
      throw new InboxDispositionError(
        504,
        "write-uncertain",
        "The disposition write outcome is uncertain. Read the exact saved request before continuing.",
      );
    }
    let confirmed: InboxDispositionStore;
    try {
      confirmed = read();
    } catch {
      throw new InboxDispositionError(
        504,
        "write-unconfirmed",
        "The disposition write could not be read back. Read the exact saved request before continuing.",
      );
    }
    if (!same(confirmed, parsed.data))
      throw new InboxDispositionError(
        504,
        "write-unconfirmed",
        "The disposition write could not be confirmed. Read the exact saved request before continuing.",
      );
    return confirmed;
  }

  async function locked<T>(work: () => Promise<T>): Promise<T> {
    try {
      ensurePrivateHome(home);
    } catch {
      throw new InboxDispositionError(
        503,
        "home-unavailable",
        "The private hearth home is unavailable for Inbox disposition storage.",
      );
    }
    const result = await withQueueLock(projectWriteLockPath(home), work, {
      waitMs: 1000,
    });
    if (!result.ok)
      throw new InboxDispositionError(
        503,
        "project-lock-unavailable",
        "The shared project write lock is busy or unavailable; nothing was changed.",
      );
    return result.value;
  }

  function projectWorkspace(
    projectId: string,
    workspace: string,
    expectedCatalogRevision: number,
  ) {
    let catalog: ProjectCatalog;
    try {
      catalog = projectStore.read();
    } catch (error) {
      if (error instanceof ProjectStoreError)
        throw new InboxDispositionError(
          503,
          "catalog-unavailable",
          error.message,
        );
      throw error;
    }
    const project = catalog.projects.find((item) => item.id === projectId);
    if (!project || project.archived)
      throw new InboxDispositionError(
        409,
        "project-unavailable",
        "The project is missing or archived; refresh before acknowledging this item.",
      );
    if (catalog.revision !== expectedCatalogRevision)
      throw new InboxDispositionError(
        409,
        "catalog-changed",
        "The project catalog changed; refresh before acknowledging this item.",
      );
    const scope = project.workspaces.find(
      (item) => workspaceKey(item.root) === workspaceKey(workspace),
    );
    if (!scope)
      throw new InboxDispositionError(
        409,
        "workspace-changed",
        "The project no longer contains this workspace; refresh before acknowledging this item.",
      );
    return workspaceKey(resolveCheckout(scope.root).workspace);
  }

  function appEntry(
    state: InboxDispositionStore,
    original: InboxDispositionStoredOriginal,
  ): InboxDispositionEntry | null {
    const key = inboxDispositionIdentityKey(original);
    return state.entries.find((entry) => entryKey(entry) === key) ?? null;
  }

  function receiptRecord(
    state: InboxDispositionStore,
    receipt: InboxDispositionReceipt,
  ): InboxDispositionRecord {
    return { entry: appEntry(state, receipt.original), receipt };
  }

  function originalFor(
    projectId: string,
    workspace: string,
    original: InboxDispositionOriginal,
  ): InboxDispositionStoredOriginal {
    return { ...original, projectId, workspace };
  }

  function findReceipt(state: InboxDispositionStore, requestId: string) {
    return state.receipts.find(
      (receipt) => receipt.original.requestId === requestId,
    );
  }

  return {
    read,
    recovery(): InboxDispositionRecovery {
      const state = read();
      return inboxDispositionRecoverySchema.parse({
        version: 1,
        complete: true,
        receipts: state.receipts,
      });
    },
    collection(projectId: string, servedWorkspace: string) {
      if (!isProjectId(projectId))
        throw new InboxDispositionError(
          400,
          "project-id",
          "Expected a project id.",
        );
      const state = read();
      const workspace = workspaceKey(servedWorkspace);
      const receipts = state.receipts.filter(
        (receipt) =>
          receipt.original.projectId === projectId &&
          workspaceKey(receipt.original.workspace) === workspace,
      );
      return {
        entries: state.entries.filter(
          (entry) =>
            entry.projectId === projectId &&
            workspaceKey(entry.workspace) === workspace,
        ),
        receipts,
      };
    },
    original(
      projectId: string,
      requestId: string,
      servedWorkspace: string,
    ): InboxDispositionRecord | null {
      if (!isProjectId(projectId))
        throw new InboxDispositionError(
          400,
          "project-id",
          "Expected a project id.",
        );
      const state = read();
      const receipt = findReceipt(state, requestId);
      return receipt?.original.projectId === projectId &&
        workspaceKey(receipt.original.workspace) ===
          workspaceKey(servedWorkspace)
        ? receiptRecord(state, receipt)
        : null;
    },
    reserve(
      projectId: string,
      servedWorkspace: string,
      body: InboxDispositionOriginal,
    ) {
      return locked(async () => {
        if (workspaceKey(body.workspace) !== workspaceKey(servedWorkspace))
          throw new InboxDispositionError(
            409,
            "workspace-not-served",
            "This hearth cannot acknowledge an Inbox item from another workspace.",
          );
        const state = read();
        const previous = findReceipt(state, body.requestId);
        if (previous) {
          const repeated = originalFor(projectId, body.workspace, body);
          if (!same(previous.original, repeated))
            throw new InboxDispositionError(
              409,
              "request-id-reused",
              "This request id is already bound to a different immutable original.",
            );
          return receiptRecord(state, previous);
        }
        const canonicalWorkspace = projectWorkspace(
          projectId,
          body.workspace,
          body.expectedCatalogRevision,
        );
        if (body.workspace !== canonicalWorkspace)
          throw new InboxDispositionError(
            409,
            "workspace-not-canonical",
            "Use the project's exact canonical workspace key before reserving this item.",
          );
        const original = originalFor(projectId, canonicalWorkspace, body);
        const pending = state.receipts.find(
          (receipt) =>
            receipt.phase === "reserved" &&
            pendingReservationFenceKey(receipt.original) ===
              pendingReservationFenceKey(original),
        );
        if (pending)
          throw new InboxDispositionError(
            409,
            "pending-original",
            "An unresolved original already exists for this Inbox item. Read or discard that exact request first.",
          );
        if (state.receipts.length >= MAX_INBOX_DISPOSITION_ORIGINALS)
          throw new InboxDispositionError(
            400,
            "original-limit",
            "The retained Inbox original limit is full; no original was evicted.",
          );
        const existing = appEntry(state, original);
        if ((existing?.revision ?? 0) !== body.expectedRevision)
          throw new InboxDispositionError(
            409,
            "entry-revision-changed",
            "This Inbox disposition changed. Read the current entry before reserving another action.",
          );
        const receipt = inboxDispositionReceiptSchema.parse({
          original,
          phase: "reserved",
          reservedAt: now().toISOString(),
        });
        const next = { ...state, receipts: [...state.receipts, receipt] };
        const saved = write(next);
        return receiptRecord(saved, receipt);
      });
    },
    apply(
      projectId: string,
      servedWorkspace: string,
      body: InboxDispositionOriginal,
    ) {
      return locked(async () => {
        if (workspaceKey(body.workspace) !== workspaceKey(servedWorkspace))
          throw new InboxDispositionError(
            409,
            "workspace-not-served",
            "This hearth cannot acknowledge an Inbox item from another workspace.",
          );
        const state = read();
        const saved = findReceipt(state, body.requestId);
        if (!saved || saved.original.projectId !== projectId)
          throw new InboxDispositionError(
            409,
            "reservation-missing",
            "The exact durable reservation is unavailable; no acknowledgment was applied.",
          );
        const submitted = originalFor(projectId, body.workspace, body);
        if (!same(saved.original, submitted))
          throw new InboxDispositionError(
            409,
            "original-mismatch",
            "The apply request does not match the exact reserved original.",
          );
        if (saved.phase !== "reserved") return receiptRecord(state, saved);
        let refusal: { code: string; reason: string } | null = null;
        try {
          const currentWorkspace = projectWorkspace(
            projectId,
            body.workspace,
            body.expectedCatalogRevision,
          );
          if (currentWorkspace !== saved.original.workspace)
            refusal = {
              code: "workspace-changed",
              reason:
                "The project's canonical workspace changed after reservation.",
            };
        } catch (error) {
          if (error instanceof InboxDispositionError && error.status === 409)
            refusal = { code: error.code, reason: error.message };
          else throw error;
        }
        const existing = appEntry(state, saved.original);
        if (!refusal && (existing?.revision ?? 0) !== body.expectedRevision)
          refusal = {
            code: "entry-revision-changed",
            reason:
              "The Inbox disposition changed after reservation; no acknowledgment was applied.",
          };
        const stamp = now();
        if (refusal) {
          const receipt = inboxDispositionReceiptSchema.parse({
            original: saved.original,
            phase: "refused",
            reservedAt: saved.reservedAt,
            settledAt: stamp.toISOString(),
            outcome: "refused",
            refusalCode: refusal.code,
            refusalReason: refusal.reason.slice(0, 300),
          });
          const next = {
            ...state,
            receipts: state.receipts.map((item) =>
              item.original.requestId === body.requestId ? receipt : item,
            ),
          };
          return receiptRecord(write(next), receipt);
        }
        const snoozedUntil =
          body.operation === "snooze-1h"
            ? new Date(stamp.getTime() + 60 * 60 * 1000).toISOString()
            : undefined;
        const entry = inboxDispositionEntrySchema.parse({
          projectId,
          workspace: saved.original.workspace,
          item: {
            sourceKind: saved.original.item.sourceKind,
            stableItemId: saved.original.item.stableItemId,
            sourceRevision: saved.original.item.sourceRevision,
          },
          revision: body.expectedRevision + 1,
          operation: body.operation,
          updatedAt: stamp.toISOString(),
          ...(snoozedUntil !== undefined ? { snoozedUntil } : {}),
        });
        const receipt = inboxDispositionReceiptSchema.parse({
          original: saved.original,
          phase: "applied",
          reservedAt: saved.reservedAt,
          settledAt: stamp.toISOString(),
          outcome: "applied",
          resultingRevision: entry.revision,
          resultingValue: body.operation,
          ...(snoozedUntil !== undefined ? { snoozedUntil } : {}),
        });
        const next = {
          ...state,
          entries: [
            ...state.entries.filter(
              (item) => entryKey(item) !== entryKey(entry),
            ),
            entry,
          ],
          receipts: state.receipts.map((item) =>
            item.original.requestId === body.requestId ? receipt : item,
          ),
        };
        return receiptRecord(write(next), receipt);
      });
    },
    discard(
      projectId: string,
      requestId: string,
      servedWorkspace: string,
      body: InboxDispositionOriginal,
    ) {
      return locked(async () => {
        if (workspaceKey(body.workspace) !== workspaceKey(servedWorkspace))
          throw new InboxDispositionError(
            409,
            "workspace-not-served",
            "This hearth cannot discard an Inbox original from another workspace.",
          );
        const state = read();
        const saved = findReceipt(state, requestId);
        if (!saved || saved.original.projectId !== projectId)
          throw new InboxDispositionError(
            404,
            "original-missing",
            "The exact Inbox original was not found.",
          );
        const supplied = originalFor(projectId, body.workspace, body);
        if (requestId !== body.requestId || !same(saved.original, supplied))
          throw new InboxDispositionError(
            409,
            "original-mismatch",
            "Discard must name the exact immutable original.",
          );
        if (saved.phase !== "reserved") return receiptRecord(state, saved);
        const receipt = inboxDispositionReceiptSchema.parse({
          original: saved.original,
          phase: "refused",
          reservedAt: saved.reservedAt,
          settledAt: now().toISOString(),
          outcome: "refused",
          refusalCode: "discarded",
          refusalReason:
            "The reserved Inbox acknowledgment was explicitly discarded.",
        });
        const next = {
          ...state,
          receipts: state.receipts.map((item) =>
            item.original.requestId === requestId ? receipt : item,
          ),
        };
        return receiptRecord(write(next), receipt);
      });
    },
  };
}
