import { expect, test } from "bun:test";
import {
  canonicalCleanupRequest,
  type CleanupRequest,
  cleanupRequestSchema,
} from "./worktree-cleanup-protocol";

const projectId = "project-a1000000-0000-4000-8000-000000000001";
const review = (): CleanupRequest => ({
  requestId: "a1000000-0000-4000-8000-000000000002",
  repository: "/workspace/repo",
  expectedCatalogRevision: 1,
  expectedRecord: {
    id: "shift-20261107-170000-0001-1",
    path: "/workspace/repo/trees/shift-20261107-170000-0001-1",
    branch: "shift/shift-20261107-170000-0001/forge-test.1",
    createdAt: "2026-11-07T00:00:00.000Z",
    beadId: "forge-test.1",
  },
  expectedHead: "a".repeat(40),
});

test("cleanup requests retain strict reviewed identities", () => {
  const request = review();
  const record = (change: Record<string, unknown>) => ({
    ...request,
    expectedRecord: { ...request.expectedRecord, ...change },
  });
  for (const width of [40, 64]) {
    const valid = { ...request, expectedHead: "a".repeat(width) };
    expect(cleanupRequestSchema.parse(valid)).toEqual(valid);
  }
  const repository = "/workspace/a\\b" + String.fromCharCode(0xfeff);
  const native = {
    ...request,
    repository,
    expectedRecord: {
      ...request.expectedRecord,
      path: `${repository}/trees/${request.expectedRecord.id}`,
    },
  };
  expect(cleanupRequestSchema.parse(native)).toEqual(native);
  const invalid: unknown[] = [
    { ...request, requestId: request.requestId.toUpperCase() },
    { ...request, requestId: "not-a-uuid" },
    { ...request, force: false },
    { ...request, auditEventId: 1 },
    { ...request, repository: "r".repeat(1025) },
    { ...request, repository: String.fromCharCode(0) },
    { ...request, repository: String.fromCharCode(0xd800) },
    record({ beadId: undefined }),
    record({ beadId: "invalid bead" }),
    record({ ownerSessionId: "session-1" }),
    record({ createdAt: "unknown" }),
    ...[
      "",
      "A".repeat(40),
      "g".repeat(40),
      ...[39, 41, 63, 65].map((n) => "a".repeat(n)),
    ].map((expectedHead) => ({ ...request, expectedHead })),
    ...[-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(
      (expectedCatalogRevision) => ({ ...request, expectedCatalogRevision }),
    ),
  ];
  for (const key of Object.keys(request))
    invalid.push({ ...request, [key]: undefined });
  invalid.forEach((value, index) => {
    expect({
      index,
      accepted: cleanupRequestSchema.safeParse(value).success,
    }).toEqual({ index, accepted: false });
  });
});

test("cleanup canonical JSON binds every native review field", () => {
  const request = review();
  const canonical = canonicalCleanupRequest(projectId, request);
  expect(canonical).toBe(
    JSON.stringify({
      family: "project-worktree-cleanup",
      version: 1,
      projectId,
      ...request,
    }),
  );
  const { expectedRecord, expectedHead, ...rest } = request;
  const { beadId, createdAt, ...recordRest } = expectedRecord;
  const reordered: CleanupRequest = {
    expectedHead,
    expectedRecord: { beadId, createdAt, ...recordRest },
    ...rest,
  };
  expect(canonicalCleanupRequest(projectId, reordered)).toBe(canonical);
  const changed: CleanupRequest[] = [
    { ...request, requestId: "a1000000-0000-4000-8000-000000000003" },
    { ...request, repository: "/workspace/other" },
    { ...request, expectedCatalogRevision: 2 },
    { ...request, expectedHead: "b".repeat(40) },
    ...Object.entries({
      id: "shift-other-1",
      path: "/workspace/other/trees/id",
      branch: "shift/other",
      createdAt: "2026-11-07T00:00:01.000Z",
      beadId: "forge-test.2",
    }).map(([key, value]) => ({
      ...request,
      expectedRecord: { ...request.expectedRecord, [key]: value },
    })),
  ];
  for (const value of changed) {
    expect(cleanupRequestSchema.safeParse(value).success).toBe(true);
    expect(canonicalCleanupRequest(projectId, value)).not.toBe(canonical);
  }
  expect(
    canonicalCleanupRequest(projectId.replace("a100", "b100"), request),
  ).not.toBe(canonical);
  const literal = { ...request, repository: "/workspace/a\\b" };
  const nested = { ...request, repository: "/workspace/a/b" };
  expect(canonicalCleanupRequest(projectId, literal)).not.toBe(
    canonicalCleanupRequest(projectId, nested),
  );
});
