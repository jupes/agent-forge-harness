import { expect, test } from "bun:test";
import type { SmithConfigEditRequest } from "../../types/smith-config-edit";
import {
  canonicalSmithConfigEditRequest,
  smithConfigEditPreviewRequestSchema,
  smithConfigEditPreviewSchema,
  smithConfigEditReceiptSchema,
  smithConfigEditRequestSchema,
} from "./smith-edit-protocol";

const smith = {
  name: "claude-master",
  provider: "claude",
  model: "exact configured model",
  effort: "custom effort",
  enabled: false,
  tags: ["rank:master", " exact tag "],
};
const request: SmithConfigEditRequest = {
  requestId: "e630e793-e617-4c93-bdaf-b1e30ba706e5",
  target: "workspace",
  name: smith.name,
  smith,
  expectedRevision: {
    version: 1,
    user: "a".repeat(64),
    workspace: "b".repeat(64),
  },
};

test("preview and write requests require a complete existing Smith and preserve exact values", () => {
  expect(
    smithConfigEditPreviewRequestSchema.parse({
      target: request.target,
      name: request.name,
      smith,
    }),
  ).toEqual({ target: request.target, name: request.name, smith });
  expect(smithConfigEditRequestSchema.parse(request)).toEqual(request);
});

test("strict edit request rejects name changes, extra fields and malformed paired revisions", () => {
  for (const invalid of [
    { ...request, name: "another" },
    { ...request, path: "/must/not/be/a/selector" },
    { ...request, smith: { ...smith, provider: "" } },
    {
      ...request,
      smith: { ...smith, tags: Array.from({ length: 65 }, () => "x") },
    },
    {
      ...request,
      expectedRevision: { ...request.expectedRevision, user: "bad" },
    },
    { ...request, requestId: request.requestId.toUpperCase() },
    { ...request, smith: { ...smith, futureField: "no" } },
    {
      ...request,
      smith: { ...smith, name: "constructor" },
      name: "constructor",
    },
  ])
    expect(smithConfigEditRequestSchema.safeParse(invalid).success).toBe(false);
});

test("canonical edit identity is a distinct versioned write family and binds target, UUID and both revisions", () => {
  const canonical = canonicalSmithConfigEditRequest(request);
  expect(canonical).toContain('"family":"smith-config-edit"');
  expect(canonical).toContain('"version":1');
  expect(canonical).toContain(request.requestId);
  expect(canonical).toContain('"target":"workspace"');
  expect(canonical).toContain('"user":"' + "a".repeat(64) + '"');
  expect(canonical).toContain('"workspace":"' + "b".repeat(64) + '"');
  expect(
    canonicalSmithConfigEditRequest({ ...request, target: "user" }),
  ).not.toBe(canonical);
  expect(
    canonicalSmithConfigEditRequest({
      ...request,
      smith: { ...smith, tags: [...smith.tags].reverse() },
    }),
  ).not.toBe(canonical);
});

test("review codec keeps target materialization distinct from effective layered values", () => {
  const preview = {
    version: 1 as const,
    target: "workspace" as const,
    file: "C:/workspace/agent-forge.toml",
    expectedRevision: request.expectedRevision,
    candidate: { sha256: "c".repeat(64), byteLength: 200, created: false },
    review: {
      name: smith.name,
      targetBefore: { model: "partial-model" },
      targetAfter: smith,
      effectiveBefore: { ...smith, model: "effective-before" },
      effectiveAfter: smith,
      provenanceBefore: {
        provider: "builtin",
        model: "C:/user/config.toml",
        effort: "builtin",
        enabled: "C:/workspace/agent-forge.toml",
        tags: "builtin",
      },
      provenanceAfter: {
        provider: "C:/workspace/agent-forge.toml",
        model: "C:/workspace/agent-forge.toml",
        effort: "C:/workspace/agent-forge.toml",
        enabled: "C:/workspace/agent-forge.toml",
        tags: "C:/workspace/agent-forge.toml",
      },
    },
  };
  expect(smithConfigEditPreviewSchema.parse(preview)).toEqual(preview);
  expect(
    smithConfigEditPreviewSchema.safeParse({
      ...preview,
      review: {
        ...preview.review,
        effectiveAfter: { ...smith, name: "other" },
      },
    }).success,
  ).toBe(false);
  expect(
    smithConfigEditPreviewSchema.safeParse({
      ...preview,
      review: {
        ...preview.review,
        effectiveBefore: { ...preview.review.effectiveBefore, name: "other" },
      },
    }).success,
  ).toBe(false);
  expect(
    smithConfigEditPreviewSchema.safeParse({
      ...preview,
      review: {
        ...preview.review,
        effectiveAfter: { ...smith, model: "shadowed-model" },
      },
    }).success,
  ).toBe(false);
  expect(
    smithConfigEditPreviewSchema.safeParse({ ...preview, file: "builtin" })
      .success,
  ).toBe(false);
});

test("receipt binds the exact original, reviewed complete Smith, and publication", () => {
  const preview = {
      version: 1 as const,
      target: request.target,
      file: "C:/workspace/agent-forge.toml",
      expectedRevision: request.expectedRevision,
      candidate: { sha256: "d".repeat(64), byteLength: 200, created: false },
      review: {
        name: request.name,
        targetBefore: { model: "before" },
        targetAfter: smith,
        effectiveBefore: { ...smith, model: "before" },
        effectiveAfter: smith,
        provenanceBefore: {
          provider: "builtin",
          model: "C:/user/config.toml",
          effort: "builtin",
          enabled: "C:/workspace/agent-forge.toml",
          tags: "builtin",
        },
        provenanceAfter: {
          provider: "C:/workspace/agent-forge.toml",
          model: "C:/workspace/agent-forge.toml",
          effort: "C:/workspace/agent-forge.toml",
          enabled: "C:/workspace/agent-forge.toml",
          tags: "C:/workspace/agent-forge.toml",
        },
      },
    },
    receipt = {
      version: 1 as const,
      requestId: request.requestId,
      ownerScopeHash: "e".repeat(64),
      inputHash: "f".repeat(64),
      createdAt: "2026-10-25T12:00:00.000Z",
      original: request,
      result: {
        phase: "confirmed" as const,
        completedAt: "2026-10-25T12:00:01.000Z",
        preview,
        publication: {
          file: preview.file,
          created: preview.candidate.created,
          sha256: preview.candidate.sha256,
        },
      },
    };
  expect(smithConfigEditReceiptSchema.parse(receipt)).toEqual(receipt);
  expect(
    smithConfigEditReceiptSchema.safeParse({
      ...receipt,
      result: {
        ...receipt.result,
        publication: { ...receipt.result.publication, sha256: "0".repeat(64) },
      },
    }).success,
  ).toBe(false);
  expect(
    smithConfigEditReceiptSchema.safeParse({
      ...receipt,
      result: {
        ...receipt.result,
        preview: {
          ...preview,
          review: {
            ...preview.review,
            effectiveAfter: { ...smith, model: "different" },
          },
        },
      },
    }).success,
  ).toBe(false);
  expect(
    smithConfigEditReceiptSchema.safeParse({
      ...receipt,
      original: {
        ...request,
        name: "other",
        smith: { ...smith, name: "other" },
      },
    }).success,
  ).toBe(false);
});
