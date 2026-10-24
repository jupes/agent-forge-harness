import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { ensurePrivateHome } from "../hearth/home-guard";
import {
  createShiftStarts,
  type ShiftChildExit,
} from "../hearth/shift-launcher";
import { writeOwnerOnly } from "../hearth/token";
import { FIXTURE_PROJECT_ID } from "../projects/testing";
import { writeShiftRecord } from "../scheduler/shift-store";
import { scratchDirs } from "../test-scratch";
import { executeOriginalProjectShift } from "./execution";
import { createAttendedProjectShiftLauncher } from "./launch-runtime";
import { projectShiftReceiptSchema } from "./protocol";
import {
  createProjectShiftRegistry,
  projectShiftRegistryFile,
} from "./registry";
import { createProjectShiftService } from "./service";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());
const request = {
  requestId: "ce7ab905-ce85-4447-9715-371bd9769a81",
  expectedCatalogRevision: 7,
  options: {
    for: "2h",
    concurrency: 1,
    maxBeads: 4,
    maxUsd: 10,
    repairs: 0,
    base: "main",
  },
};
const shiftId = "shift-20261023-063000-0001";
function fixture() {
  const root = realpathSync.native(scratch.make("project shift startup Stop ")),
    home = join(root, "home"),
    shiftsDir = join(home, "shifts");
  mkdirSync(join(root, ".git"));
  ensurePrivateHome(home);
  return { root, home, shiftsDir, workspace: root };
}

test("Starting Stop saves the original before cancelling its held tree, coalesces, and confirms only after settlement", async () => {
  const f = fixture(),
    registry = createProjectShiftRegistry(f);
  let finish = (_exit: ShiftChildExit) => {},
    stopEntered = () => {},
    stops = 0,
    launches = 0;
  const stopping = new Promise<void>((resolve) => {
    stopEntered = resolve;
  });
  const done = new Promise<ShiftChildExit>((resolve) => {
    finish = resolve;
  });
  const starts = createShiftStarts({
    ...f,
    environment: {},
    mintShiftId: () => shiftId,
    launch: () => {
      throw Error("No legacy launch");
    },
    projectLaunch: () => {
      launches++;
      return {
        pid: 123,
        done,
        async stop() {
          stops++;
          const saved = registry.read(FIXTURE_PROJECT_ID, request.requestId);
          expect(saved.startupStop?.requestedAt).toBeString();
          expect(saved.startupStop?.completedAt).toBeNull();
          stopEntered();
          await done;
        },
      };
    },
  });
  const service = createProjectShiftService({
    ...f,
    validateStart: async () => {},
    runtime: createAttendedProjectShiftLauncher(starts),
  });
  const started = await service.start(FIXTURE_PROJECT_ID, request);
  expect(started.observation.phase).toBe("starting");
  const one = service.stopStarting(FIXTURE_PROJECT_ID, shiftId);
  await stopping;
  const two = service.stopStarting(FIXTURE_PROJECT_ID, shiftId);
  const pending = service.read(FIXTURE_PROJECT_ID, request.requestId);
  expect(pending.observation.phase).toBe("stopping");
  expect(pending.observation.actual).toBeNull();
  expect(projectShiftReceiptSchema.safeParse(pending).success).toBe(true);
  finish({ exitCode: null, stdout: "", stderr: "" });
  const [first, second] = await Promise.all([one, two]);
  if (!first) throw Error("Expected the startup Stop receipt");
  expect(first?.observation.phase).toBe("stopped");
  expect(second).toEqual(first);
  expect(first?.observation.actual).toBeNull();
  expect(first?.intent.requestHash).toBe(started.intent.requestHash);
  expect(first?.intent.request).toEqual(request);
  expect(stops).toBe(1);
  expect(launches).toBe(1);
  expect(existsSync(join(f.shiftsDir, `${shiftId}.stop`))).toBe(false);
  expect(existsSync(join(f.shiftsDir, `${shiftId}.json`))).toBe(false);
  const before = readFileSync(projectShiftRegistryFile(f.home), "utf8");
  const reopened = createProjectShiftService({
    ...f,
    validateStart: async () => {
      throw Error("Archived or unavailable configuration");
    },
  });
  expect(reopened.read(FIXTURE_PROJECT_ID, request.requestId)).toEqual(first);
  expect(await reopened.start(FIXTURE_PROJECT_ID, request)).toEqual(first);
  expect(readFileSync(projectShiftRegistryFile(f.home), "utf8")).toBe(before);
  expect(projectShiftReceiptSchema.safeParse(first).success).toBe(true);
});

