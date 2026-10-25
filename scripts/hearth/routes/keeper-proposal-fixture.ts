import { randomUUID } from "node:crypto";
import type { KeeperProposalDraft } from "../../../types/keeper-proposal";
import { createConversationStore } from "../../conversations/store";
import { keeperProposals } from "../../keeper/proposals";
import { projectCatalogPath } from "../../projects/store";
import {
  FIXTURE_PROJECT_ID,
  projectCatalogFixture,
} from "../../projects/testing";
import type { TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";

export const FIXTURE_KEEPER_PROPOSAL_SOURCE =
  "7b77d65d-18f9-4a15-ab82-8f48dfab6b01";
export const FIXTURE_KEEPER_DECISION = "Use the shared project reader.";
/** A completed private reply and actual scoped tracker source, never a model call. */
export async function seedKeeperProposalSource(
  h: TestHearth,
  drafts: KeeperProposalDraft[] = [
    {
      title: "Record a decision",
      detail: "Review before recording.",
      action: {
        kind: "record-decision",
        beadId: "alpha-epic",
        decision: FIXTURE_KEEPER_DECISION,
      },
    },
    {
      title: "A dismissible decision",
      detail: "Discard this suggestion.",
      action: {
        kind: "record-decision",
        beadId: "alpha-epic",
        decision: "Do not execute this.",
      },
    },
  ],
  sourceRequestId = FIXTURE_KEEPER_PROPOSAL_SOURCE,
) {
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );
  h.bd.answer = (args) =>
    args[0] === "export"
      ? {
          status: 0,
          stdout: [...h.bd.issues.values()]
            .map((row) => JSON.stringify(row))
            .join("\n"),
          stderr: "",
        }
      : undefined;
  h.bd.issues.set("alpha-epic", {
    id: "alpha-epic",
    title: "Actual project epic",
    issue_type: "epic",
    status: "open",
    priority: 2,
    labels: ["project:alpha"],
    created_at: "2026-10-21T00:00:00.000Z",
    updated_at: "2026-10-21T00:00:00.000Z",
  });
  const store = createConversationStore(h.home);
  let state = store.read(FIXTURE_PROJECT_ID);
  const readyDeadline = Date.now() + 3000;
  while (
    state.turns.some((turn) =>
      ["accepted", "running", "cancelling"].includes(turn.phase),
    )
  ) {
    if (Date.now() >= readyDeadline)
      throw new Error(
        "A previous fixture conversation did not settle before proposal preparation.",
      );
    await Bun.sleep(5);
    state = store.read(FIXTURE_PROJECT_ID);
  }
  if (!state.turns.some((turn) => turn.requestId === sourceRequestId)) {
    const owner = randomUUID();
    await store.accept(FIXTURE_PROJECT_ID, {
      requestId: sourceRequestId,
      expectedRevision: state.revision,
      text: "Propose decisions",
      about: [],
    });
    await store.start(FIXTURE_PROJECT_ID, sourceRequestId, owner);
    await store.append(FIXTURE_PROJECT_ID, sourceRequestId, owner, {
      kind: "identity",
      ...(state.binding ?? {
        provider: "claude",
        sessionId: randomUUID(),
        version: "fixture",
      }),
    });
    await store.append(FIXTURE_PROJECT_ID, sourceRequestId, owner, {
      kind: "text",
      text: JSON.stringify({
        kind: "keeper.proposals.v1",
        message: "These are suggestions only.",
        proposals: drafts,
      }),
    });
    await store.finish(
      FIXTURE_PROJECT_ID,
      sourceRequestId,
      owner,
      "completed",
      null,
    );
    state = store.read(FIXTURE_PROJECT_ID);
  }
  return keeperProposals(state);
}
