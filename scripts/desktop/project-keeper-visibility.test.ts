import { expect, test } from "bun:test";
import { ProjectKeeperSettings } from "../../apps/desktop/src/ProjectKeeperSettings";
import { ProjectKeeperSettingsOwner } from "../../apps/desktop/src/project-keeper-settings-client";
import { inspectSmiths } from "../../apps/desktop/src/smiths-model";
import type { SmithsController } from "../../apps/desktop/src/use-smiths";
import { NotSent } from "../../docs/js/operator";
import type { KeeperVisibility } from "../../types/projects";
import { loadConfigFromContents } from "../config/load";
import { attrs, findAll, textOf } from "../dashboard/ds/vnode";
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

test("Keeper visibility write holds expose restored recovery without side effects or a permanent same-project hold", async () => {
  const id = FIXTURE_PROJECT_ID,
    foreign = "project-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  for (const hold of ["none", "foreign", "same", "storage"] as const) {
    let pending: Record<string, number> =
      hold === "foreign"
        ? { [foreign]: 1 }
        : hold === "same"
          ? { [id]: 1 }
          : {};
    let reads = 0,
      posts = 0,
      writes = 0,
      restores = 0,
      notices = 0;
    const catalog = ownerVisibilityCatalog(1, { keeperSmith: "old-smith" });
    const owner = new ProjectKeeperSettingsOwner({
      read: async () => {
        reads++;
        return catalog;
      },
      post: async () => {
        posts++;
        return Response.json(
          { ok: false, data: null, error: "Refused new intent" },
          { status: 400 },
        );
      },
      readPending: () => {
        restores++;
        if (hold === "storage") throw Error("Storage unavailable");
        return pending;
      },
      writePending: (next) => {
        writes++;
        pending = { ...next };
      },
    });
    owner.adopt(id, catalog);
    owner.setDraft(id, "new-smith");
    const unsubscribe = owner.subscribe(() => {
      notices++;
    });
    const before = owner.snapshot();
    const counts = { reads, posts, writes, restores, notices };
    expect(owner.snapshot().projects[foreign]).toBeUndefined();
    expect(owner.writesBlocked(id)).toBe(
      hold === "foreign" || hold === "storage",
    );
    expect(owner.writesBlocked(id)).toBe(
      hold === "foreign" || hold === "storage",
    );
    expect(owner.snapshot()).toBe(before);
    expect({ reads, posts, writes, restores, notices }).toEqual(counts);
    if (hold === "same") {
      await owner.save(id);
      expect(posts).toBe(0);
      await owner.review(id);
      expect(pending[id]).toBe(1);
      expect(owner.snapshot().projects[id]?.needsReview).toBe(true);
      owner.confirmReview(id);
      expect(owner.writesBlocked(id)).toBe(false);
      await owner.save(id);
      expect(posts).toBe(1);
      expect(pending[id]).toBe(1);
    } else if (hold !== "none") {
      await owner.save(id);
      expect(posts).toBe(0);
      expect(reads).toBe(0);
      expect(writes).toBe(0);
      expect(owner.snapshot().projects[id]?.message).toContain(
        hold === "foreign" ? "other project" : "could not be restored",
      );
      if (hold === "foreign") expect(pending[foreign]).toBe(1);
    }
    unsubscribe();
  }
});

