import { expect, test } from "bun:test";
import { ProjectKeeperSettingsOwner } from "../../apps/desktop/src/project-keeper-settings-client";
import type { KeeperVisibility } from "../../types/projects";
import {
  DEFAULT_KEEPER_VISIBILITY,
  effectiveKeeperVisibility,
  keeperVisibilitySchema,
  type ProjectKeeperVisibilityRequest,
  projectKeeperMutationRequestSchema,
  projectKeeperProjectionSchema,
  projectKeeperSettingsRequestSchema,
  projectKeeperSettingsSchema,
} from "../projects/project-keeper-protocol";
import { FIXTURE_PROJECT_ID, projectCatalogFixture } from "../projects/testing";

test("Keeper visibility distinguishes saved policy from the legacy default and rejects invalid explicit modes", () => {
  expect(effectiveKeeperVisibility({})).toEqual({
    value: DEFAULT_KEEPER_VISIBILITY,
    source: "default-policy",
  });
  const modes: KeeperVisibility[] = ["project-metadata", "conversation-only"];
  for (const mode of modes) {
    expect(keeperVisibilitySchema.parse(mode)).toBe(mode);
    expect(effectiveKeeperVisibility({ keeperVisibility: mode })).toEqual({
      value: mode,
      source: "project-catalog",
    });
  }
  for (const invalid of ["", "automatic", "PROJECT-METADATA", null, [], {}]) {
    expect(keeperVisibilitySchema.safeParse(invalid).success).toBe(false);
    expect(() =>
      effectiveKeeperVisibility({ keeperVisibility: invalid }),
    ).toThrow();
  }
});

test("Keeper saved projection gains visibility without widening legacy direct-store or request validation", () => {
  const keeper = projectKeeperSettingsSchema.parse({
    keeperSmith: "Keeper Ä",
    keeperAutonomy: "suggest-only",
  });
  const legacy = { expectedRevision: 7, keeper };
  expect(projectKeeperSettingsRequestSchema.parse(legacy)).toEqual(legacy);
  expect(projectKeeperMutationRequestSchema.parse(legacy)).toEqual(legacy);
  expect(
    projectKeeperMutationRequestSchema.parse({
      expectedRevision: 0,
      keeper: {},
    }),
  ).toEqual({ expectedRevision: 0, keeper: {} });
  const saved = { ...keeper, keeperVisibility: "conversation-only" };
  const projected = projectKeeperProjectionSchema.parse(saved);
  expect(projected.keeperSmith).toBe(keeper.keeperSmith);
  expect(projected.keeperAutonomy).toBe(keeper.keeperAutonomy);
  expect(projected.keeperVisibility).toBe("conversation-only");
  expect(projectKeeperSettingsSchema.safeParse(saved).success).toBe(false);
  expect(
    projectKeeperSettingsRequestSchema.safeParse({
      expectedRevision: 7,
      keeper: saved,
    }).success,
  ).toBe(false);
  expect(
    Object.hasOwn(projectKeeperProjectionSchema.parse({}), "keeperVisibility"),
  ).toBe(false);
  expect(
    projectKeeperProjectionSchema.safeParse({ keeperVisibility: "automatic" })
      .success,
  ).toBe(false);
});

test("Keeper mutation union has a strict visibility-only arm with the same revision bounds", () => {
  const modes: KeeperVisibility[] = ["project-metadata", "conversation-only"];
  for (const mode of modes) {
    const request: ProjectKeeperVisibilityRequest = {
      expectedRevision: Number.MAX_SAFE_INTEGER - 1,
      kind: "visibility",
      keeperVisibility: mode,
    };
    expect(projectKeeperMutationRequestSchema.parse(request)).toEqual(request);
    expect(projectKeeperSettingsRequestSchema.safeParse(request).success).toBe(
      false,
    );
    for (const fields of [
      { keeperSmith: "claude-master" },
      { keeperAutonomy: "suggest-only" },
      { keeper: {} },
      { extra: true },
    ])
      expect(
        projectKeeperMutationRequestSchema.safeParse({ ...request, ...fields })
          .success,
      ).toBe(false);
  }
  for (const expectedRevision of [
    -1,
    "1",
    Number.MAX_SAFE_INTEGER,
    Infinity,
    NaN,
  ]) {
    expect(
      projectKeeperMutationRequestSchema.safeParse({
        expectedRevision,
        keeper: {},
      }).success,
    ).toBe(false);
    expect(
      projectKeeperMutationRequestSchema.safeParse({
        expectedRevision,
        kind: "visibility",
        keeperVisibility: "conversation-only",
      }).success,
    ).toBe(false);
  }
  expect(
    projectKeeperMutationRequestSchema.safeParse({
      expectedRevision: 1,
      kind: "visibility",
      keeperVisibility: "automatic",
    }).success,
  ).toBe(false);
});

