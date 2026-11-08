import { z } from "zod";
import type { OperatorPost } from "../../../docs/js/operator";
import { hasDuplicateObjectKeys } from "../../../scripts/json-object-keys";
import {
  canonicalCleanupRequest,
  cleanupReceiptSchema,
  cleanupRequestSchema,
} from "../../../scripts/projects/worktree-cleanup-protocol";
import { cleanupReviewSchema } from "../../../scripts/projects/worktree-cleanup-review-protocol";

export const cleanupBrowserOriginalSchema = z
  .object({
    projectId: cleanupReceiptSchema.shape.projectId,
    review: cleanupReviewSchema.options[0],
    request: cleanupRequestSchema,
    requestHash: cleanupReceiptSchema.shape.requestHash,
  })
  .strict()
  .refine(
    (original) =>
      original.projectId === original.review.projectId &&
      canonicalCleanupRequest(original.projectId, original.request) ===
        canonicalCleanupRequest(original.projectId, {
          ...original.review,
          requestId: original.request.requestId,
        }),
    { message: "Displayed cleanup review does not match the full original" },
  );
export type CleanupBrowserOriginal = z.infer<
  typeof cleanupBrowserOriginalSchema
>;

/** Exact native values; the displayed observation time is part of the saved original. */
export function sameCleanupOriginal(
  left: CleanupBrowserOriginal,
  right: CleanupBrowserOriginal,
): boolean {
  return (
    left.projectId === right.projectId &&
    left.requestHash === right.requestHash &&
    left.review.asOf === right.review.asOf &&
    left.review.projectId === right.review.projectId &&
    left.review.worktreeId === right.review.worktreeId &&
    canonicalCleanupRequest(left.projectId, left.request) ===
      canonicalCleanupRequest(right.projectId, right.request) &&
    canonicalCleanupRequest(left.projectId, {
      ...left.review,
      requestId: left.request.requestId,
    }) ===
      canonicalCleanupRequest(right.projectId, {
        ...right.review,
        requestId: right.request.requestId,
      })
  );
}
export const cleanupBrowserRecordSchema = z
  .object({
    original: cleanupBrowserOriginalSchema,
    receipt: cleanupReceiptSchema.nullable(),
  })
  .strict()
  .refine(
    ({ original, receipt }) => {
      if (receipt === null) return true;
      if (
        receipt.projectId !== original.projectId ||
        receipt.requestHash !== original.requestHash ||
        canonicalCleanupRequest(receipt.projectId, receipt) !==
          canonicalCleanupRequest(original.projectId, original.request)
      )
        return false;
      const audited = Date.parse(receipt.audit.ts);
      return (
        (receipt.attemptedAt === null ||
          audited <= Date.parse(receipt.attemptedAt)) &&
        (receipt.endedAt === null || audited <= Date.parse(receipt.endedAt))
      );
    },
    {
      message:
        "Stored cleanup receipt does not match its original or audit chronology",
    },
  );
export type CleanupBrowserRecord = z.infer<typeof cleanupBrowserRecordSchema>;

export const cleanupBrowserMarkerSchema = z
  .object({
    version: z.literal(1),
    authorityKey: z.string().min(1).max(2048),
  })
  .strict();
export const cleanupBrowserInventorySchema = cleanupBrowserMarkerSchema
  .extend({
    records: z.array(cleanupBrowserRecordSchema).max(100),
    activeRequestId: cleanupRequestSchema.shape.requestId.nullable(),
  })
  .strict()
  .refine(
    (inventory) => {
      const seen = new Set<string>();
      let unresolved: string | null = null;
      for (const row of inventory.records) {
        const id = row.original.request.requestId;
        if (seen.has(id)) return false;
        seen.add(id);
        if (row.receipt === null || row.receipt.state === "unknown") {
          if (unresolved !== null) return false;
          unresolved = id;
        }
      }
      return inventory.activeRequestId === unresolved;
    },
    { message: "Cleanup inventory has conflicting active ownership" },
  );
export type CleanupBrowserInventory = z.infer<
  typeof cleanupBrowserInventorySchema
>;

