import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { usageThresholdJson } from "../../types/usage-threshold-settings";
import { writeOwnerOnly } from "../hearth/token";
import { workspaceKey } from "./scope";
import { createProjectStore, projectCatalogPath } from "./store";
import { projectCatalogFixture } from "./testing";
import {
  createUsageThresholdStore,
  type UsageThresholdRecord,
  usageThresholdRequestSchema,
} from "./usage-threshold-store";

const homes: string[] = [];
const requestId = "bc000000-0000-4000-8000-000000000001";
const instant = new Date("2026-11-11T12:00:00.000Z");
afterEach(() => {
  for (const home of homes.splice(0)) {
    const target = realpathSync(home);
    if (
      dirname(target) !== realpathSync(tmpdir()) ||
      !basename(target).startsWith("forge-usage-reservation-")
    )
      throw Error("Unsafe owned reservation fixture cleanup");
    rmSync(target, { recursive: true, force: true });
  }
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "forge-usage-reservation-"));
  homes.push(home);
  const workspace = workspaceKey(home);
  writeOwnerOnly(
    projectCatalogPath(home),
    JSON.stringify(projectCatalogFixture(workspace)),
  );
  const project = createProjectStore(home).read().projects[0];
  if (!project) throw Error("Invalid canonical project fixture");
  const request = usageThresholdRequestSchema.parse({
    requestId,
    workspace,
    expectedCatalogRevision: 1,
    expectedRevision: 0,
    rules: [],
  });
  const store = createUsageThresholdStore(home, workspace, {
    now: () => new Date(instant),
  });
  return { home, workspace, projectId: project.id, request, store };
}
const stateFile = (home: string) =>
  join(home, "usage-threshold-settings", "state.json");
function legacyState(home: string, saved: UsageThresholdRecord) {
  const state = {
    version: 1,
    documents: [saved.document],
    receipts: [saved.receipt],
  };
  writeOwnerOnly(stateFile(home), JSON.stringify(state));
  return state;
}

test("a real canonical request and exact legacy v1 journal preserve the original receipt", async () => {
  const f = fixture();
  expect(usageThresholdRequestSchema.parse(f.request)).toEqual(f.request);
  const saved = await f.store.write(f.projectId, f.request);
  expect(saved.receipt.originalHash).toBe(
    createHash("sha256")
      .update(usageThresholdJson({ ...f.request, projectId: f.projectId }))
      .digest("hex"),
  );
  expect(saved.receipt).toMatchObject({
    outcome: "applied",
    observedRevision: 0,
    resultingRevision: 1,
    settledAt: instant.toISOString(),
    refusalCode: null,
  });
  legacyState(f.home, saved);
  const before = readFileSync(stateFile(f.home));
  const restored = createUsageThresholdStore(f.home, f.workspace);
  expect(restored.read(f.projectId)).toEqual(saved.document);
  expect(restored.original(f.projectId, requestId)).toEqual(saved);
  expect(await restored.write(f.projectId, f.request)).toEqual(saved);
  expect(readFileSync(stateFile(f.home))).toEqual(before);
});

test("a complete original is durably reserved before any policy revision or applied receipt exists", async () => {
  const f = fixture();
  const reserve = f.store.reserve;
  expect(typeof reserve).toBe("function");
  if (typeof reserve !== "function")
    throw Error("Missing policy reservation producer");
  const result = await f.store.reserve(f.projectId, f.request);
  expect(result).toMatchObject({
    origin: "reservation",
    phase: "reserved",
    original: { ...f.request, projectId: f.projectId },
    reservedAt: instant.toISOString(),
    discardedAt: null,
    receipt: null,
    document: {
      projectId: f.projectId,
      workspace: f.workspace,
      revision: 0,
      rules: [],
    },
  });
  expect(f.store.read(f.projectId).revision).toBe(0);
  expect(() => f.store.original(f.projectId, requestId)).toThrow();
  expect(readFileSync(stateFile(f.home), "utf8")).toContain(requestId);
});

test("only explicit exact reserved Apply can publish and direct write cannot bypass the pending original", async () => {
  const f = fixture();
  await f.store.reserve(f.projectId, f.request);
  const reserved = readFileSync(stateFile(f.home));
  await expect(f.store.write(f.projectId, f.request)).rejects.toMatchObject({
    status: 409,
  });
  await expect(
    f.store.write(f.projectId, {
      ...f.request,
      requestId: "bc000000-0000-4000-8000-000000000002",
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect(readFileSync(stateFile(f.home))).toEqual(reserved);
  const apply = f.store.applyReserved;
  expect(typeof apply).toBe("function");
  if (typeof apply !== "function")
    throw Error("Missing explicit reserved Apply");
  const result = await f.store.applyReserved(f.projectId, f.request);
  expect(result).toMatchObject({
    document: { revision: 1, rules: [] },
    receipt: {
      original: { ...f.request, projectId: f.projectId },
      outcome: "applied",
      observedRevision: 0,
      resultingRevision: 1,
    },
  });
  expect(f.store.original(f.projectId, requestId)).toEqual(result);
  const applied = readFileSync(stateFile(f.home));
  expect(await f.store.applyReserved(f.projectId, f.request)).toEqual(result);
  expect(await f.store.write(f.projectId, f.request)).toEqual(result);
  expect(readFileSync(stateFile(f.home))).toEqual(applied);
});
