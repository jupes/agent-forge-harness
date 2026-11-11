import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { InboxSourceRead } from "../../apps/desktop/src/inbox-bead-shift-source";
import {
  type InboxCouncilProjectionInput,
  projectInboxCouncilSource,
} from "../../apps/desktop/src/inbox-council-source";
import {
  councilVerdictInput,
  verifyProjectCouncilOriginalRead,
} from "../../apps/desktop/src/project-council-proof";
import {
  type ProjectCouncilOriginal,
  projectCouncilMetadata,
  projectCouncilOriginalReadSchema,
} from "../../types/project-council";
import { projectCouncilRunReadSchema } from "../../types/project-council-run-read";
import { buildContextPackFromParts, contextListing } from "../council/context";
import {
  projectCouncilInputHash,
  projectCouncilIntentHash,
  projectCouncilProfileHash,
  projectCouncilRunId,
} from "../council/project-original-store";
import { parseCouncilProfileJson } from "../council/types";
import { councilVerdictComment } from "../council/verdict-comment";
import { projectBeadsPageSchema } from "../projects/beads-protocol";

const scope = {
  projectId: "project-015821b4-4b38-4bf3-9326-71ce9c09ff46",
  workspace: "/fixture/workspace",
};
const requestId = "0f67921f-a292-4e9a-9f63-d4b9d4c71189";
const at = "2026-11-11T00:00:00.000Z";
const finished = "2026-11-11T00:01:00.000Z";
const beadId = "fixture-task";
function read<T>(raw: T): InboxSourceRead<T> {
  return {
    raw,
    lastVerified: null,
    coverage: {
      started: true,
      settled: true,
      complete: true,
      fresh: true,
      error: null,
    },
  };
}
function fixture(): InboxCouncilProjectionInput {
  const seat = {
    id: "reviewer",
    role: "Reviewer",
    provider: "fake",
    model: "deterministic",
    timeoutMs: 1000,
    maxOutputTokens: 100,
    estimatedCostUsd: 0,
  };
  const parsed = parseCouncilProfileJson(
    JSON.stringify({
      schemaVersion: 1,
      id: "fixture",
      title: "PRIVATE_PROFILE_TITLE",
      depth: "quick",
      minQuorum: 2,
      minPeerBallots: 0,
      maxEstimatedUsd: 0,
      seats: [seat, { ...seat, id: "second-reviewer" }],
      chair: { ...seat, id: "chair", role: "Chair" },
    }),
  );
  if (!parsed.ok) throw Error("Invalid inert profile fixture");
  const profile = parsed.value;
  const content = "PRIVATE_CONTEXT_BODY";
  const context = buildContextPackFromParts({
    kind: "bead",
    displayName: beadId,
    locator: beadId,
    maxBytes: 1024,
    parts: [{ label: "Fixture bead", chunks: [{ text: content }] }],
  });
  context.createdAt = at;
  const original: ProjectCouncilOriginal = {
    requestId,
    runId: projectCouncilRunId(requestId),
    inputHash: projectCouncilInputHash({ sourceType: "bead", source: beadId }),
    intentHash: "0".repeat(64),
    binding: {
      ...scope,
      catalogRevision: 3,
      scopeHash: createHash("sha256").update("fixture-scope").digest("hex"),
      profileHash: projectCouncilProfileHash(profile),
    },
    profileChoice: "fixture.json",
    profile,
    providerEndpoints: [{ provider: "fake", transport: "fake", baseUrl: null }],
    context,
    listing: contextListing(context),
    options: {
      maxUsd: 1,
      maxBytes: 1024,
      redactSecrets: true,
      deepDiscussion: false,
    },
    state: "completed",
    createdAt: at,
    updatedAt: finished,
    dispatchClaimedAt: at,
  };
  original.intentHash = projectCouncilIntentHash(original);
  const originalRead = projectCouncilOriginalReadSchema.parse({
    metadata: projectCouncilMetadata(original),
    original,
  });
  const event = {
    schemaVersion: 1,
    runId: original.runId,
    seq: 1,
    at: finished,
    type: "run.completed",
    payload: { verdict: "pass", findingCount: 0 },
  };
  const job = {
    runId: original.runId,
    status: "completed",
    startedAt: at,
    updatedAt: finished,
    events: [event],
    profile,
    run: {
      schemaVersion: 1,
      runId: original.runId,
      status: "completed",
      startedAt: at,
      finishedAt: finished,
      profile,
      context: {
        source: original.context.source,
        contentHash: original.context.contentHash,
        byteLength: original.context.byteLength,
        truncated: false,
        redactions: [],
        evidence: original.context.evidence,
      },
      estimatedCostUsd: 0,
      actualCostUsd: 0,
      usageEstimatedCostUsd: 0,
      accountedCostUsd: 0,
      costIsEstimate: false,
      limitations: [],
      records: [],
      aggregatedFindings: [],
      chair: {
        verdict: "pass",
        summary: "PRIVATE_CHAIR_SUMMARY",
        recommendations: [],
        consensusFindingKeys: [],
        dissentFindingKeys: [],
      },
      failures: [],
      events: [event],
    },
  };
  const result = projectCouncilRunReadSchema.parse({
    version: 1,
    provenance: {
      version: 1,
      requestId,
      intentHash: original.intentHash,
      runId: original.runId,
      ...scope,
      catalogRevision: original.binding.catalogRevision,
      scopeHash: original.binding.scopeHash,
    },
    receipt: { metadata: originalRead.metadata, phase: "completed" },
    job,
    verdictCommentPreview: null,
  });
  const ended = result.job;
  if (!ended?.run?.chair) throw Error("Missing completed fixture job");
  const comment = councilVerdictComment({
    runId: ended.runId,
    status: ended.status,
    run: councilVerdictInput(ended.run),
  });
  if (!comment) throw Error("Missing canonical fixture comment");
  result.verdictCommentPreview = comment;
  const bead = projectBeadsPageSchema.parse({
    ...scope,
    asOf: finished,
    complete: true,
    problems: [],
    dependencies: [],
    beads: [
      {
        id: beadId,
        title: "PRIVATE_BEAD_TITLE",
        type: "task",
        status: "in_progress",
        priority: 2,
        parent: null,
        assignee: null,
        owner: null,
        labels: [],
        createdAt: at,
        updatedAt: finished,
        due: null,
        description: "",
        acceptanceCriteria: "",
        estimate: null,
        spent: null,
        ready: false,
        blocked: false,
        blockers: [],
        unavailableBlockers: 0,
        queue: "review",
        smith: null,
        comments: [
          { body: comment, author: "PRIVATE_AUTHOR", createdAt: finished },
        ],
        commentsComplete: true,
        detailsLoaded: true,
      },
    ],
  });
  return {
    scope: { ...scope },
    requestId,
    sourceGeneration: 7,
    catalogRevision: 3,
    original: read(originalRead),
    result: read(result),
    bead: read(bead),
  };
}

