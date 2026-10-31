import { z } from "zod";
import {
  inboxDispositionOriginalSchema,
  inboxDispositionReceiptSchema,
  inboxDispositionStoreSchema,
  type InboxDispositionEntry,
  type InboxDispositionOriginal,
  type InboxDispositionReceipt,
} from "../../../types/inbox";
import { NotSent, type OperatorPost, type OperatorRead } from "../../../docs/js/operator";

const LIMIT = 4 * 1024 * 1024 + 64 * 1024;
const protectedRoot = "/__agent-forge";
const root = (projectId: string) =>
  `${protectedRoot}/projects/${encodeURIComponent(projectId)}/inbox-dispositions`;

export interface InboxDispositionScope {
  projectId: string;
  workspace: string;
}
export interface InboxDispositionRecord {
  entry: InboxDispositionEntry | null;
  receipt: InboxDispositionReceipt;
}
export interface InboxDispositionCollection {
  entries: InboxDispositionEntry[];
  receipts: InboxDispositionReceipt[];
}
export type InboxDispositionResult<T> =
  | { state: "confirmed"; value: T }
  | { state: "not-sent"; message: string }
  | { state: "refused"; message: string; value?: T }
  | { state: "unknown"; message: string }
  | { state: "unavailable"; message: string }
  | { state: "missing" };

const sameOriginal = (
  a: InboxDispositionReceipt["original"],
  b: InboxDispositionReceipt["original"],
) =>
  a.requestId === b.requestId &&
  a.projectId === b.projectId &&
  a.expectedCatalogRevision === b.expectedCatalogRevision &&
  a.workspace === b.workspace &&
  a.item.sourceKind === b.item.sourceKind &&
  a.item.stableItemId === b.item.stableItemId &&
  a.item.sourceRevision === b.item.sourceRevision &&
  a.expectedRevision === b.expectedRevision &&
  a.operation === b.operation;

function inScope(scope: InboxDispositionScope, record: InboxDispositionRecord) {
  const { receipt, entry } = record;
  const original = receipt.original;
  if (original.projectId !== scope.projectId || original.workspace !== scope.workspace)
    return false;
  if (!entry) return true;
  if (
    entry.projectId !== scope.projectId ||
    entry.workspace !== scope.workspace ||
    entry.item.sourceKind !== original.item.sourceKind ||
    entry.item.stableItemId !== original.item.stableItemId ||
    entry.item.sourceRevision !== original.item.sourceRevision ||
    entry.revision < original.expectedRevision
  ) return false;
  if (receipt.resultingRevision === undefined) return true;
  if (entry.revision < receipt.resultingRevision) return false;
  if (entry.revision > receipt.resultingRevision) return true;
  return receipt.phase === "applied" &&
    entry.operation === receipt.resultingValue &&
    entry.updatedAt === receipt.settledAt &&
    entry.snoozedUntil === receipt.snoozedUntil;
}

async function envelope(response: Response): Promise<unknown> {
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > LIMIT) throw Error("The protected Inbox reply is too large.");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text);
}

function successData(raw: unknown): unknown {
  return z.object({ ok: z.literal(true), data: z.unknown(), error: z.null() }).strict().parse(raw).data;
}

function errorText(raw: unknown): string | null {
  const parsed = z.object({ ok: z.literal(false), data: z.null(), error: z.string() }).strict().safeParse(raw);
  return parsed.success ? parsed.data.error : null;
}

function record(raw: unknown, scope: InboxDispositionScope, requestId?: string): InboxDispositionRecord {
  const value = z.object({ entry: z.unknown(), receipt: z.unknown() }).strict().parse(raw);
  const receipt = inboxDispositionReceiptSchema.parse(value.receipt);
  const entry = value.entry === null
    ? null
    : inboxDispositionStoreSchema.shape.entries.element.parse(value.entry);
  const result = { entry, receipt };
  if (requestId !== undefined && receipt.original.requestId !== requestId)
    throw Error("The saved Inbox receipt does not match the requested original.");
  if (!inScope(scope, result)) throw Error("The saved Inbox record conflicts with its immutable receipt.");
  return result;
}

