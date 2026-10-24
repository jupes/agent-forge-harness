import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ensurePrivateHome } from "../hearth/home-guard";
import { FIXTURE_PROJECT_ID } from "../projects/testing";
import { projectShiftReceiptSchema } from "./protocol";
import {
  createProjectShiftRegistry,
  projectShiftRegistryFile,
} from "./registry";
import { createProjectShiftService } from "./service";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (
      dirname(root) !== realpathSync.native(tmpdir()) ||
      !basename(root).startsWith("agent-forge project shift service ") ||
      lstatSync(root).isSymbolicLink()
    )
      throw Error("Unsafe shift service cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = realpathSync.native(
    mkdtempSync(join(tmpdir(), "agent-forge project shift service ")),
  );
  roots.push(root);
  const home = join(root, "home"),
    workspace = join(root, "workspace");
  ensurePrivateHome(home);
  mkdirSync(join(workspace, ".git"), { recursive: true });
  return { home, root: workspace };
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

test("exact Start survives a lost launch result and recreation without mutable validation or redispatch; reads stay inert", async () => {
  const paths = fixture();
  let checked = 0,
    launched = 0;
  const service = createProjectShiftService({
    ...paths,
    validateStart: async () => {
      checked++;
    },
    runtime: {
      attended: true,
      mint: () => shiftId,
      launch: () => {
        launched++;
        throw Error("PRIVATE-UNKNOWN-PROVIDER");
      },
    },
  });
  const [one, two] = await Promise.all([
    service.start(FIXTURE_PROJECT_ID, request),
    service.start(FIXTURE_PROJECT_ID, structuredClone(request)),
  ]);
  expect(one.intent.shiftId).toBe(shiftId);
  expect(projectShiftReceiptSchema.safeParse(one).success).toBe(true);
  expect(
    projectShiftReceiptSchema.safeParse({
      ...one,
      observation: {
        ...one.observation,
        requestId: "5bb5fd7a-0729-457b-af9d-4f49ca690f01",
      },
    }).success,
  ).toBe(false);
  expect(two.intent.requestHash).toBe(one.intent.requestHash);
  expect(checked).toBe(1);
  expect(launched).toBe(1);
  expect(
    service.read(FIXTURE_PROJECT_ID, request.requestId).observation.phase,
  ).toBe("unknown");
  const recreated = createProjectShiftService({
    ...paths,
    validateStart: async () => {
      throw Error("mutable configuration unavailable");
    },
  });
  expect((await recreated.start(FIXTURE_PROJECT_ID, request)).intent).toEqual(
    service.read(FIXTURE_PROJECT_ID, request.requestId).intent,
  );
  expect(recreated.list(FIXTURE_PROJECT_ID).items).toHaveLength(1);
  expect(JSON.stringify(recreated.list(FIXTURE_PROJECT_ID))).not.toContain(
    "PRIVATE",
  );
  expect(launched).toBe(1);
  await expect(
    recreated.start(FIXTURE_PROJECT_ID, {
      ...request,
      options: { ...request.options, maxBeads: 5 },
    }),
  ).rejects.toMatchObject({ status: 409 });
});

test("production refuses Start before any durable reservation until attended capture exists", async () => {
  const paths = fixture();
  let checked = 0;
  const service = createProjectShiftService({
    ...paths,
    validateStart: async () => {
      checked++;
    },
  });
  await expect(
    service.start(FIXTURE_PROJECT_ID, request),
  ).rejects.toMatchObject({ status: 503 });
  expect(checked).toBe(0);
  expect(existsSync(projectShiftRegistryFile(paths.home))).toBe(false);
});

test("the validated and dispatched bounds are the parsed immutable original even if a caller mutates its object while admission waits", async () => {
  const paths = fixture(),
    body = structuredClone(request);
  const checked: number[] = [],
    dispatched: number[] = [];
  const service = createProjectShiftService({
    ...paths,
    validateStart: async (_id, reviewed) => {
      checked.push(reviewed.options.maxBeads);
    },
    runtime: {
      attended: true,
      mint: () => shiftId,
      launch: (intent) => {
        dispatched.push(intent.request.options.maxBeads);
      },
    },
  });
  const pending = service.start(FIXTURE_PROJECT_ID, body);
  body.options.maxBeads = 9;
  body.requestId = "5bb5fd7a-0729-457b-af9d-4f49ca690f01";
  const receipt = await pending;
  expect(checked).toEqual([4]);
  expect(dispatched).toEqual([4]);
  expect(receipt.intent.request.options.maxBeads).toBe(4);
});

test("a reserved original is read before mutable preparation but never implicitly launched, and closing fences late admission", async () => {
  const paths = fixture();
  await createProjectShiftRegistry(paths).reserve(
    FIXTURE_PROJECT_ID,
    request,
    async () => ({ shiftId }),
  );
  let calls = 0;
  const service = createProjectShiftService({
    ...paths,
    validateStart: async () => {
      calls++;
    },
    runtime: {
      attended: true,
      mint: () => shiftId,
      launch: () => {
        calls++;
      },
    },
  });
  expect(
    (await service.start(FIXTURE_PROJECT_ID, request)).observation.phase,
  ).toBe("reserved");
  expect(calls).toBe(0);
  const other = fixture();
  let release = () => {};
  const held = new Promise<void>((done) => {
    release = done;
  });
  let entered = () => {};
  const entering = new Promise<void>((done) => {
    entered = done;
  });
  const closing = createProjectShiftService({
    ...other,
    validateStart: async () => {
      entered();
      await held;
    },
    runtime: {
      attended: true,
      mint: () => shiftId,
      launch: () => {
        calls++;
      },
    },
  });
  const pending = closing.start(FIXTURE_PROJECT_ID, request);
  await entering;
  closing.close();
  release();
  await expect(pending).rejects.toMatchObject({ status: 503 });
  expect(existsSync(projectShiftRegistryFile(other.home))).toBe(false);
  expect(calls).toBe(0);
});
