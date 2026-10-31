import { expect, test } from "bun:test";
import { NotSent } from "../../../docs/js/operator";
import type { ProjectGeneralSettings } from "../../../scripts/projects/project-general-protocol";
import type { ProjectCatalog, ProjectRecord } from "../../../types/projects";
import {
  type GeneralDraft,
  generalCatalogForProject,
  ProjectGeneralSettingsOwner,
  validatedGeneralCatalog,
} from "./project-general-settings-client";

const alpha: ProjectRecord = {
  id: "project-alpha",
  slug: "alpha",
  name: "Alpha",
  description: "Fixture project",
  icon: "A",
  workspaces: [{ root: "C:/fixture", repositories: [], epicIds: [] }],
  color: "blue",
  pinned: false,
  archived: false,
  createdAt: "2026-10-21T00:00:00.000Z",
  updatedAt: "2026-10-21T00:00:00.000Z",
};
const catalog = (
  revision: number,
  project: ProjectRecord = alpha,
): ProjectCatalog => ({
  version: 1,
  revision,
  projects: [project],
});
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ ok: true, data, error: null }), { status });
const submitted: ProjectGeneralSettings = {
  name: "Alpha renamed",
  description: "Fixture project",
  icon: "A",
  color: "blue",
};
const draft: GeneralDraft = submitted;

function updated(
  revision: number,
  general: ProjectGeneralSettings,
): ProjectCatalog {
  const { color, ...requiredGeneral } = general;
  const project: ProjectRecord = {
    ...alpha,
    ...requiredGeneral,
    updatedAt: "2026-10-31T00:00:00.000Z",
  };
  if (color === undefined) delete project.color;
  else project.color = color;
  return catalog(revision, project);
}

test("sends the complete General snapshot at the reviewed catalog revision", async () => {
  let current = catalog(7);
  let summaryRefreshes = 0;
  const posts: { url: string; body: unknown }[] = [];
  const owner = new ProjectGeneralSettingsOwner({
    read: async () => current,
    refreshHome: async () => {
      summaryRefreshes++;
    },
    post: async (url, body) => {
      posts.push({ url, body });
      current = updated(8, submitted);
      return response(current);
    },
  });
  owner.setDraft("project-alpha", draft);

  await owner.save("project-alpha", 7, alpha, draft);

  expect(posts).toEqual([
    {
      url: "/__agent-forge/projects/project-alpha/settings/general",
      body: { expectedRevision: 7, general: submitted },
    },
  ]);
  expect(owner.snapshot().catalog?.revision).toBe(8);
  expect(owner.snapshot().drafts["project-alpha"]).toBeUndefined();
  expect(summaryRefreshes).toBe(1);
});

test("503 remains unknown and a catalog check never resends the old request", async () => {
  let current = catalog(7);
  let posts = 0;
  const owner = new ProjectGeneralSettingsOwner({
    read: async () => current,
    post: async () => {
      posts++;
      return new Response(JSON.stringify({ ok: false, error: "Unavailable" }), {
        status: 503,
      });
    },
  });
  owner.setDraft("project-alpha", draft);

  await owner.save("project-alpha", 7, alpha, draft);
  expect(owner.snapshot().unresolved).toHaveLength(1);
  await owner.review("project-alpha");

  expect(posts).toBe(1);
  expect(owner.snapshot().unresolved).toHaveLength(1);
  expect(owner.snapshot().checkedProjectId).toBe("project-alpha");
  expect(owner.snapshot().reviewedProjectId).toBeNull();
  expect(owner.snapshot().notices["project-alpha"]).toContain(
    "outcome remains unknown",
  );
});