test("the inert completed fixture satisfies actual original hash and strict public result/comment contracts", async () => {
  const input = fixture();
  const saved = await verifyProjectCouncilOriginalRead(
    input.original.raw,
    scope.projectId,
    scope.workspace,
    requestId,
  );
  const result = projectCouncilRunReadSchema.parse(input.result.raw);
  const bead = projectBeadsPageSchema.parse(input.bead.raw);
  expect(saved.original.runId).toBe(projectCouncilRunId(requestId));
  expect(result.receipt.metadata.intentHash).toBe(saved.original.intentHash);
  const preview = result.verdictCommentPreview;
  if (preview === null) throw Error("Missing fixture preview");
  expect(bead.beads[0]?.comments[0]?.body).toBe(preview);
});

test("one exact current completed-bead result and canonical comment produce an unresolved posted fact", async () => {
  const result = await projectInboxCouncilSource(fixture());
  expect(result.facts).toHaveLength(1);
  expect(result).toMatchObject({
    scope,
    requestId,
    sourceGeneration: 7,
    catalogRevision: 3,
    status: "verified-posted",
    coverage: { complete: true, fresh: true },
    diagnostics: [],
  });
  expect(result.facts[0]).toMatchObject({
    ...scope,
    sourceKind: "council-verdict",
    status: "informational",
    resolved: false,
    fresh: true,
    complete: true,
    outcome: "pass",
    findings: { blocker: 0, high: 0, medium: 0, low: 0 },
    sourceIdentity: {
      requestId,
      runId: projectCouncilRunId(requestId),
      beadId,
    },
  });
  for (const privateValue of [
    "PRIVATE_CONTEXT_BODY",
    "PRIVATE_PROFILE_TITLE",
    "PRIVATE_CHAIR_SUMMARY",
    "PRIVATE_BEAD_TITLE",
    "PRIVATE_AUTHOR",
    "review: COUNCIL",
  ])
    expect(JSON.stringify(result)).not.toContain(privateValue);
});

