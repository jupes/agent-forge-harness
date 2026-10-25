import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeeperProposal } from "../../types/keeper-proposal";
import type { KeeperSessionStartRequest } from "../../types/keeper-session-start";
import type { KeeperShiftStartRequest } from "../../types/keeper-shift-start";
import { writeOwnerOnly } from "../hearth/token";
import {
  createKeeperProposalStore,
  keeperProposalFile,
  keeperSessionStartHashes,
} from "./proposal-store";

const projectId = "project-a5832fa0-7a21-403b-8184-44892f0d8d86";
const sourceRequestId = "1a5832fa-7a21-403b-8184-44892f0d8d86";
const proposal: KeeperProposal = {
  id: `proposal-${sourceRequestId}-0`,
  projectId,
  sourceRequestId,
  sourceHash: "a".repeat(64),
  createdAt: "2026-10-23T04:00:00.000Z",
  draft: {
    title: "Review this session",
    detail: "Human review required",
    action: {
      kind: "start-session",
      provider: "claude",
      smith: "claude-journeyman",
      beadId: "alpha-1",
      repository: "C:/fixture/repository",
      worktree: "current",
      prompt: "Original source suggestion",
    },
  },
};
const original: KeeperSessionStartRequest = {
  sourceHash: proposal.sourceHash,
  expectedRevision: 0,
  start: {
    requestId: "b14cc7eb-3231-4930-a288-d411c5ee0426",
    smith: "claude-journeyman",
    repository: "C:/fixture/repository",
    worktree: "C:/fixture/repository",
    beadId: "alpha-1",
    launch: {
      mode: "task",
      model: "claude-sonnet-4-6",
      prompt: "  Edited full launch\n🌱\n",
      permissionMode: "plan",
      maxBudgetUsd: 2,
      attachments: [
        {
          kind: "image",
          name: "pixel.png",
          mediaType: "image/png",
          data: "iVBORw0KGgo=",
        },
      ],
      outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
    },
  },
};
const shiftSourceRequestId = "2a5832fa-7a21-403b-8184-44892f0d8d86";
const shiftProposal: KeeperProposal = {
  id: `proposal-${shiftSourceRequestId}-0`,
  projectId,
  sourceRequestId: shiftSourceRequestId,
  sourceHash: "c".repeat(64),
  createdAt: "2026-10-23T04:00:00.000Z",
  draft: {
    title: "Review a project Shift",
    detail: "Review the full bounds before starting",
    action: {
      kind: "start-shift",
      durationMinutes: 45,
      concurrency: 2,
      beadLimit: 5,
      spendLimitUsd: 8,
    },
  },
};
const shiftOriginal: KeeperShiftStartRequest = {
  sourceHash: shiftProposal.sourceHash,
  expectedRevision: 0,
  start: {
    requestId: "c14cc7eb-3231-4930-a288-d411c5ee0426",
    expectedCatalogRevision: 12,
    options: {
      for: "45m",
      concurrency: 2,
      maxBeads: 9,
      maxUsd: 12,
      repairs: 1,
      base: "main",
      epic: "cla5.5",
      smith: "claude-journeyman",
      runTimeout: "300s",
    },
  },
};
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "keeper-session-start-"));
  homes.push(home);
  return { home, store: createKeeperProposalStore(home) };
}

test("the Keeper bridge retains the established ordinary Start hash bytes", () => {
  const request = {
    ...original,
    start: {
      requestId: "b14cc7eb-3231-4930-a288-d411c5ee0426",
      smith: "claude-journeyman",
      repository: "C:/fixture/repository",
      worktree: "C:/fixture/repository",
      launch: { mode: "task" as const, model: "sonnet", prompt: "  exact\n" },
    },
  };
  // Fixed pre-bridge canonical Start fixture: no proposal, project, source or revision enters this hash.
  expect(
    keeperSessionStartHashes(projectId, proposal.id, request).startHash,
  ).toBe("27ee47ceb1838b9a198d81dd975567dbc24928463fbb88857837eeb14716f3d6");
});

