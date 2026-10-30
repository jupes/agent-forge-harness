import { afterEach, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { showCouncilControls } from "../../apps/desktop/src/ProjectReviews";
import { projectCouncilProfilesSchema } from "../../apps/desktop/src/project-council-transport";
import {
  createProjectCouncilOwner,
  type ProjectCouncilTransportInput,
} from "../../apps/desktop/src/use-project-council";
import {
  type ProjectCouncilOriginal,
  projectCouncilHistorySchema,
  projectCouncilMetadata,
  projectCouncilOriginalReadSchema,
  projectCouncilReceiptSchema,
  projectCouncilSourceChoiceSchema,
} from "../../types/project-council";
import {
  type ProjectCouncilRunRead,
  projectCouncilRunReadSchema,
} from "../../types/project-council-run-read";
import { buildContextPack, contextListing } from "../council/context";
import {
  createProjectCouncilOriginalStore,
  projectCouncilInputHash,
  projectCouncilProfileHash,
} from "../council/project-original-store";
import { providerEndpointSnapshot } from "../council/providers";
import { parseCouncilProfileJson } from "../council/types";
import { privateTempDir } from "../hearth/testing";
import { withQueueLock } from "../scheduler/queue-lock";

const projectId = "project-2b4f8e0a-76f1-4c29-972e-4aee9c216d12";
const defaultWorkspace = "C:\\workspace";
const emptyHistory = {
  version: 1 as const,
  projectId,
  workspace: defaultWorkspace,
  activeRequestId: null,
  total: 0,
  omitted: 0,
  items: [],
};
const homes: string[] = [];
const owners = new Set<ReturnType<typeof createProjectCouncilOwner>>();
afterEach(() => {
  for (const owner of owners) owner.dispose();
  owners.clear();
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

test("Council review display preserves Markdown whitespace and makes hostile controls visible", () => {
  expect(showCouncilControls("line one\r\n\tline two")).toBe(
    "line one\r\n\tline two",
  );
  expect(showCouncilControls("safe\u0000hidden\u200Btext")).toBe(
    "safe<U+0000>hidden<U+200B>text",
  );
});
function inertTransport(overrides: Partial<ProjectCouncilTransportInput> = {}) {
  return {
    profiles: async () => [],
    history: async () => emptyHistory,
    original: async () => {
      throw Error("No saved original exists.");
    },
    reserve: async () => {
      throw Error("unexpected reserve");
    },
    retire: async () => {
      throw Error("unexpected retirement");
    },
    commit: async () => {
      throw Error("unexpected commit");
    },
    cancel: async () => {
      throw Error("unexpected cancellation");
    },
    run: async () => {
      throw Error("unexpected run read");
    },
    ...overrides,
  } satisfies ProjectCouncilTransportInput;
}

function initialHistoryFailureFixture(
  recoveredHistory: Awaited<
    ReturnType<ProjectCouncilTransportInput["history"]>
  >,
  overrides: Partial<ProjectCouncilTransportInput> = {},
  workspace = defaultWorkspace,
) {
  let reads = 0;
  let releaseInitial!: () => void;
  const blocked = new Promise<void>((resolve) => (releaseInitial = resolve));
  const owner = createProjectCouncilOwner(
    projectId,
    workspace,
    inertTransport({
      ...overrides,
      history: async () => {
        reads++;
        if (reads === 1) {
          await blocked;
          throw Error("initial history unavailable");
        }
        return recoveredHistory;
      },
    }),
  );
  owners.add(owner);
  let unsubscribe = () => {};
  const failed = new Promise<void>((resolve) => {
    unsubscribe = owner.subscribe(() => {
      if (owner.get().error === "initial history unavailable") {
        unsubscribe();
        resolve();
      }
    });
  });
  return {
    owner,
    failInitial: releaseInitial,
    failed,
    reads: () => reads,
  };
}

const inertProfile = {
  path: "default.json",
  title: "Inert test profile",
  id: "inert-test",
  depth: "balanced" as const,
  maxEstimatedUsd: 1,
  seats: [
    {
      id: "reviewer",
      role: "Reviewer",
      provider: "fake",
      model: "deterministic",
      timeoutMs: 1000,
      maxOutputTokens: 100,
      estimatedCostUsd: 0,
    },
  ],
  chair: {
    id: "chair",
    role: "Chair",
    provider: "fake",
    model: "deterministic",
    timeoutMs: 1000,
    maxOutputTokens: 100,
    estimatedCostUsd: 0,
  },
  readiness: [
    {
      provider: "fake",
      configured: true,
      missing: [],
      models: ["deterministic"],
      validation: "local-configuration-only" as const,
    },
  ],
};

test("Council source selectors are nonempty, bounded, and closed", () => {
  expect(
    projectCouncilSourceChoiceSchema.safeParse({
      sourceType: "text",
      source: "Review this",
    }).success,
  ).toBe(true);
  expect(
    projectCouncilSourceChoiceSchema.safeParse({
      sourceType: "text",
      source: "",
    }).success,
  ).toBe(false);
  expect(
    projectCouncilSourceChoiceSchema.safeParse({
      sourceType: "text",
      source: "Review this",
      path: "C:\\private",
    }).success,
  ).toBe(false);
});

test("profile list rejects unknown fields rather than hiding provider configuration drift", () => {
  expect(
    projectCouncilProfilesSchema.safeParse([
      { ...inertProfile, secret: "unexpected" },
    ]).success,
  ).toBe(false);
});

test("an active history identity absent from its scoped rows remains held", async () => {
  let commits = 0;
  const owner = createProjectCouncilOwner(
    projectId,
    "C:\\workspace",
    inertTransport({
      history: async () => ({
        ...emptyHistory,
        activeRequestId: "00000000-0000-4000-8000-000000000001",
      }),
      commit: async () => {
        commits++;
        throw Error("unexpected commit");
      },
    }),
  );
  owners.add(owner);
  await owner.refresh();
  expect(owner.get().phase).toBe("held");
  expect(owner.get().original).toBeNull();
  expect(owner.get().error).toContain("missing from the scoped history");
  expect(commits).toBe(0);
});

test("history from another project or workspace remains held", async () => {
  const owner = createProjectCouncilOwner(
    projectId,
    defaultWorkspace,
    inertTransport({
      history: async () => ({
        ...emptyHistory,
        projectId: "project-0b4f8e0a-76f1-4c29-972e-4aee9c216d12",
        workspace: "C:\\other-workspace",
      }),
    }),
  );
  owners.add(owner);
  await owner.refresh();
  expect(owner.get().phase).toBe("held");
  expect(owner.get().history).toBeNull();
  expect(owner.get().error).toContain("different project or workspace");
});

test("explicit initial-history recovery clears its error without effects", async () => {
  let effects = 0;
  const unexpected = async () => {
    effects++;
    throw Error("unexpected Council effect");
  };
  const fixture = initialHistoryFailureFixture(emptyHistory, {
    reserve: unexpected,
    retire: unexpected,
    commit: unexpected,
    cancel: unexpected,
  });
  fixture.failInitial();
  await fixture.failed;
  expect(fixture.owner.get().phase).toBe("held");
  await fixture.owner.refresh();
  expect(fixture.owner.get().phase).toBe("ready");
  expect(fixture.owner.get().error).toBe("");
  expect(fixture.reads()).toBe(2);
  expect(effects).toBe(0);
});

test("a lost reserve reply after metadata recovery stays held and cannot reserve again", async () => {
  let reserves = 0;
  const fixture = initialHistoryFailureFixture(emptyHistory, {
      profiles: async () => [inertProfile],
      reserve: async () => {
        reserves++;
        throw Error("connection lost after POST");
      },
  });
  const { owner } = fixture;
  fixture.failInitial();
  await fixture.failed;
  expect(owner.get().phase).toBe("held");
  await owner.refresh();
  expect(owner.get().phase).toBe("ready");
  expect(owner.get().error).toBe("");
  const request = {
    sourceChoice: {
      sourceType: "text" as const,
      source: "Review this exact text.",
    },
    profileChoice: "default.json",
    maxUsd: 1,
    maxBytes: 1024,
    redactSecrets: true,
    deepDiscussion: false,
  };
  await owner.prepare(request);
  expect(reserves).toBe(1);
  expect(owner.get().phase).toBe("held");
  await owner.refresh();
  await owner.prepare(request);
  expect(reserves).toBe(1);
  owner.dispose();
});

test("initial history recovery keeps active or foreign identities held", async () => {
  const canonical = await councilFixture();
  const original = canonical.original();
  await canonical.owner.convene(original.requestId, original.intentHash);
  await canonical.owner.refresh();
  const activeHistory = canonical.owner.get().history;
  if (!activeHistory?.activeRequestId)
    throw Error("The canonical running Council fixture has no active ID.");
  const workspace = original.binding.workspace;
  canonical.owner.dispose();
  for (const recoveredHistory of [
    activeHistory,
    {
      ...emptyHistory,
      workspace,
      activeRequestId: "00000000-0000-4000-8000-000000000001",
    },
    {
      ...emptyHistory,
      workspace,
      projectId: "project-0b4f8e0a-76f1-4c29-972e-4aee9c216d12",
    },
  ]) {
    const fixture = initialHistoryFailureFixture(
      recoveredHistory,
      {},
      workspace,
    );
    fixture.failInitial();
    await fixture.failed;
    await fixture.owner.refresh();
    expect(fixture.owner.get().phase).toBe("held");
    if (recoveredHistory === activeHistory) {
      expect(fixture.owner.get().history?.activeRequestId).toBe(
        activeHistory.activeRequestId,
      );
      expect(fixture.owner.get().history?.items[0]?.phase).toBe("running");
    } else expect(fixture.owner.get().history).toBeNull();
    expect(fixture.reads()).toBe(2);
  }
});

test("retirement cannot run without a verified source-known reserved original", async () => {
  let retirements = 0;
  const owner = createProjectCouncilOwner(
    projectId,
    "C:\\workspace",
    inertTransport({
      retire: async () => {
        retirements++;
        throw Error("unexpected");
      },
    }),
  );
  owners.add(owner);
  await owner.refresh();
  await owner.retire("00000000-0000-4000-8000-000000000001", "a".repeat(64));
  expect(retirements).toBe(0);
  owner.dispose();
});

test("a verified retirement stays held when readback is foreign or still active", async () => {
  const check = async (foreign: boolean) => {
    const fixture = await councilFixture();
    const original = fixture.original();
    const row = {
      requestId: original.requestId,
      runId: original.runId,
      intentHash: original.intentHash,
      state: "retired" as const,
      phase: "retired" as const,
      sourceType: "text" as const,
      sourceName: "Pasted review text",
      profileId: original.profile.id,
      profileTitle: original.profile.title,
      depth: original.profile.depth,
      createdAt: original.createdAt,
      updatedAt: original.updatedAt,
    };
    fixture.setRetireHistory(
      projectCouncilHistorySchema.parse({
        version: 1,
        projectId: foreign
          ? "project-0b4f8e0a-76f1-4c29-972e-4aee9c216d12"
          : projectId,
        workspace: original.binding.workspace,
        activeRequestId: foreign ? null : original.requestId,
        total: 1,
        omitted: 0,
        items: [row],
      }),
    );
    await fixture.owner.retire(original.requestId, original.intentHash);
    expect(fixture.retireCount()).toBe(1);
    expect(fixture.owner.get().phase).toBe("held");
    expect(fixture.owner.get().original).toBeNull();
    await fixture.owner.prepare({
      sourceChoice: { sourceType: "text", source: "A later review." },
      profileChoice: original.profileChoice,
      maxUsd: 1,
      maxBytes: 1024,
      redactSecrets: true,
      deepDiscussion: false,
    });
    expect(fixture.reserveCount()).toBe(0);
    fixture.owner.dispose();
  };

  await check(true);
  await check(false);
});

async function councilFixture() {
  const home = privateTempDir("desktop-council-client-");
  homes.push(home);
  const workspace = join(home, "workspace");
  const project = "project-2b4f8e0a-76f1-4c29-972e-4aee9c216d12";
  const profilePath = resolve(import.meta.dir, "../../councils/default.json");
  const parsed = parseCouncilProfileJson(readFileSync(profilePath, "utf8"));
  if (!parsed.ok) throw Error("The inert Council profile fixture is invalid.");
  const profile = parsed.value;
  const binding = {
    projectId: project,
    workspace,
    catalogRevision: 1,
    scopeHash: "a".repeat(64),
    profileHash: projectCouncilProfileHash(profile),
  };
  const context = buildContextPack({
    kind: "stdin",
    text: "A private inert review fixture.",
    maxBytes: 1024,
  });
  const store = createProjectCouncilOriginalStore({
    home,
    workspace,
    projectId: project,
    withQueueLock,
  });
  const reserved = await store.reservePrepared({
    binding,
    inputHash: projectCouncilInputHash({ source: context.source.locator }),
    profileChoice: profilePath,
    profile,
    providerEndpoints: providerEndpointSnapshot(profile, {}),
    context,
    listing: contextListing(context),
    options: {
      maxUsd: 1,
      maxBytes: 1024,
      redactSecrets: true,
      deepDiscussion: false,
    },
  });
  let original: ProjectCouncilOriginal = reserved.original;
  let originalOverride: ProjectCouncilOriginal | null = null;
  let heldOriginalRead: {
    entered(): void;
    wait: Promise<void>;
    release(): void;
  } | null = null;
  let originalReads = 0;
  let historyReads = 0;
  let originalReadAborted = false;
  let failNextOriginalRead = false;
  const read = () => {
    const current = originalOverride ?? original;
    return projectCouncilOriginalReadSchema.parse({
      metadata: projectCouncilMetadata(current),
      original: current,
    });
  };
  const profileChoice = {
    path: profilePath,
    title: profile.title,
    id: profile.id,
    depth: profile.depth,
    maxEstimatedUsd: profile.maxEstimatedUsd,
    seats: profile.seats,
    chair: profile.chair,
    readiness: [
      {
        provider: "fake",
        configured: true,
        missing: [],
        models: ["deterministic"],
        validation: "local-configuration-only" as const,
      },
    ],
  };
  const history = () =>
    projectCouncilHistorySchema.parse({
      version: 1,
      projectId: project,
      workspace,
      activeRequestId:
        original.state === "reserved" || original.state === "running"
          ? original.requestId
          : null,
      total: 1,
      omitted: 0,
      items: [
        {
          requestId: original.requestId,
          runId: original.runId,
          intentHash: original.intentHash,
          state: original.state,
          phase:
            original.state === "reserved"
              ? "reserved"
              : original.state === "dispatch-claimed"
                ? "unknown"
                : original.state,
          sourceType: "text",
          sourceName: "Pasted review text",
          profileId: profile.id,
          profileTitle: profile.title,
          depth: profile.depth,
          createdAt: original.createdAt,
          updatedAt: original.updatedAt,
        },
      ],
    });
  const receipt = (phase: "running" | "cancelled") =>
    projectCouncilReceiptSchema.parse({
      metadata: projectCouncilMetadata(original),
      phase,
    });
  let historyOverride: Awaited<
    ReturnType<ProjectCouncilTransportInput["history"]>
  > | null = null;
  let retireCalls = 0;
  let reserveCalls = 0;
  let commitCalls = 0;
  let cancelCalls = 0;
  let runReads = 0;
  let loseCommitReply = false;
  let tamperRunIdentity = false;
  let releaseReserve!: () => void;
  const reserveGate = new Promise<void>((resolve) => {
    releaseReserve = resolve;
  });
  let reserveOriginal: ProjectCouncilOriginal | null = null;
  const transport: ProjectCouncilTransportInput = {
    profiles: async () => [profileChoice],
    history: async () => {
      historyReads++;
      return historyOverride ?? history();
    },
    original: async (_projectId, _requestId, signal) => {
      originalReads++;
      if (failNextOriginalRead) {
        failNextOriginalRead = false;
        throw Error("saved original read failed");
      }
      if (heldOriginalRead) {
        const gate = heldOriginalRead;
        heldOriginalRead = null;
        signal?.addEventListener("abort", () => {
          originalReadAborted = true;
        });
        gate.entered();
        await gate.wait;
      }
      return read();
    },
    reserve: async () => {
      reserveCalls++;
      await reserveGate;
      if (!reserveOriginal) throw Error("reserve original was not prepared");
      originalOverride = reserveOriginal;
      return {
        metadata: projectCouncilMetadata(reserveOriginal),
        created: true,
      };
    },
    retire: async () => {
      retireCalls++;
      original = {
        ...original,
        state: "retired",
        updatedAt: new Date().toISOString(),
        dispatchClaimedAt: null,
      };
      return projectCouncilReceiptSchema.parse({
        metadata: projectCouncilMetadata(original),
        phase: "retired",
      });
    },
    commit: async () => {
      commitCalls++;
      if (loseCommitReply) {
        original = {
          ...original,
          state: "dispatch-claimed",
          updatedAt: new Date().toISOString(),
          dispatchClaimedAt: new Date().toISOString(),
        };
        throw Error("commit reply was lost");
      }
      original = {
        ...original,
        state: "running",
        updatedAt: new Date().toISOString(),
        dispatchClaimedAt: new Date().toISOString(),
      };
      return receipt("running");
    },
    cancel: async () => {
      cancelCalls++;
      original = {
        ...original,
        state: "cancelled",
        updatedAt: new Date().toISOString(),
      };
      return receipt("cancelled");
    },
    run: async () => {
      runReads++;
      const phase = original.state === "cancelled" ? "cancelled" : "running";
      const status = phase;
      const rawAnswer = {
        version: 1,
        provenance: {
          version: 1,
          requestId: original.requestId,
          intentHash: original.intentHash,
          runId: original.runId,
          projectId: project,
          workspace,
          catalogRevision: 1,
          scopeHash: original.binding.scopeHash,
        },
        receipt: receipt(phase),
        job: {
          runId: original.runId,
          status,
          startedAt: original.createdAt,
          updatedAt: original.updatedAt,
          events: [],
          profile: original.profile,
        },
        verdictCommentPreview: null,
      };
      const answer: ProjectCouncilRunRead = projectCouncilRunReadSchema.parse(
        tamperRunIdentity
          ? {
              ...rawAnswer,
              provenance: {
                ...rawAnswer.provenance,
                requestId: "00000000-0000-4000-8000-000000000000",
              },
            }
          : rawAnswer,
      );
      return answer;
    },
  };
  const owner = createProjectCouncilOwner(project, workspace, transport);
  owners.add(owner);
  await owner.refresh();
  await owner.openSaved(original.requestId);
  return {
    owner,
    original: () => original,
    historyReads: () => historyReads,
    originalReads: () => originalReads,
    originalReadAborted: () => originalReadAborted,
    counts: () => ({ commitCalls, cancelCalls, runReads }),
    retireCount: () => retireCalls,
    reserveCount: () => reserveCalls,
    setRetireHistory(
      value: Awaited<ReturnType<ProjectCouncilTransportInput["history"]>>,
    ) {
      historyOverride = value;
    },
    holdNextOriginalRead() {
      let entered!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => (entered = resolve));
      const wait = new Promise<void>((resolve) => (release = resolve));
      heldOriginalRead = { entered, wait, release };
      return { reached, release };
    },
    failNextOriginal() {
      failNextOriginalRead = true;
    },
    markDispatchClaimed() {
      original = {
        ...original,
        state: "dispatch-claimed",
        updatedAt: new Date().toISOString(),
        dispatchClaimedAt: new Date().toISOString(),
      };
    },
    loseCommitReply(value: boolean) {
      loseCommitReply = value;
    },
    tamperRunIdentity(value: boolean) {
      tamperRunIdentity = value;
    },
    async markCompleteForNewDraft() {
      original = {
        ...original,
        state: "completed",
        updatedAt: new Date().toISOString(),
        dispatchClaimedAt: new Date().toISOString(),
      };
      await owner.refresh();
      await owner.openSaved(original.requestId);
      owner.newDraft();
    },
    releaseLateReserve() {
      reserveOriginal = {
        ...original,
        state: "reserved",
        updatedAt: new Date().toISOString(),
        dispatchClaimedAt: null,
      };
      releaseReserve();
    },
  };
}

test("one explicit Convene follows the owned run and cancellation remains readback-confirmed", async () => {
  const fixture = await councilFixture();
  expect(fixture.owner.get().phase).toBe("reserved");
  await fixture.owner.convene(
    fixture.original().requestId,
    fixture.original().intentHash,
  );
  expect(fixture.counts()).toEqual({
    commitCalls: 1,
    cancelCalls: 0,
    runReads: 1,
  });
  expect(fixture.owner.get().phase).toBe("running");
  await fixture.owner.cancel(
    fixture.original().requestId,
    fixture.original().intentHash,
  );
  expect(fixture.counts()).toEqual({
    commitCalls: 1,
    cancelCalls: 1,
    runReads: 2,
  });
  expect(fixture.owner.get().phase).toBe("cancelled");
  expect(fixture.owner.get().run?.receipt.phase).toBe("cancelled");
  expect(fixture.original().state).toBe("cancelled");
  fixture.owner.dispose();
});

test("metadata refresh waits for cancellation readback and keeps its verified terminal original", async () => {
  const fixture = await councilFixture();
  await fixture.owner.convene(
    fixture.original().requestId,
    fixture.original().intentHash,
  );
  const before = fixture.owner.get().original!.original;
  const historyReads = fixture.historyReads();
  const gate = fixture.holdNextOriginalRead();
  const cancelling = fixture.owner.cancel(before.requestId, before.intentHash);
  await gate.reached;
  await fixture.owner.refresh();
  expect(fixture.historyReads()).toBe(historyReads);
  gate.release();
  await cancelling;
  expect(fixture.historyReads()).toBe(historyReads + 1);
  expect(fixture.originalReadAborted()).toBe(false);
  expect(fixture.owner.get().phase).toBe("cancelled");
  expect(fixture.owner.get().original?.original).toMatchObject({
    requestId: before.requestId,
    runId: before.runId,
    intentHash: before.intentHash,
    context: before.context,
    options: before.options,
  });
  expect(fixture.owner.get().run?.receipt.phase).toBe("cancelled");
  fixture.owner.dispose();
});

test("metadata cannot release a held admitted original when its active row is absent", async () => {
  const fixture = await councilFixture();
  const requestId = fixture.original().requestId;
  const intentHash = fixture.original().intentHash;
  await fixture.owner.convene(requestId, intentHash);
  fixture.tamperRunIdentity(true);
  await fixture.owner.readRun();
  fixture.tamperRunIdentity(false);
  expect(fixture.owner.get().phase).toBe("held");
  expect(fixture.owner.get().run?.receipt.phase).toBe("running");
  await fixture.owner.refresh();
  expect(fixture.owner.get().phase).toBe("held");
  fixture.markDispatchClaimed();
  await fixture.owner.openSaved(requestId);
  const before = fixture.owner.get().original!.original;
  expect(before.state).toBe("dispatch-claimed");
  const reads = fixture.originalReads();
  await fixture.owner.refresh();
  expect(fixture.owner.get().phase).toBe("held");
  expect(fixture.owner.get().original?.original).toEqual(before);
  fixture.owner.newDraft();
  await fixture.owner.prepare({
    sourceChoice: { sourceType: "text", source: "A new draft." },
    profileChoice: before.profileChoice,
    maxUsd: 1,
    maxBytes: 1024,
    redactSecrets: true,
    deepDiscussion: false,
  });
  fixture.setRetireHistory(emptyHistory);
  await fixture.owner.refresh();
  fixture.owner.newDraft();
  await fixture.owner.convene(requestId, intentHash);
  expect(fixture.originalReads()).toBe(reads);
  expect(fixture.owner.get().phase).toBe("held");
  expect(fixture.owner.get().original?.original).toEqual(before);
  expect(fixture.reserveCount()).toBe(0);
  expect(fixture.counts().commitCalls).toBe(1);
  fixture.owner.dispose();
});

test("a lost Convene response remains held and never sends a second commit", async () => {
  const fixture = await councilFixture();
  fixture.loseCommitReply(true);
  await fixture.owner.convene(
    fixture.original().requestId,
    fixture.original().intentHash,
  );
  expect(fixture.counts()).toEqual({
    commitCalls: 1,
    cancelCalls: 0,
    runReads: 0,
  });
  expect(fixture.owner.get().phase).toBe("held");
  await fixture.owner.convene(
    fixture.original().requestId,
    fixture.original().intentHash,
  );
  expect(fixture.counts().commitCalls).toBe(1);
  fixture.owner.dispose();
});

test("the exact held original can be explicitly re-read after lost commit with empty history", async () => {
  const fixture = await councilFixture();
  const before = fixture.owner.get().original!.original;
  fixture.loseCommitReply(true);
  await fixture.owner.convene(before.requestId, before.intentHash);
  fixture.setRetireHistory(emptyHistory);
  const reads = fixture.originalReads();
  await fixture.owner.refresh();
  expect(fixture.owner.get().phase).toBe("held");
  expect(fixture.originalReads()).toBe(reads);
  fixture.failNextOriginal();
  await fixture.owner.openSaved(before.requestId);
  expect(fixture.originalReads()).toBe(reads + 1);
  expect(fixture.owner.get().phase).toBe("held");
  expect(fixture.owner.get().run).toBeNull();
  expect(fixture.owner.get().original?.original).toMatchObject({
    requestId: before.requestId,
    intentHash: before.intentHash,
    context: before.context,
  });
  await fixture.owner.openSaved(before.requestId);
  expect(fixture.originalReads()).toBe(reads + 2);
  expect(fixture.owner.get().original?.original).toMatchObject({
    requestId: before.requestId,
    runId: before.runId,
    intentHash: before.intentHash,
    state: "dispatch-claimed",
    context: before.context,
    options: before.options,
  });
  await fixture.owner.convene(before.requestId, before.intentHash);
  expect(fixture.counts()).toEqual({
    commitCalls: 1,
    cancelCalls: 0,
    runReads: 0,
  });
  fixture.owner.dispose();
});

test("a foreign run identity is rejected and never grants a second Convene", async () => {
  const fixture = await councilFixture();
  fixture.tamperRunIdentity(true);
  await fixture.owner.convene(
    fixture.original().requestId,
    fixture.original().intentHash,
  );
  expect(fixture.counts()).toEqual({
    commitCalls: 1,
    cancelCalls: 0,
    runReads: 1,
  });
  expect(fixture.owner.get().phase).toBe("held");
  expect(fixture.owner.get().run).toBeNull();
  await fixture.owner.convene(
    fixture.original().requestId,
    fixture.original().intentHash,
  );
  expect(fixture.counts().commitCalls).toBe(1);
  fixture.owner.dispose();
});

test("rendered effect identity must match the currently verified original", async () => {
  const fixture = await councilFixture();
  const correct = fixture.original();
  await fixture.owner.convene(
    "00000000-0000-4000-8000-000000000001",
    correct.intentHash,
  );
  await fixture.owner.convene(correct.requestId, "b".repeat(64));
  await fixture.owner.retire(
    "00000000-0000-4000-8000-000000000001",
    correct.intentHash,
  );
  await fixture.owner.cancel(correct.requestId, "b".repeat(64));
  expect(fixture.counts()).toEqual({
    commitCalls: 0,
    cancelCalls: 0,
    runReads: 0,
  });
  fixture.owner.dispose();
});

test("a late prepare reply cannot replace an explicitly reopened saved original", async () => {
  const fixture = await councilFixture();
  await fixture.markCompleteForNewDraft();
  expect(fixture.owner.get().phase).toBe("ready");
  const request = {
    sourceChoice: { sourceType: "text" as const, source: "A new draft." },
    profileChoice: fixture.original().profileChoice,
    maxUsd: 1,
    maxBytes: 1024,
    redactSecrets: true,
    deepDiscussion: false,
  };
  const pending = fixture.owner.prepare(request);
  await Promise.resolve();
  await fixture.owner.openSaved(fixture.original().requestId);
  expect(fixture.owner.get().original?.original.state).toBe("completed");
  fixture.releaseLateReserve();
  await pending;
  expect(fixture.owner.get().original?.original.state).toBe("completed");
  expect(fixture.counts()).toEqual({
    commitCalls: 0,
    cancelCalls: 0,
    runReads: 0,
  });
  fixture.owner.dispose();
});
