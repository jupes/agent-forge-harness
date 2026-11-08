import { expect, test } from "bun:test";
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
