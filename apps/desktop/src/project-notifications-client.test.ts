import { expect, test } from "bun:test";
import { NotSent } from "../../../docs/js/operator";
import { NO_PROJECT_NOTIFICATIONS } from "../../../scripts/projects/project-notifications-protocol";
import { projectCatalogFixture } from "../../../scripts/projects/testing";
import { createProjectNotificationsOwner } from "./project-notifications-client";

const id = projectCatalogFixture("/repo").projects[0]!.id;
const preferences = { ...NO_PROJECT_NOTIFICATIONS, "failed-gate": true };
const catalog = (
  revision: number,
  notifications = { ...NO_PROJECT_NOTIFICATIONS },
) => ({
  ...projectCatalogFixture("/repo"),
  revision,
  projects: projectCatalogFixture("/repo").projects.map((project) => ({
    ...project,
    notifications,
  })),
});
const response = (data: unknown) =>
  Response.json({ ok: true, data, error: null });

test("notification settings verify exact receipt and readback before clearing a draft", async () => {
  let current = catalog(1),
    posts = 0;
  const owner = createProjectNotificationsOwner({
    read: async () => current,
    post: async (path, body) => {
      posts++;
      expect(path).toEndWith(`/projects/${id}/settings/notifications`);
      expect(body).toEqual({ expectedRevision: 1, notifications: preferences });
      current = catalog(2, preferences);
      return response(current);
    },
  });
  owner.adopt(id, current);
  owner.edit(id, preferences);
  await owner.save(id);
  expect(posts).toBe(1);
  expect(owner.snapshot().projects[id]).toMatchObject({
    draft: null,
    needsReview: false,
    catalog: { revision: 2, value: preferences },
  });
});

test("stale notification drafts require explicit review before any POST", async () => {
  let posts = 0;
  const owner = createProjectNotificationsOwner({
    read: async () => catalog(2),
    post: async () => {
      posts++;
      return response(catalog(3));
    },
  });
  owner.adopt(id, catalog(1));
  owner.edit(id, preferences);
  await owner.save(id);
  expect(posts).toBe(0);
  expect(owner.snapshot().projects[id]?.needsReview).toBe(true);
  owner.edit(id, preferences);
  await owner.save(id);
  expect(posts).toBe(0);
});

test.each([
  "lost",
  "malformed",
  "wrong-value",
  "wrong-revision",
])("%s notification save stays unknown across navigation and reload", async (kind) => {
  let pending: Record<string, number> = {},
    posts = 0;
  const dependencies = {
    read: async () => catalog(1),
    readPending: () => pending,
    writePending: (value: Record<string, number>) => {
      pending = value;
    },
    post: async () => {
      posts++;
      if (kind === "lost") throw Error("Lost response");
      return kind === "malformed"
        ? Response.json({ ok: "true" })
        : response(
            catalog(
              kind === "wrong-revision" ? 1 : 2,
              kind === "wrong-value"
                ? { ...NO_PROJECT_NOTIFICATIONS }
                : preferences,
            ),
          );
    },
  };
  const owner = createProjectNotificationsOwner(dependencies);
  owner.adopt(id, catalog(1));
  owner.edit(id, preferences);
  await owner.save(id);
  expect(owner.snapshot().projects[id]?.message).toContain("unknown");
  const restored = createProjectNotificationsOwner(dependencies);
  restored.adopt(id, catalog(1));
  restored.edit(id, preferences);
  await restored.save(id);
  expect(posts).toBe(1);
  expect(restored.snapshot().projects[id]?.needsReview).toBe(true);
  await restored.review(id);
  expect(posts).toBe(1);
  expect(restored.snapshot().projects[id]?.message).toContain(
    "current state only",
  );
});

test("notification settings refuse dispatch when pending metadata cannot be persisted", async () => {
  let posts = 0;
  const owner = createProjectNotificationsOwner({
    read: async () => catalog(1),
    post: async () => {
      posts++;
      return response(catalog(2));
    },
    writePending: () => {
      throw Error("Storage unavailable");
    },
  });
  owner.adopt(id, catalog(1));
  owner.edit(id, preferences);
  await owner.save(id);
  expect(posts).toBe(0);
  expect(owner.snapshot().projects[id]?.message).toContain("not sent");
});

test("known not-sent refusal preserves an earlier unresolved notification request", async () => {
  let pending: Record<string, number> = { [id]: 1 },
    posts = 0;
  const owner = createProjectNotificationsOwner({
    read: async () => catalog(1),
    readPending: () => pending,
    writePending: (value) => {
      pending = value;
    },
    post: async () => {
      posts++;
      throw new NotSent("Refused before effect");
    },
  });
  owner.adopt(id, catalog(1));
  await owner.review(id);
  owner.confirmReview(id);
  owner.edit(id, preferences);
  await owner.save(id);
  expect(posts).toBe(1);
  expect(pending[id]).toBe(1);
  expect(owner.snapshot().projects[id]?.needsReview).toBe(true);
});

test("a late notification preflight cannot replace a newer adopted catalog or send a write", async () => {
  let posts = 0,
    finish: ((value: unknown) => void) | undefined;
  const owner = createProjectNotificationsOwner({
    read: async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    post: async () => {
      posts++;
      return response(catalog(3));
    },
  });
  owner.adopt(id, catalog(1));
  owner.edit(id, preferences);
  const saving = owner.save(id);
  owner.adopt(id, catalog(3));
  finish?.(catalog(2));
  await saving;
  expect(posts).toBe(0);
  expect(owner.snapshot().projects[id]).toMatchObject({
    catalog: { revision: 3 },
    needsReview: true,
    checked: false,
    draft: preferences,
  });
});

test("late notification readback never replaces a newer catalog", async () => {
  let reads = 0,
    finish: ((value: unknown) => void) | undefined;
  const owner = createProjectNotificationsOwner({
    read: async () =>
      ++reads === 1
        ? catalog(1)
        : new Promise((resolve) => {
            finish = resolve;
          }),
    post: async () => response(catalog(2, preferences)),
  });
  owner.adopt(id, catalog(1));
  owner.edit(id, preferences);
  const saving = owner.save(id);
  await Bun.sleep(0);
  owner.adopt(id, catalog(3));
  finish?.(catalog(2, preferences));
  await saving;
  expect(owner.snapshot().projects[id]?.catalog?.revision).toBe(3);
  expect(owner.snapshot().projects[id]?.needsReview).toBe(true);
  expect(owner.snapshot().projects[id]?.message).toContain(
    "Save accepted at revision 2",
  );
});
