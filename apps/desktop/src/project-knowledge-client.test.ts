import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { NotSent } from "../../../docs/js/operator";
import {
  canonicalKnowledgeRefresh,
  type KnowledgeReceipt,
  type KnowledgeStatus,
  knowledgeRefreshRequestSchema,
} from "../../../scripts/projects/knowledge-protocol";
import { FIXTURE_PROJECT_ID } from "../../../scripts/projects/testing";
import { ProjectKnowledgeOwner } from "./project-knowledge-client";

const id = FIXTURE_PROJECT_ID,
  uuid = "90000000-0000-4000-8000-000000000001";
const status: KnowledgeStatus = {
  projectId: id,
  catalogRevision: 1,
  repositoryKey: "a".repeat(64),
  name: "alpha",
  state: "missing",
  ageDays: null,
  freshness: "missing",
  asOf: "2026-11-06T00:00:00.000Z",
  archived: false,
};
function fixture() {
  let pending: unknown = {},
    posts = 0,
    nextUuid = uuid,
    mode = "confirmed",
    writesFail = false;
  const receipts = new Map<string, KnowledgeReceipt>();
  const hash = async (text: string) =>
    createHash("sha256").update(text).digest("hex");
  const deps = {
    uuid: () => nextUuid,
    hash,
    readPending: () => structuredClone(pending),
    writePending: (value: unknown) => {
      if (writesFail) throw Error("storage unavailable");
      pending = structuredClone(value);
    },
    withLock: async <T>(work: () => Promise<T>) => work(),
    read: async (url: string): Promise<unknown> =>
      !url.endsWith("/knowledge")
        ? (receipts.get(url.split("/").at(-1) ?? "") ??
          (() => {
            throw Error("not found");
          })())
        : status,
    post: async (_url: string, body: unknown) => {
      posts++;
      if (mode === "not-sent") throw new NotSent("No token");
      if (mode === "refused")
        return new Response('{"ok":false,"error":"Changed project"}', {
          status: 409,
        });
      const request = knowledgeRefreshRequestSchema.parse(body);
      let saved: KnowledgeReceipt = {
        projectId: id,
        requestId: request.requestId,
        requestHash: await hash(canonicalKnowledgeRefresh(id, request)),
        repositoryKey: request.repositoryKey,
        state: "confirmed",
        sourceCommit: "b".repeat(40),
        evidenceHash: "c".repeat(64),
        candidateHash: "d".repeat(64),
        confirmedAt: "2026-11-06T00:00:01.000Z",
        message: "Exact candidate present",
        retainedExtensions: [],
      };
      if (mode === "reserved")
        saved = {
          ...saved,
          state: "reserved",
          candidateHash: null,
          confirmedAt: null,
          message: "Original reserved; attempt is unconfirmed",
        };
      if (mode === "mismatched")
        saved = { ...saved, requestHash: "f".repeat(64) };
      receipts.set(request.requestId, saved);
      if (mode === "lost") throw Error("lost response");
      return new Response(
        JSON.stringify({ ok: true, data: saved, error: null }),
        { status: 200 },
      );
    },
  };
  return {
    deps,
    owner: new ProjectKnowledgeOwner(deps),
    posts: () => posts,
    pending: () => pending,
    setMode(value: string) {
      mode = value;
    },
    nextUuid(value: string) {
      nextUuid = value;
    },
    failWrites() {
      writesFail = true;
    },
  };
}
test("knowledge unknown delivery restores exact metadata and read-only recovery never repeats generation", async () => {
  const f = fixture();
  await f.owner.inspect(id);
  f.setMode("lost");
  await f.owner.refresh(id);
  expect(f.posts()).toBe(1);
  expect(f.owner.snapshot().pending[id]?.requestId).toBe(uuid);
  const reopened = new ProjectKnowledgeOwner(f.deps);
  await reopened.checkOriginal(id);
  expect(reopened.snapshot().receipts[id]?.state).toBe("confirmed");
  expect(reopened.snapshot().pending[id]).toBeUndefined();
  expect(f.posts()).toBe(1);
});
test("knowledge shared pending identity prevents a second tab from dispatching and confirmed truth survives storage cleanup failure", async () => {
  const f = fixture();
  await f.owner.inspect(id);
  f.setMode("lost");
  await f.owner.refresh(id);
  const other = new ProjectKnowledgeOwner(f.deps);
  await other.inspect(id);
  await other.refresh(id);
  expect(f.posts()).toBe(1);
  f.failWrites();
  await other.checkOriginal(id);
  expect(other.snapshot().receipts[id]?.state).toBe("confirmed");
  expect(other.snapshot().storageError).toBe(true);
});
test.each([
  "not-sent",
  "refused",
])("knowledge known nondelivery releases only its exact local claim: %s", async (mode) => {
  const f = fixture();
  await f.owner.inspect(id);
  f.setMode(mode);
  await f.owner.refresh(id);
  expect(f.owner.snapshot().pending[id]).toBeUndefined();
  expect(f.posts()).toBe(1);
});
test("knowledge storage failure prevents dispatch while retained source inspection remains read-only", async () => {
  const f = fixture();
  await f.owner.inspect(id);
  f.failWrites();
  await f.owner.refresh(id);
  expect(f.posts()).toBe(0);
  expect(f.owner.snapshot().storageError).toBe(true);
  expect(f.owner.snapshot().statuses[id]).toEqual(status);
});