function values(input: InboxCouncilProjectionInput) {
  const original = projectCouncilOriginalReadSchema.parse(input.original.raw);
  const result = projectCouncilRunReadSchema.parse(input.result.raw);
  const bead = projectBeadsPageSchema.parse(input.bead.raw);
  input.original.raw = original;
  input.result.raw = result;
  input.bead.raw = bead;
  return { original, result, bead };
}
type Data = ReturnType<typeof values>;
function retain(input: InboxCouncilProjectionInput, prior = fixture()): Data {
  const data = values(prior);
  input.original.lastVerified = data.original;
  input.result.lastVerified = data.result;
  input.bead.lastVerified = data.bead;
  return data;
}
function completed(data: Data) {
  const job = data.result.job;
  if (!job?.run) throw Error("Missing fixture completed result");
  return { job, run: job.run };
}
function refreshComment(data: Data) {
  const { job, run } = completed(data);
  if (!run.chair) throw Error("Missing fixture chair");
  const body = councilVerdictComment({
    runId: job.runId,
    status: job.status,
    run: councilVerdictInput(run),
  });
  const comment = data.bead.beads[0]?.comments[0];
  if (!body || !comment) throw Error("Missing fixture comment");
  data.result.verdictCommentPreview = body;
  comment.body = body;
}

test("identity is canonical while UI/read observations do not revise the immutable source", async () => {
  const input = fixture(),
    data = values(input);
  const first = (await projectInboxCouncilSource(input)).facts[0];
  const tuple = [
    "inbox-source-v1",
    scope.workspace,
    scope.projectId,
    "council-verdict",
    ["council", beadId, requestId, projectCouncilRunId(requestId)],
  ];
  expect(first?.stableItemId).toBe(
    `sha256:${createHash("sha256").update(JSON.stringify(tuple)).digest("hex")}`,
  );
  data.bead.asOf = "2026-11-12T00:00:00.000Z";
  data.bead.beads[0]!.title = "Changed UI title";
  data.bead.beads[0]!.comments.push({
    body: "Unrelated note",
    author: "Someone",
    createdAt: at,
  });
  input.sourceGeneration++;
  input.catalogRevision++;
  const observed = (await projectInboxCouncilSource(input)).facts[0];
  expect(observed?.stableItemId).toBe(first?.stableItemId);
  expect(observed?.sourceRevision).toBe(first?.sourceRevision);
  data.bead.beads[0]!.comments[0]!.author = "Changed private author";
  const changed = (await projectInboxCouncilSource(input)).facts[0];
  expect(changed?.stableItemId).toBe(first?.stableItemId);
  expect(changed?.sourceRevision).not.toBe(first?.sourceRevision);
  expect(JSON.stringify(changed)).not.toContain("Changed private author");
});