test("a full reviewed session intent is durable before its effect and a restarted read restores the exact original without replay", async () => {
  const { home, store } = fixture();
  let calls = 0;
  const saved = await store.startSession(
    { projectId, proposalId: proposal.id, request: original, auditEventId: 12 },
    {
      prepare: async () => ({ proposal, workspace: "C:/fixture/repository" }),
      execute: async () => {
        calls++;
        const before = await createKeeperProposalStore(home).readSessionStart(
          projectId,
          proposal.id,
        );
        expect(before?.intent.original).toEqual(original);
        expect(before?.record).toMatchObject({
          phase: "approved",
          pending: true,
          auditEventId: 12,
        });
        expect(
          readFileSync(keeperProposalFile(home, projectId), "utf8"),
        ).toContain("iVBORw0KGgo=");
        throw new Error(
          "Synthetic interruption before Start; never expose this private body",
        );
      },
    },
  );
  expect(saved.record.phase).toBe("unknown");
  const restarted = createKeeperProposalStore(home);
  const observed = await restarted.readSessionStart(projectId, proposal.id);
  expect(observed?.intent.original).toEqual(original);
  expect(observed?.record.requestId).toBe(original.start.requestId);
  expect(JSON.stringify(observed)).not.toContain("Synthetic interruption");
  expect(calls).toBe(1);
  expect((await restarted.read(projectId)).records).toHaveLength(1);
  expect(JSON.stringify(await restarted.read(projectId))).not.toContain(
    "iVBORw0KGgo=",
  );
});

test("concurrent exact Starts share one admission, while changing any reviewed option or original identity refuses", async () => {
  const { home, store } = fixture();
  let entered = () => {};
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let preparations = 0,
    effects = 0;
  const input = {
    projectId,
    proposalId: proposal.id,
    request: original,
    auditEventId: 12,
  };
  const callbacks = {
    prepare: async () => {
      preparations++;
      return { proposal, workspace: "C:/fixture/repository" };
    },
    execute: async () => {
      effects++;
      entered();
      await gate;
      return {
        phase: "done" as const,
        message: "The original turn was accepted.",
        objects: [],
      };
    },
  };
  const first = store.startSession(input, callbacks);
  await waiting;
  try {
    const second = await createKeeperProposalStore(home).startSession(
      input,
      callbacks,
    );
    expect(second.record.requestId).toBe(original.start.requestId);
    for (const changed of [
      {
        ...original,
        start: {
          ...original.start,
          launch: { ...original.start.launch, maxBudgetUsd: 3 },
        },
      },
      {
        ...original,
        start: {
          ...original.start,
          launch: { ...original.start.launch, prompt: "Changed whitespace" },
        },
      },
      { ...original, sourceHash: "f".repeat(64) },
      { ...original, start: { ...original.start, requestId: randomUUID() } },
    ])
      await expect(
        createKeeperProposalStore(home).startSession(
          { ...input, request: changed },
          callbacks,
        ),
      ).rejects.toThrow();
    expect(preparations).toBe(1);
    expect(effects).toBe(1);
  } finally {
    release();
  }
  await first;
  await createKeeperProposalStore(home).startSession(input, callbacks);
  expect(effects).toBe(1);
});

