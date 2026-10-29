import { afterEach, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  projectCouncilHistorySchema,
  projectCouncilMetadata,
  projectCouncilOriginalReadSchema,
  projectCouncilReceiptSchema,
  projectCouncilSourceChoiceSchema,
  type ProjectCouncilOriginal,
} from "../../types/project-council";
import {
  projectCouncilRunReadSchema,
  type ProjectCouncilRunRead,
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
import {
  createProjectCouncilOwner,
  type ProjectCouncilTransportInput,
} from "../../apps/desktop/src/use-project-council";
import { projectCouncilProfilesSchema } from "../../apps/desktop/src/project-council-transport";
import { showCouncilControls } from "../../apps/desktop/src/ProjectReviews";

const projectId = "project-2b4f8e0a-76f1-4c29-972e-4aee9c216d12";
const defaultWorkspace = "C:\\workspace";
const emptyHistory = { version: 1 as const, projectId, workspace: defaultWorkspace, activeRequestId: null, total: 0, omitted: 0, items: [] };
const homes: string[] = [];
const owners = new Set<ReturnType<typeof createProjectCouncilOwner>>();
afterEach(() => {
  for (const owner of owners) owner.dispose();
  owners.clear();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

test("Council review display preserves Markdown whitespace and makes hostile controls visible", () => {
  expect(showCouncilControls("line one\r\n\tline two")).toBe("line one\r\n\tline two");
  expect(showCouncilControls("safe\u0000hidden\u200Btext")).toBe("safe<U+0000>hidden<U+200B>text");
});
function inertTransport(overrides: Partial<ProjectCouncilTransportInput> = {}) {
  return {
    profiles: async () => [],
    history: async () => emptyHistory,
    original: async () => { throw Error("No saved original exists."); },
    reserve: async () => { throw Error("unexpected reserve"); },
    retire: async () => { throw Error("unexpected retirement"); },
    commit: async () => { throw Error("unexpected commit"); },
    cancel: async () => { throw Error("unexpected cancellation"); },
    run: async () => { throw Error("unexpected run read"); },
    ...overrides,
  } satisfies ProjectCouncilTransportInput;
}

const inertProfile = {
  path: "default.json",
  title: "Inert test profile",
  id: "inert-test",
  depth: "balanced" as const,
  maxEstimatedUsd: 1,
  seats: [{ id: "reviewer", role: "Reviewer", provider: "fake", model: "deterministic", timeoutMs: 1000, maxOutputTokens: 100, estimatedCostUsd: 0 }],
  chair: { id: "chair", role: "Chair", provider: "fake", model: "deterministic", timeoutMs: 1000, maxOutputTokens: 100, estimatedCostUsd: 0 },
  readiness: [{ provider: "fake", configured: true, missing: [], models: ["deterministic"], validation: "local-configuration-only" as const }],
};

test("Council source selectors are nonempty, bounded, and closed", () => {
  expect(projectCouncilSourceChoiceSchema.safeParse({ sourceType: "text", source: "Review this" }).success).toBe(true);
  expect(projectCouncilSourceChoiceSchema.safeParse({ sourceType: "text", source: "" }).success).toBe(false);
  expect(projectCouncilSourceChoiceSchema.safeParse({ sourceType: "text", source: "Review this", path: "C:\\private" }).success).toBe(false);
});

test("profile list rejects unknown fields rather than hiding provider configuration drift", () => {
  expect(projectCouncilProfilesSchema.safeParse([{ ...inertProfile, secret: "unexpected" }]).success).toBe(false);
});

test("an active history identity absent from its scoped rows remains held", async () => {
  let commits = 0;
  const owner = createProjectCouncilOwner(projectId, "C:\\workspace", inertTransport({
    history: async () => ({ ...emptyHistory, activeRequestId: "00000000-0000-4000-8000-000000000001" }),
    commit: async () => { commits++; throw Error("unexpected commit"); },
  }));
  owners.add(owner);
  await owner.refresh();
  expect(owner.get().phase).toBe("held");
  expect(owner.get().original).toBeNull();
  expect(owner.get().error).toContain("missing from the scoped history");
  expect(commits).toBe(0);
});

test("history from another project or workspace remains held", async () => {
  const owner = createProjectCouncilOwner(projectId, defaultWorkspace, inertTransport({
    history: async () => ({ ...emptyHistory, projectId: "project-0b4f8e0a-76f1-4c29-972e-4aee9c216d12", workspace: "C:\\other-workspace" }),
  }));
  owners.add(owner);
  await owner.refresh();
  expect(owner.get().phase).toBe("held");
  expect(owner.get().history).toBeNull();
  expect(owner.get().error).toContain("different project or workspace");
});

test("a lost reserve reply stays held and cannot issue another reservation", async () => {
  let reserves = 0;
  const owner = createProjectCouncilOwner(projectId, "C:\\workspace", inertTransport({
    profiles: async () => [inertProfile],
    reserve: async () => { reserves++; throw Error("connection lost after POST"); },
  }));
  owners.add(owner);
  await owner.refresh();
  const request = {
    sourceChoice: { sourceType: "text" as const, source: "Review this exact text." },
    profileChoice: "default.json",
    maxUsd: 1,
    maxBytes: 1024,
    redactSecrets: true,
    deepDiscussion: false,
  };
  await owner.prepare(request);
  expect(reserves).toBe(1);
  expect(owner.get().phase).toBe("held");
  await owner.prepare(request);
  expect(reserves).toBe(1);
  owner.dispose();
});

test("retirement cannot run without a verified source-known reserved original", async () => {
  let retirements = 0;
  const owner = createProjectCouncilOwner(projectId, "C:\\workspace", inertTransport({
    retire: async () => { retirements++; throw Error("unexpected"); },
  }));
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
    fixture.setRetireHistory(projectCouncilHistorySchema.parse({
      version: 1,
      projectId: foreign ? "project-0b4f8e0a-76f1-4c29-972e-4aee9c216d12" : projectId,
      workspace: original.binding.workspace,
      activeRequestId: foreign ? null : original.requestId,
      total: 1,
      omitted: 0,
      items: [row],
    }));
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
  const context = buildContextPack({ kind: "stdin", text: "A private inert review fixture.", maxBytes: 1024 });
  const store = createProjectCouncilOriginalStore({ home, workspace, projectId: project });
  const reserved = await store.reservePrepared({
    binding,
    inputHash: projectCouncilInputHash({ source: context.source.locator }),
    profileChoice: profilePath,
    profile,
    providerEndpoints: providerEndpointSnapshot(profile, {}),
    context,
    listing: contextListing(context),
    options: { maxUsd: 1, maxBytes: 1024, redactSecrets: true, deepDiscussion: false },
  });
  let original: ProjectCouncilOriginal = reserved.original;
  let originalOverride: ProjectCouncilOriginal | null = null;
  const read = () => {
    const current = originalOverride ?? original;
    return projectCouncilOriginalReadSchema.parse({ metadata: projectCouncilMetadata(current), original: current });
  };
  const profileChoice = {
    path: profilePath,
    title: profile.title,
    id: profile.id,
    depth: profile.depth,
    maxEstimatedUsd: profile.maxEstimatedUsd,
    seats: profile.seats,
    chair: profile.chair,
    readiness: [{ provider: "fake", configured: true, missing: [], models: ["deterministic"], validation: "local-configuration-only" as const }],
  };
  const history = () => projectCouncilHistorySchema.parse({
    version: 1,
    projectId: project,
    workspace,
    activeRequestId: original.state === "reserved" || original.state === "running" ? original.requestId : null,
    total: 1,
    omitted: 0,
    items: [{
      requestId: original.requestId,
      runId: original.runId,
      intentHash: original.intentHash,
      state: original.state,
      phase: original.state === "reserved" ? "reserved" : original.state === "dispatch-claimed" ? "unknown" : original.state,
      sourceType: "text",
      sourceName: "Pasted review text",
      profileId: profile.id,
      profileTitle: profile.title,
      depth: profile.depth,
      createdAt: original.createdAt,
      updatedAt: original.updatedAt,
    }],
  });
  const receipt = (phase: "running" | "cancelled") => projectCouncilReceiptSchema.parse({ metadata: projectCouncilMetadata(original), phase });
  let historyOverride: Awaited<ReturnType<ProjectCouncilTransportInput["history"]>> | null = null;
  let retireCalls = 0;
  let reserveCalls = 0;
  let commitCalls = 0;
  let cancelCalls = 0;
  let runReads = 0;
  let loseCommitReply = false;
  let tamperRunIdentity = false;
  let releaseReserve!: () => void;
  const reserveGate = new Promise<void>((resolve) => { releaseReserve = resolve; });
  let reserveOriginal: ProjectCouncilOriginal | null = null;
  const transport: ProjectCouncilTransportInput = {
    profiles: async () => [profileChoice],
    history: async () => historyOverride ?? history(),
    original: async () => read(),
    reserve: async () => {
      reserveCalls++;
      await reserveGate;
      if (!reserveOriginal) throw Error("reserve original was not prepared");
      originalOverride = reserveOriginal;
      return { metadata: projectCouncilMetadata(reserveOriginal), created: true };
    },
    retire: async () => {
      retireCalls++;
      original = { ...original, state: "retired", updatedAt: new Date().toISOString(), dispatchClaimedAt: null };
      return projectCouncilReceiptSchema.parse({ metadata: projectCouncilMetadata(original), phase: "retired" });
    },
    commit: async () => {
      commitCalls++;
      if (loseCommitReply) throw Error("commit reply was lost");
      original = { ...original, state: "running", updatedAt: new Date().toISOString(), dispatchClaimedAt: new Date().toISOString() };
      return receipt("running");
    },
    cancel: async () => {
      cancelCalls++;
      original = { ...original, state: "cancelled", updatedAt: new Date().toISOString() };
      return receipt("cancelled");
    },
    run: async () => {
      runReads++;
      const phase = original.state === "cancelled" ? "cancelled" : "running";
      const status = phase;
      const rawAnswer = {
        version: 1,
        provenance: { version: 1, requestId: original.requestId, intentHash: original.intentHash, runId: original.runId, projectId: project, workspace, catalogRevision: 1, scopeHash: original.binding.scopeHash },
        receipt: receipt(phase),
        job: { runId: original.runId, status, startedAt: original.createdAt, updatedAt: original.updatedAt, events: [], profile: original.profile },
        verdictCommentPreview: null,
      };
      const answer: ProjectCouncilRunRead = projectCouncilRunReadSchema.parse(tamperRunIdentity
        ? { ...rawAnswer, provenance: { ...rawAnswer.provenance, requestId: "00000000-0000-4000-8000-000000000000" } }
        : rawAnswer);
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
    counts: () => ({ commitCalls, cancelCalls, runReads }),
    retireCount: () => retireCalls,
    reserveCount: () => reserveCalls,
    setRetireHistory(value: Awaited<ReturnType<ProjectCouncilTransportInput["history"]>>) { historyOverride = value; },
    loseCommitReply(value: boolean) { loseCommitReply = value; },
    tamperRunIdentity(value: boolean) { tamperRunIdentity = value; },
    async markCompleteForNewDraft() {
      original = { ...original, state: "completed", updatedAt: new Date().toISOString(), dispatchClaimedAt: new Date().toISOString() };
      await owner.refresh();
    },
    releaseLateReserve() {
      reserveOriginal = { ...original, state: "reserved", updatedAt: new Date().toISOString(), dispatchClaimedAt: null };
      releaseReserve();
    },
  };
}

test("one explicit Convene follows the owned run and cancellation remains readback-confirmed", async () => {
  const fixture = await councilFixture();
  expect(fixture.owner.get().phase).toBe("reserved");
  await fixture.owner.convene(fixture.original().requestId, fixture.original().intentHash);
  expect(fixture.counts()).toEqual({ commitCalls: 1, cancelCalls: 0, runReads: 1 });
  expect(fixture.owner.get().phase).toBe("running");
  await fixture.owner.cancel(fixture.original().requestId, fixture.original().intentHash);
  expect(fixture.counts()).toEqual({ commitCalls: 1, cancelCalls: 1, runReads: 2 });
  expect(fixture.owner.get().phase).toBe("cancelled");
  expect(fixture.owner.get().run?.receipt.phase).toBe("cancelled");
  expect(fixture.original().state).toBe("cancelled");
  fixture.owner.dispose();
});

test("a lost Convene response remains held and never sends a second commit", async () => {
  const fixture = await councilFixture();
  fixture.loseCommitReply(true);
  await fixture.owner.convene(fixture.original().requestId, fixture.original().intentHash);
  expect(fixture.counts()).toEqual({ commitCalls: 1, cancelCalls: 0, runReads: 0 });
  expect(fixture.owner.get().phase).toBe("held");
  await fixture.owner.convene(fixture.original().requestId, fixture.original().intentHash);
  expect(fixture.counts().commitCalls).toBe(1);
  fixture.owner.dispose();
});

test("a foreign run identity is rejected and never grants a second Convene", async () => {
  const fixture = await councilFixture();
  fixture.tamperRunIdentity(true);
  await fixture.owner.convene(fixture.original().requestId, fixture.original().intentHash);
  expect(fixture.counts()).toEqual({ commitCalls: 1, cancelCalls: 0, runReads: 1 });
  expect(fixture.owner.get().phase).toBe("held");
  expect(fixture.owner.get().run).toBeNull();
  await fixture.owner.convene(fixture.original().requestId, fixture.original().intentHash);
  expect(fixture.counts().commitCalls).toBe(1);
  fixture.owner.dispose();
});

test("rendered effect identity must match the currently verified original", async () => {
  const fixture = await councilFixture();
  const correct = fixture.original();
  await fixture.owner.convene("00000000-0000-4000-8000-000000000001", correct.intentHash);
  await fixture.owner.convene(correct.requestId, "b".repeat(64));
  await fixture.owner.retire("00000000-0000-4000-8000-000000000001", correct.intentHash);
  await fixture.owner.cancel(correct.requestId, "b".repeat(64));
  expect(fixture.counts()).toEqual({ commitCalls: 0, cancelCalls: 0, runReads: 0 });
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
  expect(fixture.counts()).toEqual({ commitCalls: 0, cancelCalls: 0, runReads: 0 });
  fixture.owner.dispose();
});
