import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  createManagedShiftSessionClient,
  managedShiftTarget,
} from "../../apps/desktop/src/managed-shift-session-client";
import type { ProjectShiftReceipt } from "../../types/project-shifts";
import { projectShiftRequestHash } from "../shifts/registry";

const target = {
  projectId: "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
  workspace: "/repo",
  sessionId: "session-2d5ed741-5528-424c-a927-263348778dad",
  origin: {
    kind: "shift" as const,
    projectId: "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
    originalRequestId: "2230bb02-1119-4c69-adad-c44116b375c1",
    shiftId: "shift-20261023-180000-1234",
    runId: "run-owned",
    beadId: "alpha-work",
    attempt: 1,
  },
};
function receipt(): ProjectShiftReceipt {
  const request = {
    requestId: target.origin.originalRequestId,
    expectedCatalogRevision: 7,
    options: {
      for: "2h",
      concurrency: 2,
      maxBeads: 4,
      maxUsd: 10,
      repairs: 3,
      base: "main",
    },
  };
  return {
    intent: {
      projectId: target.projectId,
      workspace: target.workspace,
      shiftId: target.origin.shiftId,
      request,
      requestHash: projectShiftRequestHash(
        target.projectId,
        target.workspace,
        request,
      ),
      createdAt: "2026-10-23T18:00:00.000Z",
      attemptedAt: "2026-10-23T18:00:00.000Z",
    },
    observation: {
      shiftId: target.origin.shiftId,
      requestId: request.requestId,
      phase: "unknown",
      reason: "Saved original",
      actual: null,
    },
  };
}
function held<T>() {
  let complete: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    complete = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      if (!complete) throw Error("Missing reader");
      complete(value);
    },
  };
}

test("held and late original reads cannot publish into another attempt or a closed view", async () => {
  const first = held<unknown>(),
    paths: string[] = [];
  const client = createManagedShiftSessionClient({
    read: async (path) => {
      paths.push(path);
      return first.promise;
    },
    changed() {},
  });
  const reading = client.activate(target);
  expect(client.get().loading).toBe(true);
  expect(client.get().receipt).toBeNull();
  await client.activate(null);
  first.resolve(receipt());
  await reading;
  expect(client.get().receipt).toBeNull();
  expect(client.get().loading).toBe(false);
  expect(paths).toEqual([
    `/projects/${target.projectId}/shifts/requests/${target.origin.originalRequestId}`,
  ]);
  client.close();
});

test("a held prior original cannot replace the new selection after its read settles", async () => {
  const old = held<unknown>(),
    next = {
      ...target,
      origin: {
        ...target.origin,
        originalRequestId: "42509d94-d509-4653-af8b-f4792fc04899",
        shiftId: "shift-20261023-180000-abcd",
      },
    },
    current = receipt();
  current.intent.shiftId = next.origin.shiftId;
  current.intent.request.requestId = next.origin.originalRequestId;
  current.intent.requestHash = projectShiftRequestHash(
    next.projectId,
    next.workspace,
    current.intent.request,
  );
  current.observation.shiftId = next.origin.shiftId;
  current.observation.requestId = next.origin.originalRequestId;
  const client = createManagedShiftSessionClient({
    read: async (path) =>
      path.endsWith(next.origin.originalRequestId) ? current : old.promise,
    changed() {},
  });
  const prior = client.activate(target);
  await client.activate(next);
  expect(client.get().receipt?.intent.request.requestId).toBe(
    next.origin.originalRequestId,
  );
  old.resolve(receipt());
  await prior;
  expect(client.get().receipt?.intent.request.requestId).toBe(
    next.origin.originalRequestId,
  );
  expect(client.get().loading).toBe(false);
  client.close();
});

test("metadata only selects an exact owned Task origin in the current workspace, never an ordinary or foreign session", () => {
  const record = {
    projectId: target.projectId,
    id: target.sessionId,
    requestId: "18da5c95-3218-439c-a33d-e5662465f505",
    requestHash: "a".repeat(64),
    createdAt: "2026-10-23T18:00:00.000Z",
    provider: "claude",
    mode: "task",
    workspace: target.workspace,
    repository: target.workspace,
    worktree: "/repo/trees/work",
    beadId: target.origin.beadId,
    smith: "claude-journeyman",
    requestedModel: "exact-model",
    requestedEffort: "medium",
  };
  const owner = { record, origin: target.origin };
  const select = (raw: unknown, expected?: string) =>
    managedShiftTarget(
      target.projectId,
      target.workspace,
      target.sessionId,
      raw,
      expected,
    );
  expect(select(owner)).toEqual(target);
  for (const raw of [
    { record, origin: null },
    { record: { ...record, mode: "chat" }, origin: target.origin },
    { record: { ...record, workspace: "/foreign" }, origin: target.origin },
    { record: { ...record, repository: "/foreign" }, origin: target.origin },
    {
      record,
      origin: {
        ...target.origin,
        projectId: "project-f05a117f-8d19-4906-80f0-75d72835f3e8",
      },
    },
  ])
    expect(select(raw)).toBeNull();
  expect(select(owner, "42509d94-d509-4653-af8b-f4792fc04899")).toBeNull();
});

test("the managed reader and inspection surface compile for the browser without Node or process-control imports", async () => {
  const build = await Bun.build({
    entrypoints: [
      fileURLToPath(
        new URL(
          "../../apps/desktop/src/ManagedShiftSession.tsx",
          import.meta.url,
        ),
      ),
    ],
    target: "browser",
  });
  expect(build.success, build.logs.map(String).join("\n")).toBe(true);
});

test("only the complete same-scope original hash and Shift association can unlock a private attempt view", async () => {
  let answer: unknown = receipt();
  const client = createManagedShiftSessionClient({
    read: async () => answer,
    changed() {},
  });
  for (const change of [
    (value: ProjectShiftReceipt) => {
      value.intent.workspace = "/foreign";
    },
    (value: ProjectShiftReceipt) => {
      value.intent.shiftId = "shift-20261023-180000-abcd";
      value.observation.shiftId = value.intent.shiftId;
    },
    (value: ProjectShiftReceipt) => {
      value.intent.request.options.maxBeads = 99;
    },
    (value: ProjectShiftReceipt) => {
      value.intent.request.requestId = "42509d94-d509-4653-af8b-f4792fc04899";
      value.observation.requestId = value.intent.request.requestId;
    },
  ]) {
    const value = receipt();
    change(value);
    answer = value;
    await client.activate(target);
    expect(client.get().receipt).toBeNull();
    expect(client.get().error).toContain("original");
  }
  answer = receipt();
  await client.activate(target);
  expect(client.get().receipt?.intent.shiftId).toBe(target.origin.shiftId);
  client.close();
});
