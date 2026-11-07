import { expect, test } from "bun:test";
import type { ProjectDefaults } from "../../../scripts/projects/project-defaults-protocol";
import { ProjectDefaultsSettingsOwner } from "./project-defaults-client";

const id = "project-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const catalog = (
  revision: number,
  claudeSessionSmith = "claude-master",
  other: ProjectDefaults = {},
) => ({
  version: 1,
  revision,
  projects: [
    {
      id,
      name: "Demo",
      description: "",
      icon: "D",
      updatedAt: "2026-11-06T00:00:00.000Z",
      claudeSessionSmith,
      ...other,
    },
  ],
});
test("provider and mode edits verify the complete current defaults while retaining omitted fields", async () => {
  let current = catalog(1);
  const owner = new ProjectDefaultsSettingsOwner({
    read: async () => current,
    post: async (_path, body) => {
      expect(body).toEqual({
        expectedRevision: 1,
        defaults: {
          codexSessionSmith: "codex-journeyman",
          sessionWhere: "new",
        },
      });
      current = catalog(2, "claude-master", {
        codexSessionSmith: "codex-journeyman",
        sessionWhere: "new",
      });
      return Response.json({ ok: true, data: current, error: null });
    },
  });
  owner.adopt(id, current);
  owner.setDefault(id, "codexSessionSmith", "codex-journeyman");
  owner.setDefault(id, "sessionWhere", "new");
  await owner.save(id);
  expect(owner.snapshot().projects[id]?.catalog).toMatchObject({
    claudeSessionSmith: "claude-master",
    codexSessionSmith: "codex-journeyman",
    sessionWhere: "new",
  });
  expect(owner.snapshot().projects[id]?.needsReview).toBe(false);
});
test("Session defaults save reads current state and verifies its receipt before readback", async () => {
  let current = catalog(1);
  let posts = 0;
  const owner = new ProjectDefaultsSettingsOwner({
    read: async () => current,
    post: async (_path, body) => {
      posts++;
      expect(body).toEqual({
        expectedRevision: 1,
        defaults: { claudeSessionSmith: "claude-journeyman" },
      });
      current = catalog(2, "claude-journeyman");
      return Response.json({ ok: true, data: current, error: null });
    },
  });
  owner.adopt(id, current);
  owner.setDraft(id, "claude-journeyman");
  await owner.save(id);
  expect(posts).toBe(1);
  expect(owner.snapshot().projects[id]?.catalog?.claudeSessionSmith).toBe(
    "claude-journeyman",
  );
  expect(owner.snapshot().projects[id]?.message).toContain(
    "read at revision 2",
  );
});
test("Session defaults stale form conflicts without sending and requires an explicit review", async () => {
  let posts = 0;
  const owner = new ProjectDefaultsSettingsOwner({
    read: async () => catalog(2),
    post: async () => {
      posts++;
      throw Error("must not send");
    },
  });
  owner.adopt(id, catalog(1));
  owner.setDraft(id, "claude-journeyman");
  await owner.save(id);
  expect(posts).toBe(0);
  expect(owner.snapshot().projects[id]?.needsReview).toBe(true);
  await owner.save(id);
  expect(posts).toBe(0);
});
test("Session defaults lost response survives reload as unknown and a matching read proves state only", async () => {
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
  const owner = new ProjectDefaultsSettingsOwner(deps);
  owner.adopt(id, current);
  owner.setDraft(id, "claude-journeyman");
  await owner.save(id);
  expect(pending[id]).toBe(1);
  expect(posts).toBe(1);
  current = catalog(2, "claude-journeyman");
  const reopened = new ProjectDefaultsSettingsOwner(deps);
  await reopened.review(id);
  expect(reopened.snapshot().projects[id]?.message).toContain(
    "earlier outcome remains unknown",
  );
  expect(reopened.snapshot().projects[id]?.needsReview).toBe(true);
  expect(posts).toBe(1);
});
test("Session defaults malformed success never becomes a confirmed save", async () => {
  const owner = new ProjectDefaultsSettingsOwner({
    read: async () => catalog(1),
    post: async () =>
      Response.json({
        ok: true,
        data: catalog(7, "claude-journeyman"),
        error: null,
      }),
  });
  owner.adopt(id, catalog(1));
  owner.setDraft(id, "claude-journeyman");
  await owner.save(id);
  expect(owner.snapshot().projects[id]?.message).toContain(
    "outcome is unknown",
  );
  expect(owner.snapshot().projects[id]?.needsReview).toBe(true);
});

test("a refused new intent retains an earlier unresolved Session defaults request", async () => {
  let pending: Record<string, number> = {};
  let sends = 0;
  const owner = new ProjectDefaultsSettingsOwner({
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
  owner.setDraft(id, "claude-journeyman");
  await owner.save(id);
  await owner.review(id);
  owner.confirmReview(id);
  await owner.save(id);
  expect(sends).toBe(2);
  expect(pending[id]).toBe(1);
  expect(owner.snapshot().projects[id]?.needsReview).toBe(true);
});
test("a changed adopted catalog invalidates the reviewed Session defaults draft", () => {
  const owner = new ProjectDefaultsSettingsOwner({
    read: async () => catalog(2),
    post: async () => {
      throw Error("not sent");
    },
  });
  owner.adopt(id, catalog(1));
  owner.setDraft(id, "claude-journeyman");
  owner.adopt(id, catalog(2));
  expect(owner.snapshot().projects[id]?.needsReview).toBe(true);
  expect(owner.snapshot().projects[id]?.draft).toBe("claude-journeyman");
});
test("confirmed Session defaults acceptance remains truthful if recovery storage cleanup fails", async () => {
  let writes = 0;
  const owner = new ProjectDefaultsSettingsOwner({
    read: async () => catalog(1),
    post: async () =>
      Response.json({
        ok: true,
        data: catalog(2, "claude-journeyman"),
        error: null,
      }),
    writePending: () => {
      if (++writes === 2) throw Error("storage unavailable");
    },
  });
  owner.adopt(id, catalog(1));
  owner.setDraft(id, "claude-journeyman");
  await owner.save(id);
  expect(owner.snapshot().projects[id]?.message).toContain(
    "Save accepted at revision 2",
  );
  expect(owner.snapshot().projects[id]?.needsReview).toBe(true);
});
test("Session defaults save readback cannot replace a newer adopted catalog", async () => {
  let reads = 0;
  let release: ((value: unknown) => void) | undefined;
  let waiting: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  const owner = new ProjectDefaultsSettingsOwner({
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
        data: catalog(2, "claude-journeyman"),
        error: null,
      }),
  });
  owner.adopt(id, catalog(1));
  owner.setDraft(id, "claude-journeyman");
  const saving = owner.save(id);
  await entered;
  owner.adopt(id, catalog(4, "claude-master"));
  release?.(catalog(2, "claude-journeyman"));
  await saving;
  expect(owner.snapshot().projects[id]?.catalog?.revision).toBe(4);
  expect(owner.snapshot().projects[id]?.needsReview).toBe(true);
});