test("Keeper visibility saves use only the strict visibility arm and preserve legacy values and drafts", async () => {
  const cases: Array<{ mode: KeeperVisibility; smith?: string }> = [
    { mode: "project-metadata" },
    { mode: "conversation-only", smith: "unavailable-smith" },
  ];
  for (const { mode, smith } of cases) {
    const legacy = {
      keeperAutonomy: "suggest-only",
      ...(smith ? { keeperSmith: smith } : {}),
    };
    let current = ownerVisibilityCatalog(1, {
      ...legacy,
      ...(mode === "conversation-only"
        ? { keeperVisibility: "project-metadata" }
        : {}),
    });
    let reads = 0,
      pending: Record<string, number> = {};
    const posts: Array<{ path: string; body: unknown }> = [];
    const pendingAtPost: Array<Record<string, number>> = [];
    const owner = new ProjectKeeperSettingsOwner({
      read: async () => {
        reads++;
        return current;
      },
      readPending: () => pending,
      writePending: (next) => {
        pending = { ...next };
      },
      post: async (path, body) => {
        posts.push({ path, body });
        pendingAtPost.push({ ...pending });
        current = ownerVisibilityCatalog(2, {
          ...legacy,
          keeperVisibility: mode,
        });
        return Response.json({ ok: true, data: current, error: null });
      },
    });
    owner.adopt(FIXTURE_PROJECT_ID, current);
    owner.setDraft(FIXTURE_PROJECT_ID, "unsaved-smith");
    owner.setAutonomyDraft(FIXTURE_PROJECT_ID, "propose-for-approval");
    await owner.saveVisibility(FIXTURE_PROJECT_ID);
    expect({ reads, posts, pending }).toEqual({
      reads: 0,
      posts: [],
      pending: {},
    });
    owner.setVisibilityDraft(FIXTURE_PROJECT_ID, mode);
    await owner.saveVisibility(FIXTURE_PROJECT_ID);
    expect(posts).toEqual([
      {
        path:
          "/__agent-forge/projects/" + FIXTURE_PROJECT_ID + "/settings/keeper",
        body: {
          expectedRevision: 1,
          kind: "visibility",
          keeperVisibility: mode,
        },
      },
    ]);
    expect(pendingAtPost).toEqual([{ [FIXTURE_PROJECT_ID]: 1 }]);
    expect(pending).toEqual({});
    expect(reads).toBe(2);
    const view = owner.snapshot().projects[FIXTURE_PROJECT_ID];
    expect(view).toMatchObject({
      catalog: { revision: 2, ...legacy, keeperVisibility: mode },
      draft: "unsaved-smith",
      autonomyDraft: "propose-for-approval",
      visibilityDraft: null,
      needsReview: false,
      checked: false,
    });
    if (!view?.catalog) throw Error("Missing verified visibility readback");
    expect(Object.hasOwn(view.catalog, "keeperSmith")).toBe(
      smith !== undefined,
    );
    expect(effectiveKeeperVisibility(view.catalog)).toEqual({
      value: mode,
      source: "project-catalog",
    });
  }
});

test("Keeper visibility raw preflight changes require review before sending", async () => {
  let posts = 0,
    writes = 0;
  const owner = new ProjectKeeperSettingsOwner({
    read: async () =>
      ownerVisibilityCatalog(1, { keeperVisibility: "project-metadata" }),
    post: async () => {
      posts++;
      throw Error("No POST expected");
    },
    writePending: () => {
      writes++;
    },
  });
  owner.adopt(FIXTURE_PROJECT_ID, ownerVisibilityCatalog(1));
  owner.setVisibilityDraft(FIXTURE_PROJECT_ID, "conversation-only");
  await owner.saveVisibility(FIXTURE_PROJECT_ID);
  expect({ posts, writes }).toEqual({ posts: 0, writes: 0 });
  expect(owner.snapshot().projects[FIXTURE_PROJECT_ID]).toMatchObject({
    catalog: { revision: 1, keeperVisibility: "project-metadata" },
    visibilityDraft: "conversation-only",
    needsReview: true,
    checked: true,
  });
});

test("Keeper visibility receipt omission, mismatch, invalidity and legacy-field drift remain unknown", async () => {
  const legacy = { keeperSmith: "saved-smith", keeperAutonomy: "suggest-only" };
  const original = ownerVisibilityCatalog(1, {
    ...legacy,
    keeperVisibility: "conversation-only",
  });
  for (const fields of [
    {},
    { keeperVisibility: "conversation-only" },
    { keeperVisibility: "automatic" },
    { keeperVisibility: "project-metadata", keeperSmith: "changed-smith" },
  ]) {
    let pending: Record<string, number> = {},
      posts = 0;
    const owner = new ProjectKeeperSettingsOwner({
      read: async () => original,
      readPending: () => pending,
      writePending: (next) => {
        pending = { ...next };
      },
      post: async () => {
        posts++;
        return Response.json({
          ok: true,
          data: ownerVisibilityCatalog(2, { ...legacy, ...fields }),
          error: null,
        });
      },
    });
    owner.adopt(FIXTURE_PROJECT_ID, original);
    owner.setVisibilityDraft(FIXTURE_PROJECT_ID, "project-metadata");
    await owner.saveVisibility(FIXTURE_PROJECT_ID);
    expect(posts).toBe(1);
    expect(pending[FIXTURE_PROJECT_ID]).toBe(1);
    expect(owner.snapshot().projects[FIXTURE_PROJECT_ID]).toMatchObject({
      catalog: { revision: 1, keeperVisibility: "conversation-only" },
      visibilityDraft: "project-metadata",
      needsReview: true,
      checked: false,
    });
    expect(owner.snapshot().projects[FIXTURE_PROJECT_ID]?.message).toContain(
      "outcome is unknown",
    );
  }
});

