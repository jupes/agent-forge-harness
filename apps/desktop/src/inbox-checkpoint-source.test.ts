import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { projectCheckpointInboxContextReadSchema } from "../../../types/project-checkpoint-inbox-context";
import {
  type ProjectCheckpointReviewOriginalRead,
  projectCheckpointReviewCommentText,
  projectCheckpointReviewIntentJson,
  projectCheckpointReviewOriginalReadSchema,
} from "../../../types/project-checkpoint-reviews";
import { projectCheckpointSubmissionOriginalJson } from "../../../types/project-checkpoint-submissions";
import {
  type InboxCheckpointProjectionInput,
  projectInboxCheckpointSource,
} from "./inbox-checkpoint-source";

const target = {
  projectId: "project-12345678-1234-4234-8234-123456789abc",
  workspacePath: "/served/workspace",
  checkout: "/served/checkout",
  runSlug: "demo",
  epicId: "forge-demo",
  beadId: "forge-demo.1",
  runUpdatedAt: "2026-11-13T00:00:00.000Z",
};
const scope = { projectId: target.projectId, workspace: target.workspacePath };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function source(requestId = "12345678-1234-4234-8234-123456789abc") {
  const binding = { ...target, catalogRevision: 1, scopeHash: "a".repeat(64) };
  const sourceVersion = {
    kind: "committed-git-snapshot" as const,
    commit: "b".repeat(40),
    tree: "c".repeat(40),
  };
  const original = {
    schemaVersion: 1 as const,
    kind: "publish" as const,
    requestId,
    binding,
    sourceVersion,
    expectedSubmissionGeneration: 0,
  };
  const originalHash = hash(projectCheckpointSubmissionOriginalJson(original));
  const reviewScopeHash = hash(
    JSON.stringify({
      family: "checkpoint-source-submission",
      originalHash,
      schemaVersion: 1,
    }),
  );
  return projectCheckpointInboxContextReadSchema.parse({
    available: true,
    schemaVersion: 1,
    context: {
      state: "current",
      generation: 1,
      continuity: "anchored",
      baseBinding: binding,
      sourceVersion,
      reviewBinding: { ...binding, scopeHash: reviewScopeHash },
      foreign: null,
      record: {
        original,
        originalHash,
        receipt: {
          schemaVersion: 1,
          requestId,
          originalHash,
          scope: {
            projectId: target.projectId,
            workspacePath: target.workspacePath,
            runSlug: target.runSlug,
            beadId: target.beadId,
          },
          state: "applied",
          observedGeneration: 0,
          resultingGeneration: 1,
          auditEventId: 1,
          appliedAt: target.runUpdatedAt,
          reviewScopeHash,
        },
      },
    },
    association: { complete: true, blockedElsewhere: false, records: [] },
  });
}
function input(raw: unknown = source()): InboxCheckpointProjectionInput {
  return {
    scope: { ...scope },
    target: { ...target },
    sourceGeneration: 4,
    catalogRevision: 1,
    association: {
      raw,
      lastVerified: null,
      coverage: {
        started: true,
        settled: true,
        complete: true,
        fresh: true,
        error: null,
      },
    },
  };
}
function current() {
  const value = source();
  if (!value.available) throw Error("Fixture unavailable");
  return value;
}
test("a complete exact publication produces one unresolved checkpoint source fact", async () => {
  const result = await projectInboxCheckpointSource(input());
  expect(result.status).toBe("awaiting-review");
  expect(result.coverage).toMatchObject({
    complete: true,
    fresh: true,
    error: null,
  });
  expect(result.facts).toHaveLength(1);
  expect(result.facts[0]).toMatchObject({
    ...scope,
    sourceKind: "checkpoint-review",
    status: "pending",
    reviewStatus: "awaiting-review",
    fresh: true,
    complete: true,
    resolved: false,
  });
  expect(result.facts[0]?.sourceIdentity.publication).toEqual(
    published(current()),
  );
  expect(Object.isFrozen(result.facts[0]?.sourceIdentity.publication)).toBe(
    true,
  );
});