test("Keeper visibility owner retains explicit saved policy independently of its legacy default", () => {
  const catalog = projectCatalogFixture("/served");
  let reads = 0,
    posts = 0,
    pendingWrites = 0;
  const owner = new ProjectKeeperSettingsOwner({
    read: async () => {
      reads++;
      return catalog;
    },
    post: async () => {
      posts++;
      return Response.json({ ok: false, data: null, error: "Not expected" });
    },
    writePending: () => {
      pendingWrites++;
    },
  });
  owner.adopt(FIXTURE_PROJECT_ID, catalog);
  const saved = owner.snapshot().projects[FIXTURE_PROJECT_ID]?.catalog;
  if (!saved) throw Error("Missing verified legacy projection");
  const { revision, ...legacy } = saved;
  expect(revision).toBe(catalog.revision);
  expect(Object.hasOwn(saved, "keeperVisibility")).toBe(false);
  expect(
    effectiveKeeperVisibility(projectKeeperProjectionSchema.parse(legacy)),
  ).toEqual({ value: "project-metadata", source: "default-policy" });
  const modes: KeeperVisibility[] = ["conversation-only", "project-metadata"];
  for (const mode of modes) {
    owner.adopt(FIXTURE_PROJECT_ID, {
      ...catalog,
      projects: catalog.projects.map((project) => ({
        ...project,
        keeperVisibility: mode,
      })),
    });
    expect(
      owner.snapshot().projects[FIXTURE_PROJECT_ID]?.catalog,
    ).toMatchObject({ keeperVisibility: mode });
  }
  expect({ reads, posts, pendingWrites }).toEqual({
    reads: 0,
    posts: 0,
    pendingWrites: 0,
  });
});

function ownerVisibilityCatalog(
  revision: number,
  fields: Record<string, unknown> = {},
): unknown {
  const catalog = projectCatalogFixture("/served");
  return {
    ...catalog,
    revision,
    projects: catalog.projects.map((project) => ({ ...project, ...fields })),
  };
}

test("Keeper visibility drafts retain saved provenance and invalid catalog evidence without legacy writes", async () => {
  const catalog = ownerVisibilityCatalog(1, {
    keeperVisibility: "conversation-only",
  });
  let reads = 0,
    posts = 0,
    writes = 0;
  const owner = new ProjectKeeperSettingsOwner({
    read: async () => {
      reads++;
      return catalog;
    },
    post: async () => {
      posts++;
      throw Error("No legacy save expected");
    },
    writePending: () => {
      writes++;
    },
  });
  owner.adopt(FIXTURE_PROJECT_ID, catalog);
  owner.setVisibilityDraft(FIXTURE_PROJECT_ID, "project-metadata");
  await owner.save(FIXTURE_PROJECT_ID);
  const saved = owner.snapshot().projects[FIXTURE_PROJECT_ID]?.catalog;
  if (!saved) throw Error("Missing saved visibility catalog");
  expect(effectiveKeeperVisibility(saved)).toEqual({
    value: "conversation-only",
    source: "project-catalog",
  });
  expect(owner.snapshot().projects[FIXTURE_PROJECT_ID]?.visibilityDraft).toBe(
    "project-metadata",
  );
  owner.adopt(
    FIXTURE_PROJECT_ID,
    ownerVisibilityCatalog(2, { keeperVisibility: "automatic" }),
  );
  expect(owner.snapshot().projects[FIXTURE_PROJECT_ID]).toMatchObject({
    catalog: saved,
    needsReview: true,
    checked: false,
  });
  expect({ reads, posts, writes }).toEqual({ reads: 0, posts: 0, writes: 0 });
});

