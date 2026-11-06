import { expect, test } from "bun:test";
import { ProjectKeeperSettingsOwner } from "./project-keeper-settings-client";

const id = "project-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const catalog = (revision: number, keeperSmith = "claude-master") => ({
  version: 1,
  revision,
  projects: [
    {
      id,
      name: "Demo",
      description: "",
      icon: "D",
      updatedAt: "2026-11-06T00:00:00.000Z",
      keeperSmith,
    },
  ],
});
test("Keeper save reads current state and verifies its receipt before readback", async () => {
  let current = catalog(1);
  let posts = 0;
  const owner = new ProjectKeeperSettingsOwner({
    read: async () => current,
    post: async (_path, body) => {
      posts++;
      expect(body).toEqual({
        expectedRevision: 1,
        keeper: { keeperSmith: "codex-journeyman" },
      });
      current = catalog(2, "codex-journeyman");
      return Response.json({ ok: true, data: current, error: null });
    },
  });
  owner.adopt(id, current);
  owner.setDraft(id, "codex-journeyman");
  await owner.save(id);
  expect(posts).toBe(1);
  expect(owner.snapshot().projects[id]?.catalog?.keeperSmith).toBe(
    "codex-journeyman",
  );
  expect(owner.snapshot().projects[id]?.message).toContain(
    "read at revision 2",
  );
});
test("Keeper stale form conflicts without sending and requires an explicit review", async () => {
  let posts = 0;
  const owner = new ProjectKeeperSettingsOwner({
    read: async () => catalog(2),
    post: async () => {
      posts++;
      throw Error("must not send");
    },
  });
  owner.adopt(id, catalog(1));
  owner.setDraft(id, "codex-journeyman");
  await owner.save(id);
  expect(posts).toBe(0);
  expect(owner.snapshot().projects[id]?.needsReview).toBe(true);
  await owner.save(id);
  expect(posts).toBe(0);
});
test("Keeper lost response survives reload as unknown and a matching read proves state only", async () => {
  let pending: Record<string, number> = {};
  let current = catalog(1);
  let posts = 0;
  const deps = {
    read: async () => current,
    post: async () => {
      posts++;
      throw Error("lost reply");
    },
    readPending: () => pending,
    writePending: (value: Record<string, number>) => {
      pending = { ...value };
    },
  };
  const owner = new ProjectKeeperSettingsOwner(deps);
  owner.adopt(id, current);
  owner.setDraft(id, "codex-journeyman");
  await owner.save(id);
  expect(pending[id]).toBe(1);
  expect(posts).toBe(1);
  current = catalog(2, "codex-journeyman");
  const reopened = new ProjectKeeperSettingsOwner(deps);
  await reopened.review(id);
  expect(reopened.snapshot().projects[id]?.message).toContain(
    "earlier outcome remains unknown",
  );
  expect(reopened.snapshot().projects[id]?.needsReview).toBe(true);
  expect(posts).toBe(1);
});
test("Keeper malformed success never becomes a confirmed save", async () => {
  const owner = new ProjectKeeperSettingsOwner({
    read: async () => catalog(1),
    post: async () =>
      Response.json({
        ok: true,
        data: catalog(7, "codex-journeyman"),
        error: null,
      }),
  });
  owner.adopt(id, catalog(1));
  owner.setDraft(id, "codex-journeyman");
  await owner.save(id);
  expect(owner.snapshot().projects[id]?.message).toContain(
    "outcome is unknown",
  );
  expect(owner.snapshot().projects[id]?.needsReview).toBe(true);
});

test("a refused new intent retains an earlier unresolved Keeper request", async () => {
  let pending: Record<string, number> = {};
  let sends = 0;
  const owner = new ProjectKeeperSettingsOwner({
    read: async () => catalog(1),
    post: async () => {
      if (++sends === 1) throw Error("lost");
      return Response.json(
        { ok: false, data: null, error: "refused" },
        { status: 400 },
      );
    },
    readPending: () => pending,
    writePending: (value) => {
      pending = { ...value };
    },
  });
  owner.adopt(id, catalog(1));
  owner.setDraft(id, "codex-journeyman");
  await owner.save(id);
  await owner.review(id);
  owner.confirmReview(id);
  await owner.save(id);
  expect(sends).toBe(2);
  expect(pending[id]).toBe(1);
  expect(owner.snapshot().projects[id]?.needsReview).toBe(true);
});
test("a changed adopted catalog invalidates the reviewed Keeper draft", () => {
  const owner = new ProjectKeeperSettingsOwner({
    read: async () => catalog(2),
    post: async () => {
      throw Error("not sent");
    },
  });
  owner.adopt(id, catalog(1));
  owner.setDraft(id, "codex-journeyman");
  owner.adopt(id, catalog(2));
  expect(owner.snapshot().projects[id]?.needsReview).toBe(true);
  expect(owner.snapshot().projects[id]?.draft).toBe("codex-journeyman");
});
test("confirmed Keeper acceptance remains truthful if recovery storage cleanup fails", async () => {
  let writes = 0;
  const owner = new ProjectKeeperSettingsOwner({
    read: async () => catalog(1),
    post: async () =>
      Response.json({
        ok: true,
        data: catalog(2, "codex-journeyman"),
        error: null,
      }),
    writePending: () => {
      if (++writes === 2) throw Error("storage unavailable");
    },
  });
  owner.adopt(id, catalog(1));
  owner.setDraft(id, "codex-journeyman");
  await owner.save(id);
  expect(owner.snapshot().projects[id]?.message).toContain(
    "Save accepted at revision 2",
  );
  expect(owner.snapshot().projects[id]?.needsReview).toBe(true);
});
test("Keeper save readback cannot replace a newer adopted catalog", async () => {
  let reads = 0;
  let release: ((value: unknown) => void) | undefined;
  let waiting: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  const owner = new ProjectKeeperSettingsOwner({
    read: async () => {
      if (++reads === 1) return catalog(1);
      waiting();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    post: async () =>
      Response.json({
        ok: true,
        data: catalog(2, "codex-journeyman"),
        error: null,
      }),
  });
  owner.adopt(id, catalog(1));
  owner.setDraft(id, "codex-journeyman");
  const saving = owner.save(id);
  await entered;
  owner.adopt(id, catalog(4, "claude-master"));
  release?.(catalog(2, "codex-journeyman"));
  await saving;
  expect(owner.snapshot().projects[id]?.catalog?.revision).toBe(4);
  expect(owner.snapshot().projects[id]?.needsReview).toBe(true);
});