test("Keeper visibility accepted drift and stale readback retain current evidence and every draft", async () => {
  const legacy = { keeperSmith: "saved-smith", keeperAutonomy: "suggest-only" };
  const original = ownerVisibilityCatalog(1, {
    ...legacy,
    keeperVisibility: "conversation-only",
  });
  const receipt = ownerVisibilityCatalog(2, {
    ...legacy,
    keeperVisibility: "project-metadata",
  });
  for (const kind of ["drift", "stale"]) {
    let entered!: () => void, release!: (value: unknown) => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    let reads = 0,
      posts = 0,
      pending: Record<string, number> = {};
    const owner = new ProjectKeeperSettingsOwner({
      read: async () => {
        if (++reads === 1) return original;
        entered();
        return held;
      },
      readPending: () => pending,
      writePending: (next) => {
        pending = { ...next };
      },
      post: async () => {
        posts++;
        return Response.json({ ok: true, data: receipt, error: null });
      },
    });
    owner.adopt(FIXTURE_PROJECT_ID, original);
    owner.setDraft(FIXTURE_PROJECT_ID, "unsaved-smith");
    owner.setAutonomyDraft(FIXTURE_PROJECT_ID, "propose-for-approval");
    owner.setVisibilityDraft(FIXTURE_PROJECT_ID, "project-metadata");
    const saving = owner.saveVisibility(FIXTURE_PROJECT_ID);
    try {
      await started;
      await owner.save(FIXTURE_PROJECT_ID);
      await owner.saveVisibility(FIXTURE_PROJECT_ID);
      if (kind === "stale")
        owner.adopt(
          FIXTURE_PROJECT_ID,
          ownerVisibilityCatalog(4, {
            ...legacy,
            keeperVisibility: "conversation-only",
          }),
        );
    } finally {
      release(
        kind === "drift"
          ? ownerVisibilityCatalog(3, {
              ...legacy,
              keeperVisibility: "conversation-only",
            })
          : receipt,
      );
      await saving;
    }
    expect({ posts, reads, pending }).toEqual({
      posts: 1,
      reads: 2,
      pending: {},
    });
    expect(owner.snapshot().projects[FIXTURE_PROJECT_ID]).toMatchObject({
      catalog: {
        revision: kind === "drift" ? 3 : 4,
        keeperVisibility: "conversation-only",
      },
      draft: "unsaved-smith",
      autonomyDraft: "propose-for-approval",
      visibilityDraft: "project-metadata",
      needsReview: true,
      checked: kind === "drift",
    });
    expect(owner.snapshot().projects[FIXTURE_PROJECT_ID]?.message).toContain(
      kind === "drift"
        ? "after the accepted save"
        : "Save accepted at revision 2",
    );
  }
});

