import { afterEach, expect, test } from "bun:test";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { ensurePrivateHome } from "../hearth/home-guard";
import { writeOwnerOnly } from "../hearth/token";
import { FIXTURE_PROJECT_ID } from "../projects/testing";
import {
  createProjectShiftRegistry,
  MAX_PROJECT_SHIFT_REQUESTS,
  projectShiftRegistryFile,
  projectShiftRequestHash,
} from "./registry";

const opened: string[] = [];
afterEach(() => {
  for (const root of opened.splice(0)) {
    if (
      dirname(root) !== realpathSync.native(tmpdir()) ||
      !basename(root).startsWith("agent-forge project shifts ") ||
      lstatSync(root).isSymbolicLink()
    )
      throw Error("Unsafe shift fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = realpathSync.native(
    mkdtempSync(join(tmpdir(), "agent-forge project shifts ")),
  );
  opened.push(root);
  const home = join(root, "home"),
    workspace = join(root, "workspace");
  ensurePrivateHome(home);
  mkdirSync(join(workspace, ".git"), { recursive: true });
  return { home, root: resolve(workspace) };
}
const request = {
  requestId: "b14cc7eb-3231-4930-a288-d411c5ee0426",
  expectedCatalogRevision: 7,
  options: {
    for: "2h",
    concurrency: 2,
    maxBeads: 4,
    maxUsd: 10,
    repairs: 3,
    base: "master",
  },
};
const shiftId = "shift-20261023-063000-0001";

test("concurrent exact Starts reserve one immutable original before mutable preparation and survive recreation without dispatch", async () => {
  const paths = fixture(),
    one = createProjectShiftRegistry(paths),
    two = createProjectShiftRegistry(paths);
  let prepared = 0;
  const prepare = async () => {
    prepared++;
    return { shiftId };
  };
  const [first, second] = await Promise.all([
    one.reserve(FIXTURE_PROJECT_ID, request, prepare),
    two.reserve(FIXTURE_PROJECT_ID, structuredClone(request), prepare),
  ]);
  expect(prepared).toBe(1);
  expect(first.intent).toEqual(second.intent);
  expect([first.created, second.created].sort()).toEqual([false, true]);
  expect(first.intent.attemptedAt).toBeNull();
  const recreated = createProjectShiftRegistry(paths);
  expect(recreated.read(FIXTURE_PROJECT_ID, request.requestId)).toEqual(
    first.intent,
  );
  const original = await recreated.reserve(
    FIXTURE_PROJECT_ID,
    request,
    async () => {
      throw Error("Mutable settings unavailable");
    },
  );
  expect(original.created).toBe(false);
  expect(original.intent.request).toEqual(request);
  expect(original.intent.shiftId).toBe(shiftId);
});

test("changed or foreign original requests refuse before preparation, and each project/workspace keeps its own records", async () => {
  const paths = fixture(),
    registry = createProjectShiftRegistry(paths);
  await registry.reserve(FIXTURE_PROJECT_ID, request, async () => ({
    shiftId,
  }));
  let prepared = 0;
  const prepare = async () => {
    prepared++;
    return { shiftId: "shift-20261023-063000-0002" };
  };
  await expect(
    registry.reserve(
      FIXTURE_PROJECT_ID,
      { ...request, options: { ...request.options, maxBeads: 5 } },
      prepare,
    ),
  ).rejects.toThrow("different reviewed bounds");
  const otherProject = "project-b5832fa0-7a21-403b-8184-44892f0d8d86";
  await expect(
    registry.reserve(otherProject, request, prepare),
  ).rejects.toThrow("different project or workspace");
  expect(() => registry.read(otherProject, request.requestId)).toThrow(
    "different project or workspace",
  );
  const otherWorkspace = join(paths.root, "other");
  mkdirSync(join(otherWorkspace, ".git"), { recursive: true });
  const foreign = createProjectShiftRegistry({
    home: paths.home,
    root: otherWorkspace,
  });
  await expect(
    foreign.reserve(FIXTURE_PROJECT_ID, request, prepare),
  ).rejects.toThrow("different project or workspace");
  expect(() => foreign.read(FIXTURE_PROJECT_ID, request.requestId)).toThrow(
    "different project or workspace",
  );
  expect(foreign.list(FIXTURE_PROJECT_ID)).toEqual([]);
  expect(prepared).toBe(0);
  const independent = await foreign.reserve(
    FIXTURE_PROJECT_ID,
    { ...request, requestId: crypto.randomUUID() },
    prepare,
  );
  expect(prepared).toBe(1);
  expect(foreign.list(FIXTURE_PROJECT_ID)).toEqual([independent.intent]);
  expect(registry.list(FIXTURE_PROJECT_ID)).toHaveLength(1);
});

test("an explicitly marked launch is durably fenced once; reads and recreation never clear the attempted boundary", async () => {
  const paths = fixture(),
    registry = createProjectShiftRegistry(paths);
  const saved = await registry.reserve(
    FIXTURE_PROJECT_ID,
    request,
    async () => ({ shiftId }),
  );
  const first = await registry.markAttempted(
    FIXTURE_PROJECT_ID,
    request.requestId,
    saved.intent.requestHash,
  );
  expect(first.created).toBe(true);
  expect(first.intent.attemptedAt).not.toBeNull();
  const reopened = createProjectShiftRegistry(paths);
  const again = await reopened.markAttempted(
    FIXTURE_PROJECT_ID,
    request.requestId,
    saved.intent.requestHash,
  );
  expect(again.created).toBe(false);
  expect(again.intent).toEqual(first.intent);
  expect(reopened.read(FIXTURE_PROJECT_ID, request.requestId)).toEqual(
    first.intent,
  );
});

test("preparation refusal or invalid full bounds leave no reservation", async () => {
  const paths = fixture(),
    registry = createProjectShiftRegistry(paths);
  await expect(
    registry.reserve(FIXTURE_PROJECT_ID, request, async () => {
      throw Error("Scope changed");
    }),
  ).rejects.toThrow("Scope changed");
  expect(registry.list(FIXTURE_PROJECT_ID)).toEqual([]);
  let prepared = 0;
  for (const options of [
    { ...request.options, for: "99h" },
    { ...request.options, base: "../outside" },
    { ...request.options, concurrency: 9 },
    { ...request.options, repairs: -1 },
    { ...request.options, runTimeout: "1d" },
  ]) {
    await expect(
      registry.reserve(
        FIXTURE_PROJECT_ID,
        { ...request, options },
        async () => {
          prepared++;
          return { shiftId };
        },
      ),
    ).rejects.toThrow();
  }
  expect(prepared).toBe(0);
  expect(registry.list(FIXTURE_PROJECT_ID)).toEqual([]);
});

test("malformed, future and linked private intent files are preserved and refuse before preparation", async () => {
  for (const text of ["{damaged", '{"version":99,"records":[]}']) {
    const paths = fixture(),
      file = projectShiftRegistryFile(paths.home);
    writeOwnerOnly(file, text);
    const registry = createProjectShiftRegistry(paths);
    let prepared = 0;
    await expect(
      registry.reserve(FIXTURE_PROJECT_ID, request, async () => {
        prepared++;
        return { shiftId };
      }),
    ).rejects.toThrow("Saved Start identities have been kept");
    expect(prepared).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(text);
  }
  const paths = fixture(),
    file = projectShiftRegistryFile(paths.home),
    target = join(paths.root, "linked-intent.json");
  writeOwnerOnly(target, '{"version":1,"records":[]}');
  mkdirSync(dirname(file), { recursive: true });
  linkSync(target, file);
  const before = readFileSync(target, "utf8");
  await expect(
    createProjectShiftRegistry(paths).reserve(
      FIXTURE_PROJECT_ID,
      request,
      async () => ({ shiftId }),
    ),
  ).rejects.toThrow("linked or invalid");
  expect(readFileSync(target, "utf8")).toBe(before);
});

test("full private intent storage retains every original and refuses overflow without preparing or eviction", async () => {
  const paths = fixture(),
    registry = createProjectShiftRegistry(paths);
  const first = await registry.reserve(
    FIXTURE_PROJECT_ID,
    request,
    async () => ({ shiftId }),
  );
  const records = Array.from(
    { length: MAX_PROJECT_SHIFT_REQUESTS },
    (_, index) => {
      const original = {
        ...request,
        requestId: index === 0 ? request.requestId : crypto.randomUUID(),
      };
      return {
        ...first.intent,
        request: original,
        shiftId: `shift-20261023-063000-${index.toString(16).padStart(4, "0")}`,
        requestHash: projectShiftRequestHash(
          FIXTURE_PROJECT_ID,
          first.intent.workspace,
          original,
        ),
      };
    },
  );
  const file = projectShiftRegistryFile(paths.home),
    text = JSON.stringify({ version: 1, records });
  writeOwnerOnly(file, text);
  let prepared = 0;
  await expect(
    registry.reserve(
      FIXTURE_PROJECT_ID,
      { ...request, requestId: crypto.randomUUID() },
      async () => {
        prepared++;
        return { shiftId };
      },
    ),
  ).rejects.toThrow("full");
  expect(prepared).toBe(0);
  expect(readFileSync(file, "utf8")).toBe(text);
  if (!records[0]) throw Error("Missing retained original fixture");
  expect(registry.read(FIXTURE_PROJECT_ID, request.requestId)).toEqual(
    records[0],
  );
});
