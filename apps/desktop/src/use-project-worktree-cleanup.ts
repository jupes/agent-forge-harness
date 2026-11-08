import { z } from "zod";
import type { OperatorClient } from "../../../docs/js/operator";
import { API_PREFIX } from "../../../scripts/hearth/paths";
import { hasDuplicateObjectKeys } from "../../../scripts/json-object-keys";
import { cleanupRequestSchema } from "../../../scripts/projects/worktree-cleanup-protocol";

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