test("the first session intent upgrades a legacy journal without losing existing reviews, and later ordinary reviews retain the private intent", async () => {
  const { home, store } = fixture();
  const legacy = { ...proposal, id: `proposal-${sourceRequestId}-1` };
  await store.dismiss({
    projectId,
    proposal: legacy,
    requestId: randomUUID(),
    expectedRevision: 0,
    draft: legacy.draft,
    auditEventId: 1,
  });
  const request = { ...original, expectedRevision: 1 };
  await store.startSession(
    { projectId, proposalId: proposal.id, request, auditEventId: 2 },
    {
      prepare: async () => ({ proposal, workspace: "C:/fixture/repository" }),
      execute: async () => ({
        phase: "done",
        message: "The original turn was accepted.",
        objects: [],
      }),
    },
  );
  const later = { ...proposal, id: `proposal-${sourceRequestId}-2` };
  await store.dismiss({
    projectId,
    proposal: later,
    requestId: randomUUID(),
    expectedRevision: 3,
    draft: later.draft,
    auditEventId: 3,
  });
  expect((await store.read(projectId)).records).toHaveLength(3);
  expect(
    (
      await createKeeperProposalStore(home).readSessionStart(
        projectId,
        proposal.id,
      )
    )?.intent.original,
  ).toEqual(request);
  const bytes = readFileSync(keeperProposalFile(home, projectId), "utf8");
  let saved: unknown;
  try {
    saved = JSON.parse(bytes);
  } catch {
    throw new Error("The upgraded journal is invalid JSON.");
  }
  expect(saved).toMatchObject({ version: 2 });
  await expect(
    store.dismiss({
      projectId,
      proposal,
      requestId: randomUUID(),
      expectedRevision: 4,
      draft: proposal.draft,
      auditEventId: 4,
    }),
  ).rejects.toThrow("already");
  expect(readFileSync(keeperProposalFile(home, projectId), "utf8")).toBe(bytes);
});

test("a Shift review saves both the compact proposal and editable full original before its one effect, then keeps unknown outcomes inert", async () => {
  const { home, store } = fixture();
  let prepares = 0,
    effects = 0;
  const input = {
    projectId,
    proposalId: shiftProposal.id,
    request: shiftOriginal,
    auditEventId: 14,
  };
  const saved = await store.startShift(input, {
    async prepare() {
      prepares++;
      return { proposal: shiftProposal, workspace: "C:/fixture/repository" };
    },
    async execute(intent) {
      effects++;
      const durable = await createKeeperProposalStore(home).readShiftStart(
        projectId,
        shiftProposal.id,
      );
      expect(durable?.intent).toEqual(intent);
      expect(durable?.intent.proposal).toEqual({
        durationMinutes: 45,
        concurrency: 2,
        beadLimit: 5,
        spendLimitUsd: 8,
      });
      expect(durable?.intent.original).toEqual(shiftOriginal);
      expect(durable?.record).toMatchObject({
        phase: "approved",
        pending: true,
        auditEventId: 14,
      });
      throw Error("Synthetic lost Shift Start response");
    },
  });
  if (!saved) throw new Error("The durable Shift Start receipt is missing.");
  expect(saved.record.phase).toBe("unknown");
  expect(saved.record.pending).toBe(false);
  expect(prepares).toBe(1);
  expect(effects).toBe(1);

  const restarted = createKeeperProposalStore(home);
  const retried = await restarted.startShift(input, {
    async prepare() {
      throw Error("Exact retry must not reread source or replay.");
    },
    async execute() {
      effects++;
      return { phase: "done", message: "Must not replay", objects: [] };
    },
  });
  if (!retried) throw new Error("The exact Shift retry lost its original.");
  expect(retried.intent).toEqual(saved.intent);
  expect(retried.record.phase).toBe("unknown");
  expect(effects).toBe(1);
  const publicPage = await restarted.read(projectId);
  expect(JSON.stringify(publicPage)).not.toContain('"shiftStarts"');
  expect(JSON.stringify(publicPage)).not.toContain('"original"');

  const changed = [
    { ...shiftOriginal, sourceHash: "f".repeat(64) },
    { ...shiftOriginal, expectedRevision: 1 },
    {
      ...shiftOriginal,
      start: {
        ...shiftOriginal.start,
        options: { ...shiftOriginal.start.options, maxUsd: 13 },
      },
    },
    {
      ...shiftOriginal,
      start: { ...shiftOriginal.start, requestId: randomUUID() },
    },
  ];
  for (const request of changed)
    await expect(
      restarted.startShift(
        { ...input, request },
        {
          async prepare() {
            prepares++;
            return {
              proposal: shiftProposal,
              workspace: "C:/fixture/repository",
            };
          },
          async execute() {
            effects++;
            return { phase: "done", message: "Must not execute", objects: [] };
          },
        },
      ),
    ).rejects.toThrow();
  expect(prepares).toBe(1);
  expect(effects).toBe(1);
});