test("Keeper visibility shares review and foreign-project holds with legacy writes", async () => {
  const original = ownerVisibilityCatalog(1, { keeperSmith: "saved-smith" });
  for (const hold of ["review", "foreign"]) {
    let posts = 0,
      reads = 0;
    const owner = new ProjectKeeperSettingsOwner({
      read: async () => {
        reads++;
        return original;
      },
      readPending: (): Record<string, number> =>
        hold === "foreign"
          ? { "project-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb": 1 }
          : {},
      post: async () => {
        posts++;
        throw Error("No write expected");
      },
    });
    owner.adopt(FIXTURE_PROJECT_ID, original);
    owner.setDraft(FIXTURE_PROJECT_ID, "unsaved-smith");
    owner.setVisibilityDraft(FIXTURE_PROJECT_ID, "conversation-only");
    if (hold === "review")
      owner.adopt(
        FIXTURE_PROJECT_ID,
        ownerVisibilityCatalog(2, { keeperSmith: "saved-smith" }),
      );
    await owner.save(FIXTURE_PROJECT_ID);
    await owner.saveVisibility(FIXTURE_PROJECT_ID);
    expect({ posts, reads }).toEqual({ posts: 0, reads: 0 });
    expect(owner.snapshot().projects[FIXTURE_PROJECT_ID]?.visibilityDraft).toBe(
      "conversation-only",
    );
  }
});

test("Keeper visibility restart recovery requires manual review and preserves older cross-form uncertainty", async () => {
  const id = FIXTURE_PROJECT_ID;
  for (const { first, loss, refusal } of [
    { first: "visibility", loss: "lost", refusal: "not-sent" },
    { first: "visibility", loss: "malformed", refusal: "4xx" },
    { first: "keeper", loss: "lost", refusal: "4xx" },
    { first: "keeper", loss: "malformed", refusal: "not-sent" },
  ] as const) {
    const saved = {
      keeperSmith: "saved-smith",
      keeperAutonomy: "suggest-only",
      keeperVisibility: "project-metadata",
    };
    let current = ownerVisibilityCatalog(1, saved),
      pending: Record<string, number> = {};
    const bodies: unknown[] = [];
    const deps = {
      read: async () => current,
      readPending: () => pending,
      writePending: (next: Record<string, number>) => {
        pending = { ...next };
      },
      post: async (_path: string, body: unknown) => {
        bodies.push(body);
        if (bodies.length === 1) {
          if (loss === "lost") throw Error("Lost reply");
          return new Response("{malformed", { status: 200 });
        }
        if (bodies.length === 2) {
          if (refusal === "not-sent")
            throw new NotSent("Definite pre-send refusal");
          return Response.json(
            { ok: false, data: null, error: "Refused new intent" },
            { status: 400 },
          );
        }
        current = ownerVisibilityCatalog(2, {
          ...saved,
          ...(first === "visibility"
            ? { keeperSmith: "new-smith" }
            : { keeperVisibility: "conversation-only" }),
        });
        return Response.json({ ok: true, data: current, error: null });
      },
    };
    const initial = new ProjectKeeperSettingsOwner(deps);
    initial.adopt(id, current);
    if (first === "visibility") {
      initial.setVisibilityDraft(id, "conversation-only");
      await initial.saveVisibility(id);
    } else {
      initial.setDraft(id, "unknown-smith");
      await initial.save(id);
    }
    expect(bodies).toHaveLength(1);
    expect(pending[id]).toBe(1);
    expect(initial.snapshot().projects[id]?.message).toContain(
      "outcome is unknown",
    );
    const older = { ...pending },
      reopened = new ProjectKeeperSettingsOwner(deps);
    reopened.adopt(id, current);
    expect(reopened.snapshot().projects[id]).toMatchObject({
      draft: null,
      autonomyDraft: null,
      visibilityDraft: null,
      needsReview: true,
    });
    reopened.setDraft(
      id,
      first === "visibility" ? "new-smith" : "future-smith",
    );
    reopened.setVisibilityDraft(id, "conversation-only");
    const sendNew = () =>
      first === "visibility" ? reopened.save(id) : reopened.saveVisibility(id);
    await sendNew();
    await reopened.review(id);
    expect(bodies).toHaveLength(1);
    expect(reopened.snapshot().projects[id]?.message).toContain(
      "current state only",
    );
    expect(pending).toEqual(older);
    expect(reopened.writesBlocked(id)).toBe(false);
    reopened.confirmReview(id);
    await sendNew();
    expect(bodies).toHaveLength(2);
    expect(pending).toEqual(older);
    expect(reopened.snapshot().projects[id]?.message).toContain(
      refusal === "not-sent" ? "not sent" : "refused",
    );
    await sendNew();
    expect(bodies).toHaveLength(2);
    await reopened.review(id);
    reopened.confirmReview(id);
    await sendNew();
    const intended =
      first === "visibility"
        ? { expectedRevision: 1, keeper: { keeperSmith: "new-smith" } }
        : {
            expectedRevision: 1,
            kind: "visibility",
            keeperVisibility: "conversation-only",
          };
    expect(bodies.slice(1)).toEqual([intended, intended]);
    expect(pending).toEqual({});
    expect(reopened.snapshot().projects[id]).toMatchObject({
      catalog: { revision: 2 },
      draft: first === "visibility" ? null : "future-smith",
      visibilityDraft: first === "visibility" ? "conversation-only" : null,
      needsReview: false,
    });
    expect(reopened.snapshot().projects[id]?.message).toContain(
      "read at revision 2",
    );
  }
});

