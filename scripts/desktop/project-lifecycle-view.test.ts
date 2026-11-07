import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ProjectLifecycleFeedback } from "../../apps/desktop/src/ProjectLifecycleSettings";
import {
  ProjectLifecycleOwner,
  projectLifecycleForProject,
} from "../../apps/desktop/src/project-lifecycle-client";
import { attrs, findAll, textOf } from "../dashboard/ds/vnode";
import {
  canonicalProjectDeletion,
  projectDeletionReceiptSchema,
} from "../projects/project-lifecycle-protocol";

const id = "project-10000000-0000-4000-8000-000000000001",
  other = "project-10000000-0000-4000-8000-000000000099",
  uuid = "20000000-0000-4000-8000-000000000002";

test("deletion feedback keeps a confirmed project's action separate from global recovery storage failure", async () => {
  const request = {
      requestId: uuid,
      expectedRevision: 2,
      confirmName: "Alpha",
    },
    hash = async (text: string) =>
      createHash("sha256").update(text).digest("hex"),
    receipt = projectDeletionReceiptSchema.parse({
      projectId: id,
      requestId: uuid,
      requestHash: await hash(canonicalProjectDeletion(id, request)),
      name: "Alpha",
      slug: "alpha",
      deletedRevision: 3,
      deletedAt: "2026-11-06T00:00:01.000Z",
    });
  let metadata: unknown = {},
    writes = 0;
  const owner = new ProjectLifecycleOwner({
    read: async (): Promise<unknown> => ({
      projectId: id,
      catalogRevision: 2,
      asOf: "2026-11-06T00:00:00.000Z",
      archived: true,
      state: "eligible",
      reasons: [],
    }),
    post: async () => Response.json({ ok: true, data: receipt, error: null }),
    readPending: () => structuredClone(metadata),
    writePending(value) {
      if (++writes > 1) throw Error("Storage cleanup failed");
      metadata = structuredClone(value);
    },
    withLock: async (work) => work(),
    uuid: () => uuid,
    hash,
  });
  await owner.check(id);
  await owner.remove(id, "Alpha");
  expect(owner.snapshot().storageError).toBe(true);
  const foreign = projectLifecycleForProject(owner.snapshot(), other),
    foreignFeedback = ProjectLifecycleFeedback({ view: foreign }),
    foreignText = textOf(foreignFeedback);
  expect(foreign.phase).toBe("idle");
  expect(foreign.receipt).toBeNull();
  expect(foreign.pending).toBeNull();
  expect(foreign.message).toBe("");
  expect(foreignText).toContain("Restore browser storage");
  expect(foreignText).not.toContain("Project record deleted");
  expect(foreignText).not.toContain("Alpha");
  expect(foreignText).not.toContain(uuid);
  expect(
    findAll(foreignFeedback, "p").some((node) => attrs(node).role === "alert"),
  ).toBe(true);
  const own = projectLifecycleForProject(owner.snapshot(), id),
    ownText = textOf(ProjectLifecycleFeedback({ view: own }));
  expect(own.phase).toBe("confirmed");
  expect(own.receipt).toEqual(receipt);
  expect(ownText).toContain("Project record deleted");
  expect(ownText).toContain("Alpha");
  expect(ownText).toContain(uuid);
});
