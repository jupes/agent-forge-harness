import { z } from "zod";
import {
  NotSent,
  type OperatorPost,
  type OperatorRead,
} from "../../../docs/js/operator";
import { hasDuplicateObjectKeys } from "../../../scripts/json-object-keys";
import { workspaceKey } from "../../../scripts/projects/scope";
import {
  type InboxUsageRule,
  type InboxUsageRulesDocument,
  inboxUsageRulesDocumentSchema,
} from "../../../types/inbox-usage";
import {
  type UsageThresholdIntent,
  type UsageThresholdRecovery,
  usageThresholdIntentSchema,
  usageThresholdRecoverySchema,
} from "../../../types/usage-threshold-intents";
import {
  MAX_USAGE_POLICY_REQUEST_BYTES,
  type UsageThresholdOriginal,
  type UsageThresholdRecord,
  usageThresholdDocumentSchema,
  usageThresholdJson,
  usageThresholdOriginalSchema,
  usageThresholdRecordSchema,
} from "../../../types/usage-threshold-settings";
import { validatedGeneralCatalog } from "./project-general-settings-client";

const DATA_LIMIT = 4 * 1024 * 1024;
const CATALOG_LIMIT = 64 * 1024;
const ENVELOPE_ALLOWANCE = 64 * 1024;
const root = "/__agent-forge";
type Action = "apply" | "discard";
type Mutation = "reserve" | Action;
type Busy = "refresh" | "check" | Mutation;
type ReadonlyDeep<T> = T extends readonly (infer U)[]
  ? readonly ReadonlyDeep<U>[]
  : T extends object
    ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> }
    : T;
interface Binding {
  projectId: string;
  workspace: string;
}
interface CryptoSource {
  subtle: Pick<SubtleCrypto, "digest">;
  randomUUID(): string;
}
export interface UsageThresholdSettingsDependencies {
  read: OperatorRead;
  post: OperatorPost;
  requestId?: () => string;
  crypto?: CryptoSource | null;
}
interface Catalog {
  revision: number;
  archived: boolean;
  member: boolean;
  fresh: boolean;
}
interface Held {
  original: UsageThresholdOriginal;
  originalHash: string | null;
  phase: "prepared" | "not-sent" | "unknown" | "reserved";
  uncertain: Mutation | null;
  everUnknownReserve: boolean;
  intent: UsageThresholdIntent | null;
}
interface Terminal {
  phase: "applied" | "refused" | "discarded";
  original: UsageThresholdOriginal;
  originalHash: string;
  value: UsageThresholdIntent | UsageThresholdRecord;
}
interface Review {
  epoch: number;
  original: UsageThresholdOriginal;
  originalHash: string;
  intent: UsageThresholdIntent;
}
export interface UsageThresholdSettingsSnapshot {
  catalog: Catalog | null;
  document: InboxUsageRulesDocument | null;
  documentFresh: boolean;
  recovery: UsageThresholdRecovery | null;
  recoveryFresh: boolean;
  held: Held | null;
  lastTerminal: Terminal | null;
  review: Review | null;
  busy: Busy | null;
  disposed: boolean;
  notice: string;
}
const permitTag = Symbol("usage-review");
export interface UsageThresholdReviewPermit {
  readonly [permitTag]: true;
}
interface Permit {
  epoch: number;
  action: Action;
  original: UsageThresholdOriginal;
  hash: string;
  view: Review;
}
interface Operation {
  epoch: number;
  token: object;
}
interface CheckedDocument {
  value: InboxUsageRulesDocument;
  fingerprint: string;
}
interface Evidence {
  id: string;
  originalHash: string;
  phase: UsageThresholdIntent["phase"];
  reservedAt?: string | null;
  terminal?: string;
}
const envelope = z
  .object({ ok: z.literal(true), data: z.unknown(), error: z.null() })
  .strict();
const catalogSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    projects: z.array(
      z
        .object({
          id: usageThresholdOriginalSchema.shape.projectId,
          archived: z.boolean(),
          workspaces: z.array(
            z
              .object({ root: inboxUsageRulesDocumentSchema.shape.workspace })
              .passthrough(),
          ),
        })
        .passthrough(),
    ),
  })
  .passthrough();
function frozen<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
const bytes = (value: unknown) =>
  new TextEncoder().encode(usageThresholdJson(value)).byteLength;
const same = (a: unknown, b: unknown) =>
  usageThresholdJson(a) === usageThresholdJson(b);
const unavailable = () => new Error("Usage settings could not be verified.");
async function dataFrom(response: Response, limit: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw unavailable();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > limit + ENVELOPE_ALLOWANCE) {
        void reader.cancel().catch(() => {});
        throw unavailable();
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(all);
    if (hasDuplicateObjectKeys(text)) throw unavailable();
    const raw: unknown = JSON.parse(text);
    const data = envelope.parse(raw).data;
    if (bytes(data) > limit) throw unavailable();
    return data;
  } catch {
    throw unavailable();
  }
}

/** Retain exact originals across view navigation; only explicit reviewed actions can dispatch. */
export class ProjectUsageThresholdSettingsOwner {
  private value: UsageThresholdSettingsSnapshot = frozen({
    catalog: null,
    document: null,
    documentFresh: false,
    recovery: null,
    recoveryFresh: false,
    held: null,
    lastTerminal: null,
    review: null,
    busy: null,
    disposed: false,
    notice: "",
  });
  private readonly binding: Binding;
  private readonly read: OperatorRead;
  private readonly post: OperatorPost;
  private readonly cryptography: CryptoSource | null;
  private readonly mint: () => string;
  private readonly listeners = new Set<
    (value: ReadonlyDeep<UsageThresholdSettingsSnapshot>) => void
  >();
  private readonly revisions = new Map<number, string>();
  private permits = new WeakMap<object, Permit>();
  private epoch = 0;
  private token: object | null = null;
  private catalogRevision = -1;
  private catalogFingerprint = "";
  constructor(binding: Binding, deps: UsageThresholdSettingsDependencies) {
    try {
      this.binding = frozen(
        usageThresholdOriginalSchema
          .pick({ projectId: true, workspace: true })
          .parse({
            projectId: binding.projectId,
            workspace: workspaceKey(binding.workspace),
          }),
      );
    } catch {
      throw new Error("Usage settings scope is unavailable.");
    }
    this.read = deps.read;
    this.post = deps.post;
    this.cryptography =
      deps.crypto === undefined ? globalThis.crypto : deps.crypto;
    this.mint =
      deps.requestId ??
      (() => {
        if (!this.cryptography) throw unavailable();
        return this.cryptography.randomUUID();
      });
  }
  snapshot = (): ReadonlyDeep<UsageThresholdSettingsSnapshot> => this.value;
  subscribe = (
    listener: (value: ReadonlyDeep<UsageThresholdSettingsSnapshot>) => void,
  ) => {
    if (this.value.disposed) return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(
    change: Partial<UsageThresholdSettingsSnapshot>,
    epoch?: number,
  ): boolean {
    if (this.value.disposed || (epoch !== undefined && epoch !== this.epoch))
      return false;
    this.value = frozen({ ...this.value, ...change });
    for (const listener of [...this.listeners]) {
      try {
        listener(this.value);
      } catch {
        /* Observers cannot alter operation outcomes. */
      }
    }
    return (
      !this.value.disposed && (epoch === undefined || epoch === this.epoch)
    );
  }
  private stale(): Partial<UsageThresholdSettingsSnapshot> {
    this.permits = new WeakMap();
    return {
      review: null,
      documentFresh: false,
      recoveryFresh: false,
      catalog: this.value.catalog
        ? { ...this.value.catalog, fresh: false }
        : null,
    };
  }
  private begin(kind: Busy): Operation | null {
    if (this.value.disposed || this.value.busy) return null;
    const op = { epoch: ++this.epoch, token: {} };
    this.token = op.token;
    this.publish({ ...this.stale(), busy: kind, notice: "" });
    return op;
  }
  private live(op: Operation): boolean {
    return (
      !this.value.disposed && this.token === op.token && this.epoch === op.epoch
    );
  }
  private finish(op: Operation) {
    if (this.token === op.token) {
      this.token = null;
      this.publish({ busy: null });
    }
  }
  private path() {
    return (
      root +
      "/projects/" +
      encodeURIComponent(this.binding.projectId) +
      "/settings/usage-thresholds"
    );
  }
  private async digest(text: string): Promise<string> {
    if (!this.cryptography?.subtle) throw unavailable();
    const hash = await this.cryptography.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(text),
    );
    if (hash.byteLength !== 32) throw unavailable();
    return Array.from(new Uint8Array(hash), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  }
  private async originalHash(value: UsageThresholdOriginal): Promise<string> {
    if (bytes(value) > MAX_USAGE_POLICY_REQUEST_BYTES) throw unavailable();
    return this.digest(usageThresholdJson(value));
  }
  private async checkedDocument(raw: unknown): Promise<CheckedDocument> {
    const value = usageThresholdDocumentSchema.parse(raw);
    if (
      value.projectId !== this.binding.projectId ||
      value.workspace !== this.binding.workspace
    )
      throw unavailable();
    return { value, fingerprint: await this.digest(usageThresholdJson(value)) };
  }
  private documentPatch(
    doc: CheckedDocument,
    fresh: boolean,
  ): Partial<UsageThresholdSettingsSnapshot> {
    const revision = doc.value.revision;
    const seen = this.revisions.get(revision);
    if (
      (seen !== undefined && seen !== doc.fingerprint) ||
      (seen === undefined && this.revisions.size >= 257)
    )
      throw unavailable();
    if (this.value.document && revision < this.value.document.revision) {
      if (fresh) throw unavailable();
      this.revisions.set(revision, doc.fingerprint);
      return {};
    }
    this.revisions.set(revision, doc.fingerprint);
    return {
      document: doc.value,
      documentFresh:
        fresh ||
        (revision === this.value.document?.revision &&
          this.value.documentFresh),
    };
  }
  private checkedCatalog(raw: unknown) {
    const general = validatedGeneralCatalog(raw, this.binding.projectId, true);
    const catalog = catalogSchema.parse(raw);
    if (
      new Set(catalog.projects.map((item) => item.id)).size !==
      catalog.projects.length
    )
      throw unavailable();
    const project = catalog.projects.find(
      (item) => item.id === this.binding.projectId,
    );
    if (!project) throw unavailable();
    const matching = project.workspaces.filter(
      (item) => workspaceKey(item.root) === this.binding.workspace,
    );
    if (matching.length > 1) throw unavailable();
    return {
      value: {
        revision: general.revision,
        archived: project.archived,
        member: matching.length === 1,
        fresh: true,
      },
      fingerprint: usageThresholdJson(project),
    };
  }
  private catalogPatch(
    catalog: ReturnType<ProjectUsageThresholdSettingsOwner["checkedCatalog"]>,
  ) {
    const revision = catalog.value.revision;
    if (
      revision < this.catalogRevision ||
      (revision === this.catalogRevision &&
        this.catalogFingerprint !== catalog.fingerprint)
    )
      throw unavailable();
    this.catalogRevision = revision;
    this.catalogFingerprint = catalog.fingerprint;
    return { catalog: catalog.value };
  }
  private async checkedRecovery(raw: unknown): Promise<UsageThresholdRecovery> {
    const value = usageThresholdRecoverySchema.parse(raw);
    const scopes = new Set<string>();
    for (const row of value.pending) {
      const key =
        row.original.projectId + "\0" + workspaceKey(row.original.workspace);
      if (
        scopes.has(key) ||
        row.originalHash !== (await this.originalHash(row.original)) ||
        (this.value.held?.original.requestId === row.original.requestId &&
          !same(this.value.held.original, row.original))
      )
        throw unavailable();
      scopes.add(key);
    }
    return value;
  }
  private async get(path: string, limit = DATA_LIMIT): Promise<unknown> {
    const response = await this.read(
      path,
      { method: "GET" },
      { maxBodyBytes: limit + ENVELOPE_ALLOWANCE },
    );
    const data = await dataFrom(response, limit);
    if (response.status !== 200) throw unavailable();
    return data;
  }
  async refresh(): Promise<void> {
    const op = this.begin("refresh");
    if (!op) return;
    try {
      if (!this.live(op)) return;
      const results = await Promise.allSettled([
        this.get(root + "/projects", CATALOG_LIMIT).then((raw) =>
          this.checkedCatalog(raw),
        ),
        this.get(this.path()).then((raw) => this.checkedDocument(raw)),
        this.get(root + "/usage-threshold-settings/recovery").then((raw) =>
          this.checkedRecovery(raw),
        ),
      ]);
      if (!this.live(op)) return;
      let change: Partial<UsageThresholdSettingsSnapshot> = {};
      let failures = 0;
      const [catalog, document, recovery] = results;
      try {
        if (catalog.status !== "fulfilled") throw unavailable();
        Object.assign(change, this.catalogPatch(catalog.value));
      } catch {
        failures++;
      }
      try {
        if (document.status !== "fulfilled") throw unavailable();
        Object.assign(change, this.documentPatch(document.value, true));
      } catch {
        failures++;
      }
      try {
        if (recovery.status !== "fulfilled") throw unavailable();
        const evidence = this.evidencePatch(
          recovery.value.pending.map((row) => ({
            id: row.original.requestId,
            originalHash: row.originalHash,
            phase: "reserved",
            reservedAt: row.reservedAt,
          })),
        );
        this.knownEvidence = evidence;
        change = { ...change, recovery: recovery.value, recoveryFresh: true };
        const own = recovery.value.pending.find(
          (row) =>
            row.original.projectId === this.binding.projectId &&
            row.original.workspace === this.binding.workspace,
        );
        if (own && !this.value.held)
          change.held = {
            ...own,
            phase: "reserved",
            uncertain: null,
            everUnknownReserve: false,
            intent: null,
          };
      } catch {
        failures++;
      }
      change.notice = failures
        ? "Some usage settings could not be verified. Retained originals are unchanged."
        : "";
      this.publish(change, op.epoch);
    } finally {
      this.finish(op);
    }
  }
  private knownEvidence = new Map<string, Evidence>();
  private evidencePatch(rows: Evidence[]): Map<string, Evidence> {
    const next = new Map(this.knownEvidence);
    for (const row of rows) {
      const previous = next.get(row.id);
      if (
        previous &&
        (previous.originalHash !== row.originalHash ||
          (previous.reservedAt !== undefined &&
            row.reservedAt !== undefined &&
            previous.reservedAt !== row.reservedAt) ||
          (previous.phase !== "reserved" &&
            (row.phase !== previous.phase ||
              row.terminal !== previous.terminal)))
      )
        throw unavailable();
      const merged = { ...previous, ...row };
      if (row.reservedAt === undefined && previous?.reservedAt !== undefined)
        merged.reservedAt = previous.reservedAt;
      next.set(row.id, frozen(merged));
      if (next.size > 256) throw unavailable();
    }
    return next;
  }
  private readonly usedRequestIds = new Set<string>();
  private ready(original?: UsageThresholdOriginal): boolean {
    const value = this.value;
    if (
      !value.catalog?.fresh ||
      value.catalog.archived ||
      !value.catalog.member ||
      !value.documentFresh ||
      !value.document ||
      !value.recoveryFresh ||
      !value.recovery
    )
      return false;
    if (
      original &&
      (value.catalog.revision !== original.expectedCatalogRevision ||
        value.document.revision !== original.expectedRevision)
    )
      return false;
    return value.recovery.pending.every(
      (row) =>
        row.original.projectId !== this.binding.projectId ||
        row.original.workspace !== this.binding.workspace ||
        (original !== undefined && same(row.original, original)),
    );
  }
  private updateHeld(
    original: UsageThresholdOriginal,
    change: Partial<Held>,
    notice: string,
  ) {
    if (this.value.held?.original === original)
      this.publish({
        held: { ...this.value.held, ...change },
        notice,
        review: null,
      });
  }
  private unknown(operation: Mutation, original: UsageThresholdOriginal) {
    const held = this.value.held;
    if (held?.original !== original) return;
    this.updateHeld(
      original,
      {
        phase: "unknown",
        uncertain: operation,
        everUnknownReserve: held.everUnknownReserve || operation === "reserve",
      },
      "The usage settings outcome is unknown. Check this exact original before acting.",
    );
  }
  private async checkedIntent(raw: unknown, original?: UsageThresholdOriginal) {
    const intent = usageThresholdIntentSchema.parse(raw);
    if (
      intent.original.projectId !== this.binding.projectId ||
      intent.original.workspace !== this.binding.workspace ||
      intent.originalHash !== (await this.originalHash(intent.original)) ||
      (original && !same(intent.original, original))
    )
      throw unavailable();
    const terminal =
      intent.phase === "reserved"
        ? undefined
        : await this.digest(
            usageThresholdJson(
              intent.receipt ?? {
                originalHash: intent.originalHash,
                phase: intent.phase,
                reservedAt: intent.reservedAt,
                discardedAt: intent.discardedAt,
              },
            ),
          );
    return {
      intent,
      document: await this.checkedDocument(intent.document),
      evidence: {
        id: intent.original.requestId,
        originalHash: intent.originalHash,
        phase: intent.phase,
        reservedAt: intent.reservedAt,
        ...(terminal === undefined ? {} : { terminal }),
      },
    };
  }
  private async checkedRecord(raw: unknown, original: UsageThresholdOriginal) {
    const record = usageThresholdRecordSchema.parse(raw);
    if (
      !same(record.receipt.original, original) ||
      record.receipt.originalHash !==
        (await this.originalHash(record.receipt.original))
    )
      throw unavailable();
    return {
      record,
      document: await this.checkedDocument(record.document),
      evidence: {
        id: record.receipt.original.requestId,
        originalHash: record.receipt.originalHash,
        phase: record.receipt.outcome,
        terminal: await this.digest(usageThresholdJson(record.receipt)),
      },
    };
  }
  private async dispatch(
    operation: Mutation,
    original: UsageThresholdOriginal,
    hash: string,
    op: Operation,
  ) {
    if (!this.live(op) || this.value.held?.original !== original) return;
    const previous = this.value.held;
    const { projectId: _project, ...request } = original;
    const body = operation === "discard" ? original : frozen(request);
    const url =
      operation === "reserve"
        ? this.path() + "/requests"
        : operation === "discard"
          ? this.path() +
            "/requests/" +
            encodeURIComponent(original.requestId) +
            "/discard"
          : this.path();
    this.value = frozen({
      ...this.value,
      held: {
        ...previous,
        originalHash: hash,
        phase: "unknown",
        uncertain: operation,
      },
    });
    let response: Response;
    try {
      const pending = this.post(url, body, {
        maxBodyBytes: DATA_LIMIT + ENVELOPE_ALLOWANCE,
      });
      this.publish({});
      response = await pending;
    } catch (error) {
      let notSent = false;
      try {
        notSent = error instanceof NotSent;
      } catch {
        /* A hostile error cannot classify an effect. */
      }
      if (notSent && previous.uncertain === null)
        this.updateHeld(
          original,
          {
            ...previous,
            originalHash: hash,
            phase: operation === "reserve" ? "not-sent" : "reserved",
            uncertain: null,
          },
          "This attempt was not sent. Its exact original is retained.",
        );
      else this.unknown(operation, original);
      return;
    }
    try {
      const data = await dataFrom(response, DATA_LIMIT);
      if (operation === "apply") {
        const checked = await this.checkedRecord(data, original);
        const record = checked.record;
        if (
          response.status !== (record.receipt.outcome === "refused" ? 409 : 200)
        )
          throw unavailable();
        if (this.value.disposed || this.value.held?.original !== original)
          return;
        const evidence = this.evidencePatch([checked.evidence]);
        const document = this.documentPatch(checked.document, false);
        this.knownEvidence = evidence;
        this.publish({
          ...document,
          held: null,
          review: null,
          lastTerminal: {
            phase: record.receipt.outcome,
            original,
            originalHash: record.receipt.originalHash,
            value: record,
          },
          notice: "The exact usage settings outcome is confirmed.",
        });
      } else {
        const checked = await this.checkedIntent(data, original);
        const intent = checked.intent;
        if (
          response.status !== (intent.phase === "refused" ? 409 : 200) ||
          (operation === "discard" && intent.phase === "reserved")
        )
          throw unavailable();
        if (this.value.disposed || this.value.held?.original !== original)
          return;
        const evidence = this.evidencePatch([checked.evidence]);
        const document = this.documentPatch(checked.document, false);
        this.knownEvidence = evidence;
        if (intent.phase === "reserved")
          this.publish({
            ...document,
            held: {
              ...this.value.held,
              originalHash: hash,
              phase: "reserved",
              uncertain: null,
              intent,
            },
            review: null,
            notice:
              "The original is reserved. Check and review it before Apply or Discard.",
          });
        else
          this.publish({
            ...document,
            held: null,
            review: null,
            lastTerminal: {
              phase: intent.phase,
              original,
              originalHash: hash,
              value: intent,
            },
            notice: "The exact usage settings outcome is confirmed.",
          });
      }
    } catch {
      this.unknown(operation, original);
    }
  }
  async reserve(rules: readonly InboxUsageRule[]): Promise<void> {
    if (this.value.disposed || this.value.busy) return;
    if (this.value.held || !this.ready()) {
      this.publish({
        notice:
          "Refresh complete current settings and resolve the held original before a new Reserve.",
      });
      return;
    }
    const epoch = this.epoch;
    let original: UsageThresholdOriginal;
    try {
      if (!this.cryptography?.subtle) throw unavailable();
      original = frozen(
        usageThresholdOriginalSchema.parse({
          ...this.binding,
          requestId: this.mint(),
          expectedCatalogRevision: this.value.catalog!.revision,
          expectedRevision: this.value.document!.revision,
          rules,
        }),
      );
      if (
        bytes(original) > MAX_USAGE_POLICY_REQUEST_BYTES ||
        this.usedRequestIds.has(original.requestId) ||
        this.knownEvidence.has(original.requestId) ||
        this.knownEvidence.size >= 256 ||
        this.usedRequestIds.size >= 256 ||
        this.value.recovery!.pending.some(
          (row) => row.original.requestId === original.requestId,
        )
      )
        throw unavailable();
    } catch {
      this.publish({
        notice:
          "A complete bounded usage original and WebCrypto are required before Reserve.",
      });
      return;
    }
    if (epoch !== this.epoch || !this.ready() || this.value.held) return;
    const op = this.begin("reserve");
    if (!op) return;
    this.usedRequestIds.add(original.requestId);
    this.publish(
      {
        held: {
          original,
          originalHash: null,
          phase: "prepared",
          uncertain: null,
          everUnknownReserve: false,
          intent: null,
        },
      },
      op.epoch,
    );
    let handed = false;
    try {
      const hash = await this.originalHash(original);
      if (!this.live(op)) {
        this.updateHeld(
          original,
          { originalHash: hash, phase: "not-sent" },
          "Context changed before this attempt was handed to transport.",
        );
        return;
      }
      handed = true;
      await this.dispatch("reserve", original, hash, op);
    } catch {
      if (handed) this.unknown("reserve", original);
      else
        this.updateHeld(
          original,
          { phase: "not-sent" },
          "This attempt was not handed to transport. The original is retained.",
        );
    } finally {
      this.finish(op);
    }
  }
  async retryReserveNotSent(): Promise<void> {
    const held = this.value.held;
    if (
      this.value.disposed ||
      this.value.busy ||
      !held ||
      held.phase !== "not-sent" ||
      held.uncertain !== null ||
      held.everUnknownReserve ||
      !this.ready(held.original)
    )
      return;
    const op = this.begin("reserve");
    if (!op) return;
    let handed = false;
    try {
      const hash = await this.originalHash(held.original);
      if (this.live(op)) {
        handed = true;
        await this.dispatch("reserve", held.original, hash, op);
      }
    } catch {
      if (handed) this.unknown("reserve", held.original);
      else
        this.updateHeld(
          held.original,
          { phase: "not-sent" },
          "The exact retry was not handed to transport.",
        );
    } finally {
      this.finish(op);
    }
  }
  async check(requestId?: string): Promise<void> {
    const op = this.begin("check");
    if (!op) return;
    try {
      const held = this.value.held;
      const id = usageThresholdOriginalSchema.shape.requestId.parse(
        requestId ??
          held?.original.requestId ??
          this.value.lastTerminal?.original.requestId,
      );
      if (!this.live(op) || (held && held.original.requestId !== id))
        throw unavailable();
      const results = await Promise.allSettled([
        this.get(root + "/projects", CATALOG_LIMIT).then((raw) =>
          this.checkedCatalog(raw),
        ),
        this.get(this.path()).then((raw) => this.checkedDocument(raw)),
        this.get(
          this.path() + "/requests/" + encodeURIComponent(id) + "/reservation",
        ).then((raw) => this.checkedIntent(raw, held?.original)),
      ]);
      if (!this.live(op)) return;
      const [catalog, current, exact] = results;
      const change: Partial<UsageThresholdSettingsSnapshot> = {};
      try {
        if (catalog.status === "fulfilled")
          Object.assign(change, this.catalogPatch(catalog.value));
      } catch {
        /* Stale catalog remains unavailable. */
      }
      try {
        if (current.status === "fulfilled")
          Object.assign(change, this.documentPatch(current.value, true));
      } catch {
        /* Preserve the prior document. */
      }
      if (!this.publish(change, op.epoch)) return;
      if (
        exact.status !== "fulfilled" ||
        exact.value.intent.original.requestId !== id
      )
        throw unavailable();
      const { intent, document } = exact.value;
      const original = held?.original ?? intent.original;
      if (!this.usedRequestIds.has(id) && this.usedRequestIds.size >= 256)
        throw unavailable();
      const evidence = this.evidencePatch([exact.value.evidence]);
      const patch = this.documentPatch(document, false);
      this.usedRequestIds.add(id);
      this.knownEvidence = evidence;
      if (intent.phase !== "reserved") {
        this.publish(
          {
            ...patch,
            held: null,
            review: null,
            lastTerminal: {
              phase: intent.phase,
              original,
              originalHash: intent.originalHash,
              value: intent,
            },
            notice: "The exact usage settings outcome is confirmed.",
          },
          op.epoch,
        );
      } else {
        const blocked =
          held?.uncertain === "apply" || held?.uncertain === "discard";
        this.publish(
          {
            ...patch,
            held: {
              original,
              originalHash: intent.originalHash,
              phase: blocked ? "unknown" : "reserved",
              uncertain: blocked ? held.uncertain : null,
              everUnknownReserve: held?.everUnknownReserve ?? false,
              intent,
            },
            review: blocked
              ? null
              : {
                  epoch: op.epoch,
                  original,
                  originalHash: intent.originalHash,
                  intent,
                },
            notice: blocked
              ? "The earlier action may still arrive. A reserved read does not settle it."
              : "Review this exact original before choosing Apply or Discard.",
          },
          op.epoch,
        );
      }
    } catch {
      if (this.live(op))
        this.publish(
          {
            review: null,
            notice:
              "The exact original could not be verified. Its prior outcome is retained.",
          },
          op.epoch,
        );
    } finally {
      this.finish(op);
    }
  }
  private eligible(view: ReadonlyDeep<Review> | null, action: Action): boolean {
    const value = this.value;
    const held = value.held;
    if (
      value.disposed ||
      value.busy ||
      !view ||
      view !== value.review ||
      view.epoch !== this.epoch ||
      !held ||
      held.phase !== "reserved" ||
      held.uncertain !== null ||
      held.original !== view.original ||
      held.originalHash !== view.originalHash ||
      view.intent.phase !== "reserved"
    )
      return false;
    return (
      action === "discard" ||
      Boolean(
        value.catalog?.fresh &&
          !value.catalog.archived &&
          value.catalog.member &&
          value.catalog.revision === held.original.expectedCatalogRevision &&
          value.documentFresh &&
          value.document?.revision === held.original.expectedRevision &&
          same(value.document, view.intent.document),
      )
    );
  }
  confirmReview(
    view: ReadonlyDeep<Review> | null,
    action: Action,
  ): UsageThresholdReviewPermit | null {
    if (!this.eligible(view, action) || !this.value.held || !this.value.review)
      return null;
    const permit = frozen({ [permitTag]: true as const });
    this.permits.set(permit, {
      epoch: this.epoch,
      action,
      original: this.value.held.original,
      hash: this.value.review.originalHash,
      view: this.value.review,
    });
    return permit;
  }
  private consume(
    permit: UsageThresholdReviewPermit | null,
    action: Action,
  ): Permit | null {
    if (!permit || typeof permit !== "object") return null;
    const proof = this.permits.get(permit);
    this.permits.delete(permit);
    if (
      !proof ||
      proof.action !== action ||
      proof.epoch !== this.epoch ||
      !this.eligible(proof.view, action) ||
      this.value.held?.original !== proof.original
    )
      return null;
    return proof;
  }
  private async act(action: Action, permit: UsageThresholdReviewPermit | null) {
    const proof = this.consume(permit, action);
    if (!proof) return;
    const op = this.begin(action);
    if (!op) return;
    try {
      if (this.live(op))
        await this.dispatch(action, proof.original, proof.hash, op);
    } catch {
      this.unknown(action, proof.original);
    } finally {
      this.finish(op);
    }
  }
  async apply(permit: UsageThresholdReviewPermit | null): Promise<void> {
    await this.act("apply", permit);
  }
  async discard(permit: UsageThresholdReviewPermit | null): Promise<void> {
    await this.act("discard", permit);
  }
  invalidateContext(): void {
    if (this.value.disposed) return;
    this.epoch++;
    this.publish({
      ...this.stale(),
      notice:
        "Usage settings context changed. Check the exact original before acting.",
    });
  }
  /** Final teardown returns readable uncertainty; keep the live owner while unresolved. */
  dispose(): ReadonlyDeep<UsageThresholdSettingsSnapshot> {
    if (this.value.disposed) return this.value;
    this.epoch++;
    this.token = null;
    this.permits = new WeakMap();
    this.value = frozen({
      ...this.value,
      ...this.stale(),
      disposed: true,
      busy: null,
    });
    for (const listener of [...this.listeners]) {
      try {
        listener(this.value);
      } catch {
        /* Retain the frozen handoff. */
      }
    }
    this.listeners.clear();
    return this.value;
  }
}