export function createInboxDispositionsClient(deps: {
  read: OperatorRead;
  post: OperatorPost;
  requestId(): string;
}) {
  const read = deps.read;
  const post = deps.post;
  const requestId = deps.requestId;
  const bindingIdentity = Object.freeze({ read, post });

  async function get<T>(url: string, parse: (raw: unknown) => T): Promise<InboxDispositionResult<T>> {
    try {
      const response = await read(url, { method: "GET" }, { maxBodyBytes: LIMIT });
      const raw = await envelope(response);
      if (response.status === 404)
        return errorText(raw) === null
          ? { state: "unknown", message: "The protected Inbox 404 could not be verified." }
          : { state: "missing" };
      if (!response.ok) {
        const message = errorText(raw);
        return message === null
          ? { state: "unknown", message: "The protected Inbox read could not be verified." }
          : { state: "unavailable", message };
      }
      return { state: "confirmed", value: parse(successData(raw)) };
    } catch (error) {
      return { state: "unavailable", message: error instanceof Error ? error.message : "The protected Inbox read failed." };
    }
  }

  async function write(
    scope: InboxDispositionScope,
    url: string,
    body: InboxDispositionOriginal,
    parse: (raw: unknown) => InboxDispositionRecord,
    accepts: (record: InboxDispositionRecord) => boolean,
  ): Promise<InboxDispositionResult<InboxDispositionRecord>> {
    try {
      const original = inboxDispositionOriginalSchema.parse(body);
      if (original.workspace !== scope.workspace)
        return { state: "not-sent", message: "The Inbox original does not match the current scope." };
      const bytes = new TextEncoder().encode(JSON.stringify(original));
      if (bytes.byteLength > 4096)
        return { state: "not-sent", message: "The Inbox original exceeds the request bound." };
      const response = await post(url, original, { maxBodyBytes: LIMIT });
      const raw = await envelope(response);
      const refused = errorText(raw);
      if (!response.ok && refused !== null && (response.status === 409 || response.status === 503))
        return { state: "refused", message: refused };
      if (!response.ok && response.status >= 500)
        return { state: "unknown", message: "The Inbox write outcome is uncertain; check its exact original." };
      const value = parse(successData(raw));
      const expected = inboxDispositionOriginalSchema.parse(original);
      if (!sameOriginal(value.receipt.original, { ...expected, projectId: scope.projectId }))
        throw Error("The protected Inbox reply does not match the exact submitted original.");
      if (response.status === 409) {
        if (value.receipt.phase === "refused")
          return { state: "refused", message: value.receipt.refusalReason ?? "The saved Inbox action was refused.", value };
        return { state: "unknown", message: "The 409 Inbox reply did not contain a terminal refusal." };
      }
      if (!response.ok) return { state: "unknown", message: "The Inbox write reply could not be verified." };
      return accepts(value)
        ? { state: "confirmed", value }
        : { state: "unknown", message: "The Inbox write did not return the required terminal receipt." };
    } catch (error) {
      return error instanceof NotSent
        ? { state: "not-sent", message: error.message }
        : { state: "unknown", message: "The Inbox write outcome is uncertain; check its exact original." };
    }
  }

  const parseRecord = (scope: InboxDispositionScope, requestId?: string) =>
    (raw: unknown) => record(raw, scope, requestId);

  const client = {
    bindingIdentity,
    recovery() {
      return get(`${protectedRoot}/inbox-dispositions/recovery`, (raw) => {
        const value = z.object({ version: z.literal(1), complete: z.literal(true), receipts: z.unknown() }).strict().parse(raw);
        const checked = inboxDispositionStoreSchema.parse({ version: value.version, entries: [], receipts: value.receipts });
        return checked.receipts;
      });
    },
    collection(scope: InboxDispositionScope) {
      return get(root(scope.projectId), (raw) => {
        const value = z.object({ entries: z.unknown(), receipts: z.unknown() }).strict().parse(raw);
        const saved = inboxDispositionStoreSchema.parse({ version: 1, entries: value.entries, receipts: value.receipts });
        if (saved.entries.some((entry) => entry.projectId !== scope.projectId || entry.workspace !== scope.workspace) || saved.receipts.some((item) => item.original.projectId !== scope.projectId || item.original.workspace !== scope.workspace)) throw Error("The Inbox collection is outside this scope.");
        for (const receipt of saved.receipts) {
          const entry = saved.entries.find((candidate) =>
            candidate.item.sourceKind === receipt.original.item.sourceKind &&
            candidate.item.stableItemId === receipt.original.item.stableItemId &&
            candidate.item.sourceRevision === receipt.original.item.sourceRevision);
          if (!inScope(scope, { entry: entry ?? null, receipt })) throw Error("The Inbox collection entry contradicts its receipt.");
        }
        if (saved.entries.some((entry) => !saved.receipts.some((receipt) =>
          receipt.original.item.sourceKind === entry.item.sourceKind &&
          receipt.original.item.stableItemId === entry.item.stableItemId &&
          receipt.original.item.sourceRevision === entry.item.sourceRevision))) throw Error("The Inbox collection contains an entry without its retained receipt.");
        return { entries: saved.entries, receipts: saved.receipts };
      });
    },
    original(scope: InboxDispositionScope, requestId: string) {
      return get(`${root(scope.projectId)}/requests/${encodeURIComponent(requestId)}`, parseRecord(scope, requestId));
    },
    reserve(scope: InboxDispositionScope, original: InboxDispositionOriginal) {
      const parsed = inboxDispositionOriginalSchema.safeParse(original);
      if (!parsed.success || parsed.data.workspace !== scope.workspace)
        return Promise.resolve({ state: "not-sent", message: "The Inbox original does not match the current scope." } as const);
      return write(scope, `${root(scope.projectId)}/requests`, parsed.data, parseRecord(scope, parsed.data.requestId), () => true);
    },
    apply(scope: InboxDispositionScope, original: InboxDispositionOriginal) {
      return write(scope, root(scope.projectId), original, parseRecord(scope, original.requestId),
        (saved) => saved.receipt.phase === "applied" || saved.receipt.phase === "refused");
    },
    discard(scope: InboxDispositionScope, original: InboxDispositionOriginal) {
      return write(scope, `${root(scope.projectId)}/requests/${encodeURIComponent(original.requestId)}/discard`, original, parseRecord(scope, original.requestId),
        (saved) => saved.receipt.phase === "refused" && saved.receipt.refusalCode === "discarded");
    },
    mintOriginal(scope: InboxDispositionScope, input: Omit<InboxDispositionOriginal, "requestId" | "workspace">) {
      return inboxDispositionOriginalSchema.parse({ ...input, requestId: requestId(), workspace: scope.workspace });
    },
  };
  return Object.freeze(client);
}
