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

const projectId = "project-2b4f8e0a-76f1-4c29-972e-4aee9c216d12";
const emptyHistory = { activeRequestId: null, total: 0, omitted: 0, items: [] };
const homes: string[] = [];
const owners = new Set<ReturnType<typeof createProjectCouncilOwner>>();
afterEach(() => {
  for (const owner of owners) owner.dispose();
  owners.clear();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true, maxRetries: 3 });
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
  await owner.retire();
  expect(retirements).toBe(0);
  owner.dispose();
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
  const read = () => projectCouncilOriginalReadSchema.parse({ metadata: projectCouncilMetadata(original), original });
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
  let commitCalls = 0;
  let cancelCalls = 0;
  let runReads = 0;
  let loseCommitReply = false;
  let tamperRunIdentity = false;
  const transport: ProjectCouncilTransportInput = {
    profiles: async () => [profileChoice],
    history: async () => history(),
    original: async () => read(),
    reserve: async () => { throw Error("unexpected reserve"); },
    retire: async () => { throw Error("unexpected retire"); },
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
    loseCommitReply(value: boolean) { loseCommitReply = value; },
    tamperRunIdentity(value: boolean) { tamperRunIdentity = value; },
  };
}

test("one explicit Convene follows the owned run and cancellation remains readback-confirmed", async () => {
  const fixture = await councilFixture();
  expect(fixture.owner.get().phase).toBe("reserved");
  await fixture.owner.convene();
  expect(fixture.counts()).toEqual({ commitCalls: 1, cancelCalls: 0, runReads: 1 });
  expect(fixture.owner.get().phase).toBe("running");
  await fixture.owner.cancel();
  expect(fixture.counts()).toEqual({ commitCalls: 1, cancelCalls: 1, runReads: 2 });
  expect(fixture.owner.get().phase).toBe("cancelled");
  expect(fixture.owner.get().run?.receipt.phase).toBe("cancelled");
  expect(fixture.original().state).toBe("cancelled");
  fixture.owner.dispose();
});

test("a lost Convene response remains held and never sends a second commit", async () => {
  const fixture = await councilFixture();
  fixture.loseCommitReply(true);
  await fixture.owner.convene();
  expect(fixture.counts()).toEqual({ commitCalls: 1, cancelCalls: 0, runReads: 0 });
  expect(fixture.owner.get().phase).toBe("held");
  await fixture.owner.convene();
  expect(fixture.counts().commitCalls).toBe(1);
  fixture.owner.dispose();
});

test("a foreign run identity is rejected and never grants a second Convene", async () => {
  const fixture = await councilFixture();
  fixture.tamperRunIdentity(true);
  await fixture.owner.convene();
  expect(fixture.counts()).toEqual({ commitCalls: 1, cancelCalls: 0, runReads: 1 });
  expect(fixture.owner.get().phase).toBe("held");
  expect(fixture.owner.get().run).toBeNull();
  await fixture.owner.convene();
  expect(fixture.counts().commitCalls).toBe(1);
  fixture.owner.dispose();
});
