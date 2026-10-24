import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BeadsIssue } from "../../types/beads";
import type { KeeperProposalDraft } from "../../types/keeper-proposal";
import { createConversationStore } from "../conversations/store";
import type { ProjectSnapshot } from "../hearth/routes/project-summaries";
import { writeOwnerOnly } from "../hearth/token";
import { projectCatalogPath } from "../projects/store";
import { projectCatalogFixture } from "../projects/testing";
import type { KeeperOperatorCall, KeeperOperatorPost } from "./operator-post";
import { createKeeperProposalService } from "./proposal-service";
import { createKeeperProposalStore } from "./proposal-store";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
async function fixture(drafts?: KeeperProposalDraft[]) {
  const home = mkdtempSync(join(tmpdir(), "keeper proposal service "));
  homes.push(home);
  const catalog = projectCatalogFixture("/served"),
    project = catalog.projects[0];
  if (!project) throw new Error("Missing project fixture");
  writeOwnerOnly(projectCatalogPath(home), JSON.stringify(catalog));
  const at = "2026-10-22T12:00:00.000Z";
  const issue = (id: string, parent?: string): BeadsIssue => ({
    id,
    title: id,
    type: parent ? "task" : "epic",
    status: "open",
    createdAt: at,
    updatedAt: at,
    labels: ["project:alpha"],
    ...(parent ? { parent } : {}),
  });
  const snapshot: ProjectSnapshot = {
    catalog,
    source: {
      workspace: "/served",
      asOf: at,
      issues: [
        issue("alpha-epic"),
        issue("alpha-1", "alpha-epic"),
        { ...issue("foreign", "alpha-epic"), labels: ["project:beta"] },
      ],
      queue: [
        {
          beadId: "alpha-epic",
          title: "Alpha epic",
          state: "proposed",
          status: "open",
          backed: true,
        },
        {
          beadId: "alpha-1",
          title: "Alpha child",
          state: "proposed",
          status: "open",
          backed: true,
        },
      ],
      sessions: [],
      sessionsComplete: true,
      runs: [],
      checkout: "/served",
      problems: [],
    },
  };
  const store = createConversationStore(home),
    requestId = randomUUID(),
    owner = randomUUID();
  await store.accept(project.id, {
    requestId,
    expectedRevision: 0,
    text: "Propose two approvals",
    about: [],
  });
  await store.start(project.id, requestId, owner);
  await store.append(project.id, requestId, owner, {
    kind: "identity",
    provider: "claude",
    sessionId: "actual-provider-session",
    version: "fixture",
  });
  await store.append(project.id, requestId, owner, {
    kind: "text",
    text: JSON.stringify({
      kind: "keeper.proposals.v1",
      message: "Review these first.",
      proposals: drafts ?? [
        {
          title: "Approve two beads",
          detail: "Only checked beads will be approved.",
          action: { kind: "approve-beads", beadIds: ["alpha-epic", "alpha-1"] },
        },
      ],
    }),
  });
  await store.finish(project.id, requestId, owner, "completed", null);
  return { home, project, snapshot };
}
const confirmed = (call: KeeperOperatorCall) => ({
  status: 200,
  body: JSON.stringify({
    ok: true,
    data:
      call.kind === "queue.move"
        ? {
            id: call.id,
            action: call.action,
            from: "proposed",
            to: "approved",
            recorded: true,
          }
        : null,
    error: null,
  }),
});

