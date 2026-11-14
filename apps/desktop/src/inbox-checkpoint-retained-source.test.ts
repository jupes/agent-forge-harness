import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  projectCheckpointReviewInventoryJson,
  projectCheckpointReviewInventoryReadSchema,
} from "../../../types/project-checkpoint-review-inventory";
import {
  projectCheckpointReviewCommentText,
  projectCheckpointReviewIntentJson,
  projectCheckpointReviewOriginalReadSchema,
} from "../../../types/project-checkpoint-reviews";
import {
  type InboxRetainedCheckpointProjectionInput,
  projectInboxRetainedCheckpointSources,
} from "./inbox-checkpoint-retained-source";

const scope = {
  projectId: "project-12345678-1234-4234-8234-123456789abc",
  workspace: "/served/workspace",
};
const stamp = "2026-11-13T00:00:00.000Z";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function row(
  state:
    | "prepared"
    | "unknown"
    | "confirmed"
    | "refused"
    | "retired" = "unknown",
  beadId = "forge-test.1",
) {
  const binding = {
    projectId: scope.projectId,
    workspacePath: scope.workspace,
    checkout: "/served/checkout",
    runSlug: "missing-run",
    epicId: "forge-test",
    beadId,
    runUpdatedAt: stamp,
    catalogRevision: 1,
    scopeHash: "a".repeat(64),
  };
  const original = {
    schemaVersion: 1 as const,
    requestId: randomUUID(),
    binding,
    decision: "approve" as const,
    note: "",
    createdAt: stamp,
    commentText: "",
    intentHash: "0".repeat(64),
  };
  original.commentText = projectCheckpointReviewCommentText(original);
  original.intentHash = hash(projectCheckpointReviewIntentJson(original));
  const commentId = state === "confirmed" ? "exact-comment" : null;
  return projectCheckpointReviewOriginalReadSchema.parse({
    original,
    metadata: {
      schemaVersion: 1,
      requestId: original.requestId,
      intentHash: original.intentHash,
      scope: {
        projectId: scope.projectId,
        workspacePath: scope.workspace,
        runSlug: binding.runSlug,
        beadId,
      },
      state,
      commentId,
      createdAt: stamp,
      updatedAt: stamp,
    },
    receipt: {
      schemaVersion: 1,
      requestId: original.requestId,
      intentHash: original.intentHash,
      state,
      commentId,
      reportedCommentId: null,
      readback: state === "confirmed" ? "found" : "not-checked",
      auditEventId: 1,
      createdAt: stamp,
      updatedAt: stamp,
    },
  });
}
function inventory(records = [row()]) {
  const protectedScope = {
    projectId: scope.projectId,
    workspacePath: scope.workspace,
  };
  const parsed = projectCheckpointReviewInventoryReadSchema.parse({
    available: true,
    schemaVersion: 1,
    scope: protectedScope,
    coverage: "retained-review-records",
    records,
    observationRevision: hash(
      projectCheckpointReviewInventoryJson(protectedScope, records),
    ),
  });
  if (!parsed.available) throw Error("Fixture unavailable");
  return parsed;
}
function input(
  raw: unknown = inventory(),
): InboxRetainedCheckpointProjectionInput {
  return {
    scope: { ...scope },
    sourceGeneration: 3,
    catalogRevision: 1,
    inventory: {
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
test("cold-start retained uncertainty stays actionable without a current Run or source publication", async () => {
  const saved = row(),
    result = await projectInboxRetainedCheckpointSources(
      input(inventory([saved])),
    );
  expect(result.facts).toHaveLength(1);
  expect(result.facts[0]).toMatchObject({
    ...scope,
    sourceKind: "checkpoint-review",
    status: "pending",
    reviewStatus: "unknown",
    resolved: false,
    fresh: true,
    complete: true,
    sourceIdentity: { originalRead: saved },
  });
  expect(result.coverage).toMatchObject({
    fresh: true,
    complete: true,
    error: null,
  });
  expect(Object.isFrozen(result.facts[0]?.sourceIdentity.originalRead)).toBe(
    true,
  );
});

test("prepared and uncertain rows need attention while settled records remain ordered history", async () => {
  const records = (
    ["prepared", "unknown", "confirmed", "refused", "retired"] as const
  ).map((state, i) => row(state, "forge-test." + (i + 1)));
  const result = await projectInboxRetainedCheckpointSources(
    input(inventory(records)),
  );
  expect(result.facts.map((fact) => fact.reviewStatus)).toEqual([
    "prepared",
    "unknown",
  ]);
  expect(result.history).toEqual(records);
  expect(result.facts.every((fact) => fact.resolved === false)).toBe(true);
  expect(result.facts[0]?.sourceIdentity).not.toHaveProperty("publication");
});
test("a retained item binds its exact original and receipt while unrelated collection changes do not rewrite it", async () => {
  const saved = row(),
    initial = await projectInboxRetainedCheckpointSources(
      input(inventory([saved])),
    ),
    fact = initial.facts[0];
  const identity = [
    "inbox-source-v1",
    scope.workspace,
    scope.projectId,
    "checkpoint-review",
    [
      "retained-review",
      saved.original.binding.runSlug,
      saved.original.binding.beadId,
      saved.original.requestId,
      saved.original.intentHash,
    ],
  ];
  expect(fact?.stableItemId).toBe("sha256:" + hash(JSON.stringify(identity)));
  const next = input(inventory([saved, row("retired", "forge-test.2")]));
  next.sourceGeneration = 90;
  next.catalogRevision = 2;
  expect((await projectInboxRetainedCheckpointSources(next)).facts[0]).toEqual(
    fact,
  );
  const changed = structuredClone(saved);
  changed.receipt.readback = "absent";
  changed.receipt.updatedAt = "2026-11-13T00:01:00.000Z";
  changed.metadata.updatedAt = changed.receipt.updatedAt;
  const changedFact = (
    await projectInboxRetainedCheckpointSources(input(inventory([changed])))
  ).facts[0];
  expect(changedFact?.stableItemId).toBe(fact?.stableItemId);
  expect(changedFact?.sourceRevision).not.toBe(fact?.sourceRevision);
});
test("collection and every immutable original are independently verified before any attention is emitted", async () => {
  const wrongRevision = inventory();
  wrongRevision.observationRevision = "f".repeat(64);
  const wrongOriginal = row();
  wrongOriginal.original.intentHash = "e".repeat(64);
  wrongOriginal.metadata.intentHash = wrongOriginal.original.intentHash;
  wrongOriginal.receipt.intentHash = wrongOriginal.original.intentHash;
  const wrongReceipt = inventory();
  const first = wrongReceipt.records[0];
  if (!first) throw Error("Missing fixture");
  first.metadata.state = "confirmed";
  for (const value of [
    wrongRevision,
    inventory([row("prepared", "forge-test.2"), wrongOriginal]),
    wrongReceipt,
    { ...inventory(), schemaVersion: 2 },
  ]) {
    const result = await projectInboxRetainedCheckpointSources(input(value));
    expect(result.facts).toEqual([]);
    expect(result.coverage.complete).toBe(false);
  }
});
test("two unresolved originals in the same private family are contradictory even with distinct UUIDs", async () => {
  const result = await projectInboxRetainedCheckpointSources(
    input(inventory([row("prepared"), row("unknown")])),
  );
  expect(result.facts).toEqual([]);
  expect(result.coverage.complete).toBe(false);
});
test("only an independently verified whole prior inventory survives failed current coverage", async () => {
  const prior = inventory([row("unknown"), row("retired", "forge-test.2")]);
  for (const key of ["started", "settled", "complete", "fresh"] as const) {
    const item = input(inventory([row("prepared", "forge-test.3")]));
    item.inventory.lastVerified = prior;
    item.inventory.coverage[key] = false;
    const result = await projectInboxRetainedCheckpointSources(item);
    expect(result.history).toEqual(prior.records);
    expect(result.facts[0]).toMatchObject({
      reviewStatus: "unknown",
      fresh: false,
      complete: false,
    });
    expect(result.coverage.error).toBeTruthy();
  }
  const item = input(null);
  item.inventory.lastVerified = prior;
  expect(
    (await projectInboxRetainedCheckpointSources(item)).facts,
  ).toHaveLength(1);
  item.inventory.lastVerified = {
    ...prior,
    observationRevision: "f".repeat(64),
  };
  expect((await projectInboxRetainedCheckpointSources(item)).facts).toEqual([]);
});
test("cross-scope or invalid caller state never borrows a prior Review as current authority", async () => {
  const saved = inventory();
  for (const key of ["sourceGeneration", "catalogRevision"] as const) {
    for (const value of [-1, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      const item = input();
      item[key] = value;
      item.inventory.lastVerified = saved;
      expect((await projectInboxRetainedCheckpointSources(item)).facts).toEqual(
        [],
      );
    }
  }
  const item = input();
  item.inventory.lastVerified = saved;
  item.scope.workspace = "/other/workspace";
  expect((await projectInboxRetainedCheckpointSources(item)).facts).toEqual([]);
});
test("complete current and prior inventories and caller fields are captured before hashing", async () => {
  for (const fallback of [false, true]) {
    const current = inventory(),
      prior = inventory([row("prepared", "forge-test.2")]),
      item = input(fallback ? null : current);
    item.inventory.lastVerified = prior;
    const expected = await projectInboxRetainedCheckpointSources(
        structuredClone(item),
      ),
      pending = projectInboxRetainedCheckpointSources(item);
    item.scope.workspace = "/changed";
    item.sourceGeneration = 99;
    item.catalogRevision = 99;
    item.inventory.coverage.fresh = false;
    current.records.length = 0;
    prior.observationRevision = "0".repeat(64);
    const first = prior.records[0];
    if (!first) throw Error("Missing fixture");
    first.original.note = "changed";
    expect(await pending).toEqual(expected);
    expect(Object.isFrozen(expected.history)).toBe(true);
  }
});
