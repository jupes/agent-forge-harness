import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { NotSent } from "../../../docs/js/operator";
import { canonicalProjectDeletion } from "../../../scripts/projects/project-lifecycle-protocol";
import { ProjectLifecycleOwner } from "./project-lifecycle-client";

const id = "project-10000000-0000-4000-8000-000000000001",
  uuid = "20000000-0000-4000-8000-000000000002";
const withLock = async <T>(work: () => Promise<T>) => work();
const hash = async (text: string) =>
  createHash("sha256").update(text).digest("hex");
const status = {
  projectId: id,
  catalogRevision: 2,
  asOf: "2026-11-06T00:00:00.000Z",
  archived: true,
  state: "eligible",
  reasons: [],
};
test("two already-open tabs merge pending originals and clean only their exact claim", async () => {
  const other = "project-10000000-0000-4000-8000-000000000099";
  let metadata: unknown = {},
    tail = Promise.resolve(),
    posts = 0;
  const sharedLock = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work);
    tail = next.then(
      () => {},
      () => {},
    );
    return next;
  };
  const deps = {
    read: async (url: string) => ({
      ...status,
      projectId: url.includes(other) ? other : id,
    }),
    post: async (url: string) => {
      posts++;
      if (url.includes(other)) throw new NotSent("No operator session");
      throw Error("Lost reply");
    },
    withLock: sharedLock,
    readPending: () => metadata,
    writePending: (value: unknown) => {
      metadata = structuredClone(value);
    },
    uuid: () => crypto.randomUUID(),
    hash,
  };
  const a = new ProjectLifecycleOwner(deps),
    b = new ProjectLifecycleOwner(deps),
    sameProject = new ProjectLifecycleOwner(deps);
  await a.check(id);
  await b.check(other);
  await sameProject.check(id);
  await a.remove(id, "Alpha");
  const original = structuredClone(metadata);
  await b.remove(other, "Beta");
  expect(metadata).toEqual(original);
  await sameProject.remove(id, "Alpha");
  expect(posts).toBe(2);
  expect(metadata).toEqual(original);
  expect(sameProject.snapshot().pending[id]).toEqual(a.snapshot().pending[id]);
  expect(sameProject.snapshot().messageProjectId).toBe(id);
  expect(sameProject.snapshot().message).toContain("Another tab");
});
test("lost deletion reply survives restart and exact receipt lookup confirms once without resending", async () => {
  let metadata: unknown = {},
    posts = 0,
    receipt: unknown = null;
  const paths: string[] = [];
  const deps = {
    read: async (url: string) => {
      paths.push(url);
      return url.endsWith(uuid) ? receipt : status;
    },
    post: async (_url: string, raw: unknown) => {
      posts++;
      const request = raw as {
        requestId: string;
        expectedRevision: number;
        confirmName: string;
      };
      receipt = {
        projectId: id,
        requestId: uuid,
        requestHash: await hash(canonicalProjectDeletion(id, request)),
        name: "Alpha",
        slug: "alpha",
        deletedRevision: 3,
        deletedAt: "2026-11-06T00:00:01.000Z",
      };
      throw Error("Lost reply after commit");
    },
    withLock,
    readPending: () => metadata,
    writePending: (value: unknown) => {
      metadata = structuredClone(value);
    },
    uuid: () => uuid,
    hash,
  };
  const first = new ProjectLifecycleOwner(deps);
  await first.check(id);
  await first.remove(id, "Alpha");
  expect(posts).toBe(1);
  expect(first.snapshot().pending[id]?.requestId).toBe(uuid);
  expect(first.snapshot().receipts[id]).toBeUndefined();
  const restarted = new ProjectLifecycleOwner(deps);
  await restarted.remove(id, "Alpha");
  expect(posts).toBe(1);
  await restarted.check(id);
  expect(paths.at(-1)).toContain(`/deletion/${uuid}`);
  expect(receipt).toEqual(restarted.snapshot().receipts[id]);
  expect(metadata).toEqual({});
  await first.check(id);
  expect(receipt).toEqual(first.snapshot().receipts[id]);
  await restarted.remove(id, "Alpha");
  expect(posts).toBe(1);
});
test("missing, malformed and mismatching exact receipts retain the pending deletion original", async () => {
  const pending = {
      [id]: { requestId: uuid, requestHash: "a".repeat(64), revision: 2 },
    },
    posts: string[] = [];
  for (const reply of [
    null,
    {},
    {
      projectId: id,
      requestId: uuid,
      requestHash: "b".repeat(64),
      name: "Alpha",
      slug: "alpha",
      deletedRevision: 3,
      deletedAt: "2026-11-06T00:00:01.000Z",
    },
  ]) {
    const owner = new ProjectLifecycleOwner({
      read: async () => reply,
      post: async (url) => {
        posts.push(url);
        throw Error("Must not send");
      },
      withLock,
      readPending: () => pending,
      writePending: () => {},
      uuid: () => uuid,
      hash,
    });
    await owner.check(id);
    await owner.remove(id, "Alpha");
    expect(owner.snapshot().pending).toEqual(pending);
    expect(owner.snapshot().receipts[id]).toBeUndefined();
  }
  expect(posts).toEqual([]);
});
test("preflight changes, broken storage and typed NotSent never leave a dispatchable blind retry", async () => {
  let reads = 0,
    posts = 0,
    metadata: unknown = {};
  const deps = {
    read: async () => ({ ...status, catalogRevision: ++reads === 1 ? 2 : 3 }),
    post: async () => {
      posts++;
      throw new NotSent("No operator session");
    },
    withLock,
    readPending: () => metadata,
    writePending: (value: unknown) => {
      metadata = value;
    },
    uuid: () => uuid,
    hash,
  };
  const stale = new ProjectLifecycleOwner(deps);
  await stale.check(id);
  await stale.remove(id, "Alpha");
  expect(posts).toBe(0);
  expect(metadata).toEqual({});
  const notSent = new ProjectLifecycleOwner({
    ...deps,
    read: async () => status,
  });
  await notSent.check(id);
  await notSent.remove(id, "Alpha");
  expect(posts).toBe(1);
  expect(notSent.snapshot().pending).toEqual({});
  expect(notSent.snapshot().statuses[id]).toBeUndefined();
  const broken = new ProjectLifecycleOwner({
    ...deps,
    withLock,
    readPending: () => {
      throw Error("Storage unavailable");
    },
  });
  await broken.check(id);
  await broken.remove(id, "Alpha");
  expect(posts).toBe(1);
  expect(broken.snapshot().storageError).toBe(true);
});
test("a confirmed deletion stays confirmed when local cleanup or Projects refresh fails", async () => {
  const request = {
      requestId: uuid,
      expectedRevision: 2,
      confirmName: "Alpha",
    },
    receipt = {
      projectId: id,
      requestId: uuid,
      requestHash: await hash(canonicalProjectDeletion(id, request)),
      name: "Alpha",
      slug: "alpha",
      deletedRevision: 3,
      deletedAt: "2026-11-06T00:00:01.000Z",
    };
  let writes = 0,
    metadata: unknown = {};
  const owner = new ProjectLifecycleOwner({
    read: async () => status,
    post: async () => Response.json({ ok: true, data: receipt, error: null }),
    withLock,
    readPending: () => metadata,
    writePending: (value) => {
      if (++writes > 1) throw Error("Storage cleanup failed");
      metadata = structuredClone(value);
    },
    uuid: () => uuid,
    hash,
    refresh: async () => {
      throw Error("Refresh failed");
    },
  });
  await owner.check(id);
  await owner.remove(id, "Alpha");
  expect(owner.snapshot().receipts[id]).toEqual(receipt);
  expect(owner.snapshot().storageError).toBe(true);
  expect(owner.snapshot().message).toContain("confirmed");
});