test("an already-open owner retains another project's unknown original through a fresh claim and known refusal after a second tab cleared shared storage", async () => {
  const f = fixture(),
    otherId = "project-90000000-0000-4000-8000-000000000002",
    read = f.deps.read;
  f.deps.read = async (url) =>
    url.includes(otherId) ? { ...status, projectId: otherId } : read(url);
  await f.owner.inspect(id);
  f.setMode("lost");
  await f.owner.refresh(id);
  const other = new ProjectKnowledgeOwner(f.deps);
  await other.checkOriginal(id);
  expect(f.pending()).toEqual({});
  const secondUuid = "90000000-0000-4000-8000-000000000002";
  f.nextUuid(secondUuid);
  f.setMode("lost");
  await other.inspect(id);
  await other.refresh(id);
  expect(other.snapshot().pending[id]?.requestId).toBe(secondUuid);
  await f.owner.inspect(otherId);
  f.setMode("refused");
  await f.owner.refresh(otherId);
  expect(f.owner.snapshot().pending[id]?.requestId).toBe(uuid);
  expect(f.owner.snapshot().pending[otherId]).toBeUndefined();
  expect(f.posts()).toBe(3);
  await f.owner.checkOriginal(id);
  expect(f.owner.snapshot().receipts[id]?.state).toBe("confirmed");
  expect(f.owner.snapshot().pending[id]?.requestId).toBe(secondUuid);
});

test("a normalized post-reservation refusal remains a held exact original rather than being cleared as nondelivery", async () => {
  const f = fixture();
  await f.owner.inspect(id);
  f.setMode("reserved");
  await f.owner.refresh(id);
  expect(f.owner.snapshot().pending[id]?.requestId).toBe(uuid);
  expect(f.owner.snapshot().receipts[id]?.state).toBe("reserved");
  const reopened = new ProjectKnowledgeOwner(f.deps);
  await reopened.checkOriginal(id);
  expect(reopened.snapshot().pending[id]?.requestId).toBe(uuid);
  expect(f.posts()).toBe(1);
});

test("a mismatched result cannot confirm or clear the locally saved original", async () => {
  const f = fixture();
  await f.owner.inspect(id);
  f.setMode("mismatched");
  await f.owner.refresh(id);
  expect(f.owner.snapshot().receipts[id]).toBeUndefined();
  expect(f.owner.snapshot().pending[id]?.requestId).toBe(uuid);
  await f.owner.checkOriginal(id);
  expect(f.owner.snapshot().pending[id]?.requestId).toBe(uuid);
  expect(f.posts()).toBe(1);
});