test("Keeper visibility accepted writes remain accepted when storage cleanup or current readback fails", async () => {
  const fields = { keeperSmith: "saved-smith", keeperAutonomy: "suggest-only" };
  const original = ownerVisibilityCatalog(1, {
    ...fields,
    keeperVisibility: "project-metadata",
  });
  const receipt = ownerVisibilityCatalog(2, {
    ...fields,
    keeperVisibility: "conversation-only",
  });
  for (const failure of ["storage", "readback"]) {
    let reads = 0,
      posts = 0,
      writes = 0,
      pending: Record<string, number> = {};
    const owner = new ProjectKeeperSettingsOwner({
      read: async () => {
        if (++reads > 1) throw Error("Current read unavailable");
        return original;
      },
      readPending: () => pending,
      writePending: (next) => {
        if (++writes === 2 && failure === "storage")
          throw Error("Cleanup storage unavailable");
        pending = { ...next };
      },
      post: async () => {
        posts++;
        return Response.json({ ok: true, data: receipt, error: null });
      },
    });
    owner.adopt(FIXTURE_PROJECT_ID, original);
    owner.setDraft(FIXTURE_PROJECT_ID, "unsaved-smith");
    owner.setAutonomyDraft(FIXTURE_PROJECT_ID, "propose-for-approval");
    owner.setVisibilityDraft(FIXTURE_PROJECT_ID, "conversation-only");
    await owner.saveVisibility(FIXTURE_PROJECT_ID);
    expect(posts).toBe(1);
    expect(pending).toEqual(
      failure === "storage" ? { [FIXTURE_PROJECT_ID]: 1 } : {},
    );
    expect(owner.snapshot().projects[FIXTURE_PROJECT_ID]).toMatchObject({
      catalog: { revision: 1 },
      draft: "unsaved-smith",
      autonomyDraft: "propose-for-approval",
      visibilityDraft: "conversation-only",
      needsReview: true,
      checked: false,
    });
    expect(owner.snapshot().projects[FIXTURE_PROJECT_ID]?.message).toContain(
      "Save accepted at revision 2",
    );
    expect(
      owner.snapshot().projects[FIXTURE_PROJECT_ID]?.message,
    ).not.toContain("outcome is unknown");
    expect(
      owner.snapshot().projects[FIXTURE_PROJECT_ID]?.message,
    ).not.toContain("not sent");
  }
});

