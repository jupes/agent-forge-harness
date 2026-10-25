import type { KeeperProposalDraft } from "../../../types/keeper-proposal";
import { createKeeperProposalStore } from "../../keeper/proposal-store";
import { FIXTURE_PROJECT_ID } from "../../projects/testing";
import type { TestHearth } from "../testing";
import { seedKeeperProposalSource } from "./keeper-proposal-fixture";

export const FIXTURE_KEEPER_SHIFT_SOURCE =
  "9e92ce46-1e66-4ac2-8989-5b1e9ab58222";
export const FIXTURE_KEEPER_SHIFT_PROPOSAL = `proposal-${FIXTURE_KEEPER_SHIFT_SOURCE}-0`;
export const FIXTURE_KEEPER_SHIFT_HISTORY = `proposal-${FIXTURE_KEEPER_SHIFT_SOURCE}-0`;
export const FIXTURE_KEEPER_SHIFT_REQUEST =
  "37c8aa56-1db1-4722-8fd2-1dbef8326001";
export const FIXTURE_KEEPER_SHIFT_HISTORY_REQUEST =
  "37c8aa56-1db1-4722-8fd2-1dbef8326002";

export function keeperShiftDraft(
  title = "Review a project Shift",
): KeeperProposalDraft {
  return {
    title,
    detail: "Review the complete bounds before starting.",
    action: {
      kind: "start-shift",
      durationMinutes: 45,
      concurrency: 2,
      beadLimit: 5,
      spendLimitUsd: 8,
    },
  };
}

export async function seedKeeperShiftStartSource(
  h: TestHearth,
  drafts: KeeperProposalDraft[] = [keeperShiftDraft()],
) {
  const proposals = await seedKeeperProposalSource(
    h,
    drafts,
    FIXTURE_KEEPER_SHIFT_SOURCE,
  );
  return proposals.filter(
    (proposal) => proposal.sourceRequestId === FIXTURE_KEEPER_SHIFT_SOURCE,
  );
}

export const keeperShiftStartFixture = (
  sourceHash: string,
  requestId = FIXTURE_KEEPER_SHIFT_REQUEST,
  expectedRevision = 0,
) => ({
  sourceHash,
  expectedRevision,
  start: {
    requestId,
    expectedCatalogRevision: 1,
    options: {
      for: "2h",
      concurrency: 3,
      maxBeads: 7,
      maxUsd: 20,
      repairs: 4,
      base: "master",
    },
  },
});

/** Historical private original for the operator API route inventory test. */
export async function seedKeeperShiftStartHistory(h: TestHearth) {
  const proposal = (await seedKeeperShiftStartSource(h))[0];
  if (!proposal) throw new Error("Missing fixture Keeper Shift proposal");
  const store = createKeeperProposalStore(h.home),
    state = await store.read(FIXTURE_PROJECT_ID),
    body = keeperShiftStartFixture(
      proposal.sourceHash,
      FIXTURE_KEEPER_SHIFT_HISTORY_REQUEST,
      state.revision,
    );
  await store.startShift(
    {
      projectId: FIXTURE_PROJECT_ID,
      proposalId: proposal.id,
      request: body,
      auditEventId: 1,
    },
    {
      prepare: async () => ({ proposal, workspace: h.workspace }),
      execute: async () => ({
        phase: "unknown",
        message: "The historical original Shift Start is unconfirmed.",
        objects: [],
      }),
    },
  );
}