test("after recreation without the actual held handle, Stop stays unknown and fences late execution without PID-based completion", async () => {
  const f = fixture(),
    registry = createProjectShiftRegistry(f);
  const saved = await registry.reserve(
    FIXTURE_PROJECT_ID,
    request,
    async () => ({ shiftId }),
  );
  await registry.markAttempted(
    FIXTURE_PROJECT_ID,
    request.requestId,
    saved.intent.requestHash,
  );
  const service = createProjectShiftService({
    ...f,
    validateStart: async () => {},
  });
  const stopped = await service.stopStarting(FIXTURE_PROJECT_ID, shiftId);
  if (!stopped) throw Error("Expected the unknown startup Stop receipt");
  expect(stopped?.observation.phase).toBe("unknown");
  expect(stopped?.intent.startupStop?.completedAt).toBeNull();
  expect(stopped?.intent.requestHash).toBe(saved.intent.requestHash);
  let dispatched = 0;
  const late = await executeOriginalProjectShift({
    ...f,
    projectId: FIXTURE_PROJECT_ID,
    requestId: request.requestId,
    runtime: {
      attended: true,
      prepare: async () => {
        dispatched++;
      },
      run: async () => {
        dispatched++;
      },
    },
  });
  expect(late.observation.phase).toBe("unknown");
  expect(dispatched).toBe(0);
  await expect(
    registry.claimExecution(
      FIXTURE_PROJECT_ID,
      request.requestId,
      saved.intent.requestHash,
    ),
  ).rejects.toMatchObject({ status: 409 });
  const file = projectShiftRegistryFile(f.home),
    before = readFileSync(file, "utf8");
  expect((await service.start(FIXTURE_PROJECT_ID, request)).intent).toEqual(
    stopped?.intent,
  );
  await expect(
    service.stopStarting(
      "project-a38c579e-f311-481c-b84e-47e5110024a0",
      shiftId,
    ),
  ).rejects.toMatchObject({ status: 404 });
  const foreign = join(f.root, "foreign");
  mkdirSync(join(foreign, ".git"), { recursive: true });
  await expect(
    createProjectShiftService({
      ...f,
      root: foreign,
      validateStart: async () => {},
    }).stopStarting(FIXTURE_PROJECT_ID, shiftId),
  ).rejects.toMatchObject({ status: 404 });
  expect(readFileSync(file, "utf8")).toBe(before);
  expect(existsSync(join(f.shiftsDir, `${shiftId}.stop`))).toBe(false);
});

test("a canonical record published during startup cancellation wins and requires real recovery instead of a fabricated stopped receipt", async () => {
  const f = fixture();
  const service = createProjectShiftService({
    ...f,
    validateStart: async () => {},
    runtime: {
      attended: true,
      mint: () => shiftId,
      launch: () => {},
      async stopStarting(intent) {
        const startedAt = new Date().toISOString();
        writeShiftRecord(f.shiftsDir, {
          shiftId,
          workspace: intent.workspace,
          pid: 2_000_000_000,
          state: "running",
          startedAt,
          deadline: new Date(Date.parse(startedAt) + 7_200_000).toISOString(),
          options: {
            concurrency: 1,
            forMs: 7_200_000,
            maxBeads: 4,
            maxUsd: 10,
            repairs: 0,
            base: "main",
          },
          spentUsd: 0,
          unpriced: 0,
          admitted: 0,
          beads: [],
        });
        return true;
      },
    },
  });
  await service.start(FIXTURE_PROJECT_ID, request);
  const result = await service.stopStarting(FIXTURE_PROJECT_ID, shiftId);
  if (!result) throw Error("Expected the canonical race receipt");
  expect(result?.observation.phase).toBe("needs-recovery");
  expect(result?.observation.actual?.startedAt).toBeString();
  expect(result?.intent.startupStop?.completedAt).toBeNull();
  expect(service.authorizeControl(FIXTURE_PROJECT_ID, shiftId)).toEqual(result);
  expect(await service.stopStarting(FIXTURE_PROJECT_ID, shiftId)).toBeNull();
});

test("a lost Stop result or unconfirmed completion write retains the original and cannot claim completion", async () => {
  for (const corrupt of [false, true]) {
    const f = fixture(),
      file = projectShiftRegistryFile(f.home);
    let stops = 0,
      requested = "";
    const service = createProjectShiftService({
      ...f,
      validateStart: async () => {},
      runtime: {
        attended: true,
        mint: () => shiftId,
        launch: () => {},
        async stopStarting() {
          stops++;
          requested = readFileSync(file, "utf8");
          if (corrupt) {
            writeOwnerOnly(file, "{preserve-unverified-stop");
            return true;
          }
          throw Error("PRIVATE lost Stop response");
        },
      },
    });
    await service.start(FIXTURE_PROJECT_ID, request);
    if (corrupt) {
      await expect(
        service.stopStarting(FIXTURE_PROJECT_ID, shiftId),
      ).rejects.toMatchObject({ status: 503 });
      expect(readFileSync(file, "utf8")).toBe("{preserve-unverified-stop");
      writeOwnerOnly(file, requested);
    } else {
      expect(
        (await service.stopStarting(FIXTURE_PROJECT_ID, shiftId))?.observation
          .phase,
      ).toBe("unknown");
    }
    const read = service.read(FIXTURE_PROJECT_ID, request.requestId);
    expect(read.observation.phase).toBe("unknown");
    expect(read.intent.startupStop?.completedAt).toBeNull();
    expect(JSON.stringify(read)).not.toContain("PRIVATE");
    expect(stops).toBe(1);
  }
});