function published(data: ReturnType<typeof current>) {
  const record = data.context.record;
  if (!record) throw Error("Fixture publication missing");
  return record;
}
function review(
  data: ReturnType<typeof current>,
  state: ProjectCheckpointReviewOriginalRead["receipt"]["state"],
  n: number,
  decision: "approve" | "request-changes" = "approve",
  createdAt = target.runUpdatedAt,
) {
  const binding = data.context.reviewBinding;
  if (!binding) throw Error("No fixture binding");
  const requestId = "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
  const note = decision === "request-changes" ? "Correct the boundary." : "";
  const preimage = {
    schemaVersion: 1 as const,
    requestId,
    binding,
    decision,
    note,
    commentText: projectCheckpointReviewCommentText({
      requestId,
      binding,
      decision,
      note,
    }),
    createdAt,
  };
  const original = {
    ...preimage,
    intentHash: hash(
      projectCheckpointReviewIntentJson({
        ...preimage,
        intentHash: "0".repeat(64),
      }),
    ),
  };
  const commentId = state === "confirmed" ? "comment-" + n : null;
  return projectCheckpointReviewOriginalReadSchema.parse({
    original,
    metadata: {
      schemaVersion: 1,
      requestId,
      intentHash: original.intentHash,
      scope: {
        projectId: binding.projectId,
        workspacePath: binding.workspacePath,
        runSlug: binding.runSlug,
        beadId: binding.beadId,
      },
      state,
      commentId,
      createdAt,
      updatedAt: createdAt,
    },
    receipt: {
      schemaVersion: 1,
      requestId,
      intentHash: original.intentHash,
      state,
      commentId,
      reportedCommentId: null,
      readback: state === "confirmed" ? "found" : "not-checked",
      auditEventId: n,
      createdAt,
      updatedAt: createdAt,
    },
  });
}
test("unresolved matching and foreign reviews take precedence over earlier recorded decisions", async () => {
  for (const state of ["prepared", "unknown"] as const) {
    const data = current(),
      posted = review(data, "confirmed", 1),
      active = review(data, state, 2);
    data.association.records.push(posted, active);
    const result = await projectInboxCheckpointSource(input(data));
    expect(result.status).toBe("recovery-required");
    expect(result.facts[0]?.sourceIdentity.active).toEqual(active);
    expect(result.facts[0]?.sourceIdentity.latestRecordedReview).toEqual(
      posted,
    );
    expect(result.facts[0]?.resolved).toBe(false);
  }
  const data = current();
  data.association.records.push(review(data, "confirmed", 1));
  data.association.blockedElsewhere = true;
  const result = await projectInboxCheckpointSource(input(data));
  expect(result.status).toBe("recovery-required");
  expect(result.facts[0]?.sourceIdentity.active).toBeNull();
  expect(result.facts[0]?.sourceIdentity.blockedElsewhere).toBe(true);
});
test("insertion order separates latest attempt from last recorded human decision without a Done claim", async () => {
  for (const decision of ["approve", "request-changes"] as const) {
    const data = current(),
      posted = review(data, "confirmed", 1, decision),
      retired = review(
        data,
        "retired",
        2,
        "approve",
        "2026-11-12T00:00:00.000Z",
      );
    data.association.records.push(posted, review(data, "refused", 3), retired);
    const result = await projectInboxCheckpointSource(input(data));
    expect(result.status).toBe("recorded-review");
    expect(result.facts[0]).toMatchObject({
      status: "informational",
      resolved: false,
    });
    expect(result.facts[0]?.sourceIdentity.latestAttempt).toEqual(retired);
    expect(result.facts[0]?.sourceIdentity.latestRecordedReview).toEqual(
      posted,
    );
    expect(result.facts[0]?.detail).toContain("recorded");
  }
});

