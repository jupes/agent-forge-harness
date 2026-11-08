import { z } from "zod";
import type { OperatorClient } from "../../../docs/js/operator";
import { API_PREFIX } from "../../../scripts/hearth/paths";
import { HEARTH_API_VERSION } from "../../../scripts/hearth/protocol";
import { hasDuplicateObjectKeys } from "../../../scripts/json-object-keys";
import { cleanupRequestSchema } from "../../../scripts/projects/worktree-cleanup-protocol";
import {
  type ProjectRepositoriesSnapshot,
  projectRepositoriesKey,
} from "./project-repositories-client";
import {
  type CleanupBrowserScope,
  type CleanupBrowserView,
  ProjectWorktreeCleanupOwner,
} from "./project-worktree-cleanup-client";

const success = z
  .object({ ok: z.literal(true), data: z.unknown(), error: z.null() })
  .strict();
const health = z
  .object({
    pid: z.number().int().positive().safe(),
    root: cleanupRequestSchema.shape.repository,
    apiVersion: z.number().int().positive().safe(),
  })
  .strict();

/** Captured protected receiving boundaries; semantic original validation stays in the owner. */
export function createCleanupTransport(
  client: Pick<OperatorClient, "read" | "post">,
) {
  const protectedRead = client.read.bind(client),
    protectedPost = client.post.bind(client);
  const read = async (
    url: string,
    limits: { maxBodyBytes: number },
  ): Promise<unknown> => {
    const response = await protectedRead(API_PREFIX + url, undefined, limits);
    if (!response.ok) throw Error("Cleanup read was refused.");
    const raw = await response.text();
    try {
      if (hasDuplicateObjectKeys(raw))
        throw Error("Duplicate cleanup response keys.");
      return success.parse(JSON.parse(raw)).data;
    } catch {
      throw Error("Cleanup response could not be verified.");
    }
  };
  return {
    readReview: read,
    readReceipt: read,
    health: async () =>
      health.parse(await read("/health", { maxBodyBytes: 65536 })),
    operatorPost: ((url, body, limits = { maxBodyBytes: 65536 }) =>
      protectedPost(
        API_PREFIX + url,
        body,
        limits,
      )) satisfies OperatorClient["post"],
  };
}

export function parseCleanupAuthority(key: string, origin: string) {
  try {
    if (key.length > 2048) throw Error("Cleanup authority exceeds its limit.");
    const parsedOrigin = new URL(origin);
    const tuple = z
      .tuple([z.string(), cleanupRequestSchema.shape.repository])
      .parse(JSON.parse(key));
    if (
      JSON.stringify(tuple) !== key ||
      tuple[0] !== origin ||
      origin === "null" ||
      parsedOrigin.origin !== origin ||
      !["http:", "https:"].includes(parsedOrigin.protocol)
    )
      throw Error("Invalid cleanup authority.");
    return { key, origin, repository: tuple[1] };
  } catch {
    throw Error("Cleanup authority could not be verified.");
  }
}

export function cleanupAuthorityKey(
  origin: string,
  repository: string,
): string {
  const key = JSON.stringify([origin, repository]);
  return parseCleanupAuthority(key, origin).key;
}

