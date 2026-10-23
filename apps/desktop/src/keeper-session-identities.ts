import { z } from "zod";
import { workspaceKey } from "../../../scripts/projects/scope";
import type { KeeperProposal } from "../../../types/keeper-proposal";

export const KEEPER_SESSION_IDENTITIES =
  "agent-forge.keeper-session-identities.v1";
const MAX_IDENTITY_TEXT = 1_200_000;
const identity = z
  .object({
    projectId: z.string().min(1).max(100),
    proposalId: z.string().min(1).max(150),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    repository: z.string().min(1).max(4096),
    requestId: z.uuid(),
  })
  .strict();
const journal = z
  .object({ version: z.literal(1), records: z.array(identity).max(256) })
  .strict();
type Identity = z.infer<typeof identity>;
export interface KeeperSessionIdentities {
  read(source: KeeperProposal): string | null;
  reserve(
    source: KeeperProposal,
    mint: () => string,
  ): Promise<{ requestId: string; created: boolean }>;
}

/** Metadata only. Never evict an uncertain identity or store private launch input. */
export function createKeeperSessionIdentities(deps: {
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  withLock<T>(work: () => T | Promise<T>): Promise<T>;
}): KeeperSessionIdentities {
  const read = () => {
    if (!deps.storage) throw Error("Start identity storage is unavailable.");
    const text = deps.storage.getItem(KEEPER_SESSION_IDENTITIES);
    if (text === null) return journal.parse({ version: 1, records: [] });
    if (text.length > MAX_IDENTITY_TEXT)
      throw Error("Start identity storage exceeds its limit.");
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw Error(
        "Start identity storage could not be verified. Existing records were kept.",
      );
    }
    const parsed = journal.safeParse(raw);
    if (!parsed.success)
      throw Error(
        "Start identity storage could not be verified. Existing records were kept.",
      );
    const value = parsed.data,
      seen = new Set<string>();
    for (const entry of value.records) {
      const key = JSON.stringify([
        entry.projectId,
        entry.proposalId,
        entry.sourceHash,
      ]);
      if (seen.has(key) || workspaceKey(entry.repository) !== entry.repository)
        throw Error("Start identity storage contains conflicting metadata.");
      seen.add(key);
    }
    return value;
  };
  const find = (entries: Identity[], source: KeeperProposal) => {
    if (source.draft.action.kind !== "start-session")
      throw Error("Expected a session proposal.");
    const held = entries.find(
      (entry) =>
        entry.projectId === source.projectId &&
        entry.proposalId === source.id &&
        entry.sourceHash === source.sourceHash,
    );
    if (
      held &&
      held.repository !== workspaceKey(source.draft.action.repository)
    )
      throw Error("The saved Start identity belongs to another repository.");
    return held;
  };
  return {
    read(source) {
      return find(read().records, source)?.requestId ?? null;
    },
    reserve(source, mint) {
      return deps.withLock(() => {
        const value = read(),
          held = find(value.records, source);
        if (held) return { requestId: held.requestId, created: false };
        if (value.records.length >= 256)
          throw Error(
            "Start identity storage is full. Existing uncertain starts are retained.",
          );
        if (source.draft.action.kind !== "start-session")
          throw Error("Expected a session proposal.");
        const entry = identity.parse({
          projectId: source.projectId,
          proposalId: source.id,
          sourceHash: source.sourceHash,
          repository: workspaceKey(source.draft.action.repository),
          requestId: mint(),
        });
        const text = JSON.stringify({
          version: 1,
          records: [...value.records, entry],
        });
        if (text.length > MAX_IDENTITY_TEXT)
          throw Error(
            "Start identity storage exceeds its limit. Existing uncertain starts are retained.",
          );
        if (!deps.storage)
          throw Error("Start identity storage is unavailable.");
        deps.storage.setItem(KEEPER_SESSION_IDENTITIES, text);
        if (deps.storage.getItem(KEEPER_SESSION_IDENTITIES) !== text)
          throw Error(
            "The original Start identity could not be saved and verified.",
          );
        return { requestId: entry.requestId, created: true };
      });
    },
  };
}
