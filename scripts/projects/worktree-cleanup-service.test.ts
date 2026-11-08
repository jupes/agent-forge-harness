import { expect, test } from "bun:test";
import { cleanupReceiptSchema } from "./worktree-cleanup-protocol";

const stamp = "2026-11-07T00:00:00.000Z";
const confirmed = {
  projectId: "project-a1000000-0000-4000-8000-000000000001",
  requestId: "a1000000-0000-4000-8000-000000000002",
  requestHash: "a".repeat(64),
  repository: "/repo",
  expectedCatalogRevision: 1,
  expectedRecord: {
    id: "shift-test-1",
    path: "/repo/trees/shift-test-1",
    branch: "shift/test",
    createdAt: stamp,
    beadId: "forge-test.1",
  },
  expectedHead: "b".repeat(40),
  state: "confirmed" as const,
  reason: null,
  attemptedAt: stamp,
  endedAt: "2026-11-07T00:00:01.000Z",
  audit: { eventId: 1, ulid: "0".repeat(26), ts: stamp },
};

test("cleanup receipts retain exact reviewed identity and coherent outcome evidence", () => {
  const unknown = {
    ...confirmed,
    state: "unknown" as const,
    endedAt: null,
    reason: "Cleanup is not confirmed",
  };
  const refused = {
    ...confirmed,
    state: "refused" as const,
    attemptedAt: null,
    reason: "No primitive was invoked",
  };
  for (const value of [
    confirmed,
    refused,
    unknown,
    { ...unknown, attemptedAt: null },
  ])
    expect(cleanupReceiptSchema.parse(value)).toEqual(value);
  const invalid: unknown[] = [
    { ...confirmed, attemptedAt: null },
    { ...confirmed, endedAt: null },
    { ...confirmed, endedAt: "2026-11-06T23:59:59.000Z" },
    { ...confirmed, reason: "Not confirmed" },
    { ...refused, attemptedAt: stamp },
    { ...refused, reason: null },
    { ...unknown, endedAt: stamp },
    { ...unknown, reason: null },
    { ...unknown, reason: "" },
    { ...confirmed, state: "reserved" },
    { ...confirmed, force: false },
    { ...confirmed, requestId: confirmed.requestId.toUpperCase() },
    { ...confirmed, requestHash: "invalid" },
    { ...confirmed, audit: { ...confirmed.audit, eventId: 0 } },
    { ...confirmed, audit: { ...confirmed.audit, eventId: 1.5 } },
    {
      ...confirmed,
      audit: { ...confirmed.audit, eventId: Number.MAX_SAFE_INTEGER + 1 },
    },
    { ...confirmed, audit: { ...confirmed.audit, ulid: "8" + "0".repeat(25) } },
    { ...confirmed, audit: { ...confirmed.audit, ts: "unknown" } },
    { ...confirmed, audit: { ...confirmed.audit, authority: true } },
  ];
  invalid.forEach((value, index) => {
    expect({
      index,
      valid: cleanupReceiptSchema.safeParse(value).success,
    }).toEqual({ index, valid: false });
  });
});