test("destination description limits are checked before consuming approval, while old source drafts remain readable and dismissible", async () => {
  const draft: KeeperProposalDraft = {
    title: "Create a child",
    detail: "Review this source draft",
    action: {
      kind: "create-beads",
      beads: [
        {
          title: "A child",
          type: "task",
          priority: 2,
          parentId: "alpha-epic",
          description: "x".repeat(5000),
        },
      ],
    },
  };
  const f = await fixture([draft]);
  let calls = 0;
  const service = createKeeperProposalService({
    home: f.home,
    root: "/served",
    load: async () => f.snapshot,
    post: async (call) => {
      calls++;
      return confirmed(call);
    },
  });
  const page = await service.read(f.project.id),
    card = page.proposals[0]!;
  expect(card.available).toBe(false);
  expect(card.destinationAvailable).toBe(true);
  expect(card.reason).toContain("4000");
  const body = {
    id: card.proposal.id,
    sourceHash: card.proposal.sourceHash,
    requestId: randomUUID(),
    expectedRevision: page.revision,
    draft,
  };
  await expect(service.approve(f.project.id, body, 12)).rejects.toThrow("4000");
  if (draft.action.kind !== "create-beads")
    throw new Error("Wrong fixture action");
  await expect(
    service.approve(
      f.project.id,
      {
        ...body,
        draft: {
          ...draft,
          action: {
            ...draft.action,
            beads: draft.action.beads.map((bead) => ({
              ...bead,
              description: "-",
            })),
          },
        },
      },
      12,
    ),
  ).rejects.toThrow("placeholder");
  expect(
    (await createKeeperProposalStore(f.home).read(f.project.id)).records,
  ).toHaveLength(0);
  const result = await service.dismiss(
    f.project.id,
    {
      id: body.id,
      sourceHash: body.sourceHash,
      requestId: body.requestId,
      expectedRevision: 0,
    },
    12,
  );
  expect(result.record.phase).toBe("dismissed");
  expect(calls).toBe(0);
  await service.close();
});

test("each selected bead is rechecked just before dispatch; an earlier approved bead does not invalidate the remaining checked work", async () => {
  const f = await fixture(),
    calls: KeeperOperatorCall[] = [];
  const service = createKeeperProposalService({
    home: f.home,
    root: "/served",
    load: async () => f.snapshot,
    post: async (call) => {
      calls.push(call);
      if (call.kind === "queue.move")
        f.snapshot.source.queue =
          f.snapshot.source.queue?.map((row) =>
            row.beadId === call.id ? { ...row, state: "approved" } : row,
          ) ?? null;
      return confirmed(call);
    },
  });
  const page = await service.read(f.project.id),
    card = page.proposals[0]!;
  const result = await service.approve(
    f.project.id,
    {
      id: card.proposal.id,
      sourceHash: card.proposal.sourceHash,
      requestId: randomUUID(),
      expectedRevision: page.revision,
      draft: card.proposal.draft,
    },
    12,
  );
  expect(result.record.phase).toBe("done");
  expect(calls).toEqual([
    { kind: "queue.move", id: "alpha-epic", action: "approve" },
    { kind: "queue.move", id: "alpha-1", action: "approve" },
  ]);
  await service.close();
});

test("scope lost during a multi-step approval stops remaining writes and retains the partial result", async () => {
  const f = await fixture(),
    calls: KeeperOperatorCall[] = [];
  const service = createKeeperProposalService({
    home: f.home,
    root: "/served",
    load: async () => f.snapshot,
    post: async (call) => {
      calls.push(call);
      f.snapshot.source.issues =
        f.snapshot.source.issues?.map((row) =>
          row.id === "alpha-1" ? { ...row, labels: ["project:beta"] } : row,
        ) ?? null;
      return confirmed(call);
    },
  });
  const page = await service.read(f.project.id),
    card = page.proposals[0]!;
  const result = await service.approve(
    f.project.id,
    {
      id: card.proposal.id,
      sourceHash: card.proposal.sourceHash,
      requestId: randomUUID(),
      expectedRevision: page.revision,
      draft: card.proposal.draft,
    },
    12,
  );
  expect(result.record.phase).toBe("failed");
  expect(result.record.message).toContain("earlier steps were confirmed");
  expect(calls).toHaveLength(1);
  await service.close();
});