test("publication identity changes on resubmission of the same commit while caller epochs do not rewrite source facts", async () => {
  const first = await projectInboxCheckpointSource(input());
  const nextInput = input(source("12345678-1234-4234-8234-123456789abd"));
  const next = await projectInboxCheckpointSource(nextInput);
  expect(next.facts[0]?.stableItemId).not.toBe(first.facts[0]?.stableItemId);
  expect(next.facts[0]?.sourceIdentity.publication.original.kind).toBe(
    "publish",
  );
  expect(next.status).toBe("awaiting-review");
  const bumped = input();
  bumped.sourceGeneration = 500;
  expect((await projectInboxCheckpointSource(bumped)).facts).toEqual(
    first.facts,
  );
  const posted = current();
  posted.association.records.push(review(posted, "confirmed", 1));
  const changed = await projectInboxCheckpointSource(input(posted));
  expect(changed.facts[0]?.stableItemId).toBe(first.facts[0]?.stableItemId);
  expect(changed.facts[0]?.sourceRevision).not.toBe(
    first.facts[0]?.sourceRevision,
  );
});
test("every expected target field and the exact current catalog fence is checked", async () => {
  const replacements = {
    projectId: "project-12345678-1234-4234-8234-123456789abd",
    workspacePath: "/other/workspace",
    checkout: "/other/checkout",
    runSlug: "other",
    epicId: "forge-other",
    beadId: "forge-demo.2",
    runUpdatedAt: "2026-11-12T00:00:00.000Z",
  };
  for (const [key, value] of Object.entries(replacements)) {
    const item = input();
    Object.assign(item.target, { [key]: value });
    const result = await projectInboxCheckpointSource(item);
    expect(result.facts).toEqual([]);
    expect(result.coverage.complete).toBe(false);
  }
  const newer = input();
  newer.catalogRevision = 2;
  newer.association.lastVerified = current();
  const result = await projectInboxCheckpointSource(newer);
  expect(result.status).toBe("unverified");
  expect(result.facts).toHaveLength(1);
  expect(result.facts[0]).toMatchObject({ fresh: false, complete: false });
  expect(result.coverage).toMatchObject({ fresh: false, complete: false });
  const wrongScope = input();
  wrongScope.scope.workspace = "/other/workspace";
  expect((await projectInboxCheckpointSource(wrongScope)).facts).toEqual([]);
});
test("a single invalid publication, derived binding or review original prevents complete empty readiness", async () => {
  const badSource = current();
  if (!badSource.context.record) throw Error("Fixture missing");
  badSource.context.record.originalHash = "f".repeat(64);
  badSource.context.record.receipt.originalHash = "f".repeat(64);
  const badDerived = current();
  if (!badDerived.context.record || !badDerived.context.reviewBinding)
    throw Error("Fixture missing");
  badDerived.context.record.receipt.reviewScopeHash = "e".repeat(64);
  badDerived.context.reviewBinding.scopeHash = "e".repeat(64);
  const badReview = current();
  const row = review(badReview, "confirmed", 1);
  row.original.intentHash = "d".repeat(64);
  row.metadata.intentHash = row.original.intentHash;
  row.receipt.intentHash = row.original.intentHash;
  badReview.association.records.push(review(badReview, "confirmed", 2), row);
  const duplicate = current();
  const once = review(duplicate, "confirmed", 1);
  duplicate.association.records.push(once, once);
  const foreignBinding = current();
  foreignBinding.association.records.push(
    review(currentWithOtherPublication(), "confirmed", 1),
  );
  for (const data of [
    badSource,
    badDerived,
    badReview,
    duplicate,
    foreignBinding,
  ]) {
    const result = await projectInboxCheckpointSource(input(data));
    expect(result.status).toBe("unverified");
    expect(result.facts).toEqual([]);
    expect(result.coverage.complete).toBe(false);
  }
});
function currentWithOtherPublication() {
  const data = source("12345678-1234-4234-8234-123456789abd");
  if (!data.available) throw Error("Fixture unavailable");
  return data;
}
test("noncurrent source states and unavailable or unsupported reads cannot manufacture review readiness", async () => {
  for (const state of ["unbound", "withdrawn", "foreign", "stale"] as const) {
    const data = current();
    data.context.state = state;
    data.context.reviewBinding = null;
    data.association.complete = false;
    if (state !== "stale") data.context.record = null;
    if (state === "unbound") {
      data.context.continuity = "legacy-unverified";
      data.context.generation = 0;
    }
    if (state === "foreign")
      data.context.foreign = {
        projectId: target.projectId,
        runSlug: "other",
        beadId: target.beadId,
      };
    const result = await projectInboxCheckpointSource(input(data));
    expect(result.status).toBe("not-current");
    expect(result.facts).toEqual([]);
    expect(result.coverage.complete).toBe(false);
  }
  for (const raw of [
    null,
    {
      available: false,
      error:
        "The checkpoint source and review association is unavailable. Read retained originals before trying again.",
    },
    { ...current(), schemaVersion: 2 },
  ]) {
    const result = await projectInboxCheckpointSource(input(raw));
    expect(result.facts).toEqual([]);
    expect(result.coverage.complete).toBe(false);
  }
});
test("only a fully verified prior bundle survives incomplete current reads, and it stays stale", async () => {
  const saved = current();
  saved.association.records.push(review(saved, "confirmed", 1));
  for (const key of ["started", "settled", "complete", "fresh"] as const) {
    const item = input();
    item.association.lastVerified = saved;
    item.association.coverage[key] = false;
    const result = await projectInboxCheckpointSource(item);
    expect(result.status).toBe("unverified");
    expect(result.facts[0]).toMatchObject({
      fresh: false,
      complete: false,
      reviewStatus: "recorded-review",
    });
    expect(result.facts[0]?.sourceIdentity.records).toEqual(
      saved.association.records,
    );
  }
  const item = input(null);
  item.association.lastVerified = saved;
  const result = await projectInboxCheckpointSource(item);
  expect(result.facts).toHaveLength(1);
  expect(result.coverage.error).toBeTruthy();
  const forgedPrior = current();
  forgedPrior.association.records.push(
    review(currentWithOtherPublication(), "confirmed", 1),
  );
  item.association.lastVerified = forgedPrior;
  expect((await projectInboxCheckpointSource(item)).facts).toEqual([]);
});
test("caller scope and unsafe provenance never turn a source snapshot into authority", async () => {
  for (const epoch of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    for (const key of ["sourceGeneration", "catalogRevision"] as const) {
      const item = input();
      item[key] = epoch;
      item.association.lastVerified = current();
      expect((await projectInboxCheckpointSource(item)).facts).toEqual([]);
    }
  }
  const item = input();
  item.scope.projectId = "project-12345678-1234-4234-8234-123456789abd";
  expect((await projectInboxCheckpointSource(item)).facts).toEqual([]);
});
test("all current and prior DTOs and caller state are captured before the first real digest await", async () => {
  for (const usePrior of [false, true]) {
    const raw = current();
    raw.association.records.push(review(raw, "confirmed", 1));
    const prior = current();
    prior.association.records.push(review(prior, "unknown", 2));
    const item = input(usePrior ? null : raw);
    item.association.lastVerified = prior;
    const expected = await projectInboxCheckpointSource(structuredClone(item));
    const pending = projectInboxCheckpointSource(item);
    item.scope.workspace = "/changed";
    item.target.checkout = "/changed";
    item.sourceGeneration = 9;
    item.catalogRevision = 9;
    item.association.coverage.fresh = false;
    raw.context.sourceVersion.commit = "d".repeat(40);
    raw.association.records.length = 0;
    prior.association.blockedElsewhere = true;
    const priorRow = prior.association.records[0];
    if (!priorRow || !raw.context.record || !prior.context.record)
      throw Error("Fixture missing");
    priorRow.original.note = "changed";
    raw.context.record.original.requestId =
      "00000000-0000-4000-8000-000000000001";
    prior.context.record.originalHash = "e".repeat(64);
    expect(await pending).toEqual(expected);
    expect(Object.isFrozen(expected.facts[0]?.sourceIdentity.records)).toBe(
      true,
    );
  }
});
test("unsupported history counts and over-bound complete envelopes fail closed without truncated readiness", async () => {
  const tooMany = current();
  tooMany.association.records = Array.from({ length: 101 }, (_, i) =>
    review(tooMany, "confirmed", i + 1),
  );
  expect((await projectInboxCheckpointSource(input(tooMany))).facts).toEqual(
    [],
  );
  const tooLarge = current();
  const longStamp = "2026-11-13T00:00:00." + "1".repeat(20000) + "Z";
  tooLarge.association.records = Array.from({ length: 45 }, (_, i) =>
    review(tooLarge, "confirmed", i + 1, "approve", longStamp),
  );
  expect(
    new TextEncoder().encode(
      JSON.stringify({ ok: true, data: tooLarge, error: null }),
    ).byteLength,
  ).toBeGreaterThan(4 * 1024 * 1024);
  const result = await projectInboxCheckpointSource(input(tooLarge));
  expect(result.facts).toEqual([]);
  expect(result.coverage.complete).toBe(false);
});

test("refused or retired attempts alone record no posted decision and cannot inherit a previous publication's review", async () => {
  const data = current();
  data.association.records.push(
    review(data, "refused", 1),
    review(data, "retired", 2),
  );
  const result = await projectInboxCheckpointSource(input(data));
  expect(result.status).toBe("awaiting-review");
  expect(result.facts[0]?.sourceIdentity.latestRecordedReview).toBeNull();
  expect(result.facts[0]?.sourceIdentity.latestAttempt?.receipt.state).toBe(
    "retired",
  );
  const priorPublication = currentWithOtherPublication();
  priorPublication.association.records.push(
    review(priorPublication, "confirmed", 3),
  );
  const item = input(data);
  item.association.lastVerified = priorPublication;
  expect(
    (await projectInboxCheckpointSource(item)).facts[0]?.sourceIdentity
      .publication,
  ).toEqual(published(data));
});