test("late Start completion re-reads startup Stop truth and never dispatches a cancelled original", async () => {
  const f = fixture();
  let release = () => {},
    entered = () => {},
    launches = 0;
  const held = new Promise<void>((resolve) => {
      release = resolve;
    }),
    entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
  const starts = createShiftStarts({
    ...f,
    environment: {},
    mintShiftId: () => shiftId,
    launch: () => {
      launches++;
      throw Error("No late launch");
    },
  });
  const bridge = createAttendedProjectShiftLauncher(starts);
  const service = createProjectShiftService({
    ...f,
    validateStart: async () => {},
    runtime: {
      ...bridge,
      async launch(intent) {
        entered();
        await held;
        bridge.launch(intent);
      },
    },
  });
  const starting = service.start(FIXTURE_PROJECT_ID, request);
  await entering;
  expect(
    (await service.stopStarting(FIXTURE_PROJECT_ID, shiftId))?.observation
      .phase,
  ).toBe("unknown");
  release();
  const outcome = await starting;
  expect(outcome.intent.startupStop?.requestedAt).toBeString();
  expect(outcome.observation.phase).toBe("unknown");
  expect(launches).toBe(0);
});

test("an invalid private path refuses startup Stop before cancelling, preserving every saved byte", async () => {
  const f = fixture();
  let stops = 0;
  const service = createProjectShiftService({
    ...f,
    validateStart: async () => {},
    runtime: {
      attended: true,
      mint: () => shiftId,
      launch: () => {},
      stopStarting: async () => {
        stops++;
        return true;
      },
    },
  });
  await service.start(FIXTURE_PROJECT_ID, request);
  const file = projectShiftRegistryFile(f.home),
    alias = join(f.root, "linked-original.json"),
    before = readFileSync(file, "utf8");
  linkSync(file, alias);
  try {
    await expect(
      service.stopStarting(FIXTURE_PROJECT_ID, shiftId),
    ).rejects.toMatchObject({ status: 503 });
    expect(stops).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(before);
  } finally {
    unlinkSync(alias);
  }
  expect(
    service.read(FIXTURE_PROJECT_ID, request.requestId).intent.startupStop,
  ).toBeUndefined();
});

test("late ownership settlement cannot complete a replaced original association", async () => {
  const f = fixture(),
    file = projectShiftRegistryFile(f.home);
  const service = createProjectShiftService({
    ...f,
    validateStart: async () => {},
    runtime: {
      attended: true,
      mint: () => shiftId,
      launch: () => {},
      async stopStarting(intent) {
        writeOwnerOnly(
          file,
          JSON.stringify({
            version: 1,
            records: [{ ...intent, shiftId: "shift-20261023-063000-0002" }],
          }),
        );
        return true;
      },
    },
  });
  await service.start(FIXTURE_PROJECT_ID, request);
  const outcome = await service.stopStarting(FIXTURE_PROJECT_ID, shiftId);
  expect(outcome?.observation.phase).toBe("unknown");
  expect(outcome?.intent.startupStop?.completedAt).toBeNull();
  expect(outcome?.observation.actual).toBeNull();
});

test("strict startup receipts reject invented completion, contradictory timestamps and unknown control fields; old originals remain readable", async () => {
  const f = fixture();
  const service = createProjectShiftService({
    ...f,
    validateStart: async () => {},
    runtime: { attended: true, mint: () => shiftId, launch: () => {} },
  });
  const original = await service.start(FIXTURE_PROJECT_ID, request),
    stopped = {
      ...original,
      observation: { ...original.observation, phase: "stopped" },
    },
    requestedAt = original.intent.attemptedAt;
  if (!requestedAt) throw Error("Missing attempted Start");
  expect(projectShiftReceiptSchema.safeParse(original).success).toBe(true);
  expect(projectShiftReceiptSchema.safeParse(stopped).success).toBe(false);
  for (const startupStop of [
    { requestedAt, completedAt: null },
    { requestedAt, completedAt: "2000-01-01T00:00:00.000Z" },
    { requestedAt, completedAt: requestedAt, pid: process.pid },
  ])
    expect(
      projectShiftReceiptSchema.safeParse({
        ...stopped,
        intent: { ...original.intent, startupStop },
      }).success,
    ).toBe(false);
  expect(
    projectShiftReceiptSchema.safeParse({
      ...stopped,
      intent: {
        ...original.intent,
        startupStop: { requestedAt, completedAt: requestedAt },
      },
    }).success,
  ).toBe(true);
});
