import { describe, expect, test } from "bun:test";
import {
  projectCheckpointReviewCommentText,
  projectCheckpointReviewIntentJson,
  type ProjectCheckpointReviewMetadata,
  type ProjectCheckpointReviewOriginalRead,
  type ProjectCheckpointReviewReceipt,
  type ProjectCheckpointReviewScope,
} from "../../types/project-checkpoint-reviews";
import {
  createProjectCheckpointReviewOwner,
  type ProjectCheckpointReviewTarget,
} from "../../apps/desktop/src/project-checkpoint-review-client";
import type { ProjectCheckpointReviewTransport } from "../../apps/desktop/src/project-checkpoint-review-transport";
import { selectProjectCheckpointReviewView } from "../../apps/desktop/src/use-project-checkpoint-review";

const target: ProjectCheckpointReviewTarget = {
  projectId: "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
  workspacePath: "C:/forge/alpha",
  checkout: "C:/forge/alpha",
  runSlug: "alpha-run",
  epicId: "alpha-epic",
  beadId: "alpha-task",
  runUpdatedAt: "2026-10-29T12:00:00.000Z",
};
const scope: ProjectCheckpointReviewScope = {
  projectId: target.projectId,
  workspacePath: target.workspacePath,
  runSlug: target.runSlug,
  beadId: target.beadId,
};
const at = "2026-10-29T12:00:00.000Z";
const id = "a5832fa0-7a21-403b-8184-44892f0d8d86";
const hashOf = async (value: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

async function records(state: "prepared" | "confirmed" | "refused" | "unknown" | "retired" = "prepared", requestId = id) {
  const draft = {
    schemaVersion: 1 as const,
    requestId,
    binding: { ...target, catalogRevision: 4, scopeHash: "a".repeat(64) },
    decision: "approve" as const,
    note: "Ready to proceed",
    commentText: "",
    createdAt: at,
  };
  const original = { ...draft, commentText: projectCheckpointReviewCommentText(draft), intentHash: "" };
  original.intentHash = await hashOf(projectCheckpointReviewIntentJson(original));
  const receipt: ProjectCheckpointReviewReceipt = {
    schemaVersion: 1, requestId, intentHash: original.intentHash,
    state: state === "prepared" ? "prepared" : state,
    commentId: state === "confirmed" ? "comment-1" : null,
    reportedCommentId: state === "confirmed" ? "comment-1" : null,
    readback: state === "confirmed" ? "found" : state === "unknown" ? "absent" : "not-checked",
    auditEventId: 1, createdAt: at, updatedAt: at,
  };
  const metadata: ProjectCheckpointReviewMetadata = {
    schemaVersion: 1, requestId, intentHash: original.intentHash, scope,
    state, commentId: receipt.commentId, createdAt: at, updatedAt: at,
  };
  const read: ProjectCheckpointReviewOriginalRead = { metadata, original, receipt };
  return { read, metadata };
}

function metadataRead(item: ProjectCheckpointReviewMetadata | null = null) {
  return { schemaVersion: 1 as const, scope, activeRequestId: item && ["prepared", "unknown"].includes(item.state) ? item.requestId : null, blocked: false, items: item ? [item] : [] };
}

function fakeTransport(overrides: Partial<ProjectCheckpointReviewTransport> = {}) {
  const prepared: ProjectCheckpointReviewMetadata[] = [];
  const calls: string[] = [];
  let latest: Awaited<ReturnType<typeof records>> | null = null;
  const transport: ProjectCheckpointReviewTransport = {
    async metadata() { return metadataRead(latest?.metadata ?? prepared.at(-1) ?? null); },
    async original(_scope, requestId) {
      calls.push("original");
      if (!latest || requestId !== latest.read.original.requestId) throw Error("missing original");
      return latest.read;
    },
    async prepare(_scope, request) {
      calls.push(`prepare:${request.decision}:${request.note}`);
      latest = await records("prepared", request.requestId);
      const preparedItem = latest.metadata;
      prepared.push(preparedItem);
      return preparedItem;
    },
    async commit(_scope, requestId, intentHash) {
      calls.push("commit");
      latest = await records("confirmed", requestId);
      return { ...latest.read.receipt, intentHash };
    },
    async retire(_scope, requestId, intentHash) {
      calls.push("retire");
      latest = await records("retired", requestId);
      return { ...latest.read.receipt, intentHash };
    },
    async readback(_scope, requestId, intentHash) {
      calls.push("readback");
      latest = await records("confirmed", requestId);
      return { ...latest.read.receipt, intentHash };
    },
    ...overrides,
  };
  return { transport, calls, prepared, setLatest(value: Awaited<ReturnType<typeof records>>) { latest = value; } };
}

async function readyOwner(transport: ProjectCheckpointReviewTransport) {
  const owner = createProjectCheckpointReviewOwner(target, transport);
  await owner.refresh();
  return owner;
}

describe("checkpoint review owner", () => {
  test("prepares, verifies and records one exact comment in one gesture", async () => {
    const fake = fakeTransport();
    const owner = await readyOwner(fake.transport);
    owner.setNote(" Ready to proceed ");
    await owner.submit("approve");
    expect(fake.calls).toEqual(["prepare:approve:Ready to proceed", "original", "commit"]);
    expect(owner.get().phase).toBe("confirmed");
    const original = owner.get().original?.original;
    expect(original?.commentText).toContain(original?.requestId);
    owner.dispose();
  });

  test("rejects a mismatched saved scope before commit and retains the note", async () => {
    const fake = fakeTransport({
      async original(_scope, requestId) {
        const value = await records("prepared", requestId);
        value.read.original.binding.workspacePath = "C:/foreign";
        return value.read;
      },
    });
    const owner = await readyOwner(fake.transport);
    owner.setNote("preserve this");
    await owner.submit("approve");
    expect(fake.calls).not.toContain("commit");
    expect(owner.get().phase).toBe("held");
    expect(owner.get().note).toBe("preserve this");
    owner.dispose();
  });

  test("target change during prepare fences the old commit", async () => {
    let release!: (value: ProjectCheckpointReviewMetadata) => void;
    const fake = fakeTransport({
      prepare: () => new Promise((resolve) => { release = resolve; }),
    });
    const owner = await readyOwner(fake.transport);
    owner.setNote("keep while moving");
    const action = owner.submit("approve");
    await Promise.resolve();
    owner.setTarget({ ...target, runUpdatedAt: "2026-10-29T12:01:00.000Z" });
    release(fake.prepared[0] ?? {
      schemaVersion: 1, requestId: id, intentHash: "b".repeat(64), scope,
      state: "prepared", commentId: null, createdAt: at, updatedAt: at,
    });
    await action;
    expect(fake.calls).not.toContain("commit");
    owner.dispose();
  });

  test("duplicate gesture while preparing sends only one prepare", async () => {
    let prepareCount = 0;
    const fake = fakeTransport({
      async prepare(_scope, request) {
        prepareCount++;
        return (await records("prepared", request.requestId)).metadata;
      },
      async original(_scope, requestId) { return (await records("prepared", requestId)).read; },
    });
    const owner = await readyOwner(fake.transport);
    owner.setNote("single gesture");
    const first = owner.submit("approve");
    await owner.submit("approve");
    await first;
    expect(prepareCount).toBe(1);
    owner.dispose();
  });

  test("unknown comment stays unresolved through metadata refresh until explicit exact readback", async () => {
    let latest: Awaited<ReturnType<typeof records>> | null = null;
    let commitCount = 0;
    let readbackCount = 0;
    const fake = fakeTransport({
      async metadata() { return metadataRead(latest?.metadata ?? null); },
      async prepare(_scope, request) {
        latest = await records("prepared", request.requestId);
        return latest.metadata;
      },
      async original(_scope, requestId) {
        if (!latest || latest.read.original.requestId !== requestId) throw Error("missing original");
        return latest.read;
      },
      async commit(_scope, requestId, intentHash) {
        commitCount++;
        latest = await records("unknown", requestId);
        return { ...latest.read.receipt, intentHash };
      },
      async readback(_scope, requestId, intentHash) {
        readbackCount++;
        const receipt = (await records("confirmed", requestId)).read.receipt;
        return { ...receipt, intentHash };
      },
    });
    const owner = await readyOwner(fake.transport);
    owner.setNote("reviewed");
    await owner.submit("approve");
    await owner.refresh();
    const requestId = owner.get().metadata?.items[0]?.requestId;
    expect(owner.get().phase).toBe("unknown");
    expect(requestId).toBeDefined();
    expect(readbackCount).toBe(0);
    await owner.openSaved(requestId!);
    expect(owner.get().phase).toBe("unknown");
    await owner.checkRecordedComment();
    expect(owner.get().phase).toBe("confirmed");
    expect(commitCount).toBe(1);
    expect(readbackCount).toBe(1);
    owner.dispose();
  });

  test("recovered prepared original requires a separate explicit record action", async () => {
    const fake = fakeTransport();
    fake.setLatest(await records("prepared"));
    const owner = await readyOwner(fake.transport);
    expect(fake.calls).toEqual([]);
    await owner.openSaved(id);
    expect(owner.get().phase).toBe("prepared");
    expect(fake.calls).toEqual(["original"]);
    await owner.recordSaved();
    expect(fake.calls).toEqual(["original", "commit"]);
    expect(owner.get().phase).toBe("confirmed");
    owner.dispose();
  });

  test("historical original read binds route scope without requiring current run metadata", async () => {
    const fake = fakeTransport();
    fake.setLatest(await records("prepared"));
    const owner = await readyOwner(fake.transport);
    owner.setTarget({ ...target, checkout: "C:/new-checkout", epicId: "new-epic", runUpdatedAt: "2026-10-29T13:00:00.000Z" });
    await owner.refresh();
    await owner.openSaved(id);
    expect(owner.get().phase).toBe("prepared");
    expect(owner.get().original?.original.binding).toMatchObject({
      checkout: target.checkout,
      epicId: target.epicId,
      runUpdatedAt: target.runUpdatedAt,
    });
    expect(fake.calls).toEqual(["original"]);
    owner.dispose();
  });

  test("owner switch renders only the new owner's view before effects run", () => {
    const oldOwner = createProjectCheckpointReviewOwner(target, fakeTransport().transport);
    const nextOwner = createProjectCheckpointReviewOwner({ ...target, beadId: "other-task" }, fakeTransport().transport);
    oldOwner.setNote("private old note");
    nextOwner.setNote("new scope note");
    const snapshot = { owner: oldOwner, view: oldOwner.get() };
    expect(selectProjectCheckpointReviewView(nextOwner, snapshot)).toEqual(nextOwner.get());
    expect(selectProjectCheckpointReviewView(nextOwner, snapshot).note).toBe("new scope note");
    oldOwner.dispose();
    nextOwner.dispose();
  });

  test("request changes cannot be prepared without a note", async () => {
    const fake = fakeTransport();
    const owner = await readyOwner(fake.transport);
    await owner.submit("request-changes");
    expect(fake.calls).toEqual([]);
    expect(owner.get().phase).toBe("ready");
    expect(owner.get().error).toContain("note");
    owner.dispose();
  });
});
