import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  type InboxUsageRulesDocument,
  inboxUsageRulesDocumentSchema,
} from "../../types/inbox-usage";
import { ensurePrivateHome, readHomeFileBounded } from "../hearth/home-guard";
import { writeOwnerOnly } from "../hearth/token";
import { withQueueLock } from "../scheduler/queue-lock";
import { withProjectAdmission } from "./admission";
import { workspaceKey } from "./scope";
import { createProjectStore, ProjectStoreError } from "./store";

export const MAX_USAGE_POLICY_BYTES = 4 * 1024 * 1024;
export const MAX_USAGE_POLICY_DOCUMENTS = 64;
export const MAX_USAGE_POLICY_ORIGINALS = 256;
export const MAX_USAGE_POLICY_REQUEST_BYTES = 256 * 1024;
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const uuid = z.uuid().refine((value) => value === value.toLowerCase());
const workspace = inboxUsageRulesDocumentSchema.shape.workspace.refine(
  (value) => value === workspaceKey(value),
);
export const usageThresholdRequestSchema = z
  .object({
    requestId: uuid,
    workspace,
    expectedCatalogRevision: counter,
    expectedRevision: counter.max(Number.MAX_SAFE_INTEGER - 1),
    rules: inboxUsageRulesDocumentSchema.shape.rules,
  })
  .strict();
const originalSchema = usageThresholdRequestSchema
  .extend({ projectId: inboxUsageRulesDocumentSchema.shape.projectId })
  .strict();
export type UsageThresholdRequest = z.infer<typeof usageThresholdRequestSchema>;
export type UsageThresholdOriginal = z.infer<typeof originalSchema>;
const receiptSchema = z
  .object({
    original: originalSchema,
    originalHash: z.string().regex(/^[a-f0-9]{64}$/),
    outcome: z.enum(["applied", "refused"]),
    observedRevision: counter,
    resultingRevision: counter,
    settledAt: z.iso.datetime(),
    refusalCode: z.literal("policy-revision-conflict").nullable(),
  })
  .strict()
  .refine((row) =>
    row.outcome === "applied"
      ? row.observedRevision === row.original.expectedRevision &&
        row.resultingRevision === row.original.expectedRevision + 1 &&
        row.refusalCode === null
      : row.observedRevision !== row.original.expectedRevision &&
        row.resultingRevision === row.observedRevision &&
        row.refusalCode === "policy-revision-conflict",
  );
export type UsageThresholdReceipt = z.infer<typeof receiptSchema>;
const savedDocumentSchema = inboxUsageRulesDocumentSchema.refine(
  (doc) => doc.revision > 0 && doc.workspace === workspaceKey(doc.workspace),
);
const stateSchema = z
  .object({
    version: z.literal(1),
    documents: z.array(savedDocumentSchema).max(MAX_USAGE_POLICY_DOCUMENTS),
    receipts: z.array(receiptSchema).min(1).max(MAX_USAGE_POLICY_ORIGINALS),
  })
  .strict();
type State = z.infer<typeof stateSchema>;
export interface UsageThresholdRecord {
  receipt: UsageThresholdReceipt;
  document: InboxUsageRulesDocument;
}
export interface UsageThresholdStore {
  read(projectId: string): InboxUsageRulesDocument;
  original(projectId: string, requestId: string): UsageThresholdRecord;
  write(projectId: string, raw: unknown): Promise<UsageThresholdRecord>;
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
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => JSON.stringify(key) + ":" + stable(item))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
};
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
function checkedState(raw: unknown): State {
  const parsed = stateSchema.safeParse(raw);
  if (!parsed.success) return unavailable();
  const state = parsed.data;
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
): UsageThresholdStore {
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
      return { version: 1, documents: [], receipts: [] };
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
    async write(rawId, raw) {
      const id = projectId(rawId),
        parsed = usageThresholdRequestSchema.safeParse(raw);
      if (!parsed.success)
        return fail(
          400,
          "invalid-request",
          "Expected complete explicit usage threshold settings.",
        );
      const original = freeze(
        structuredClone(
          originalSchema.parse({ ...parsed.data, projectId: id }),
        ),
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
      let attempted = false;
      try {
        ensurePrivateHome(home);
        ensurePrivateHome(join(home, "projects"));
        checkPaths();
        const locked = await withQueueLock(
          lock,
          async () => {
            const replay = existing(readState(), original);
            if (replay) return replay;
            await beforeAdmission?.();
            return withProjectAdmission(home, id, () => {
              currentCatalog(id, original.expectedCatalogRevision);
              const current = readState(),
                replay = existing(current, original);
              if (replay) return replay;
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
                resultingRevision: applied
                  ? prior.revision + 1
                  : prior.revision,
                settledAt: now().toISOString(),
                refusalCode: applied ? null : "policy-revision-conflict",
              });
              const nextDoc: InboxUsageRulesDocument = {
                projectId: id,
                workspace: binding,
                revision: receipt.resultingRevision,
                rules: original.rules,
              };
              const next = checkedState({
                version: 1,
                documents: applied
                  ? prior.revision === 0
                    ? [...current.documents, nextDoc]
                    : current.documents.map((doc) =>
                        key(doc) === key(nextDoc) ? nextDoc : doc,
                      )
                  : current.documents,
                receipts: [...current.receipts, receipt],
              });
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
    },
  };
}