test("Keeper visibility draft adoption distinguishes raw absence from an explicit default and newer revisions", () => {
  for (const after of [
    ownerVisibilityCatalog(3, { keeperVisibility: "project-metadata" }),
    ownerVisibilityCatalog(4),
  ]) {
    const before = ownerVisibilityCatalog(3);
    const owner = new ProjectKeeperSettingsOwner({
      read: async () => after,
      post: async () => {
        throw Error("No write expected");
      },
    });
    owner.adopt(FIXTURE_PROJECT_ID, before);
    owner.setVisibilityDraft(FIXTURE_PROJECT_ID, "conversation-only");
    owner.adopt(FIXTURE_PROJECT_ID, before);
    owner.adopt(
      FIXTURE_PROJECT_ID,
      ownerVisibilityCatalog(2, { keeperVisibility: "conversation-only" }),
    );
    expect(owner.snapshot().projects[FIXTURE_PROJECT_ID]).toMatchObject({
      catalog: { revision: 3 },
      needsReview: false,
    });
    owner.adopt(FIXTURE_PROJECT_ID, after);
    expect(owner.snapshot().projects[FIXTURE_PROJECT_ID]).toMatchObject({
      visibilityDraft: "conversation-only",
      needsReview: true,
      checked: false,
    });
  }
});

test("Keeper visibility setters are inert while the shared owner is checking settings", async () => {
  const catalog = ownerVisibilityCatalog(1, {
    keeperVisibility: "conversation-only",
  });
  let release!: () => void, entered!: () => void;
  const held = new Promise<unknown>((resolve) => {
    release = () => resolve(catalog);
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const owner = new ProjectKeeperSettingsOwner({
    read: async () => {
      entered();
      return held;
    },
    post: async () => {
      throw Error("No write expected");
    },
  });
  owner.adopt(FIXTURE_PROJECT_ID, catalog);
  owner.setVisibilityDraft(FIXTURE_PROJECT_ID, "project-metadata");
  const reviewing = owner.review(FIXTURE_PROJECT_ID);
  try {
    await started;
    owner.setVisibilityDraft(FIXTURE_PROJECT_ID, "conversation-only");
    expect(owner.snapshot().projects[FIXTURE_PROJECT_ID]?.visibilityDraft).toBe(
      "project-metadata",
    );
  } finally {
    release();
    await reviewing;
  }
  expect(owner.snapshot().busy).toBeNull();
  expect(owner.snapshot().projects[FIXTURE_PROJECT_ID]?.visibilityDraft).toBe(
    "project-metadata",
  );
});

test("Keeper legacy saves preserve raw visibility and its separate draft with the strict original request", async () => {
  let current = ownerVisibilityCatalog(1, {
    keeperSmith: "old-smith",
    keeperAutonomy: "suggest-only",
    keeperVisibility: "conversation-only",
  });
  const posts: Array<{ path: string; body: unknown }> = [];
  const owner = new ProjectKeeperSettingsOwner({
    read: async () => current,
    post: async (path, body) => {
      posts.push({ path, body });
      current = ownerVisibilityCatalog(2, {
        keeperSmith: "new-smith",
        keeperAutonomy: "suggest-only",
        keeperVisibility: "conversation-only",
      });
      return Response.json({ ok: true, data: current, error: null });
    },
  });
  owner.adopt(FIXTURE_PROJECT_ID, current);
  owner.setVisibilityDraft(FIXTURE_PROJECT_ID, "project-metadata");
  owner.setDraft(FIXTURE_PROJECT_ID, "new-smith");
  await owner.save(FIXTURE_PROJECT_ID);
  expect(posts).toEqual([
    {
      path:
        "/__agent-forge/projects/" + FIXTURE_PROJECT_ID + "/settings/keeper",
      body: { expectedRevision: 1, keeper: { keeperSmith: "new-smith" } },
    },
  ]);
  expect(owner.snapshot().projects[FIXTURE_PROJECT_ID]).toMatchObject({
    catalog: {
      revision: 2,
      keeperSmith: "new-smith",
      keeperAutonomy: "suggest-only",
      keeperVisibility: "conversation-only",
    },
    draft: null,
    visibilityDraft: "project-metadata",
    needsReview: false,
  });
});
