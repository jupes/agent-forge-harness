import type { KeeperProposal } from "../../../types/keeper-proposal";
import { createKeeperProposalStore } from "../../keeper/proposal-store";
import { FIXTURE_PROJECT_ID } from "../../projects/testing";
import type { TestHearth } from "../testing";
import { seedKeeperProposalSource } from "./keeper-proposal-fixture";
import { sessionStartFixture } from "./session-fixture";

export const FIXTURE_KEEPER_SESSION_SOURCE =
  "9e92ce46-1e66-4ac2-8989-5b1e9ab58221";
export const FIXTURE_KEEPER_SESSION_PROPOSAL = `proposal-${FIXTURE_KEEPER_SESSION_SOURCE}-0`;
export const FIXTURE_KEEPER_SESSION_HISTORY = `proposal-${FIXTURE_KEEPER_SESSION_SOURCE}-1`;
export const FIXTURE_KEEPER_SESSION_REQUEST =
  "e3c8159d-79bc-4ea4-ae01-71263d034bba";

export async function seedKeeperSessionStartSource(h: TestHearth) {
  const sources = await seedKeeperProposalSource(
    h,
    [
      {
        title: "Review a session",
        detail: "Only explicit Start may run this suggestion.",
        action: {
          kind: "start-session",
          provider: "claude",
          smith: "claude-journeyman",
          beadId: "alpha-epic",
          repository: h.workspace,
          worktree: "current",
          prompt: "Source suggestion",
        },
      },
    ],
    FIXTURE_KEEPER_SESSION_SOURCE,
  );
  const source = sources.find(
    (item) => item.id === FIXTURE_KEEPER_SESSION_PROPOSAL,
  );
  if (!source) throw new Error("Missing verified Keeper session source.");
  return source;
}

/** A private historical review, planted without a route, provider, tracker or ledger effect. */
export async function seedKeeperSessionStartHistory(h: TestHearth) {
  const store = createKeeperProposalStore(h.home);
  if (
    await store.readSessionStart(
      FIXTURE_PROJECT_ID,
      FIXTURE_KEEPER_SESSION_HISTORY,
    )
  )
    return;
  const proposal: KeeperProposal = {
    id: FIXTURE_KEEPER_SESSION_HISTORY,
    projectId: FIXTURE_PROJECT_ID,
    sourceRequestId: FIXTURE_KEEPER_SESSION_SOURCE,
    sourceHash: "a".repeat(64),
    createdAt: "2026-10-23T04:00:00.000Z",
    draft: {
      title: "Historical session review",
      detail: "The original reviewed input is retained.",
      action: {
        kind: "start-session",
        provider: "claude",
        smith: "claude-journeyman",
        beadId: "alpha-epic",
        repository: h.workspace,
        worktree: "current",
        prompt: "Source suggestion",
      },
    },
  };
  await store.startSession(
    {
      projectId: FIXTURE_PROJECT_ID,
      proposalId: proposal.id,
      request: {
        sourceHash: proposal.sourceHash,
        expectedRevision: (await store.read(FIXTURE_PROJECT_ID)).revision,
        start: sessionStartFixture(h, "6c980ce0-3b77-4b36-a682-5f6d6ac56634"),
      },
      auditEventId: 1,
    },
    {
      prepare: async () => ({ proposal, workspace: h.workspace }),
      execute: async () => ({
        phase: "unknown",
        message: "The historical original Start is unconfirmed.",
        objects: [],
      }),
    },
  );
}
