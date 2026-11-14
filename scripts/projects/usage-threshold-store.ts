import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  type InboxUsageRulesDocument,
  inboxUsageRulesDocumentSchema,
} from "../../types/inbox-usage";
import {
  type UsageThresholdIntent,
  type UsageThresholdRecovery,
  usageThresholdIntentSchema,
  usageThresholdPendingSchema,
  usageThresholdRecoverySchema,
} from "../../types/usage-threshold-intents";
import {
  MAX_USAGE_POLICY_REQUEST_BYTES,
  usageThresholdOriginalSchema as originalSchema,
  usageThresholdReceiptSchema as receiptSchema,
  usageThresholdJson as stable,
  type UsageThresholdOriginal,
  type UsageThresholdReceipt,
  type UsageThresholdRecord,
  usageThresholdRequestSchema,
} from "../../types/usage-threshold-settings";

export {
  MAX_USAGE_POLICY_REQUEST_BYTES,
  type UsageThresholdOriginal,
  type UsageThresholdReceipt,
  type UsageThresholdRecord,
  type UsageThresholdRequest,
  usageThresholdRequestSchema,
} from "../../types/usage-threshold-settings";

import { ensurePrivateHome, readHomeFileBounded } from "../hearth/home-guard";
import { writeOwnerOnly } from "../hearth/token";
import { withQueueLock } from "../scheduler/queue-lock";
import { withProjectAdmission } from "./admission";
import { workspaceKey } from "./scope";
import { createProjectStore, ProjectStoreError } from "./store";

export const MAX_USAGE_POLICY_BYTES = 4 * 1024 * 1024;
export const MAX_USAGE_POLICY_DOCUMENTS = 64;
export const MAX_USAGE_POLICY_ORIGINALS = 256;
const uuid = usageThresholdRequestSchema.shape.requestId;
const workspace = usageThresholdRequestSchema.shape.workspace;
const savedDocumentSchema = inboxUsageRulesDocumentSchema.refine(
  (doc) => doc.revision > 0 && doc.workspace === workspaceKey(doc.workspace),
);
const legacyStateSchema = z
  .object({
    version: z.literal(1),
    documents: z.array(savedDocumentSchema).max(MAX_USAGE_POLICY_DOCUMENTS),
    receipts: z.array(receiptSchema).min(1).max(MAX_USAGE_POLICY_ORIGINALS),
  })
  .strict();
const reservationSchema = usageThresholdPendingSchema
  .extend({
    phase: z.enum(["reserved", "discarded"]),
    discardedAt: z.iso.datetime().nullable(),
  })
  .strict()
  .refine((row) =>
    row.phase === "reserved"
      ? row.discardedAt === null
      : row.discardedAt !== null &&
        row.discardedAt.length === 24 &&
        row.discardedAt >= row.reservedAt,
  );
const stateSchema = z
  .object({
    version: z.literal(2),
    documents: legacyStateSchema.shape.documents,
    receipts: z.array(receiptSchema).max(MAX_USAGE_POLICY_ORIGINALS),
    originals: z.array(reservationSchema).max(MAX_USAGE_POLICY_ORIGINALS),
  })
  .strict()
  .refine((state) => state.receipts.length + state.originals.length > 0);
type State = z.infer<typeof stateSchema>;
export interface UsageThresholdStore {
  read(projectId: string): InboxUsageRulesDocument;
  original(projectId: string, requestId: string): UsageThresholdRecord;
  write(projectId: string, raw: unknown): Promise<UsageThresholdRecord>;
}
export interface UsageThresholdReservationStore extends UsageThresholdStore {
  reserve(projectId: string, raw: unknown): Promise<UsageThresholdIntent>;
  applyReserved(projectId: string, raw: unknown): Promise<UsageThresholdRecord>;
  reservation(projectId: string, requestId: string): UsageThresholdIntent;
  recovery(): UsageThresholdRecovery;
  discardReserved(
    projectId: string,
    requestId: string,
    raw: unknown,
  ): Promise<UsageThresholdIntent>;
}
export class UsageThresholdError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 503 | 504,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const MARKER = "usage-threshold-settings-v1\n";
const same = (a: unknown, b: unknown) => stable(a) === stable(b);
const hash = (value: unknown) =>
  createHash("sha256").update(stable(value)).digest("hex");