test("Keeper visibility form uses actual draft and submit actions without requiring Smith configuration", async () => {
  const id = FIXTURE_PROJECT_ID;
  const saved = {
    keeperSmith: "unavailable-smith",
    keeperAutonomy: "suggest-only",
  };
  let current = ownerVisibilityCatalog(1, saved),
    reads = 0,
    prevented = 0;
  const posts: Array<{ path: string; body: unknown }> = [];
  const owner = new ProjectKeeperSettingsOwner({
    read: async () => {
      reads++;
      return current;
    },
    post: async (path, body) => {
      posts.push({ path, body });
      current = ownerVisibilityCatalog(2, {
        ...saved,
        keeperVisibility: "conversation-only",
      });
      return Response.json({ ok: true, data: current, error: null });
    },
  });
  owner.adopt(id, current);
  owner.setDraft(id, "future-smith");
  const render = () =>
    ProjectKeeperSettings({
      projectId: id,
      archived: false,
      writesAllowed: true,
      settings: { ...owner.snapshot(), owner },
      smiths: { client: null, view: null },
    });
  const formOf = (tree: ReturnType<typeof render>) =>
    findAll(tree, "form").find(
      (node) => attrs(node)["aria-label"] === "Keeper visibility settings",
    );
  const savedText = (tree: ReturnType<typeof render>) =>
    textOf(
      findAll(tree, "p").find((node) =>
        textOf(node).startsWith("Saved visibility:"),
      ),
    );
  let tree = render();
  const initialSaved = savedText(tree);
  expect(initialSaved).toContain("Project metadata");
  expect(initialSaved).toContain("default policy");
  const select = findAll(tree, "select").find(
    (node) => attrs(node)["aria-label"] === "Keeper visibility",
  );
  expect(attrs(select)["disabled"]).toBe(false);
  const change = attrs(select)["onChange"];
  if (typeof change !== "function")
    throw Error("Missing real visibility change handler");
  change({ currentTarget: { value: "automatic" } });
  expect(owner.snapshot().projects[id]?.visibilityDraft).toBeNull();
  change({ currentTarget: { value: "conversation-only" } });
  expect(owner.snapshot().projects[id]?.visibilityDraft).toBe(
    "conversation-only",
  );
  expect({ reads, posts }).toEqual({ reads: 0, posts: [] });
  tree = render();
  expect(savedText(tree)).toBe(initialSaved);
  const form = formOf(tree);
  expect(attrs(findAll(form, "button")[0])["disabled"]).toBe(false);
  expect(
    attrs(
      findAll(tree, "button").find((node) =>
        textOf(node).includes("Save Keeper settings"),
      ),
    )["disabled"],
  ).toBe(true);
  const submit = attrs(form)["onSubmit"];
  if (typeof submit !== "function")
    throw Error("Missing real visibility submit handler");
  let enteredBusy = false,
    finish!: () => void;
  const settled = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const unsubscribe = owner.subscribe((state) => {
    if (state.busy === id) enteredBusy = true;
    else if (enteredBusy && state.busy === null) finish();
  });
  try {
    submit({
      preventDefault() {
        prevented++;
      },
    });
    expect(enteredBusy).toBe(true);
    await settled;
  } finally {
    unsubscribe();
  }
  expect(prevented).toBe(1);
  expect(posts).toEqual([
    {
      path: "/__agent-forge/projects/" + id + "/settings/keeper",
      body: {
        expectedRevision: 1,
        kind: "visibility",
        keeperVisibility: "conversation-only",
      },
    },
  ]);
  expect(reads).toBe(2);
  expect(owner.snapshot().projects[id]).toMatchObject({
    catalog: { revision: 2, keeperVisibility: "conversation-only" },
    draft: "future-smith",
    visibilityDraft: null,
    needsReview: false,
  });
  tree = render();
  expect(savedText(tree)).toContain("Conversation only");
  expect(savedText(tree)).toContain("project catalog");
  expect(savedText(tree)).toContain("revision 2");
  expect(attrs(findAll(formOf(tree), "button")[0])["disabled"]).toBe(true);
});

