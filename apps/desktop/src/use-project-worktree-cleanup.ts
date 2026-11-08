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