const key = (value: { projectId: string; workspace: string }) =>
  stable([value.projectId, value.workspace]);
const fail = (
  status: UsageThresholdError["status"],
  code: string,
  message: string,
): never => {
  throw new UsageThresholdError(status, code, message);
};
const unavailable = (): never =>
  fail(
    503,
    "storage-unavailable",
    "Private usage threshold storage is unavailable or inconsistent.",
  );
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function checkedState(raw: unknown, preflight = false): State {
  const parsed = z.union([legacyStateSchema, stateSchema]).safeParse(raw);
  if (!parsed.success) return unavailable();
  const state: State =
    parsed.data.version === 1
      ? { ...parsed.data, version: 2, originals: [] }
      : parsed.data;
  if (
    new Set(state.documents.map(key)).size !== state.documents.length ||
    new Set(state.receipts.map((row) => row.original.requestId)).size !==
      state.receipts.length
  )
    return unavailable();
  const versions = new Map<string, number>(),
    latest = new Map<string, UsageThresholdReceipt>();
  for (const row of state.receipts) {
    const id = key(row.original),
      precedingRevision = versions.get(id) ?? 0;
    if (
      row.originalHash !== hash(row.original) ||
      Buffer.byteLength(JSON.stringify(row.original), "utf8") >
        MAX_USAGE_POLICY_REQUEST_BYTES ||
      row.observedRevision !== precedingRevision
    )
      return unavailable();
    if (row.outcome === "applied") {
      versions.set(id, row.resultingRevision);
      latest.set(id, row);
    }
  }
  for (const [id, revision] of versions) {
    const doc = state.documents.find((item) => key(item) === id),
      last = latest.get(id);
    if (
      !doc ||
      !last ||
      doc.revision !== revision ||
      !same(doc.rules, last.original.rules)
    )
      return unavailable();
  }
  for (const doc of state.documents)
    if (versions.get(key(doc)) !== doc.revision) return unavailable();
  const receipts = new Map(
    state.receipts.map((row) => [row.original.requestId, row]),
  );
  const ids = new Set(receipts.keys());
  const pending = new Set<string>();
  const seen = new Set<string>();
  let heldBytes = 0;
  for (const row of state.originals) {
    const id = row.original.requestId;
    const currentRevision =
      state.documents.find((doc) => key(doc) === key(row.original))?.revision ??
      0;
    if (currentRevision < row.original.expectedRevision) return unavailable();
    const originalBytes = Buffer.byteLength(JSON.stringify(row.original));
    if (
      seen.has(id) ||
      row.originalHash !== hash(row.original) ||
      originalBytes > MAX_USAGE_POLICY_REQUEST_BYTES
    )
      return unavailable();
    seen.add(id);
    ids.add(id);
    const receipt = receipts.get(id);
    if (receipt) {
      if (
        row.phase === "discarded" ||
        !same(row.original, receipt.original) ||
        row.originalHash !== receipt.originalHash ||
        receipt.settledAt.length !== 24 ||
        receipt.settledAt < row.reservedAt
      )
        return unavailable();
    } else if (row.phase === "reserved") {
      if (
        pending.has(key(row.original)) ||
        currentRevision !== row.original.expectedRevision
      )
        return unavailable();
      pending.add(key(row.original));
      heldBytes += 2 * originalBytes + 512;
    }
  }
  if (
    ids.size > MAX_USAGE_POLICY_ORIGINALS ||
    Buffer.byteLength(JSON.stringify(parsed.data)) + heldBytes >
      MAX_USAGE_POLICY_BYTES
  )
    return preflight
      ? fail(
          503,
          "history-full",
          "Usage threshold history is full. Existing original recovery remains available.",
        )
      : unavailable();
  return state;
}