test("version 3 preserves session and Shift originals across both admission directions and ordinary dismiss", async () => {
  const { home, store } = fixture();
  await store.startSession(
    { projectId, proposalId: proposal.id, request: original, auditEventId: 3 },
    {
      prepare: async () => ({ proposal, workspace: "C:/fixture/repository" }),
      execute: async () => ({
        phase: "done",
        message: "Original session accepted.",
        objects: [],
      }),
    },
  );
  const priorSession = await store.readSessionStart(projectId, proposal.id);
  if (!priorSession) throw new Error("The session intent was not saved.");
  const collision = {
    ...shiftOriginal,
    start: { ...shiftOriginal.start, requestId: original.start.requestId },
  };
  await expect(
    store.startShift(
      {
        projectId,
        proposalId: shiftProposal.id,
        request: collision,
        auditEventId: 4,
      },
      {
        prepare: async () => ({
          proposal: shiftProposal,
          workspace: "C:/fixture/repository",
        }),
        execute: async () => ({
          phase: "done",
          message: "Must not execute",
          objects: [],
        }),
      },
    ),
  ).rejects.toThrow();
  const request = { ...shiftOriginal, expectedRevision: 2 };
  const firstShift = await store.startShift(
    {
      projectId,
      proposalId: shiftProposal.id,
      request,
      auditEventId: 5,
    },
    {
      prepare: async () => ({
        proposal: shiftProposal,
        workspace: "C:/fixture/repository",
      }),
      execute: async () => ({
        phase: "done",
        message: "Original Shift accepted.",
        objects: [],
      }),
    },
  );
  expect(
    (
      await createKeeperProposalStore(home).readSessionStart(
        projectId,
        proposal.id,
      )
    )?.intent,
  ).toEqual(priorSession?.intent);
  expect(
    (
      await createKeeperProposalStore(home).readShiftStart(
        projectId,
        shiftProposal.id,
      )
    )?.intent.original,
  ).toEqual(request);

  const laterSessionProposal = {
    ...proposal,
    id: `proposal-${sourceRequestId}-1`,
  };
  const laterSessionRequest: KeeperSessionStartRequest = {
    ...original,
    expectedRevision: 4,
    start: { ...original.start, requestId: randomUUID() },
  };
  await store.startSession(
    {
      projectId,
      proposalId: laterSessionProposal.id,
      request: laterSessionRequest,
      auditEventId: 6,
    },
    {
      prepare: async () => ({
        proposal: laterSessionProposal,
        workspace: "C:/fixture/repository",
      }),
      execute: async () => ({
        phase: "done",
        message: "Later session accepted.",
        objects: [],
      }),
    },
  );
  const dismissedSourceId = "3a5832fa-7a21-403b-8184-44892f0d8d86";
  const dismissedProposal = {
    ...shiftProposal,
    id: `proposal-${dismissedSourceId}-0`,
    sourceRequestId: dismissedSourceId,
    sourceHash: "d".repeat(64),
  };
  await store.dismiss({
    projectId,
    proposal: dismissedProposal,
    requestId: randomUUID(),
    expectedRevision: 6,
    draft: dismissedProposal.draft,
    auditEventId: 7,
  });
  const laterShiftSourceId = "4a5832fa-7a21-403b-8184-44892f0d8d86";
  const laterShiftProposal: KeeperProposal = {
    ...shiftProposal,
    id: `proposal-${laterShiftSourceId}-0`,
    sourceRequestId: laterShiftSourceId,
    sourceHash: "e".repeat(64),
  };
  const laterShiftRequest: KeeperShiftStartRequest = {
    ...request,
    sourceHash: laterShiftProposal.sourceHash,
    expectedRevision: 7,
    start: { ...request.start, requestId: randomUUID() },
  };
  const laterShift = await store.startShift(
    {
      projectId,
      proposalId: laterShiftProposal.id,
      request: laterShiftRequest,
      auditEventId: 8,
    },
    {
      prepare: async () => ({
        proposal: laterShiftProposal,
        workspace: "C:/fixture/repository",
      }),
      execute: async () => ({
        phase: "done",
        message: "Later Shift accepted.",
        objects: [],
      }),
    },
  );
  if (!firstShift || !laterShift)
    throw new Error("A Shift original was not retained in the journal.");
  const reopened = createKeeperProposalStore(home);
  expect(
    (await reopened.readSessionStart(projectId, proposal.id))?.intent,
  ).toEqual(priorSession.intent);
  expect(
    (await reopened.readShiftStart(projectId, shiftProposal.id))?.intent,
  ).toEqual(firstShift.intent);
  expect(
    (await reopened.readSessionStart(projectId, laterSessionProposal.id))?.intent
      .original,
  ).toEqual(laterSessionRequest);
  expect(
    (await reopened.readShiftStart(projectId, laterShiftProposal.id))?.intent
      .original,
  ).toEqual(laterShiftRequest);
  const bytes = readFileSync(keeperProposalFile(home, projectId), "utf8");
  let saved: unknown;
  try {
    saved = JSON.parse(bytes);
  } catch {
    throw new Error("The upgraded Keeper journal is invalid JSON.");
  }
  expect(saved).toMatchObject({ version: 3 });
});

