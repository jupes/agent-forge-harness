import { describe, expect, test } from "bun:test";
import { forgeSlugFor, gateIdentity } from "./quality-gate-identity";

const TREE = "C:/work/harness/trees/dg40";

const BASE = {
  cwd: "C:/work/harness/trees/dg40/scripts",
  gitToplevel: TREE,
  gitBranch: "feat/nocturne",
  taskId: "agent-forge-harness-dg40.9",
  forgeSlugEnv: null as string | null,
  runs: [{ slug: "agent-forge-harness-dg40", complete: false, checkout: TREE }],
};

describe("gateIdentity", () => {
  test("records the checkout top level, branch, task and forge run", () => {
    expect(gateIdentity(BASE)).toEqual({
      checkout: TREE,
      branch: "feat/nocturne",
      taskId: "agent-forge-harness-dg40.9",
      forgeSlug: "agent-forge-harness-dg40",
    });
  });

  test("uses the top level, not the directory the hook happened to run in", () => {
    expect(gateIdentity(BASE).checkout).not.toBe(BASE.cwd);
  });

  test("falls back to the working directory outside a git checkout", () => {
    const identity = gateIdentity({
      ...BASE,
      gitToplevel: null,
      gitBranch: null,
    });
    expect(identity.checkout).toBe(BASE.cwd);
    expect(identity.branch).toBeNull();
  });

  test("records no branch for a detached HEAD", () => {
    expect(gateIdentity({ ...BASE, gitBranch: "HEAD" }).branch).toBeNull();
  });

  test("trims the newline git prints", () => {
    const identity = gateIdentity({
      ...BASE,
      gitToplevel: "C:/work/harness\n",
      gitBranch: "main\n",
    });
    expect(identity.checkout).toBe("C:/work/harness");
    expect(identity.branch).toBe("main");
  });

  test("records no forge run when the harness knows of none", () => {
    expect(gateIdentity({ ...BASE, runs: [] }).forgeSlug).toBeNull();
  });

  test("records no task when the event carried none", () => {
    expect(gateIdentity({ ...BASE, taskId: undefined }).taskId).toBeNull();
    expect(gateIdentity({ ...BASE, taskId: "" }).taskId).toBeNull();
  });
});

describe("forgeSlugFor", () => {
  const other = "C:/work/harness/trees/aa11";

  test("FORGE_SLUG wins, even before the run has written state", () => {
    expect(
      forgeSlugFor({ envSlug: "brand-new", checkout: TREE, runs: [] }),
    ).toBe("brand-new");
  });

  test("ignores a blank FORGE_SLUG", () => {
    expect(
      forgeSlugFor({
        envSlug: "   ",
        checkout: TREE,
        runs: [{ slug: "only", complete: false, checkout: null }],
      }),
    ).toBe("only");
  });

  test("picks the run that claims this checkout", () => {
    expect(
      forgeSlugFor({
        envSlug: null,
        checkout: TREE,
        runs: [
          { slug: "here", complete: false, checkout: TREE },
          { slug: "elsewhere", complete: false, checkout: other },
        ],
      }),
    ).toBe("here");
  });

  test("matches a checkout across separator and drive-case differences", () => {
    expect(
      forgeSlugFor({
        envSlug: null,
        checkout: "c:\\work\\harness\\trees\\dg40\\",
        runs: [{ slug: "here", complete: false, checkout: TREE }],
      }),
    ).toBe("here");
  });

  test("records nothing when two live runs share this checkout", () => {
    expect(
      forgeSlugFor({
        envSlug: null,
        checkout: TREE,
        runs: [
          { slug: "alpha", complete: false, checkout: TREE },
          { slug: "beta", complete: false, checkout: TREE },
        ],
      }),
    ).toBeNull();
  });

  test("records nothing when two live runs recorded no checkout", () => {
    expect(
      forgeSlugFor({
        envSlug: null,
        checkout: TREE,
        runs: [
          { slug: "alpha", complete: false, checkout: null },
          { slug: "beta", complete: false, checkout: null },
        ],
      }),
    ).toBeNull();
  });

  test("a shipped run does not claim new gate results", () => {
    expect(
      forgeSlugFor({
        envSlug: null,
        checkout: TREE,
        runs: [
          { slug: "shipped", complete: true, checkout: TREE },
          { slug: "live", complete: false, checkout: null },
        ],
      }),
    ).toBe("live");
  });

  test("a run in another worktree never claims this checkout's gate", () => {
    expect(
      forgeSlugFor({
        envSlug: null,
        checkout: TREE,
        runs: [
          { slug: "elsewhere", complete: false, checkout: other },
          { slug: "also-elsewhere", complete: false, checkout: other },
        ],
      }),
    ).toBeNull();
  });
});