/** Two fixed passes observe namespace drift; they do not promise atomic storage. */
export function discoverCleanupAuthorities(
  storage: Pick<Storage, "length" | "key">,
  origin: string,
  currentKey: string | null,
) {
  const rows = new Map<
    string,
    ReturnType<typeof parseCleanupAuthority> & {
      marker: boolean;
      inventory: boolean;
    }
  >();
  let hold: string | null = null;
  const warn = () => {
    hold =
      "Cleanup recovery discovery is incomplete. New cleanup is unavailable; saved evidence is preserved.";
  };
  const take = (key: string) => {
    const authority = parseCleanupAuthority(key, origin);
    if (!rows.has(key)) {
      if (rows.size >= 8) throw Error("Too many cleanup authorities.");
      rows.set(key, { ...authority, marker: false, inventory: false });
    }
    return rows.get(key)!;
  };
  const scan = () => {
    const count = storage.length;
    if (!Number.isSafeInteger(count) || count < 0 || count > 512)
      throw Error("Too many origin storage keys.");
    const keys: string[] = [];
    for (let index = 0; index < count; index++) {
      const key = storage.key(index);
      if (key === null || keys.includes(key))
        throw Error("Storage enumeration changed.");
      keys.push(key);
    }
    if (storage.length !== count) throw Error("Storage enumeration changed.");
    return keys;
  };
  try {
    if (currentKey !== null) take(currentKey);
    const keys = scan(),
      prefix = "agent-forge.project-worktree-cleanup.v1.";
    let dedicated = 0;
    for (const key of keys) {
      if (!key.startsWith(prefix)) continue;
      try {
        if (++dedicated > 16) throw Error("Too many cleanup storage keys.");
        if (key.length > prefix.length + 2048 + ".inventory".length)
          throw Error("Cleanup storage key exceeds its limit.");
        const match = /^(.*)\.(marker|inventory)$/.exec(
          key.slice(prefix.length),
        );
        if (!match) throw Error("Unknown cleanup storage key.");
        const row = take(match[1]!);
        if (match[2] === "marker") row.marker = true;
        else row.inventory = true;
      } catch {
        warn();
      }
    }
    if (JSON.stringify(scan()) !== JSON.stringify(keys)) warn();
    if ([...rows.values()].some((row) => row.marker !== row.inventory)) warn();
  } catch {
    warn();
  }
  return { authorities: [...rows.values()], hold };
}

interface CleanupWebCapabilities {
  storage?(): Partial<Pick<Storage, "getItem" | "setItem" | "length" | "key">>;
  locks?(): Partial<Pick<LockManager, "request">>;
  crypto?(): {
    randomUUID?: Crypto["randomUUID"];
    subtle?: Partial<Pick<SubtleCrypto, "digest">>;
  };
}

