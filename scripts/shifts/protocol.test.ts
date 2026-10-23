import { expect, test } from "bun:test";
import { projectShiftStartSchema } from "./protocol";

const request = {
  requestId: "b14cc7eb-3231-4930-a288-d411c5ee0426",
  expectedCatalogRevision: 2,
  options: {
    for: "2h",
    concurrency: 2,
    maxBeads: 4,
    maxUsd: 10,
    repairs: 3,
    base: "master",
  },
};

test("reviewed shift Start is closed and accepts full bounds without caller runtime or workspace authority", () => {
  expect(projectShiftStartSchema.safeParse(request).success).toBe(true);
  for (const extra of [
    { argv: ["other"] },
    { workspace: "/other" },
    { resume: "foreign" },
    { context: "private" },
  ])
    expect(
      projectShiftStartSchema.safeParse({ ...request, ...extra }).success,
    ).toBe(false);
  for (const options of [
    { ...request.options, concurrency: 0 },
    { ...request.options, repairs: 11 },
    { ...request.options, maxUsd: 0 },
    { ...request.options, shell: "other" },
    { ...request.options, for: "25h" },
    { ...request.options, base: "--upload-pack=x" },
    { ...request.options, base: "shift/other/work" },
  ])
    expect(
      projectShiftStartSchema.safeParse({ ...request, options }).success,
    ).toBe(false);
});

test("the shift browser protocol bundles without Node, Bun, private stores or runtime launchers", async () => {
  const built = await Bun.build({
    entrypoints: [import.meta.dir + "/protocol.ts"],
    target: "browser",
  });
  expect(built.success).toBe(true);
  const bundle = await built.outputs[0]?.text();
  expect(bundle).toBeDefined();
  expect(bundle).not.toContain("node:fs");
  expect(bundle).not.toContain("bun:sqlite");
  expect(bundle).not.toContain("createShiftStarts");
  expect(bundle).not.toContain("writeOwnerOnly");
});