test("explicit same-project review may create a new CAS at the unchanged revision", async () => {
  let current = catalog(7);
  let posts = 0;
  const owner = new ProjectGeneralSettingsOwner({
    read: async () => current,
    post: async (_url, body) => {
      posts++;
      if (posts === 1) {
        current = updated(7, submitted);
        return new Response("gateway unavailable", { status: 503 });
      }
      expect(body).toEqual({ expectedRevision: 7, general: submitted });
      current = updated(8, submitted);
      return response(current);
    },
  });
  owner.setDraft("project-alpha", draft);

  await owner.save("project-alpha", 7, alpha, draft);
  await owner.review("project-alpha");
  expect(posts).toBe(1);
  expect(owner.snapshot().unresolved).toHaveLength(1);
  expect(owner.snapshot().notices["project-alpha"]).toContain(
    "These values are present now",
  );
  expect(owner.snapshot().notices["project-alpha"]).toContain(
    "outcome remains unknown",
  );
  owner.confirmReview("project-alpha");
  await owner.save("project-alpha", 7, submitted, draft);

  expect(posts).toBe(2);
  expect(owner.snapshot().unresolved).toHaveLength(0);
  expect(owner.snapshot().priorNotices["project-alpha"]?.join(" ")).toContain(
    "outcome remains unknown",
  );
});

test("malformed success stays held and stale conflict requires an explicit review", async () => {
  let current = catalog(7);
  let malformedPosts = 0;
  const malformed = new ProjectGeneralSettingsOwner({
    read: async () => current,
    post: async () => {
      malformedPosts++;
      return new Response(JSON.stringify({ ok: true, data: { wrong: true } }), {
        status: 200,
      });
    },
  });
  await malformed.save("project-alpha", 7, alpha, draft);
  expect(malformed.snapshot().unresolved).toHaveLength(1);
  await malformed.review("project-alpha");
  expect(malformedPosts).toBe(1);

  const conflict = new ProjectGeneralSettingsOwner({
    read: async () => current,
    post: async () => new Response("stale", { status: 409 }),
  });
  await conflict.save("project-alpha", 7, alpha, draft);
  expect(conflict.snapshot().reviewRequired["project-alpha"]).toBe(true);
  expect(conflict.snapshot().reviewedProjectId).toBeNull();
});

test("unknown intent stays project-bound while a reviewed same-revision save clears color", async () => {
  let current = catalog(7);
  let reads = 0;
  let posts = 0;
  let wireBody: unknown;
  const beta = { ...alpha, id: "project-beta", slug: "beta", name: "Beta" };
  const cleared: GeneralDraft = {
    name: "Alpha",
    description: "Fixture project",
    icon: "A",
  };
  const owner = new ProjectGeneralSettingsOwner({
    read: async () => {
      reads++;
      return current;
    },
    post: async (_url, body) => {
      posts++;
      if (posts === 1) return new Response("Unavailable", { status: 503 });
      wireBody = JSON.parse(JSON.stringify(body));
      const next: ProjectRecord = {
        ...alpha,
        name: cleared.name,
        description: cleared.description,
        icon: cleared.icon,
        updatedAt: "2026-10-31T00:00:00.000Z",
      };
      delete next.color;
      current = catalog(8, next);
      return response(current);
    },
  });
  owner.setDraft("project-alpha", draft);

  await owner.save("project-alpha", 7, alpha, draft);
  await owner.review("project-alpha");
  const afterAlphaReview = reads;
  await owner.review(beta.id);
  await owner.save(beta.id, 7, beta, beta);
  expect(reads).toBe(afterAlphaReview);
  expect(owner.snapshot().notices[beta.id]).toContain(
    "Resolve the pending General update",
  );

  owner.setDraft("project-alpha", cleared);
  owner.confirmReview("project-alpha");
  await owner.save("project-alpha", 7, alpha, cleared);

  expect(posts).toBe(2);
  expect(wireBody).toEqual({
    expectedRevision: 7,
    general: { name: "Alpha", description: "Fixture project", icon: "A" },
  });
  expect(owner.snapshot().catalog?.project.general.color).toBeUndefined();
  expect(owner.snapshot().unresolved).toHaveLength(0);
  expect(owner.snapshot().drafts["project-alpha"]).toBeUndefined();
  expect(owner.snapshot().priorNotices["project-alpha"]?.join(" ")).toContain(
    "outcome remains unknown",
  );
});