/** Capture capability receivers only; construction performs no storage, lock or crypto operation. */
export function createCleanupCapabilities(
  authorityKey: string,
  web: CleanupWebCapabilities,
) {
  const unavailable = (): never => {
    throw Error(
      "Cleanup requires browser storage, shared Web Locks and WebCrypto. No fallback cleanup was sent.",
    );
  };
  const capture = <T>(take: () => T): T | null => {
    try {
      return take();
    } catch {
      return null;
    }
  };
  const storage = capture(() => {
    const value = web.storage?.();
    if (
      typeof value?.getItem !== "function" ||
      typeof value.setItem !== "function"
    )
      return unavailable();
    return {
      getItem: value.getItem.bind(value),
      setItem: value.setItem.bind(value),
    };
  });
  const request = capture(() => {
    const value = web.locks?.();
    if (typeof value?.request !== "function") return unavailable();
    return value.request.bind(value);
  });
  const cryptography = capture(() => {
    const value = web.crypto?.(),
      subtle = value?.subtle;
    if (
      typeof value?.randomUUID !== "function" ||
      typeof subtle?.digest !== "function"
    )
      return unavailable();
    return {
      uuid: value.randomUUID.bind(value),
      digest: subtle.digest.bind(subtle),
    };
  });
  const available =
    storage !== null && request !== null && cryptography !== null;
  return {
    available,
    warning: available
      ? null
      : "Browser storage, shared Web Locks or WebCrypto is unavailable. Restore these capabilities before new cleanup; retained receipts remain visible.",
    storage: storage ?? { getItem: unavailable, setItem: unavailable },
    async withLock<T>(work: () => Promise<T>): Promise<T> {
      if (!request) return unavailable();
      return request(
        "agent-forge.project-worktree-cleanup.v1." + authorityKey,
        { signal: AbortSignal.timeout(10000) },
        work,
      );
    },
    uuid: () => cryptography?.uuid() ?? unavailable(),
    async hash(text: string) {
      if (!cryptography) return unavailable();
      const digest = await cryptography.digest(
        "SHA-256",
        new TextEncoder().encode(text),
      );
      return [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    },
  };
}

export interface CleanupContextFacts {
  route: string;
  routeGeneration: number;
  projectId: string | null;
  archived: boolean;
  catalogRevision: number | null;
  catalogSource: object | null;
  catalogReady: boolean;
  repositoryKey: string | null;
  repositoryPhase: ProjectRepositoriesSnapshot["phase"];
  repositoryData: ProjectRepositoriesSnapshot["data"];
  repositoryRequestedRevision: number | null;
  repositoryResponseRevision: number | null;
  connectionPhase: string;
  writesAllowed: boolean;
  connectionBusy: boolean;
  connectionUnknown: boolean;
}

/** Context changes close the coherent gate before synchronous proof invalidation. */
export function createCleanupContextGate(invalidateProof: () => void) {
  let generation = 0;
  let context: Readonly<CleanupContextFacts> | null = null;
  let fingerprint: unknown[] | null = null;
  let observed: Readonly<z.infer<typeof health>> | null = null;
  const invalidate = () => {
    observed = null;
    generation++;
    invalidateProof();
  };
  const snapshot = () => ({
    generation,
    context,
    health: observed,
    open: context !== null && observed !== null,
  });
  return {
    snapshot,
    invalidate,
    adopt(next: CleanupContextFacts) {
      const values = [
        next.route,
        next.routeGeneration,
        next.projectId,
        next.archived,
        next.catalogRevision,
        next.catalogSource,
        next.catalogReady,
        next.repositoryKey,
        next.repositoryPhase,
        next.repositoryData,
        next.repositoryRequestedRevision,
        next.repositoryResponseRevision,
        next.connectionPhase,
        next.writesAllowed,
        next.connectionBusy,
        next.connectionUnknown,
      ];
      if (fingerprint?.every((value, index) => Object.is(value, values[index])))
        return false;
      context = Object.freeze({ ...next });
      fingerprint = values;
      invalidate();
      return true;
    },
    publishHealth(expectedGeneration: number, answer: unknown): number | null {
      if (expectedGeneration !== generation || context === null) return null;
      let next: z.infer<typeof health>;
      try {
        next = health.parse(answer);
      } catch {
        invalidate();
        return null;
      }
      if (
        observed?.root === next.root &&
        observed.pid === next.pid &&
        observed.apiVersion === next.apiVersion
      )
        return generation;
      if (observed !== null) {
        const source = context;
        invalidate();
        if (context !== source || generation !== expectedGeneration + 1)
          return null;
      }
      observed = Object.freeze(next);
      return generation;
    },
    writesAvailable() {
      return (
        observed?.apiVersion === HEARTH_API_VERSION &&
        context !== null &&
        context.connectionPhase === "connected" &&
        context.writesAllowed &&
        !context.connectionBusy &&
        !context.connectionUnknown &&
        context.projectId !== null &&
        !context.archived &&
        context.catalogReady &&
        context.repositoryPhase === "ready" &&
        context.repositoryKey !== null &&
        context.repositoryData?.projectId === context.projectId &&
        context.repositoryData.catalogRevision === context.catalogRevision &&
        context.repositoryRequestedRevision === context.catalogRevision &&
        context.repositoryResponseRevision === context.catalogRevision
      );
    },
    deactivate() {
      context = null;
      fingerprint = null;
      invalidate();
    },
  };
}

const latestCleanupHealthRead = new WeakMap<
  ReturnType<typeof createCleanupContextGate>,
  object
>();

export async function refreshCleanupHealth(
  gate: ReturnType<typeof createCleanupContextGate>,
  readHealth: () => Promise<unknown>,
) {
  const expected = gate.snapshot().generation;
  const token = {};
  latestCleanupHealthRead.set(gate, token);
  try {
    const answer = await readHealth();
    if (latestCleanupHealthRead.get(gate) !== token) return null;
    const published = gate.publishHealth(expected, answer);
    return published === null ? null : gate.snapshot();
  } catch {
    if (
      latestCleanupHealthRead.get(gate) === token &&
      gate.snapshot().generation === expected
    )
      gate.invalidate();
    return null;
  }
}

/** Current health binds reads to one exact authority; actual sent outcomes stay owned by the original. */
export function createCleanupLiveTransport(
  authorityRoot: string,
  gate: ReturnType<typeof createCleanupContextGate>,
  transport: ReturnType<typeof createCleanupTransport>,
  canDispatch: () => boolean,
) {
  const healthRead = transport.health.bind(transport);
  const reviewRead = transport.readReview.bind(transport),
    receiptRead = transport.readReceipt.bind(transport),
    post = transport.operatorPost.bind(transport);
  const fresh = async (review: boolean) => {
    const expected = gate.snapshot().generation;
    const view = await refreshCleanupHealth(gate, healthRead);
    if (
      !view?.health ||
      view.health.root !== authorityRoot ||
      (review &&
        (view.health.apiVersion !== HEARTH_API_VERSION ||
          view.generation !== expected))
    )
      throw Error(
        "The cleanup hearth identity changed. Check its connection and review again.",
      );
    return view;
  };
  return {
    async readReview(url: string, limits: { maxBodyBytes: number }) {
      const before = await fresh(true);
      const data = await reviewRead(url, limits);
      const after = await fresh(true);
      if (after.generation !== before.generation)
        throw Error("The cleanup context changed.");
      return data;
    },
    async readReceipt(url: string, limits: { maxBodyBytes: number }) {
      const before = await fresh(false);
      const data = await receiptRead(url, limits);
      const after = await fresh(false);
      if (
        before.health?.root !== after.health?.root ||
        before.health?.pid !== after.health?.pid ||
        before.health?.apiVersion !== after.health?.apiVersion
      )
        throw Error("The cleanup receipt's hearth identity changed.");
      return data;
    },
    operatorPost: (async (url, body, limits) => {
      const expected = gate.snapshot().generation;
      const before = await fresh(true);
      if (
        !canDispatch() ||
        gate.snapshot().generation !== expected ||
        gate.snapshot().health !== before.health
      )
        throw Error(
          "The cleanup dispatch context changed. The original is retained.",
        );
      return post(url, body, limits);
    }) satisfies OperatorClient["post"],
  };
}

export function createCleanupOwnerRegistry(deps: {
  origin: string;
  web: CleanupWebCapabilities;
  gate: ReturnType<typeof createCleanupContextGate>;
  transport: ReturnType<typeof createCleanupTransport>;
  currentScope(authorityKey: string): CleanupBrowserScope | null;
  canDispatch(authorityKey: string): boolean;
  onChange(): void;
}) {
  type Entry = ReturnType<typeof parseCleanupAuthority> & {
    owner: ProjectWorktreeCleanupOwner;
    view: CleanupBrowserView;
    available: boolean;
    hasEvidence: boolean;
    allowEmpty: boolean;
    leave(): void;
  };
  const entries = new Map<string, Entry>();
  let lifecycle: "active" | "disposed" = "active";
  const active = () => lifecycle === "active";
  const notify = () => {
    if (active()) deps.onChange();
  };
  let discoveryWarning: string | null = null;
  const foreign = (entry: Entry) =>
    entry.view.inventory?.records.some(
      (row) => row.original.request.repository !== entry.repository,
    ) ?? false;
  const warning = () =>
    discoveryWarning ??
    ([...entries.values()].some(
      (entry) => !entry.available || entry.view.storageError || foreign(entry),
    )
      ? "Cleanup recovery storage or authority could not be verified. Saved originals and receipts are retained."
      : null);
  const otherPending = (key: string) =>
    [...entries.values()].some(
      (entry) =>
        entry.key !== key && entry.view.inventory?.activeRequestId != null,
    );
  const invalidateInspections = () => {
    if (!active()) return;
    for (const entry of entries.values()) void entry.owner.inspect(null);
  };
  return {
    invalidateInspections,
    snapshot() {
      return {
        hold: warning(),
        pending: [...entries.values()].some(
          (entry) => entry.view.inventory?.activeRequestId != null,
        ),
        authorities: [...entries.values()].map((entry) => ({
          key: entry.key,
          repository: entry.repository,
          owner: entry.owner,
          view: entry.view,
          readsAvailable:
            active() && deps.gate.snapshot().health?.root === entry.repository,
          foreignOriginal: foreign(entry),
        })),
      };
    },
    async checkOriginal(authorityKey: string, requestId: string) {
      if (!active()) return;
      const entry = entries.get(authorityKey);
      const row = entry?.owner
        .snapshot()
        .inventory?.records.find(
          (record) => record.original.request.requestId === requestId,
        );
      if (
        !entry ||
        !row ||
        row.original.request.repository !== entry.repository
      )
        return;
      await entry.owner.checkOriginal(requestId);
    },
    async restore() {
      if (!active()) return;
      let surface:
        | ReturnType<NonNullable<CleanupWebCapabilities["storage"]>>
        | undefined;
      let keyReader: ((index: number) => string | null) | undefined;
      let currentKey: string | null = null;
      discoveryWarning = null;
      try {
        surface = deps.web.storage?.();
        keyReader = surface?.key?.bind(surface);
        const root = deps.gate.snapshot().health?.root;
        if (root) currentKey = cleanupAuthorityKey(deps.origin, root);
      } catch {
        discoveryWarning =
          "Browser cleanup storage is inaccessible. Restore access before new cleanup.";
      }
      const discovered = discoverCleanupAuthorities(
        {
          get length() {
            if (typeof surface?.length !== "number")
              throw Error("Storage enumeration unavailable");
            return surface.length;
          },
          key(index) {
            if (!keyReader) throw Error("Storage enumeration unavailable");
            return keyReader(index);
          },
        },
        deps.origin,
        currentKey,
      );
      discoveryWarning ??= discovered.hold;
      for (const row of discovered.authorities) {
        if (!active()) return;
        let entry = entries.get(row.key);
        if (!entry) {
          if (entries.size >= 8) {
            discoveryWarning =
              "Eight cleanup authorities are already retained. New cleanup is unavailable; existing originals are preserved.";
            continue;
          }
          const capabilities = createCleanupCapabilities(row.key, {
            ...deps.web,
            storage: () => surface ?? {},
          });
          let created!: Entry;
          const writable = () =>
            active() &&
            warning() === null &&
            capabilities.available &&
            !otherPending(row.key) &&
            deps.canDispatch(row.key);
          const healthRead = deps.transport.health.bind(deps.transport);
          const reviewRead = deps.transport.readReview.bind(deps.transport);
          const receiptRead = deps.transport.readReceipt.bind(deps.transport);
          const requireActiveRead = () => {
            if (!active()) throw Error("Cleanup recovery is disposed.");
          };
          const live = createCleanupLiveTransport(
            row.repository,
            deps.gate,
            {
              ...deps.transport,
              health: () => {
                requireActiveRead();
                return healthRead();
              },
              readReview: (...args) => {
                requireActiveRead();
                return reviewRead(...args);
              },
              readReceipt: (...args) => {
                requireActiveRead();
                return receiptRead(...args);
              },
            },
            writable,
          );
          const owner = new ProjectWorktreeCleanupOwner({
            ...capabilities,
            ...live,
            authorityKey: row.key,
            storage: {
              getItem(key) {
                const raw = capabilities.storage.getItem(key);
                if (raw === null && !created.allowEmpty)
                  throw Error(
                    "Previously observed cleanup evidence is missing",
                  );
                return raw;
              },
              setItem(key, value) {
                if (!active()) throw Error("Cleanup recovery is disposed.");
                capabilities.storage.setItem(key, value);
              },
            },
            withLock<T>(work: () => Promise<T>): Promise<T> {
              if (!active())
                return Promise.reject(Error("Cleanup recovery is disposed."));
              return capabilities.withLock(async () => {
                if (!active()) throw Error("Cleanup recovery is disposed.");
                return work();
              });
            },
            currentScope: () => (active() ? deps.currentScope(row.key) : null),
            canWrite: writable,
          });
          const leave = owner.subscribe((view) => {
            created.view = view;
            if (view.inventory !== null) created.hasEvidence = true;
            notify();
          });
          created = {
            ...parseCleanupAuthority(row.key, deps.origin),
            owner,
            view: owner.snapshot(),
            available: capabilities.available,
            hasEvidence: row.marker || row.inventory,
            allowEmpty: false,
            leave,
          };
          entries.set(row.key, created);
          entry = created;
        }
        if (row.marker || row.inventory) entry.hasEvidence = true;
      }
      for (const entry of entries.values()) {
        if (!active()) return;
        entry.allowEmpty =
          discoveryWarning === null &&
          entry.key === currentKey &&
          !entry.hasEvidence;
        try {
          await entry.owner.restore();
        } finally {
          entry.allowEmpty = false;
        }
      }
      notify();
    },
    dispose() {
      if (!active()) return;
      lifecycle = "disposed";
      for (const entry of entries.values()) {
        entry.allowEmpty = false;
        void entry.owner.inspect(null);
        entry.leave();
      }
    },
  };
}

/** Reported facts select a candidate; only the owner's full fresh review can authorize confirmation. */
export function cleanupCandidate(
  context: CleanupContextFacts | null,
  observedHealth: unknown,
  scope: CleanupBrowserScope,
) {
  const checkedHealth = health.safeParse(observedHealth);
  if (!checkedHealth.success || !context) return null;
  const root = checkedHealth.data.root,
    data = context.repositoryData;
  if (
    checkedHealth.data.apiVersion !== HEARTH_API_VERSION ||
    !context.catalogReady ||
    context.projectId === null ||
    context.projectId !== scope.projectId ||
    scope.repository !== root ||
    context.repositoryPhase !== "ready" ||
    !data ||
    data.projectId !== context.projectId ||
    data.catalogRevision !== context.catalogRevision ||
    context.repositoryRequestedRevision !== context.catalogRevision ||
    context.repositoryResponseRevision !== context.catalogRevision ||
    context.repositoryKey === null ||
    context.repositoryKey !==
      projectRepositoriesKey(context.projectId, context.catalogRevision)
  )
    return null;
  const workspaces = data.repositories.filter(
    (workspace) => workspace.workspaceRoot === root,
  );
  if (workspaces.length !== 1) return null;
  const members = workspaces[0]!.repositories.filter(
    (member) => member.access === "served" && member.path === root,
  );
  if (members.length !== 1) return null;
  const member = members[0]!;
  if (member.access !== "served") return null;
  const rows = member.worktrees.filter((row) => row.id === scope.worktreeId);
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  if (row.kind !== "trees" || row.missing) return null;
  const record = cleanupRequestSchema.shape.expectedRecord
    .omit({ beadId: true })
    .safeParse({
      id: row.id,
      path: row.path,
      branch: row.branch,
      createdAt: row.createdAt,
    });
  if (!record.success) return null;
  return Object.freeze({
    scope: Object.freeze({
      projectId: scope.projectId,
      repository: root,
      worktreeId: record.data.id,
    }),
    catalogRevision: data.catalogRevision,
    row: Object.freeze(record.data),
  });
}
