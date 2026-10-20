import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCouncilService } from "./service";

test.each([
  true,
  false,
])("the UI default matches an omitted start profile, even with other files first (default present: %s)", async (includeDefault) => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "council-profile-order-")),
  );
  const harnessRoot = join(root, "harness");
  const workspaceRoot = join(root, "workspace");
  for (const directory of [harnessRoot, workspaceRoot])
    mkdirSync(join(directory, "councils"), { recursive: true });
  const body = readFileSync(
    join(import.meta.dir, "../../councils/default.json"),
    "utf8",
  );
  const harness = (name: string) => join(harnessRoot, "councils", name);
  const workspace = (name: string) => join(workspaceRoot, "councils", name);
  // Neither insertion order nor alphabetical order puts the intended default first.
  for (const path of [
    workspace("z.json"),
    workspace("default.json"),
    harness("z.json"),
    harness("a.json"),
  ])
    writeFileSync(path, body);
  writeFileSync(harness("broken.json"), "invalid profile");
  if (includeDefault) writeFileSync(harness("default.json"), body);
  const service = createCouncilService({
    harnessRoot,
    workspaceRoot,
    environment: {},
  });
  try {
    const otherPaths = [
      harness("a.json"),
      harness("z.json"),
      workspace("default.json"),
      workspace("z.json"),
    ].sort();
    expect(service.profiles().map((profile) => profile.path)).toEqual(
      includeDefault ? [harness("default.json"), ...otherPaths] : otherPaths,
    );
    if (includeDefault)
      expect(service.profiles()[0]?.id).toBe(service.readiness().profileId);
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