test("request lookup retains a completed receipt when its source card falls outside the recent forty", async () => {
  const f = await fixture();
  const service = createKeeperProposalService({
    home: f.home,
    root: "/served",
    load: async () => f.snapshot,
    post: async (call) => confirmed(call),
  });
  const page = await service.read(f.project.id),
    card = page.proposals[0]!,
    requestId = randomUUID();
  await service.dismiss(
    f.project.id,
    {
      id: card.proposal.id,
      sourceHash: card.proposal.sourceHash,
      requestId,
      expectedRevision: page.revision,
    },
    12,
  );
  const store = createConversationStore(f.home);
  for (let index = 0; index < 6; index++) {
    const next = randomUUID(),
      owner = randomUUID();
    await store.accept(f.project.id, {
      requestId: next,
      expectedRevision: store.read(f.project.id).revision,
      text: "More suggestions",
      about: [],
    });
    await store.start(f.project.id, next, owner);
    await store.append(f.project.id, next, owner, {
      kind: "identity",
      provider: "claude",
      sessionId: "actual-provider-session",
      version: "fixture",
    });
    await store.append(f.project.id, next, owner, {
      kind: "text",
      text: JSON.stringify({
        kind: "keeper.proposals.v1",
        message: "More suggestions",
        proposals: Array.from({ length: 7 }, () => card.proposal.draft),
      }),
    });
    await store.finish(f.project.id, next, owner, "completed", null);
  }
  const result = await service.read(f.project.id, { requestId });
  expect(result.proposals).toHaveLength(40);
  expect(
    result.proposals.some((item) => item.proposal.id === card.proposal.id),
  ).toBe(false);
  expect(result.request).toMatchObject({
    requestId,
    operation: "dismiss",
    phase: "dismissed",
  });
  expect(
    (await service.read(f.project.id, { requestId: randomUUID() })).request,
  ).toBeNull();
  await service.close();
});

test("only the reviewed checked subset is dispatched once, and a receipt still reconciles after the queue changes", async () => {
  const f = await fixture(),
    calls: KeeperOperatorCall[] = [];
  const post: KeeperOperatorPost = async (call) => {
    calls.push(call);
    if (call.kind === "queue.move" && f.snapshot.source.queue)
      f.snapshot.source.queue = f.snapshot.source.queue.map((row) =>
        row.beadId === call.id ? { ...row, state: "approved" } : row,
      );
    return confirmed(call);
  };
  const service = createKeeperProposalService({
    home: f.home,
    root: "/served",
    load: async () => f.snapshot,
    post,
  });
  const initial = await service.read(f.project.id),
    card = initial.proposals[0];
  if (!card) throw new Error("Missing proposal");
  expect(card.available).toBe(true);
  expect(calls).toHaveLength(0);
  const body = {
    id: card.proposal.id,
    sourceHash: card.proposal.sourceHash,
    requestId: randomUUID(),
    expectedRevision: initial.revision,
    draft: {
      ...card.proposal.draft,
      action: { kind: "approve-beads" as const, beadIds: ["alpha-1"] },
    },
  };
  const result = await service.approve(f.project.id, body, 12);
  expect(result.record.phase).toBe("done");
  expect(calls).toEqual([
    { kind: "queue.move", id: "alpha-1", action: "approve" },
  ]);
  expect((await service.approve(f.project.id, body, 13)).record).toEqual(
    result.record,
  );
  expect(calls).toHaveLength(1);
  await service.close();
});

test("forged source or foreign edited objects are refused before dispatch; lost completion is retained without a second call", async () => {
  const f = await fixture();
  let calls = 0;
  const service = createKeeperProposalService({
    home: f.home,
    root: "/served",
    load: async () => f.snapshot,
    post: async () => {
      calls++;
      throw new Error("Synthetic lost operator response");
    },
  });
  const initial = await service.read(f.project.id),
    card = initial.proposals[0];
  if (!card) throw new Error("Missing proposal");
  const body = {
    id: card.proposal.id,
    sourceHash: card.proposal.sourceHash,
    requestId: randomUUID(),
    expectedRevision: initial.revision,
    draft: card.proposal.draft,
  };
  await expect(
    service.approve(f.project.id, { ...body, sourceHash: "b".repeat(64) }, 12),
  ).rejects.toThrow("source");
  await expect(
    service.approve(
      f.project.id,
      {
        ...body,
        draft: {
          ...body.draft,
          action: { kind: "approve-beads", beadIds: ["foreign"] },
        },
      },
      12,
    ),
  ).rejects.toThrow("scope");
  expect(calls).toBe(0);
  const unknown = await service.approve(f.project.id, body, 12);
  expect(unknown.record.phase).toBe("unknown");
  expect((await service.approve(f.project.id, body, 13)).record.phase).toBe(
    "unknown",
  );
  expect(calls).toBe(1);
  await service.close();
});