function parseCleanupRaw(source: string, maxBytes: number): unknown {
  if (
    typeof source !== "string" ||
    source.length > maxBytes ||
    new TextEncoder().encode(source).byteLength > maxBytes
  )
    throw Error("Cleanup recovery metadata exceeds its byte limit");
  try {
    if (hasDuplicateObjectKeys(source))
      throw Error("Duplicate decoded JSON key");
    return JSON.parse(source);
  } catch {
    throw Error("Cleanup recovery metadata is malformed or has duplicate keys");
  }
}
/** Read-only: absence of both keys is distinct from damaged initialized evidence. */
export async function readCleanupBrowserInventory(
  rawMarker: string | null,
  rawInventory: string | null,
  authorityKey: string,
  hash: (text: string) => Promise<string>,
): Promise<CleanupBrowserInventory | null> {
  cleanupBrowserMarkerSchema.shape.authorityKey.parse(authorityKey);
  if (rawMarker === null && rawInventory === null) return null;
  if (rawMarker === null || rawInventory === null)
    throw Error("Initialized cleanup recovery metadata is missing");
  const marker = cleanupBrowserMarkerSchema.parse(
    parseCleanupRaw(rawMarker, 16384),
  );
  const raw = parseCleanupRaw(rawInventory, 1048576);
  if (
    raw &&
    typeof raw === "object" &&
    "records" in raw &&
    Array.isArray(raw.records) &&
    raw.records.length > 100
  )
    throw Error("Cleanup inventory exceeds its row limit");
  const inventory = cleanupBrowserInventorySchema.parse(raw);
  if (
    marker.authorityKey !== authorityKey ||
    inventory.authorityKey !== authorityKey
  )
    throw Error("Cleanup recovery authority changed");
  for (const row of inventory.records) {
    const original = row.original;
    if (
      (await hash(
        canonicalCleanupRequest(original.projectId, original.request),
      )) !== original.requestHash
    )
      throw Error("Cleanup recovery original hash does not match");
  }
  return inventory;
}

/** Inputs come from the complete raw/hash reader; storage history only advances. */
export function advanceCleanupBrowserInventory(
  knownInventory: CleanupBrowserInventory,
  freshInventory: unknown,
): CleanupBrowserInventory {
  const known = cleanupBrowserInventorySchema.parse(knownInventory);
  const fresh = cleanupBrowserInventorySchema.parse(freshInventory);
  if (
    known.authorityKey !== fresh.authorityKey ||
    known.version !== fresh.version
  )
    throw Error("Cleanup recovery authority changed");
  const rows = new Map(
    fresh.records.map((row) => [row.original.request.requestId, row]),
  );
  for (const held of known.records) {
    const candidate = rows.get(held.original.request.requestId);
    if (!candidate || !sameCleanupOriginal(held.original, candidate.original))
      throw Error("Cleanup recovery lost or changed an original");
    const before = held.receipt,
      after = candidate.receipt;
    if (before === null) continue;
    if (
      after === null ||
      before.audit.eventId !== after.audit.eventId ||
      before.audit.ulid !== after.audit.ulid ||
      before.audit.ts !== after.audit.ts ||
      (before.attemptedAt !== null && before.attemptedAt !== after.attemptedAt)
    )
      throw Error("Cleanup recovery erased or changed verified evidence");
    if (
      before.state !== "unknown" &&
      (before.state !== after.state ||
        before.reason !== after.reason ||
        before.endedAt !== after.endedAt ||
        before.attemptedAt !== after.attemptedAt)
    )
      throw Error("Cleanup recovery changed a terminal receipt");
  }
  return fresh;
}

