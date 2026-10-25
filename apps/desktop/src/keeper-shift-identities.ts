import { z } from "zod";
import { keeperShiftProposalIdSchema } from "../../../scripts/keeper/shift-start-wire";
import { workspaceKey } from "../../../scripts/projects/scope";
import {
  sessionProjectIdSchema,
  sessionRequestHashSchema,
} from "../../../scripts/sessions/identity-protocol";
import { shiftRequestIdSchema } from "../../../scripts/shifts/protocol";
import type { KeeperProposal } from "../../../types/keeper-proposal";

export const KEEPER_SHIFT_IDENTITIES = "agent-forge.keeper-shift-identities.v1";
const MAX_IDENTITY_BYTES = 100_000;
const identitySchema = z
  .object({
    projectId: sessionProjectIdSchema,
    proposalId: keeperShiftProposalIdSchema,
    sourceHash: sessionRequestHashSchema,
    workspace: z.string().min(1).max(4096),
    requestId: shiftRequestIdSchema,
  })
  .strict();
const journalSchema = z
  .object({ version: z.literal(1), records: z.array(identitySchema).max(256) })
  .strict();
export type KeeperShiftIdentity = z.infer<typeof identitySchema>;

export interface KeeperShiftIdentities {
  /** Read saved identity metadata without granting access to its protected original. */
  read(source: KeeperProposal, workspace?: string): KeeperShiftIdentity | null;
  reserve(
    source: KeeperProposal,
    workspace: string,
    mint: () => string,
  ): Promise<{ identity: KeeperShiftIdentity; created: boolean }>;
}

/** Metadata only. A held UUID is permanent through uncertain outcomes; request bodies never enter storage. */
export function createKeeperShiftIdentities(deps: {
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  withLock<T>(work: () => T | Promise<T>): Promise<T>;
}): KeeperShiftIdentities {
  const readJournal = () => {
    if (!deps.storage) throw Error("Shift identity storage is unavailable.");
    const text = deps.storage.getItem(KEEPER_SHIFT_IDENTITIES);
    if (text === null) return journalSchema.parse({ version: 1, records: [] });
    if (new TextEncoder().encode(text).byteLength > MAX_IDENTITY_BYTES)
      throw Error("Shift identity metadata exceeds its storage limit.");
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw Error(
        "Shift identity metadata could not be verified. Existing bytes were kept.",
      );
    }
    const parsed = journalSchema.safeParse(raw);
    if (!parsed.success)
      throw Error(
        "Shift identity metadata could not be verified. Existing bytes were kept.",
      );
    const seenProposals = new Set<string>(),
      seenRequests = new Set<string>();
    for (const row of parsed.data.records) {
      const proposalKey = JSON.stringify([row.projectId, row.proposalId]);
      if (
        seenProposals.has(proposalKey) ||
        seenRequests.has(row.requestId) ||
        workspaceKey(row.workspace) !== row.workspace
      )
        throw Error(
          "Shift identity metadata contains conflicting records. Existing bytes were kept.",
        );
      seenProposals.add(proposalKey);
      seenRequests.add(row.requestId);
    }
    return parsed.data;
  };
  const proposalFor = (source: KeeperProposal) => {
    if (source.draft.action.kind !== "start-shift")
      throw Error("This proposal does not request a Shift.");
    return {
      durationMinutes: source.draft.action.durationMinutes,
      concurrency: source.draft.action.concurrency,
      beadLimit: source.draft.action.beadLimit,
      spendLimitUsd: source.draft.action.spendLimitUsd,
    };
  };
  const find = (
    records: KeeperShiftIdentity[],
    source: KeeperProposal,
    workspace?: string,
  ) => {
    proposalFor(source);
    const held = records.find(
      (row) =>
        row.projectId === source.projectId && row.proposalId === source.id,
    );
    if (
      held &&
      (held.sourceHash !== source.sourceHash ||
        (workspace !== undefined && held.workspace !== workspaceKey(workspace)))
    )
      throw Error(
        "The held Shift identity belongs to a changed proposal source or workspace. A replacement is locked.",
      );
    return held;
  };
  const save = (records: KeeperShiftIdentity[]) => {
    if (!deps.storage) throw Error("Shift identity storage is unavailable.");
    const parsed = journalSchema.safeParse({ version: 1, records });
    if (!parsed.success)
      throw Error("The Shift identity metadata could not be verified.");
    const text = JSON.stringify(parsed.data);
    if (new TextEncoder().encode(text).byteLength > MAX_IDENTITY_BYTES)
      throw Error(
        "Shift identity storage is full. Existing uncertain identities were kept.",
      );
    deps.storage.setItem(KEEPER_SHIFT_IDENTITIES, text);
    if (deps.storage.getItem(KEEPER_SHIFT_IDENTITIES) !== text)
      throw Error("The Shift identity could not be saved and verified.");
  };

  return {
    read(source, workspace) {
      const held = find(readJournal().records, source, workspace);
      return held ? structuredClone(held) : null;
    },
    reserve(source, workspace, mint) {
      const scope = workspaceKey(workspace);
      return deps.withLock(() => {
        const journal = readJournal(),
          held = find(journal.records, source, scope);
        if (held) return { identity: structuredClone(held), created: false };
        if (journal.records.length >= 256)
          throw Error(
            "Shift identity storage is full. Existing uncertain identities were kept.",
          );
        const identity = identitySchema.safeParse({
          projectId: source.projectId,
          proposalId: source.id,
          sourceHash: source.sourceHash,
          workspace: scope,
          requestId: mint(),
        });
        if (
          !identity.success ||
          journal.records.some(
            (row) => row.requestId === identity.data?.requestId,
          )
        )
          throw Error("The Shift identity could not be verified.");
        const records = [...journal.records, identity.data];
        save(records);
        const verified = find(readJournal().records, source, scope);
        if (!verified || verified.requestId !== identity.data.requestId)
          throw Error("The Shift identity could not be saved and verified.");
        return { identity: structuredClone(verified), created: true };
      });
    },
  };
}
