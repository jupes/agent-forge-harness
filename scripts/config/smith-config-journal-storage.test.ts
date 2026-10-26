import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertOwnerOnly, nativeWindowsAcl } from "../hearth/acl-windows";
import { scratchDirs } from "../test-scratch";
import {
  createSmithConfigJournalStorage,
  smithJournalDirectoryName,
} from "./smith-config-journal-storage";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("journal families map only to their fixed, isolated namespaces", () => {
  expect(smithJournalDirectoryName("create")).toBe("smith-create-journal");
  expect(smithJournalDirectoryName("edit")).toBe("smith-edit-journal");
  expect(smithJournalDirectoryName("routing")).toBe(
    "smith-routing-edit-journal",
  );
  expect(() => smithJournalDirectoryName("custom")).toThrow(
    "The private Smith journal family is invalid.",
  );
  expect(() => smithJournalDirectoryName(null)).toThrow(
    "The private Smith journal family is invalid.",
  );
});

test("invalid family is rejected before profile resolution or filesystem changes", () => {
  const absentProfile = join(scratch.make("smith-family-invalid-"), "absent");
  expect(() =>
    // Runtime callers are checked even when they bypass the TypeScript union.
    createSmithConfigJournalStorage(absentProfile, "custom" as "create"),
  ).toThrow("The private Smith journal family is invalid.");
  expect(existsSync(absentProfile)).toBe(false);
});

test("same request identity remains isolated between fixed Smith journal stores", async () => {
  const profile = join(scratch.make("smith-family-isolation-"), "profile");
  mkdirSync(profile);
  const create = createSmithConfigJournalStorage(profile, "create"),
    edit = createSmithConfigJournalStorage(profile, "edit"),
    routing = createSmithConfigJournalStorage(profile, "routing"),
    requestId = "eb56db61-e8ac-46c8-8e05-a787754d1019",
    createText = '{"family":"create"}',
    editText = '{"family":"edit"}',
    routingText = '{"family":"routing"}';

  await create.exclusive(async () => {
    create.writeOnce(requestId, "intent.json", createText);
  });
  await edit.exclusive(async () => {
    edit.writeOnce(requestId, "intent.json", editText);
  });
  await routing.exclusive(async () => {
    routing.writeOnce(requestId, "intent.json", routingText);
  });

  for (const [storage, expected] of [
    [create, createText],
    [edit, editText],
    [routing, routingText],
  ] as const) {
    const entries = [...storage.inspect(requestId)!];
    expect(entries.map(({ name }) => name)).toEqual(["intent.json"]);
    expect(storage.read(requestId, entries[0]!, 65_536)).toBe(expected);
    expect(
      [...storage.operations()].map(({ requestId: listed }) => listed),
    ).toEqual([requestId]);
  }
  expect(existsSync(join(profile, "smith-create-journal"))).toBe(true);
  expect(existsSync(join(profile, "smith-edit-journal"))).toBe(true);
  expect(existsSync(join(profile, "smith-routing-edit-journal"))).toBe(true);
});

test("routing SQLite sidecars stay owner-only and its mutex serializes another process", async () => {
  const profile = join(scratch.make("smith-routing-cross-process-"), "profile");
  mkdirSync(profile);
  const storage = createSmithConfigJournalStorage(profile, "routing"),
    signal = join(scratch.make("smith-routing-signal-"), "started"),
    entered = join(scratch.make("smith-routing-entered-"), "entered");
  let release!: () => void;
  let announceHeld!: () => void;
  const held = new Promise<void>((resolve) => (announceHeld = resolve)),
    gate = new Promise<void>((resolve) => (release = resolve));

  const parent = storage.exclusive(async () => {
    announceHeld();
    await gate;
  });
  await held;
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "smith-routing-storage-child.ts")],
    {
      env: {
        ...process.env,
        SMITH_ROUTING_STORAGE_CHILD_ROLE: "exclusive",
        SMITH_ROUTING_STORAGE_CHILD_PROFILE: profile,
        SMITH_ROUTING_STORAGE_CHILD_SIGNAL: signal,
        SMITH_ROUTING_STORAGE_CHILD_ENTERED: entered,
      },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  try {
    const deadline = Date.now() + 2_000;
    while (
      !existsSync(signal) &&
      child.exitCode === null &&
      Date.now() < deadline
    )
      await sleep(10);
    expect(existsSync(signal)).toBe(true);
    await sleep(100);
    expect(existsSync(entered)).toBe(false);

    const lockDirectory = join(profile, "smith-routing-edit-journal", "locks"),
      mutex = join(lockDirectory, "journal.sqlite"),
      sidecars = readdirSync(lockDirectory).filter(
        (name) => name !== "journal.sqlite",
      );
    if (process.platform === "win32") {
      expect(sidecars.length).toBeGreaterThan(0);
      const acl = nativeWindowsAcl();
      expect(acl.read(mutex).owner).toBe(acl.userSid());
      assertOwnerOnly(mutex, "file", acl);
      for (const name of sidecars) {
        const path = join(lockDirectory, name);
        expect(acl.read(path).owner).toBe(acl.userSid());
        assertOwnerOnly(path, "file", acl);
      }
    }

    release();
    await parent;
    const exited = await Promise.race([
      child.exited,
      sleep(2_000).then(() => null),
    ]);
    expect(exited).toBe(0);
    expect(existsSync(entered)).toBe(true);
  } finally {
    release();
    await parent.catch(() => undefined);
    if (child.exitCode === null) {
      await Promise.race([child.exited, sleep(1_000)]);
      if (child.exitCode === null) child.kill();
    }
    await child.exited;
  }
});