test("projection validates the target General fields and discards shared catalog metadata", () => {
  const raw = catalog(7);
  const projected = validatedGeneralCatalog(raw, alpha.id);
  expect(projected).toEqual({
    revision: 7,
    freshRead: false,
    project: {
      id: alpha.id,
      updatedAt: alpha.updatedAt,
      general: {
        name: "Alpha",
        description: "Fixture project",
        icon: "A",
        color: "blue",
      },
    },
  });
  expect(() =>
    validatedGeneralCatalog(
      { ...raw, projects: [...raw.projects, alpha] },
      alpha.id,
    ),
  ).toThrow("missing or ambiguous");
  expect(() =>
    validatedGeneralCatalog({ ...raw, version: 2 }, alpha.id),
  ).toThrow("malformed");
  expect(() =>
    validatedGeneralCatalog({ ...raw, createOperations: [] }, alpha.id),
  ).toThrow("malformed");
  expect(() =>
    validatedGeneralCatalog(
      { ...raw, revision: Number.MAX_SAFE_INTEGER + 1 },
      alpha.id,
    ),
  ).toThrow("malformed");
  const invalidName: unknown = {
    version: 1,
    revision: 7,
    projects: [{ ...alpha, name: null }],
  };
  expect(() => validatedGeneralCatalog(invalidName, alpha.id)).toThrow();
  expect(() =>
    validatedGeneralCatalog(
      catalog(7, { ...alpha, updatedAt: "yesterday" }),
      alpha.id,
    ),
  ).toThrow();
});

test("NotSent unlocks the request without losing the user's installed draft", async () => {
  const owner = new ProjectGeneralSettingsOwner({
    read: async () => catalog(7),
    post: async () => {
      throw new NotSent("No dashboard session");
    },
  });
  owner.setDraft(alpha.id, { ...draft, name: "Saved draft" });
  await owner.save(alpha.id, 7, alpha, owner.draft(alpha.id, alpha));
  expect(owner.snapshot().sendingProjectId).toBeNull();
  expect(owner.snapshot().unresolved).toHaveLength(0);
  expect(owner.snapshot().drafts[alpha.id]?.name).toBe("Saved draft");
  expect(owner.snapshot().notices[alpha.id]).toContain("request was not sent");

  const uncertain = new ProjectGeneralSettingsOwner({
    read: async () => catalog(7),
    post: async () => {
      throw Error("socket closed after send");
    },
  });
  uncertain.setDraft(alpha.id, { ...draft, name: "Possibly sent" });
  await uncertain.save(alpha.id, 7, alpha, uncertain.draft(alpha.id, alpha));
  expect(uncertain.snapshot().unresolved).toHaveLength(1);
  expect(uncertain.snapshot().drafts[alpha.id]?.name).toBe("Possibly sent");
  expect(uncertain.snapshot().notices[alpha.id]).toContain(
    "outcome is unknown",
  );
});

test("accepted receipt is not adopted as current when the confirming GET fails", async () => {
  let reads = 0;
  let current = catalog(7);
  const owner = new ProjectGeneralSettingsOwner({
    read: async () => {
      reads++;
      if (reads === 2) throw Error("read unavailable");
      return current;
    },
    post: async () => {
      current = updated(8, { ...submitted, name: "Kept until readback" });
      return response(current);
    },
  });
  owner.setDraft(alpha.id, { ...draft, name: "Kept until readback" });
  await owner.save(alpha.id, 7, alpha, owner.draft(alpha.id, alpha));
  expect(owner.snapshot().catalog?.revision).toBe(7);
  expect(owner.snapshot().catalog?.project.general.name).toBe("Alpha");
  expect(owner.snapshot().unresolved).toHaveLength(0);
  expect(owner.snapshot().drafts[alpha.id]?.name).toBe("Kept until readback");
  expect(owner.snapshot().reviewRequired[alpha.id]).toBe(true);
  expect(owner.snapshot().notices[alpha.id]).toContain(
    "save was accepted at catalog revision 8",
  );
  expect(owner.snapshot().notices[alpha.id]).toContain(
    "current values are unavailable",
  );
});

