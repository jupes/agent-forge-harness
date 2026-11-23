import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { KeeperSessionStartRequest } from "../../../types/keeper-session-start";
import { ConversationError } from "../../conversations/error";
import { keeperProposalFile } from "../../keeper/proposal-store";
import { keeperSessionStartReceiptSchema } from "../../keeper/session-start-protocol";
import { FIXTURE_PROJECT_ID } from "../../projects/testing";
import { createSessionRegistry } from "../../sessions/registry";
import { startTestHearth } from "../testing";
import { seedKeeperProposalSource } from "./keeper-proposal-fixture";
import { seedKeeperSessionStartSource } from "./keeper-session-start-fixture";
import {
  fakeSessionRuntime,
  fixtureSessionGit,
  sessionStartFixture,
  waitOwnedTurn,
} from "./session-fixture";

test("the audited Keeper Start route binds the full edited launch, returns its private original, and exact retries never duplicate the provider", async () => {
  const fake = fakeSessionRuntime();
  const h = await startTestHearth({
    api: { sessionRuntime: fake.runtime, git: fixtureSessionGit },
  });
  try {
    const [proposal] = await seedKeeperProposalSource(h, [
      {
        title: "Review a session",
        detail: "Review before Start",
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
    if (!proposal) throw new Error("Missing proposal source");
    const path = `${h.api}/projects/${FIXTURE_PROJECT_ID}/keeper/proposals/${proposal.id}/session-start`;
    expect(
      (await fetch(path, { headers: h.headers(h.hearth.token) })).status,
    ).toBe(404);
    expect(existsSync(keeperProposalFile(h.home, FIXTURE_PROJECT_ID))).toBe(
      false,
    );
    expect(existsSync(join(h.home, "sessions"))).toBe(false);
    const body: KeeperSessionStartRequest = {
      sourceHash: proposal.sourceHash,
      expectedRevision: 0,
      start: {
        ...sessionStartFixture(h),
        beadId: "alpha-epic",
        launch: {
          mode: "task",
          model: "sonnet",
          prompt: "  Full human launch\n🌱\n",
          permissionMode: "plan",
          attachments: [
            {
              kind: "image",
              name: "pixel.png",
              mediaType: "image/png",
              data: "iVBORw0KGgo=",
            },
          ],
        },
      },
    };
    const originalPrepare = fake.runtime.prepare;
    fake.runtime.prepare = async (input) => {
      expect(h.events(["operator.action"]).at(-1)?.payload).toMatchObject({
        action: "keeper.proposal.session.start",
        target: proposal.id,
      });
      expect(existsSync(keeperProposalFile(h.home, FIXTURE_PROJECT_ID))).toBe(
        fake.prepared.length > 0,
      );
      return originalPrepare(input);
    };
    const response = await fetch(path, {
      method: "POST",
      headers: h.headers(h.hearth.token),
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    const envelope = await response.json();
    expect(envelope.ok).toBe(true);
    const receipt = keeperSessionStartReceiptSchema.parse(envelope.data);
    expect(receipt.original).toEqual(body);
    if (!receipt.session) throw new Error("No correlated session");
    await waitOwnedTurn(h, receipt.session, body.start.requestId);
    const reads = fake.prepared.length;
    const lookup = await fetch(`${path}?requestId=${body.start.requestId}`, {
      headers: h.headers(h.hearth.token),
    });
    expect(lookup.status).toBe(200);
    expect(
      keeperSessionStartReceiptSchema.parse((await lookup.json()).data).receipt
        ?.turn.phase,
    ).toBe("completed");
    const retry = await fetch(path, {
      method: "POST",
      headers: h.headers(h.hearth.token),
      body: JSON.stringify(body),
    });
    expect(retry.status).toBe(200);
    expect(fake.runs).toHaveLength(1);
    expect(fake.prepared).toHaveLength(reads);
    expect(JSON.stringify(h.events())).not.toContain(body.start.launch.prompt);
    expect(JSON.stringify(h.events())).not.toContain("iVBORw0KGgo=");
  } finally {
    await h.close();
  }
});

test("only the full strict audited Start can admit a session; stale source/revision and unsupported preparation reserve nothing", async () => {
  const fake = fakeSessionRuntime();
  const h = await startTestHearth({
    api: { sessionRuntime: fake.runtime, git: fixtureSessionGit },
  });
  try {
    const proposal = await seedKeeperSessionStartSource(h);
    const path = `${h.api}/projects/${FIXTURE_PROJECT_ID}/keeper/proposals`;
    const cards = await fetch(path, { headers: h.headers(h.hearth.token) });
    const card = (await cards.json()).data.proposals.find(
      (item: { proposal: { id: string } }) => item.proposal.id === proposal.id,
    );
    expect(card).toMatchObject({
      available: false,
      destinationAvailable: true,
    });
    expect(card.reason).toContain("session review composer");
    const body = {
      sourceHash: proposal.sourceHash,
      expectedRevision: 0,
      start: sessionStartFixture(h),
    };
    const post = (url: string, input: unknown) =>
      fetch(url, {
        method: "POST",
        headers: h.headers(h.hearth.token),
        body: JSON.stringify(input),
      });
    const small = await post(`${path}/approve`, {
      id: proposal.id,
      sourceHash: proposal.sourceHash,
      requestId: body.start.requestId,
      expectedRevision: 0,
      draft: proposal.draft,
    });
    expect(small.status).toBe(409);
    expect((await small.json()).error).toContain("complete session");
    const start = `${path}/${proposal.id}/session-start`;
    expect(
      (await post(start, { ...body, sourceHash: "f".repeat(64) })).status,
    ).toBe(409);
    expect((await post(start, { ...body, expectedRevision: 1 })).status).toBe(
      409,
    );
    expect(fake.prepared).toEqual([]);
    const audits = h.events(["operator.action"]).length;
    expect(
      (
        await post(start, {
          ...body,
          start: {
            ...body.start,
            launch: {
              ...body.start.launch,
              context: { projectId: FIXTURE_PROJECT_ID },
            },
          },
        })
      ).status,
    ).toBe(400);
    expect(h.events(["operator.action"])).toHaveLength(audits);
    fake.runtime.prepare = async () => {
      expect(h.events(["operator.action"]).at(-1)?.payload).toMatchObject({
        action: "keeper.proposal.session.start",
        target: proposal.id,
      });
      throw new ConversationError(
        409,
        "Fixture capability refuses this reviewed flag",
      );
    };
    const refused = await post(start, body);
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toContain("reviewed flag");
    expect(existsSync(keeperProposalFile(h.home, FIXTURE_PROJECT_ID))).toBe(
      false,
    );
    expect(createSessionRegistry(h.home).list(FIXTURE_PROJECT_ID)).toEqual([]);
    expect(fake.runs).toEqual([]);
    for (const query of [
      "?other=1",
      "?requestId=bad",
      `?requestId=${body.start.requestId}&requestId=${body.start.requestId}`,
    ])
      expect(
        (await fetch(start + query, { headers: h.headers(h.hearth.token) }))
          .status,
      ).toBe(400);
  } finally {
    await h.close();
  }
});