test("scope, original hash, profile, published context and complete metadata must all join", async () => {
  for (const corrupt of [
    (data: Data) => {
      data.original.original.context.evidence[0]!.content =
        "PRIVATE_CHANGED_CONTEXT";
    },
    (data: Data) => {
      data.result.provenance.scopeHash = "0".repeat(64);
    },
    (data: Data) => {
      data.result.provenance.catalogRevision++;
    },
    (data: Data) => {
      data.result.receipt.metadata.updatedAt = at;
    },
    (data: Data) => {
      const { job, run } = completed(data);
      if (job.profile) job.profile.title = "PRIVATE_CHANGED_PROFILE";
      run.profile.title = "PRIVATE_CHANGED_PROFILE";
    },
    (data: Data) => {
      completed(data).run.context.contentHash = "0".repeat(64);
    },
  ]) {
    const input = fixture(),
      data = values(input);
    corrupt(data);
    const result = await projectInboxCouncilSource(input);
    expect(result.status).toBe("unverified");
    expect(result.facts).toEqual([]);
    expect(result.coverage.complete).toBe(false);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_CHANGED");
  }
  for (const patch of [
    { scope: { ...scope, workspace: "/foreign" } },
    {
      scope: {
        ...scope,
        projectId: "project-f05a117f-8d19-4906-80f0-75d72835f3e8",
      },
    },
    { requestId: "invalid" },
    { requestId: "2230bb02-1119-4c69-adad-c44116b375c1" },
    { sourceGeneration: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const result = await projectInboxCouncilSource({ ...fixture(), ...patch });
    expect(result.facts).toEqual([]);
    expect(result.coverage.fresh).toBe(false);
  }
});

test("current comment presence needs loaded complete scope and no run-specific contradiction", async () => {
  for (const corrupt of [
    (data: Data) => {
      data.bead.beads[0]!.comments = [];
    },
    (data: Data) => {
      data.bead.beads[0]!.comments.push({
        ...data.bead.beads[0]!.comments[0]!,
      });
    },
    (data: Data) => {
      const row = data.bead.beads[0]!;
      row.comments.push({
        ...row.comments[0]!,
        body: `${row.comments[0]!.body} PRIVATE_CONTRADICTION`,
      });
    },
    (data: Data) => {
      data.bead.beads[0]!.commentsComplete = false;
    },
    (data: Data) => {
      data.bead.beads[0]!.detailsLoaded = false;
    },
    (data: Data) => {
      data.bead.workspace = "/foreign";
    },
    (data: Data) => {
      data.bead.problems = ["PRIVATE_SOURCE_PROBLEM"];
    },
    (data: Data) => {
      data.result.verdictCommentPreview = "PRIVATE_WRONG_PREVIEW";
    },
  ]) {
    const input = fixture(),
      data = values(input);
    corrupt(data);
    const result = await projectInboxCouncilSource(input);
    expect(result.facts).toEqual([]);
    expect(result.coverage).toMatchObject({ complete: false, fresh: false });
    expect(result.diagnostics).toHaveLength(1);
    retain(input);
    const retained = await projectInboxCouncilSource(input);
    expect(retained.facts[0]).toMatchObject({
      fresh: false,
      complete: false,
      resolved: false,
    });
    expect(JSON.stringify(retained)).not.toContain("PRIVATE_");
  }
});

test("every source coverage gap needs an independently complete prior triple", async () => {
  for (const name of ["original", "result", "bead"] as const) {
    for (const patch of [
      { started: false },
      { settled: false },
      { complete: false },
      { fresh: false },
      { error: "PRIVATE_SOURCE_ERROR" },
    ]) {
      const input = fixture();
      input[name].coverage = { ...input[name].coverage, ...patch };
      const missing = await projectInboxCouncilSource(input);
      expect(missing.facts).toEqual([]);
      expect(missing.coverage.complete).toBe(false);
      retain(input);
      const held = await projectInboxCouncilSource(input);
      expect(held.facts).toHaveLength(1);
      expect(held.facts[0]).toMatchObject({
        fresh: false,
        complete: false,
        resolved: false,
      });
      expect(JSON.stringify(held)).not.toContain("PRIVATE_SOURCE_ERROR");
    }
    const input = fixture();
    retain(input);
    input[name].lastVerified = null;
    input.result.coverage.error = "Unavailable";
    expect((await projectInboxCouncilSource(input)).facts).toEqual([]);
  }
});

test("non-posted classifications are explicit and cannot become verified empty or Done", async () => {
  for (const phase of [
    "reserved",
    "running",
    "failed",
    "cancelled",
    "retired",
    "unknown",
  ] as const) {
    const input = fixture(),
      data = values(input);
    data.original.original.state =
      phase === "unknown" ? "dispatch-claimed" : phase;
    data.original.original.dispatchClaimedAt =
      phase === "reserved" || phase === "retired" ? null : at;
    data.original.metadata = projectCouncilMetadata(data.original.original);
    data.result.receipt = { metadata: data.original.metadata, phase };
    data.result.verdictCommentPreview = null;
    data.result.job =
      phase === "running"
        ? {
            runId: data.original.original.runId,
            status: "running",
            startedAt: at,
            updatedAt: at,
            events: [],
          }
        : null;
    const result = await projectInboxCouncilSource(input);
    expect(result.status).toBe(
      phase === "unknown"
        ? "unverified"
        : phase === "reserved" || phase === "running"
          ? "pending-result"
          : "no-completed-verdict",
    );
    expect(result.facts).toEqual([]);
    expect(result.coverage).toMatchObject({ complete: false, fresh: false });
    retain(input);
    expect((await projectInboxCouncilSource(input)).facts[0]?.fresh).toBe(
      false,
    );
  }
  const input = fixture(),
    data = values(input);
  data.original.original.context.source = {
    kind: "stdin",
    displayName: "Input",
    locator: "stdin",
  };
  data.original.original.intentHash = projectCouncilIntentHash(
    data.original.original,
  );
  data.original.metadata = projectCouncilMetadata(data.original.original);
  expect((await projectInboxCouncilSource(input)).status).toBe("unverified");
  const { run } = completed(data);
  run.context.source = data.original.original.context.source;
  data.result.provenance.intentHash = data.original.original.intentHash;
  data.result.receipt.metadata = data.original.metadata;
  data.result.verdictCommentPreview = null;
  const result = await projectInboxCouncilSource(input);
  expect(result.status).toBe("not-bead");
  expect(result.coverage.complete).toBe(false);
  expect(result.facts).toEqual([]);
});

test("custom profiles, nested current/prior DTOs and caller provenance are captured before awaits", async () => {
  const reference = (await projectInboxCouncilSource(fixture())).facts[0];
  for (const prior of [false, true]) {
    const input = fixture();
    const data = prior ? retain(input) : values(input);
    if (prior) input.result.coverage.error = "Unavailable";
    const pending = projectInboxCouncilSource(input);
    let result: Awaited<ReturnType<typeof projectInboxCouncilSource>>;
    try {
      data.original.original.profile.seats[0]!.model = "PRIVATE_MUTATED_MODEL";
      data.original.original.context.evidence[0]!.content =
        "PRIVATE_MUTATED_CONTENT";
      completed(data).run.chair!.summary = "PRIVATE_MUTATED_SUMMARY";
      data.bead.beads[0]!.comments[0]!.body = "PRIVATE_MUTATED_COMMENT";
      input.scope.workspace = "/foreign";
      input.sourceGeneration = 99;
      input.catalogRevision = 99;
      input.requestId = "changed";
      input.bead.coverage.error = "PRIVATE_MUTATED_ERROR";
    } finally {
      result = await pending;
    }
    expect(result).toMatchObject({
      scope,
      requestId,
      sourceGeneration: 7,
      catalogRevision: 3,
    });
    expect(result.facts[0]?.sourceRevision).toBe(reference?.sourceRevision);
    expect(result.facts[0]).toMatchObject({ fresh: !prior, resolved: false });
    expect(Object.isFrozen(result.facts[0]?.findings)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_MUTATED");
  }
});

test("actual finding semantics revise the source while raw finding text stays private", async () => {
  const input = fixture(),
    data = values(input);
  const { run, job } = completed(data);
  run.aggregatedFindings.push({
    key: "F1",
    title: "PRIVATE_FINDING_TITLE",
    claim: "PRIVATE_FINDING_CLAIM",
    consequence: "PRIVATE_FINDING_CONSEQUENCE",
    severity: "low",
    evidenceIds: [data.original.original.context.evidence[0]!.id],
    confidence: 1,
    proposedBy: 1,
    support: 1,
    oppose: 0,
    uncertain: 0,
    contested: false,
    reviewed: true,
    consensusEligible: true,
    resolution: "consensus",
    independentProposers: 1,
    severityDisputed: false,
    rationales: [],
  });
  for (const event of [...job.events, ...run.events])
    if (event.type === "run.completed") event.payload.findingCount = 1;
  run.aggregatedFindings[0]!.rationales = [
    {
      reviewerLabel: "PRIVATE_PEER",
      stance: "support",
      reason: "PRIVATE_REASON",
      evidenceIds: [],
      suggestedSeverity: undefined,
    },
    {
      reviewerLabel: "PRIVATE_OTHER_PEER",
      stance: "support",
      reason: "PRIVATE_OTHER_REASON",
      evidenceIds: [],
      suggestedSeverity: "low",
    },
  ];
  const normalized = councilVerdictInput(run).aggregatedFindings[0]!;
  expect(Object.hasOwn(normalized.rationales[0]!, "suggestedSeverity")).toBe(
    false,
  );
  expect(normalized.rationales[1]).toMatchObject({
    suggestedSeverity: "low",
    reason: "PRIVATE_OTHER_REASON",
  });
  expect(normalized.claim).toBe("PRIVATE_FINDING_CLAIM");
  refreshComment(data);
  const first = (await projectInboxCouncilSource(input)).facts[0];
  expect(first?.findings).toEqual({ blocker: 0, high: 0, medium: 0, low: 1 });
  run.aggregatedFindings[0]!.claim = "PRIVATE_CHANGED_FINDING";
  const changed = (await projectInboxCouncilSource(input)).facts[0];
  expect(changed?.stableItemId).toBe(first?.stableItemId);
  expect(changed?.sourceRevision).not.toBe(first?.sourceRevision);
  expect(JSON.stringify(changed)).not.toContain("PRIVATE_");
});