function keeperMatrixSmiths(enabled = true): SmithsController {
  const config = loadConfigFromContents({
    env: {},
    sources: {
      user: { file: "/fixture/user.toml", text: null },
      workspace: {
        file: "/fixture/agent-forge.toml",
        text: enabled ? null : "[smiths.claude-journeyman]\nenabled = false\n",
      },
    },
  });
  return {
    client: null,
    view: {
      configuration: {
        data: inspectSmiths(config),
        loading: false,
        error: "",
        checkedAt: "2026-11-08T00:00:00.000Z",
      },
      scoreboard: { data: null, loading: false, error: "", checkedAt: null },
      range: "7d",
      scoreboardRange: null,
      scoreboardSince: null,
    },
  };
}
function keeperMatrixOwner(
  options: {
    visibility?: KeeperVisibility | undefined;
    pending?: Record<string, number>;
    storage?: boolean;
    reply?: "lost" | "conflict";
    read?: () => Promise<unknown>;
  } = {},
) {
  const catalog = ownerVisibilityCatalog(1, {
    keeperSmith: "claude-journeyman",
    ...(options.visibility === undefined
      ? {}
      : { keeperVisibility: options.visibility }),
  });
  const stats = { reads: 0, posts: 0 };
  let pending: Record<string, number> = { ...options.pending };
  const owner = new ProjectKeeperSettingsOwner({
    read: async () => {
      stats.reads++;
      return options.read ? options.read() : catalog;
    },
    readPending: () => {
      if (options.storage) throw Error("Storage unavailable");
      return pending;
    },
    writePending: (next) => {
      pending = { ...next };
    },
    post: async () => {
      stats.posts++;
      if (options.reply === "lost") throw Error("Lost reply");
      return Response.json(
        { ok: false, data: null, error: "Conflict" },
        { status: 409 },
      );
    },
  });
  owner.adopt(FIXTURE_PROJECT_ID, catalog);
  owner.setDraft(FIXTURE_PROJECT_ID, "claude-journeyman");
  owner.setVisibilityDraft(
    FIXTURE_PROJECT_ID,
    options.visibility === "conversation-only"
      ? "project-metadata"
      : "conversation-only",
  );
  return { owner, stats, catalog };
}
function keeperMatrixView(
  owner: ProjectKeeperSettingsOwner,
  overrides: Partial<
    Pick<
      Parameters<typeof ProjectKeeperSettings>[0],
      "projectId" | "archived" | "writesAllowed" | "smiths"
    >
  > = {},
) {
  return ProjectKeeperSettings({
    projectId: FIXTURE_PROJECT_ID,
    archived: false,
    writesAllowed: true,
    settings: { ...owner.snapshot(), owner },
    smiths: keeperMatrixSmiths(),
    ...overrides,
  });
}
function keeperMatrixButtons(tree: ReturnType<typeof keeperMatrixView>) {
  return Object.fromEntries(
    findAll(tree, "form").map((form) => [
      attrs(form)["aria-label"] === "Keeper visibility settings"
        ? "visibility"
        : "keeper",
      attrs(findAll(form, "button")[0])["disabled"],
    ]),
  );
}
function forceBlockedKeeperForms(tree: ReturnType<typeof keeperMatrixView>) {
  const forms = findAll(tree, "form");
  expect(forms).toHaveLength(2);
  for (const form of forms) {
    expect(attrs(findAll(form, "button")[0])["disabled"]).toBe(true);
    const submit = attrs(form)["onSubmit"];
    if (typeof submit !== "function")
      throw Error("Missing actual submit handler");
    submit({ preventDefault() {} });
  }
}
const keeperSavedVisibilityText = (tree: ReturnType<typeof keeperMatrixView>) =>
  textOf(
    findAll(tree, "p").find((node) =>
      textOf(node).startsWith("Saved visibility:"),
    ),
  );

test("Keeper visibility busy, conflict and unknown owner states block both actual form callbacks", async () => {
  let release!: (value: unknown) => void, entered!: () => void;
  const held = new Promise<unknown>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const busy = keeperMatrixOwner({
    read: async () => {
      entered();
      return held;
    },
  });
  const reviewing = busy.owner.review(FIXTURE_PROJECT_ID);
  try {
    await started;
    const tree = keeperMatrixView(busy.owner);
    forceBlockedKeeperForms(tree);
    expect(
      attrs(
        findAll(tree, "Button").find((node) =>
          textOf(node).includes("Check current Keeper settings"),
        ),
      )["disabled"],
    ).toBe(true);
    expect(busy.stats).toEqual({ reads: 1, posts: 0 });
  } finally {
    release(busy.catalog);
    await reviewing;
  }
  for (const reply of ["lost", "conflict"] as const) {
    const { owner, stats } = keeperMatrixOwner({ reply });
    await owner.saveVisibility(FIXTURE_PROJECT_ID);
    const before = { ...stats },
      tree = keeperMatrixView(owner);
    expect(textOf(tree)).toContain(
      reply === "lost" ? "outcome is unknown" : "changed before saving",
    );
    forceBlockedKeeperForms(tree);
    expect(stats).toEqual(before);
    expect(owner.snapshot().busy).toBeNull();
  }
});