test("missing audit, refused preparation and corrupt or future journals preserve data and start nothing", async () => {
  const { home, store } = fixture();
  let effects = 0,
    shiftPrepares = 0;
  const input = {
    projectId,
    proposalId: proposal.id,
    request: original,
    auditEventId: 1,
  };
  const callbacks = {
    prepare: async () => {
      throw new Error("Synthetic scope refusal");
    },
    execute: async () => {
      effects++;
      return { phase: "done" as const, message: "Must not start", objects: [] };
    },
  };
  const shiftCallbacks = {
    async prepare() {
      shiftPrepares++;
      return {
        proposal: shiftProposal,
        workspace: "C:/fixture/repository",
      };
    },
    async execute() {
      effects++;
      return { phase: "done" as const, message: "Must not start", objects: [] };
    },
  };
  await expect(
    store.startSession({ ...input, auditEventId: 0 }, callbacks),
  ).rejects.toThrow("audit");
  await expect(store.startSession(input, callbacks)).rejects.toThrow(
    "scope refusal",
  );
  expect((await store.read(projectId)).records).toHaveLength(0);
  for (const bytes of [
    '{"version":3,"private":"keep"}',
    '{"version":4,"private":"keep"}',
    "{bad JSON",
  ]) {
    writeOwnerOnly(keeperProposalFile(home, projectId), bytes);
    await expect(store.startSession(input, callbacks)).rejects.toThrow("kept");
    await expect(
      store.startShift(
        {
          projectId,
          proposalId: shiftProposal.id,
          request: shiftOriginal,
          auditEventId: 2,
        },
        shiftCallbacks,
      ),
    ).rejects.toThrow("kept");
    expect(readFileSync(keeperProposalFile(home, projectId), "utf8")).toBe(
      bytes,
    );
  }
  expect(effects).toBe(0);
  expect(shiftPrepares).toBe(0);
});