test("project projections are cached per project without regression and fresh reads recover them", async () => {
  const beta = { ...alpha, id: "project-beta", slug: "beta", name: "Beta" };
  const owner = new ProjectGeneralSettingsOwner({
    read: async () => catalog(7),
    post: async () => new Response("unused", { status: 500 }),
  });
  owner.adopt(alpha.id, catalog(7));
  owner.adopt(beta.id, catalog(4, beta));
  expect(owner.snapshot().catalog?.project.id).toBe(beta.id);
  expect(owner.snapshot().catalog?.revision).toBe(4);
  owner.adopt(alpha.id, catalog(6, { ...alpha, name: "Older" }));
  expect(owner.snapshot().catalog?.project.id).toBe(alpha.id);
  expect(owner.snapshot().catalog?.revision).toBe(7);
  expect(owner.snapshot().catalogs[alpha.id]?.project.general.name).toBe(
    "Alpha",
  );
  owner.adopt(alpha.id, catalog(8, { ...alpha, name: "New summary value" }));
  expect(owner.snapshot().catalog?.revision).toBe(8);
  expect(owner.snapshot().catalog?.project.general.name).toBe(
    "New summary value",
  );
  expect(owner.snapshot().catalog?.freshRead).toBe(false);

  let recoveryReads = 0;
  const recovery = new ProjectGeneralSettingsOwner({
    read: async () => {
      recoveryReads++;
      return recoveryReads === 1
        ? catalog(4, beta)
        : catalog(8, { ...alpha, name: "Late Alpha read" });
    },
    post: async () => new Response("unused", { status: 500 }),
  });
  recovery.adopt(alpha.id, catalog(7));
  await recovery.review(beta.id);
  expect(recovery.snapshot().catalog?.project.id).toBe(alpha.id);
  expect(
    generalCatalogForProject(recovery.snapshot(), beta.id)?.freshRead,
  ).toBe(true);
  const betaScreen = generalCatalogForProject(recovery.snapshot(), beta.id);
  await recovery.review(alpha.id);
  expect(recovery.snapshot().catalog?.project.general.name).toBe(
    "Late Alpha read",
  );
  expect(generalCatalogForProject(recovery.snapshot(), beta.id)).toBe(
    betaScreen,
  );
});

test("one held request owns the client across double-submit and another-project review", async () => {
  let releasePreflight!: (value: unknown) => void;
  let releaseConflict!: (value: unknown) => void;
  let reachedConflict!: () => void;
  const conflictStarted = new Promise<void>((resolve) => {
    reachedConflict = () => resolve();
  });
  let reads = 0;
  let posts = 0;
  const owner = new ProjectGeneralSettingsOwner({
    read: () => {
      reads++;
      if (reads === 1)
        return new Promise((resolve) => {
          releasePreflight = resolve;
        });
      reachedConflict();
      return new Promise((resolve) => {
        releaseConflict = resolve;
      });
    },
    post: async () => {
      posts++;
      return new Response("stale", { status: 409 });
    },
  });
  const first = owner.save(alpha.id, 7, alpha, draft);
  await owner.save(alpha.id, 7, alpha, draft);
  await owner.review("project-beta");
  expect(reads).toBe(1);
  expect(posts).toBe(0);
  releasePreflight(catalog(7));
  await conflictStarted;
  expect(owner.snapshot().sendingProjectId).toBe(alpha.id);
  await owner.save("project-beta", 7, alpha, draft);
  expect(posts).toBe(1);
  expect(reads).toBe(2);
  releaseConflict(catalog(7));
  await first;
  expect(posts).toBe(1);
  expect(owner.snapshot().sendingProjectId).toBeNull();
  expect(owner.snapshot().checkedProjectId).toBe("project-alpha");
  expect(owner.snapshot().catalog?.project.id).toBe("project-alpha");
});