export interface CleanupBrowserScope {
  projectId: string;
  repository: string;
  worktreeId: string;
}
export interface CleanupBrowserDependencies {
  authorityKey: string;
  storage: Pick<Storage, "getItem" | "setItem">;
  withLock<T>(work: () => Promise<T>): Promise<T>;
  uuid(): string;
  hash(text: string): Promise<string>;
  currentScope(): CleanupBrowserScope | null;
  canWrite(): boolean;
  readReview(url: string, limits: { maxBodyBytes: number }): Promise<unknown>;
  readReceipt(url: string, limits: { maxBodyBytes: number }): Promise<unknown>;
  operatorPost: OperatorPost;
}
export interface CleanupBrowserView {
  readonly phase:
    | "idle"
    | "restoring"
    | "retained-unconfirmed"
    | "storage-unavailable";
  readonly inventory: CleanupBrowserInventory | null;
  readonly storageError: boolean;
}
function freezeCleanupSnapshot<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeCleanupSnapshot(child);
    Object.freeze(value);
  }
  return value;
}
export class ProjectWorktreeCleanupOwner {
  private value: CleanupBrowserView = freezeCleanupSnapshot({
    phase: "idle",
    inventory: null,
    storageError: false,
  });
  private listeners = new Set<(value: CleanupBrowserView) => void>();
  private initialized = false;
  private restoring: Promise<void> | null = null;
  private deps: CleanupBrowserDependencies;
  private keys: [string, string];
  constructor(deps: CleanupBrowserDependencies) {
    const {
      authorityKey,
      storage,
      withLock,
      uuid,
      hash,
      currentScope,
      canWrite,
      readReview,
      readReceipt,
      operatorPost,
    } = deps;
    this.deps = Object.freeze({
      authorityKey,
      storage: Object.freeze({
        getItem: storage.getItem.bind(storage),
        setItem: storage.setItem.bind(storage),
      }),
      withLock: withLock.bind(deps),
      uuid: uuid.bind(deps),
      hash: hash.bind(deps),
      currentScope: currentScope.bind(deps),
      canWrite: canWrite.bind(deps),
      readReview: readReview.bind(deps),
      readReceipt: readReceipt.bind(deps),
      operatorPost: operatorPost.bind(deps),
    });
    const base = "agent-forge.project-worktree-cleanup.v1." + authorityKey;
    this.keys = [base + ".marker", base + ".inventory"];
  }
  snapshot = () => this.value;
  subscribe = (listener: (value: CleanupBrowserView) => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(next: CleanupBrowserView) {
    this.value = freezeCleanupSnapshot(structuredClone(next));
    for (const listener of [...this.listeners]) {
      try {
        listener(this.value);
      } catch {
        /* Observers cannot change verified truth. */
      }
    }
  }
  private raw(): [string | null, string | null] {
    const observe = (key: string) => {
      const value = this.deps.storage.getItem(key);
      if (value !== null) this.initialized = true;
      return value;
    };
    return [observe(this.keys[0]), observe(this.keys[1])];
  }
  private assertRaw(expected: [string | null, string | null]) {
    const actual = this.raw();
    if (actual[0] !== expected[0] || actual[1] !== expected[1])
      throw Error("Cleanup recovery metadata changed during verification");
  }
  restore() {
    if (this.restoring) return this.restoring;
    const work = Promise.resolve().then(async () => {
      try {
        this.publish({ ...this.value, phase: "restoring" });
        await this.deps.withLock(async () => {
          let expected = this.raw();
          if (expected.some((value) => value !== null)) this.initialized = true;
          let inventory = await readCleanupBrowserInventory(
            expected[0],
            expected[1],
            this.deps.authorityKey,
            this.deps.hash,
          );
          this.assertRaw(expected);
          if (inventory === null) {
            if (this.initialized)
              throw Error("Initialized cleanup recovery metadata was lost");
            this.initialized = true;
            const empty = cleanupBrowserInventorySchema.parse({
              version: 1,
              authorityKey: this.deps.authorityKey,
              records: [],
              activeRequestId: null,
            });
            const write = (index: 0 | 1, text: string) => {
              this.assertRaw(expected);
              this.deps.storage.setItem(this.keys[index], text);
              expected = [...expected];
              expected[index] = text;
              this.assertRaw(expected);
            };
            write(
              0,
              JSON.stringify({
                version: 1,
                authorityKey: this.deps.authorityKey,
              }),
            );
            write(1, JSON.stringify(empty));
            inventory = await readCleanupBrowserInventory(
              expected[0],
              expected[1],
              this.deps.authorityKey,
              this.deps.hash,
            );
            this.assertRaw(expected);
            if (inventory === null)
              throw Error("Cleanup recovery initialization was not verified");
          }
          if (this.value.inventory)
            inventory = advanceCleanupBrowserInventory(
              this.value.inventory,
              inventory,
            );
          this.publish({
            phase: inventory.activeRequestId ? "retained-unconfirmed" : "idle",
            inventory,
            storageError: false,
          });
        });
      } catch {
        this.publish({
          ...this.value,
          phase: "storage-unavailable",
          storageError: true,
        });
      } finally {
        this.restoring = null;
      }
    });
    this.restoring = work;
    return work;
  }
}