/** One app-owned policy journal; no provider, acknowledgment or source action is performed. */
export function createUsageThresholdStore(
  home: string,
  servedWorkspace: string,
  options: {
    now?: () => Date;
    beforeAdmission?: () => Promise<void>;
    afterWrite?: () => void;
  } = {},
): UsageThresholdReservationStore {
  if (
    typeof home !== "string" ||
    !isAbsolute(home) ||
    typeof servedWorkspace !== "string"
  )
    fail(400, "invalid-binding", "Expected a trusted usage settings binding.");
  const binding = workspaceKey(servedWorkspace);
  if (!workspace.safeParse(binding).success)
    fail(400, "invalid-binding", "Expected a trusted usage settings binding.");
  const now = options.now ?? (() => new Date()),
    beforeAdmission = options.beforeAdmission,
    afterWrite = options.afterWrite;
  const directory = join(home, "usage-threshold-settings"),
    file = join(directory, "state.json"),
    marker = join(home, "projects", "usage-threshold-settings.initialized"),
    lock = join(home, "projects", "usage-threshold-settings.lock.db");
  function checkPaths() {
    for (const [target, folder] of [
      [directory, true],
      [file, false],
      [marker, false],
      [lock, false],
    ] as const) {
      try {
        const info = lstatSync(target);
        if (
          info.isSymbolicLink() ||
          (folder ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)
        )
          unavailable();
      } catch (error) {
        if (error instanceof UsageThresholdError) throw error;
        if (
          !(
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          unavailable();
      }
    }
  }
  function readState(): State {
    checkPaths();
    const stored = readHomeFileBounded(home, file, MAX_USAGE_POLICY_BYTES),
      initialized = readHomeFileBounded(home, marker, 64);
    if (stored.problem !== null || initialized.problem !== null)
      return unavailable();
    if (stored.text === null && initialized.text === null) {
      try {
        lstatSync(directory);
        return unavailable();
      } catch (error) {
        if (error instanceof UsageThresholdError) throw error;
        if (
          !(
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          return unavailable();
      }
      return { version: 2, documents: [], receipts: [], originals: [] };
    }
    if (stored.text === null || initialized.text !== MARKER)
      return unavailable();
    let raw: unknown;
    try {
      raw = JSON.parse(stored.text);
    } catch {
      return unavailable();
    }
    return checkedState(raw);
  }
  function projectId(value: string): string {
    const parsed =
      inboxUsageRulesDocumentSchema.shape.projectId.safeParse(value);
    if (!parsed.success)
      return fail(400, "invalid-project", "Expected a project identity.");
    return parsed.data;
  }
  function document(state: State, id: string): InboxUsageRulesDocument {
    return (
      state.documents.find(
        (doc) => doc.projectId === id && doc.workspace === binding,
      ) ?? { projectId: id, workspace: binding, revision: 0, rules: [] }
    );
  }
  function record(
    state: State,
    receipt: UsageThresholdReceipt,
  ): UsageThresholdRecord {
    return freeze(
      structuredClone({
        receipt,
        document: document(state, receipt.original.projectId),
      }),
    );
  }
  function mapError(error: unknown, attempted = false): UsageThresholdError {
    if (attempted)
      return new UsageThresholdError(
        504,
        "outcome-unknown",
        "Usage threshold settings may have changed. Check this exact saved original before doing anything else.",
      );
    if (error instanceof UsageThresholdError) return error;
    if (error instanceof ProjectStoreError)
      return new UsageThresholdError(
        error.status === 410 ? 404 : error.status,
        "project-unavailable",
        "Current project admission or usage settings scope is unavailable.",
      );
    return new UsageThresholdError(
      503,
      "storage-unavailable",
      "Private usage threshold settings are unavailable.",
    );
  }
  function currentCatalog(id: string, expectedRevision?: number) {
    const catalog = createProjectStore(home).read(),
      project = catalog.projects.find((item) => item.id === id);
    if (!project)
      return fail(
        404,
        "project-unavailable",
        "The project is unavailable for current usage settings.",
      );
    if (
      !project.workspaces.some(
        (scope) => workspaceKey(scope.root) === binding,
      ) ||
      (expectedRevision !== undefined && catalog.revision !== expectedRevision)
    )
      return fail(
        409,
        "scope-changed",
        "Project scope or catalog revision changed. Refresh usage settings before saving.",
      );
    return catalog;
  }
  function existing(
    state: State,
    original: UsageThresholdOriginal,
  ): UsageThresholdRecord | null {
    const found = state.receipts.find(
      (row) => row.original.requestId === original.requestId,
    );
    if (!found) return null;
    if (!same(found.original, original))
      return fail(
        409,
        "request-id-reused",
        "This usage settings UUID already names another original.",
      );
    return record(state, found);
  }
  function captureOriginal(
    rawId: string,
    raw: unknown,
  ): UsageThresholdOriginal {
    const id = projectId(rawId),
      parsed = usageThresholdRequestSchema.safeParse(raw);
    if (!parsed.success)
      return fail(
        400,
        "invalid-request",
        "Expected complete explicit usage threshold settings.",
      );
    const original = freeze(
      structuredClone(originalSchema.parse({ ...parsed.data, projectId: id })),
    );
    if (original.workspace !== binding)
      return fail(
        409,
        "scope-changed",
        "The requested usage settings belong to another workspace.",
      );
    if (
      Buffer.byteLength(JSON.stringify(original), "utf8") >
      MAX_USAGE_POLICY_REQUEST_BYTES
    )
      return fail(
        400,
        "request-too-large",
        "Usage threshold settings exceed the supported request size.",
      );
    return original;
  }
  function pendingInScope(state: State, original: UsageThresholdOriginal) {
    const terminal = new Set(
      state.receipts.map((row) => row.original.requestId),
    );
    return state.originals.some(
      (row) =>
        row.phase === "reserved" &&
        !terminal.has(row.original.requestId) &&
        key(row.original) === key(original),
    );
  }
  function refusePending(state: State, original: UsageThresholdOriginal) {
    if (
      pendingInScope(state, original) ||
      state.originals.some(
        (row) => row.original.requestId === original.requestId,
      )
    )
      fail(
        409,
        "reserved-original",
        "Check the exact reserved usage settings original before continuing.",
      );
  }
  function retainedIntent(
    state: State,
    original: UsageThresholdOriginal,
  ): UsageThresholdIntent | null {
    const row = state.originals.find(
      (value) => value.original.requestId === original.requestId,
    );
    const receipt = state.receipts.find(
      (value) => value.original.requestId === original.requestId,
    );
    if (!row && !receipt) return null;
    if (!same(row?.original ?? receipt?.original, original))
      return fail(
        409,
        "request-id-reused",
        "This usage settings UUID already names another original.",
      );
    return freeze(
      usageThresholdIntentSchema.parse({
        origin: row ? "reservation" : "legacy-receipt",
        phase: receipt?.outcome ?? row?.phase,
        original,
        originalHash: row?.originalHash ?? receipt?.originalHash,
        reservedAt: row?.reservedAt ?? null,
        discardedAt: row?.discardedAt ?? null,
        receipt: receipt ?? null,
        document: document(state, original.projectId),
      }),
    );
  }
  function findIntent(state: State, id: string, requestId: string) {
    const original = [...state.originals, ...state.receipts].find(
      (row) =>
        row.original.requestId === requestId &&
        row.original.projectId === id &&
        row.original.workspace === binding,
    )?.original;
    const result = original ? retainedIntent(state, original) : null;
    if (!result)
      return fail(
        404,
        "original-unavailable",
        "The exact saved usage settings original is unavailable.",
      );
    return result;
  }
  function publishState(next: State): State {
    const encoded = JSON.stringify(next);
    if (Buffer.byteLength(encoded) > MAX_USAGE_POLICY_BYTES)
      return unavailable();
    if (readHomeFileBounded(home, marker, 64).text === null)
      writeOwnerOnly(marker, MARKER);
    writeOwnerOnly(file, encoded);
    afterWrite?.();
    const confirmed = readState();
    if (!same(confirmed, next)) return unavailable();
    return confirmed;
  }
  function requireReservation(state: State, original: UsageThresholdOriginal) {
    const row = state.originals.find(
      (value) => value.original.requestId === original.requestId,
    );
    if (!row || row.phase !== "reserved" || !same(row.original, original))
      fail(
        409,
        "reservation-required",
        "A matching retained usage settings reservation is required before Apply.",
      );
  }
  async function save(
    rawId: string,
    raw: unknown,
    requiresReservation: boolean,
  ): Promise<UsageThresholdRecord> {
    const original = captureOriginal(rawId, raw),
      id = original.projectId;
    let attempted = false;
    try {
      ensurePrivateHome(home);
      ensurePrivateHome(join(home, "projects"));
      checkPaths();
      const locked = await withQueueLock(
        lock,
        async () => {
          const initial = readState(),
            replay = existing(initial, original);
          if (replay) return replay;
          if (requiresReservation) requireReservation(initial, original);
          else refusePending(initial, original);
          await beforeAdmission?.();
          return withProjectAdmission(home, id, () => {
            currentCatalog(id, original.expectedCatalogRevision);
            const current = readState(),
              replay = existing(current, original);
            if (replay) return replay;
            if (requiresReservation) requireReservation(current, original);
            else refusePending(current, original);
            const prior = document(current, id),
              applied = prior.revision === original.expectedRevision;
            if (
              current.receipts.length >= MAX_USAGE_POLICY_ORIGINALS ||
              (applied &&
                prior.revision === 0 &&
                current.documents.length >= MAX_USAGE_POLICY_DOCUMENTS)
            )
              return fail(
                503,
                "history-full",
                "Usage threshold history is full. Existing original recovery remains available.",
              );
            const receipt = receiptSchema.parse({
              original,
              originalHash: hash(original),
              outcome: applied ? "applied" : "refused",
              observedRevision: prior.revision,
              resultingRevision: applied ? prior.revision + 1 : prior.revision,
              settledAt: now().toISOString(),
              refusalCode: applied ? null : "policy-revision-conflict",
            });
            const nextDoc: InboxUsageRulesDocument = {
              projectId: id,
              workspace: binding,
              revision: receipt.resultingRevision,
              rules: original.rules,
            };
            const next = checkedState(
              {
                version: 2,
                originals: current.originals,
                documents: applied
                  ? prior.revision === 0
                    ? [...current.documents, nextDoc]
                    : current.documents.map((doc) =>
                        key(doc) === key(nextDoc) ? nextDoc : doc,
                      )
                  : current.documents,
                receipts: [...current.receipts, receipt],
              },
              true,
            );
            const encoded = JSON.stringify(next);
            if (Buffer.byteLength(encoded, "utf8") > MAX_USAGE_POLICY_BYTES)
              return fail(
                503,
                "history-full",
                "Usage threshold history is full. Existing original recovery remains available.",
              );
            // Complete validation/capacity preflight precedes either publication.
            attempted = true;
            if (readHomeFileBounded(home, marker, 64).text === null)
              writeOwnerOnly(marker, MARKER);
            writeOwnerOnly(file, encoded);
            afterWrite?.();
            const confirmed = readState();
            if (!same(confirmed, next)) return unavailable();
            return record(confirmed, receipt);
          });
        },
        { waitMs: 1000 },
      );
      if (!locked.ok)
        return fail(
          503,
          "busy",
          "Usage threshold settings are busy or unavailable. No new policy was confirmed.",
        );
      return locked.value;
    } catch (error) {
      throw mapError(error, attempted);
    }
  }
  return {
    read(rawId) {
      const id = projectId(rawId);
      try {
        currentCatalog(id);
        return freeze(structuredClone(document(readState(), id)));
      } catch (error) {
        throw mapError(error);
      }
    },
    original(rawId, rawRequestId) {
      const id = projectId(rawId),
        parsed = uuid.safeParse(rawRequestId);
      if (!parsed.success)
        return fail(
          400,
          "invalid-request-id",
          "Expected a saved request UUID.",
        );
      try {
        const state = readState(),
          found = state.receipts.find(
            (row) =>
              row.original.requestId === parsed.data &&
              row.original.projectId === id &&
              row.original.workspace === binding,
          );
        if (!found)
          return fail(
            404,
            "original-unavailable",
            "The exact saved usage settings original is unavailable.",
          );
        return record(state, found);
      } catch (error) {
        throw mapError(error);
      }
    },
    reservation(rawId, rawRequestId) {
      const id = projectId(rawId),
        parsed = uuid.safeParse(rawRequestId);
      if (!parsed.success)
        return fail(
          400,
          "invalid-request-id",
          "Expected a saved request UUID.",
        );
      try {
        return findIntent(readState(), id, parsed.data);
      } catch (error) {
        throw mapError(error);
      }
    },
    recovery() {
      try {
        const state = readState();
        const terminal = new Set(
          state.receipts.map((row) => row.original.requestId),
        );
        return freeze(
          usageThresholdRecoverySchema.parse({
            version: 1,
            complete: true,
            pending: state.originals
              .filter(
                (row) =>
                  row.phase === "reserved" &&
                  !terminal.has(row.original.requestId),
              )
              .map(({ original, originalHash, reservedAt }) => ({
                original,
                originalHash,
                reservedAt,
              })),
          }),
        );
      } catch (error) {
        throw mapError(error);
      }
    },
    async discardReserved(rawId, rawRequestId, raw) {
      const parsed = originalSchema.safeParse(raw);
      if (
        !parsed.success ||
        parsed.data.projectId !== projectId(rawId) ||
        parsed.data.requestId !== rawRequestId
      )
        return fail(
          400,
          "invalid-request",
          "Expected the exact complete saved usage settings original.",
        );
      const { projectId: id, ...request } = parsed.data;
      const original = captureOriginal(id, request);
      let attempted = false;
      try {
        ensurePrivateHome(home);
        ensurePrivateHome(join(home, "projects"));
        checkPaths();
        const locked = await withQueueLock(
          lock,
          async () => {
            const state = readState();
            const prior = retainedIntent(state, original);
            if (!prior)
              return fail(
                404,
                "original-unavailable",
                "The exact saved usage settings original is unavailable.",
              );
            if (prior.phase !== "reserved") return prior;
            const next = checkedState(
              {
                ...state,
                originals: state.originals.map((row) =>
                  row.original.requestId === original.requestId
                    ? {
                        ...row,
                        phase: "discarded",
                        discardedAt: now().toISOString(),
                      }
                    : row,
                ),
              },
              true,
            );
            attempted = true;
            return (
              retainedIntent(publishState(next), original) ?? unavailable()
            );
          },
          { waitMs: 1000 },
        );
        if (!locked.ok)
          return fail(
            503,
            "busy",
            "Usage threshold settings are busy or unavailable. No new policy was confirmed.",
          );
        return locked.value;
      } catch (error) {
        throw mapError(error, attempted);
      }
    },
    write: (id, raw) => save(id, raw, false),
    applyReserved: (id, raw) => save(id, raw, true),
    async reserve(rawId, raw) {
      const original = captureOriginal(rawId, raw),
        id = original.projectId;
      let attempted = false;
      try {
        ensurePrivateHome(home);
        ensurePrivateHome(join(home, "projects"));
        checkPaths();
        const locked = await withQueueLock(
          lock,
          async () => {
            const initial = readState(),
              replay = retainedIntent(initial, original);
            if (replay) return replay;
            await beforeAdmission?.();
            return withProjectAdmission(home, id, () => {
              currentCatalog(id, original.expectedCatalogRevision);
              const state = readState(),
                replay = retainedIntent(state, original);
              if (replay) return replay;
              if (pendingInScope(state, original))
                return fail(
                  409,
                  "pending-original",
                  "Check the unsettled usage settings original before a new save.",
                );
              if (document(state, id).revision !== original.expectedRevision)
                return fail(
                  409,
                  "policy-revision-conflict",
                  "Current usage threshold settings changed. Review them before reserving.",
                );
              if (
                new Set([
                  ...state.receipts.map((row) => row.original.requestId),
                  ...state.originals.map((row) => row.original.requestId),
                ]).size >= MAX_USAGE_POLICY_ORIGINALS
              )
                return fail(
                  503,
                  "history-full",
                  "Usage threshold history is full. Existing original recovery remains available.",
                );
              const row = reservationSchema.parse({
                original,
                originalHash: hash(original),
                reservedAt: now().toISOString(),
                phase: "reserved",
                discardedAt: null,
              });
              const next = checkedState(
                { ...state, originals: [...state.originals, row] },
                true,
              );
              attempted = true;
              const confirmed = publishState(next);
              const result = retainedIntent(confirmed, original);
              if (!result) return unavailable();
              return result;
            });
          },
          { waitMs: 1000 },
        );
        if (!locked.ok)
          return fail(
            503,
            "busy",
            "Usage threshold settings are busy or unavailable. No new policy was confirmed.",
          );
        return locked.value;
      } catch (error) {
        throw mapError(error, attempted);
      }
    },
  };
}
