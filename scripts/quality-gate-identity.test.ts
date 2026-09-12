import { describe, expect, test } from "bun:test";
import { gateIdentity } from "./quality-gate-identity";

const BASE = {
  cwd: "C:/work/harness/trees/dg40/scripts",
  gitToplevel: "C:/work/harness/trees/dg40",
  gitBranch: "feat/nocturne",
  taskId: "agent-forge-harness-dg40.9",
  forgeStateJson: JSON.stringify({
    slug: "agent-forge-harness-dg40",
    phase: "implement",
  }),
};

describe("gateIdentity", () => {
  test("records the checkout top level, branch, task and forge run", () => {
    expect(gateIdentity(BASE)).toEqual({
      checkout: "C:/work/harness/trees/dg40",
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

  test("records no forge run when there is no readable forge state", () => {
    for (const forgeStateJson of [
      null,
      "",
      "not json",
      JSON.stringify({ phase: "plan" }),
    ]) {
      expect(gateIdentity({ ...BASE, forgeStateJson }).forgeSlug).toBeNull();
    }
  });

  test("records no task when the event carried none", () => {
    expect(gateIdentity({ ...BASE, taskId: undefined }).taskId).toBeNull();
    expect(gateIdentity({ ...BASE, taskId: "" }).taskId).toBeNull();
  });
});
