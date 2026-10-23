import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { seedKeeperProposalSource } from "../hearth/routes/keeper-proposal-fixture";
import {
  fakeSessionRuntime,
  sessionStartFixture,
  waitOwnedTurn,
} from "../hearth/routes/session-fixture";
import { startTestHearth } from "../hearth/testing";
import { FIXTURE_PROJECT_ID } from "../projects/testing";
import { createOwnedSessionService } from "../sessions/admission";
import { canonicalSessionInput } from "../sessions/preparation";
import { createKeeperSessionStartService } from "./session-start-service";

test("the verified proposal binds the edited full Start to its original owned turn, and restart reads never dispatch", async () => {
  const h = await startTestHearth();
  const fake = fakeSessionRuntime();
  const sessions = createOwnedSessionService({
    home: h.home,
    root: h.root,
    runtime: fake.runtime,
    validateScope: async () => {},
  });
  let prepared = 0;
  const options = {
    home: h.home,
    root: h.root,
    sessions,
    prepare: async () => {
      prepared++;
    },
  };
  const service = createKeeperSessionStartService(options);
  try {
    const [proposal] = await seedKeeperProposalSource(h, [
      {
        title: "Review a session",
        detail: "Only the human starts it",
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
    ]);
    if (!proposal) throw new Error("Missing trusted proposal fixture");
    const start = {
      ...sessionStartFixture(h),
      beadId: "alpha-epic",
      launch: {
        ...sessionStartFixture(h).launch,
        prompt: "  Human edited prompt\n🌱\n",
        permissionMode: "plan" as const,
      },
    };
    const body = {
      sourceHash: proposal.sourceHash,
      expectedRevision: 0,
      start,
    };
    const receipt = await service.start(
      FIXTURE_PROJECT_ID,
      proposal.id,
      body,
      1,
    );
    expect(receipt.original).toEqual(body);
    expect(receipt.session?.requestHash).toBe(
      createHash("sha256").update(canonicalSessionInput(start)).digest("hex"),
    );
    expect(receipt.receipt?.turn.requestId).toBe(start.requestId);
    if (!receipt.session) throw new Error("No correlated session");
    await waitOwnedTurn(h, receipt.session, start.requestId);
    const restarted = createKeeperSessionStartService({
      ...options,
      prepare: async () => {
        throw new Error("A recovery read must not prepare or dispatch");
      },
    });
    const observed = await restarted.read(
      FIXTURE_PROJECT_ID,
      proposal.id,
      start.requestId,
    );
    expect(observed.receipt?.turn.phase).toBe("completed");
    expect(observed.original).toEqual(body);
    expect(fake.runs).toHaveLength(1);
    expect(prepared).toBe(1);
    await restarted.close();
  } finally {
    await service.close();
    await sessions.close();
    await h.close();
  }
});