test("row and byte bounds refuse overflow without evicting any original or invoking its effect", async () => {
  const full = fixture();
  const at = proposal.createdAt;
  const records = Array.from({ length: 1000 }, () => {
    const sourceRequestId = randomUUID();
    return {
      ...proposal,
      sourceRequestId,
      id: `proposal-${sourceRequestId}-0`,
      requestId: randomUUID(),
      requestHash: "b".repeat(64),
      operation: "dismiss",
      auditEventId: 1,
      phase: "dismissed",
      pending: false,
      updatedAt: at,
      message: "Dismissed.",
      objects: [],
    };
  });
  const fullPath = keeperProposalFile(full.home, projectId);
  writeOwnerOnly(
    fullPath,
    JSON.stringify({ version: 1, projectId, revision: 1000, records }),
  );
  const fullBytes = readFileSync(fullPath, "utf8");
  let prepares = 0,
    effects = 0;
  await expect(
    full.store.startSession(
      {
        projectId,
        proposalId: proposal.id,
        request: { ...original, expectedRevision: 1000 },
        auditEventId: 1,
      },
      {
        prepare: async () => {
          prepares++;
          return { proposal, workspace: "C:/fixture/repository" };
        },
        execute: async () => {
          effects++;
          return { phase: "unknown", message: "Unconfirmed.", objects: [] };
        },
      },
    ),
  ).rejects.toThrow("full");
  expect(prepares).toBe(0);
  expect(effects).toBe(0);
  expect(readFileSync(fullPath, "utf8")).toBe(fullBytes);
  expect((await full.store.read(projectId)).records).toHaveLength(1000);

  const bounded = fixture();
  const boundedPath = keeperProposalFile(bounded.home, projectId);
  const image = "AAAA".repeat(487_500);
  let originalId = "";
  for (let index = 0; index < 5; index++) {
    const sourceRequestId = randomUUID();
    const source = {
      ...proposal,
      sourceRequestId,
      id: `proposal-${sourceRequestId}-0`,
    };
    const request = {
      ...original,
      expectedRevision: index * 2,
      start: {
        ...original.start,
        requestId: randomUUID(),
        launch: {
          ...original.start.launch,
          attachments: [
            {
              kind: "image" as const,
              name: "bounded.png",
              mediaType: "image/png" as const,
              data: image,
            },
          ],
        },
      },
    };
    const before = index ? readFileSync(boundedPath, "utf8") : "";
    const admission = bounded.store.startSession(
      { projectId, proposalId: source.id, request, auditEventId: 1 },
      {
        prepare: async () => ({
          proposal: source,
          workspace: "C:/fixture/repository",
        }),
        execute: async () => {
          effects++;
          return { phase: "unknown", message: "Unconfirmed.", objects: [] };
        },
      },
    );
    if (index < 4) {
      await admission;
      if (!index) originalId = source.id;
    } else {
      await expect(admission).rejects.toThrow("full");
      expect(readFileSync(boundedPath, "utf8")).toBe(before);
    }
  }
  expect(effects).toBe(4);
  expect((await bounded.store.read(projectId)).records).toHaveLength(4);
  expect(
    (await bounded.store.readSessionStart(projectId, originalId))?.intent
      .original.start.launch.attachments?.[0],
  ).toMatchObject({ data: image });
}, 30_000);

test("a linked journal directory preserves its target and cannot admit a reviewed Start", async () => {
  const { home, store } = fixture();
  const target = fixture().home;
  const file = join(target, `keeper-${projectId}-proposals.json`);
  writeOwnerOnly(file, "Keep the linked private bytes");
  const link = join(home, "conversations");
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  let effects = 0;
  try {
    await expect(
      store.startSession(
        {
          projectId,
          proposalId: proposal.id,
          request: original,
          auditEventId: 1,
        },
        {
          prepare: async () => {
            effects++;
            return { proposal, workspace: "C:/fixture/repository" };
          },
          execute: async () => {
            effects++;
            return { phase: "done", message: "Must not run.", objects: [] };
          },
        },
      ),
    ).rejects.toThrow("linked");
    expect(effects).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("Keep the linked private bytes");
  } finally {
    rmSync(link);
  }
});
