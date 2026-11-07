import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateHome } from "../hearth/home-guard";
import { writeOwnerOnly } from "../hearth/token";
import { appendEvent } from "../ledger/append";
import { closeLedger } from "../ledger/db";
import { scratchDirs } from "../test-scratch";
import { canonicalTrustedDirectory } from "../trusted-directory";
import {
  canonicalCleanupRequest,
  type CleanupRequest,
} from "./worktree-cleanup-protocol";
import { readWorktreeCleanupInventory } from "./worktree-cleanup-store";

const scratch = scratchDirs();
const stamp = "2026-11-07T00:00:00.000Z";
afterEach(() => {
  closeLedger();
  scratch.cleanup();
});

function fixture() {
  const home = canonicalTrustedDirectory(scratch.make("cleanup-store-"));
  ensurePrivateHome(home);
  const repository = join(home, "repo");
  ensurePrivateHome(repository);
  const projectId = "project-a1000000-0000-4000-8000-000000000001";
  const id = "shift-20261107-170000-0001-1";
  const request: CleanupRequest = {
    requestId: "a1000000-0000-4000-8000-000000000002",
    repository,
    expectedCatalogRevision: 1,
    expectedRecord: {
      id,
      path: join(repository, "trees", id),
      branch: "shift/shift-20261107-170000-0001/forge-test.1",
      createdAt: stamp,
      beadId: "forge-test.1",
    },
    expectedHead: "a".repeat(40),
  };
  const requestHash = createHash("sha256")
    .update(canonicalCleanupRequest(projectId, request))
    .digest("hex");
  const audit = appendEvent(
    {
      kind: "operator.action",
      workspace: repository,
      beadId: request.expectedRecord.beadId,
      payload: {
        action: "project.worktree.cleanup",
        surface: "ui",
        target: projectId,
        family: "project-worktree-cleanup",
        requestId: request.requestId,
        inputHash: requestHash,
      },
    },
    { path: join(home, "ledger.db"), now: () => new Date(stamp) },
  );
  if (!audit.ok || !("id" in audit)) throw Error("Expected a stored audit");
  const original = {
    version: 1 as const,
    projectId,
    request,
    requestHash,
    createdAt: stamp,
    audit: { eventId: audit.id, ulid: audit.ulid, ts: stamp },
  };
  const row = {
    original,
    phase: "unknown" as const,
    attemptedAt: stamp,
    endedAt: null,
    reason: "The prior cleanup outcome is unconfirmed.",
    outcome: null,
  };
  const namespace = join(home, "project-worktree-cleanup");
  ensurePrivateHome(namespace);
  const file = join(namespace, "operations.json");
  const seed = (value: unknown) =>
    writeOwnerOnly(file, JSON.stringify({ version: 1, records: [value] }));
  return { home, file, row, seed };
}

test("terminal cleanup originals remain readable without unresolved ownership", () => {
  const f = fixture();
  f.seed(f.row);
  expect(readWorktreeCleanupInventory(f.home)).toEqual([f.row]);
  const terminal = {
    ...f.row,
    phase: "refused" as const,
    attemptedAt: null,
    endedAt: stamp,
    reason: "No primitive invocation was admitted.",
  };
  f.seed(terminal);
  const bytes = readFileSync(f.file, "utf8");
  expect(readWorktreeCleanupInventory(f.home)).toEqual([terminal]);
  expect(readFileSync(f.file, "utf8")).toBe(bytes);
});

test("confirmed cleanup originals require direct reviewed success evidence", () => {
  const f = fixture();
  const confirmed = {
    ...f.row,
    phase: "confirmed" as const,
    endedAt: "2026-11-07T00:00:01.000Z",
    reason: null,
    outcome: "reviewed-remove-returned-ok" as const,
  };
  f.seed(confirmed);
  expect(readWorktreeCleanupInventory(f.home)).toEqual([confirmed]);
  for (const invalid of [
    {
      ...confirmed,
      original: {
        ...confirmed.original,
        audit: { ...confirmed.original.audit, ulid: "8" + "0".repeat(25) },
      },
    },
    { ...confirmed, attemptedAt: null },
    { ...confirmed, endedAt: null },
    { ...confirmed, endedAt: "2026-11-06T23:59:59.000Z" },
    { ...confirmed, reason: "Unconfirmed" },
    { ...confirmed, outcome: null },
    { ...confirmed, outcome: "unverified" },
  ]) {
    f.seed(invalid);
    expect(() => readWorktreeCleanupInventory(f.home)).toThrow();
  }
  const otherPhases = [
    f.row,
    { ...f.row, phase: "reserved" as const, attemptedAt: null, reason: null },
    { ...f.row, phase: "attempted" as const, reason: null },
    { ...f.row, phase: "refused" as const, attemptedAt: null, endedAt: stamp },
  ];
  for (const row of otherPhases) {
    f.seed(row);
    expect(readWorktreeCleanupInventory(f.home)).toEqual([row]);
    f.seed({ ...row, outcome: confirmed.outcome });
    expect(() => readWorktreeCleanupInventory(f.home)).toThrow();
  }
});
