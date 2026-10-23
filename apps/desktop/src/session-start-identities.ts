import { z } from "zod";
import {
  canonicalOwnedSessionStart,
  parseOwnedSessionStart,
} from "../../../scripts/sessions/codex-owned-protocol";
import type {
  OwnedSessionStartInput,
  OwnedSessionStartRequest,
} from "../../../types/codex-owned-task";

export const SESSION_START_IDENTITIES =
  "agent-forge.owned-session-start-identities.v1";
const identitySchema = z
  .object({
    projectId: z
      .string()
      .regex(
        /^project-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    requestId: z.uuid().refine((value) => value === value.toLowerCase()),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    provider: z.enum(["claude", "codex"]),
  })
  .strict();
const schema = z
  .object({ version: z.literal(1), records: z.array(identitySchema).max(256) })
  .strict();
export type SessionStartIdentity = z.infer<typeof identitySchema>;
export interface SessionStartIdentities {
  read(projectId: string): SessionStartIdentity | null;
  reserve(
    projectId: string,
    input: OwnedSessionStartInput,
    mint: () => string,
  ): Promise<{
    identity: SessionStartIdentity;
    created: boolean;
    request: OwnedSessionStartRequest | null;
  }>;
  release(identity: SessionStartIdentity): Promise<void>;
}
export async function sessionStartHash(
  input: OwnedSessionStartRequest,
): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalOwnedSessionStart(input)),
  );
  return [...new Uint8Array(hash)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

/** Metadata only, before POST. Never evicts an uncertain identity or stores private input. */
export function createSessionStartIdentities(deps: {
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  withLock<T>(work: () => T | Promise<T>): Promise<T>;
}): SessionStartIdentities {
  const read = () => {
    if (!deps.storage)
      throw Error("Original Start identity storage is unavailable.");
    const text = deps.storage.getItem(SESSION_START_IDENTITIES);
    if (text === null) return schema.parse({ version: 1, records: [] });
    if (text.length > 100_000)
      throw Error(
        "Original Start identity storage exceeds its limit. Saved identities were kept.",
      );
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw Error(
        "Original Start identities could not be verified. Saved data was kept.",
      );
    }
    const parsed = schema.safeParse(raw);
    if (
      !parsed.success ||
      new Set(parsed.data.records.map((item) => item.projectId)).size !==
        parsed.data.records.length ||
      new Set(parsed.data.records.map((item) => item.requestId)).size !==
        parsed.data.records.length
    )
      throw Error(
        "Original Start identities conflict or use an unsupported version. Saved data was kept.",
      );
    return parsed.data;
  };
  const save = (value: z.infer<typeof schema>) => {
    const text = JSON.stringify(schema.parse(value));
    if (text.length > 100_000 || !deps.storage)
      throw Error("The original Start identity could not be saved.");
    deps.storage.setItem(SESSION_START_IDENTITIES, text);
    if (deps.storage.getItem(SESSION_START_IDENTITIES) !== text)
      throw Error(
        "The original Start identity could not be saved and verified.",
      );
  };
  return {
    read(projectId) {
      return structuredClone(
        read().records.find((item) => item.projectId === projectId) ?? null,
      );
    },
    reserve(projectId, input, mint) {
      const draft = structuredClone(input);
      return deps.withLock(async () => {
        const value = read(),
          held = value.records.find((item) => item.projectId === projectId);
        if (held)
          return {
            identity: structuredClone(held),
            created: false,
            request: null,
          };
        if (value.records.length >= 256)
          throw Error(
            "Original Start identity storage is full. Uncertain Starts were kept.",
          );
        const request = parseOwnedSessionStart({ ...draft, requestId: mint() });
        const identity = identitySchema.parse({
          projectId,
          requestId: request.requestId,
          requestHash: await sessionStartHash(request),
          provider: "provider" in request ? request.provider : "claude",
        });
        if (value.records.some((item) => item.requestId === identity.requestId))
          throw Error(
            "The new Start identity collides with another saved original.",
          );
        save({ version: 1, records: [...value.records, identity] });
        return { identity, created: true, request: structuredClone(request) };
      });
    },
    release(identity) {
      const expected = identitySchema.parse(identity);
      return deps.withLock(() => {
        const value = read(),
          held = value.records.find(
            (item) => item.projectId === expected.projectId,
          );
        if (!held) return;
        if (
          held.requestId !== expected.requestId ||
          held.requestHash !== expected.requestHash ||
          held.provider !== expected.provider
        )
          throw Error("A different original Start identity is still held.");
        save({
          version: 1,
          records: value.records.filter((item) => item !== held),
        });
      });
    },
  };
}
