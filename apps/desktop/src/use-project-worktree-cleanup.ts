import { z } from "zod";
import type { OperatorClient } from "../../../docs/js/operator";
import { API_PREFIX } from "../../../scripts/hearth/paths";
import { HEARTH_API_VERSION } from "../../../scripts/hearth/protocol";
import { hasDuplicateObjectKeys } from "../../../scripts/json-object-keys";
import { cleanupRequestSchema } from "../../../scripts/projects/worktree-cleanup-protocol";
import type { ProjectRepositoriesSnapshot } from "./project-repositories-client";

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
  storage?(): Partial<Pick<Storage, "getItem" | "setItem">>;
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
