import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { SmithConfigPreview } from "../../types/smith-config-create";
import { assertOwnerOnly, nativeWindowsAcl } from "../hearth/acl-windows";
import { ensurePrivateHome } from "../hearth/home-guard";
import { scratchDirs } from "../test-scratch";
import { createSmithCreateJournalCore } from "./smith-create-journal-core";
import type { SmithCreateOwner } from "./smith-create-journal-protocol";
import {
  createSmithCreateJournalStorage,
  isTrustedNewSmithSidecarOwner,
} from "./smith-create-journal-storage";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());

const id = "eb56db61-e8ac-46c8-8e05-a787754d1019";
const profile = () => join(scratch.make("smith-create-journal-"), "profile");
const original = {
  requestId: id,
  target: "workspace" as const,
  smith: {
    name: "complete",
    provider: "custom",
    model: "exact",
    effort: "custom",
    enabled: true,
    tags: ["tag"],
  },
  expectedRevision: {
    version: 1 as const,
    user: "a".repeat(64),
    workspace: "b".repeat(64),
  },
};
const owner = (home: string): SmithCreateOwner => ({
  version: 1,
  checkout: { path: "/served/repo", dev: "1", ino: "2" },
  profile: home,
  userSelector: "/user/config.toml",
  workspaceSelector: "/served/repo/agent-forge.toml",
});
const preview = (originalRequest = original): SmithConfigPreview => {
  const file = "/served/repo/agent-forge.toml";
  return {
    version: 1,
    target: "workspace",
    file,
    expectedRevision: originalRequest.expectedRevision,
    candidate: { sha256: "c".repeat(64), byteLength: 300, created: true },
    review: {
      before: null,
      after: originalRequest.smith,
      provenance: {
        provider: file,
        model: file,
        effort: file,
        enabled: file,
        tags: file,
      },
    },
  };
};

test("only the current user or this token's default owner is trusted for a new SQLite sidecar", () => {
  const user = "S-1-5-21-1000",
    elevatedDefaultOwner = "S-1-5-32-544";
  expect(isTrustedNewSmithSidecarOwner(user, user, elevatedDefaultOwner)).toBe(
    true,
  );
  expect(
    isTrustedNewSmithSidecarOwner(
      elevatedDefaultOwner,
      user,
      elevatedDefaultOwner,
    ),
  ).toBe(true);
  expect(
    isTrustedNewSmithSidecarOwner("S-1-5-18", user, elevatedDefaultOwner),
  ).toBe(false);
  expect(
    isTrustedNewSmithSidecarOwner(
      elevatedDefaultOwner,
      user,
      "S-1-5-21-1000-1001",
    ),
  ).toBe(false);
  expect(isTrustedNewSmithSidecarOwner(null, user, elevatedDefaultOwner)).toBe(
    false,
  );
});

test("read-only inspect and operation scan do not create journal state", () => {
  const home = profile();
  mkdirSync(home);
  const storage = createSmithCreateJournalStorage(home);

  expect(storage.inspect(id)).toBeNull();
  expect([...storage.operations()]).toEqual([]);
  expect(existsSync(join(home, "smith-create-journal"))).toBe(false);
});

test("profile resolution refuses a linked ancestor before creating an absent tail", () => {
  const base = scratch.make("smith-create-linked-profile-"),
    target = join(base, "target"),
    alias = join(base, "alias"),
    linkedProfile = join(alias, "absent", "profile");
  mkdirSync(target);
  symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");

  expect(() => createSmithCreateJournalStorage(linkedProfile)).toThrow(
    "The trusted directory is not a plain directory.",
  );
  expect(existsSync(join(target, "absent"))).toBe(false);
});

test("SQLite-created lock sidecars are normalized before exclusive work", async () => {
  const home = profile();
  mkdirSync(home);
  const storage = createSmithCreateJournalStorage(home);
  await storage.exclusive(async () => {
    const lockDirectory = join(home, "smith-create-journal", "locks"),
      sidecars = readdirSync(lockDirectory).filter(
        (name) => name !== "journal.sqlite",
      );
    if (process.platform === "win32") {
      expect(sidecars.length).toBeGreaterThan(0);
      const acl = nativeWindowsAcl();
      for (const name of sidecars) {
        const path = join(lockDirectory, name);
        expect(acl.read(path).owner).toBe(acl.userSid());
        assertOwnerOnly(path, "file", acl);
      }
    }
  });

  expect(storage.inspect(id)).toBeNull();
  expect([...storage.operations()]).toEqual([]);
  expect(
    existsSync(join(home, "smith-create-journal", "locks", "journal.sqlite")),
  ).toBe(true);
});

test("mutex is persistent and immutable records require its exclusive section", async () => {
  const home = profile();
  mkdirSync(home);
  const storage = createSmithCreateJournalStorage(home);
  const text = JSON.stringify({ version: 1, kind: "intent" });

  expect(() => storage.writeOnce(id, "intent.json", text)).toThrow(
    "require the journal mutex",
  );
  await storage.exclusive(async () => {
    storage.writeOnce(id, "intent.json", text);
    expect(
      storage.read(
        id,
        { name: "intent.json", bytes: text.length, plain: true },
        65_536,
      ),
    ).toBe(text);
    expect(() => storage.writeOnce(id, "intent.json", text)).toThrow(
      "already exists",
    );
    expect(
      storage.read(
        id,
        { name: "intent.json", bytes: text.length, plain: true },
        65_536,
      ),
    ).toBe(text);
  });

  const mutex = join(home, "smith-create-journal", "locks", "journal.sqlite");
  expect(existsSync(mutex)).toBe(true);
  const before = statSync(mutex, { bigint: true });
  await storage.exclusive(async () => undefined);
  const after = statSync(mutex, { bigint: true });
  expect(after.ino).toBe(before.ino);
  expect(after.dev).toBe(before.dev);
});

test("unknown files remain visible to the core instead of being removed", async () => {
  const home = profile();
  mkdirSync(home);
  const storage = createSmithCreateJournalStorage(home);
  const text = "{}";
  await storage.exclusive(async () => {
    storage.writeOnce(id, "intent.json", text);
  });

  const operation = join(home, "smith-create-journal", "records", id);
  const unknown = join(operation, "future-phase.json");
  writeFileSync(unknown, "future", { mode: 0o600, flag: "wx" });
  const before = readdirSync(operation)
    .sort()
    .map((name) => [name, readFileSync(join(operation, name))]);

  expect([...storage.inspect(id)!].map(({ name }) => name).sort()).toEqual([
    "future-phase.json",
    "intent.json",
  ]);
  expect(readFileSync(unknown, "utf8")).toBe("future");
  expect(() =>
    createSmithCreateJournalCore(storage, owner(home)).readOriginal(id),
  ).toThrow();
  expect(
    readdirSync(operation)
      .sort()
      .map((name) => [name, readFileSync(join(operation, name))]),
  ).toEqual(before);
});

test("real journal lifecycle survives recreation and exact duplicate is inert", async () => {
  const home = profile();
  mkdirSync(home);
  const at = () => "2026-01-01T00:00:00.000Z";
  const core = createSmithCreateJournalCore(
    createSmithCreateJournalStorage(home),
    owner(home),
    at,
  );
  const first = await core.reserve(original, (writer) => {
    writer.prepare(preview());
    writer.attempted();
    writer.confirm({
      file: "/served/repo/agent-forge.toml",
      created: true,
      sha256: "c".repeat(64),
    });
  });
  const recreated = createSmithCreateJournalCore(
    createSmithCreateJournalStorage(home),
    owner(home),
    at,
  );
  const storage = createSmithCreateJournalStorage(home);
  const before = [...storage.inspect(id)!].map((entry) => [
    entry.name,
    storage.read(id, entry, 65_536),
  ]);
  let called = false;

  expect(first.result.phase).toBe("confirmed");
  expect(
    await recreated.reserve(original, () => {
      called = true;
    }),
  ).toEqual(first);
  expect(recreated.readOriginal(id)).toEqual(first);
  expect(called).toBe(false);
  expect(
    [...storage.inspect(id)!].map((entry) => [
      entry.name,
      storage.read(id, entry, 65_536),
    ]),
  ).toEqual(before);
});

test("oversized record input is refused before creating its request directory", async () => {
  const home = profile();
  mkdirSync(home);
  const storage = createSmithCreateJournalStorage(home);

  await storage.exclusive(async () => {
    expect(() =>
      storage.writeOnce(id, "intent.json", "x".repeat(65_537)),
    ).toThrow("record exceeds its byte limit");
  });
  expect(existsSync(join(home, "smith-create-journal", "records"))).toBe(false);
});

test("oversized retained record is held without truncation or repair", async () => {
  const home = profile();
  mkdirSync(home);
  const storage = createSmithCreateJournalStorage(home);
  await storage.exclusive(async () => {
    storage.writeOnce(id, "intent.json", "{}");
  });
  const operation = join(home, "smith-create-journal", "records", id);
  const oversized = Buffer.alloc(65_537, 0x62);
  const prepared = join(operation, "prepared.json");
  writeFileSync(prepared, oversized, { mode: 0o600, flag: "wx" });

  expect(() =>
    createSmithCreateJournalCore(storage, owner(home)).readOriginal(id),
  ).toThrow();
  expect(readFileSync(prepared)).toEqual(oversized);
  expect(readdirSync(operation).sort()).toEqual([
    "intent.json",
    "prepared.json",
  ]);
});

test("unknown-entry capacity overflow refuses and preserves every file", async () => {
  const home = profile();
  mkdirSync(home);
  const storage = createSmithCreateJournalStorage(home);
  await storage.exclusive(async () => {
    storage.writeOnce(id, "intent.json", "{}");
  });
  const operation = join(home, "smith-create-journal", "records", id);
  for (let index = 0; index < 8; index++)
    writeFileSync(join(operation, `unknown-${index}.json`), "future", {
      mode: 0o600,
      flag: "wx",
    });

  expect(() => storage.inspect(id)).toThrow("entry limit");
  expect(readdirSync(operation)).toHaveLength(9);
  expect(readFileSync(join(operation, "unknown-6.json"), "utf8")).toBe(
    "future",
  );
  expect(readFileSync(join(operation, "unknown-7.json"), "utf8")).toBe(
    "future",
  );
});

test("oversized mutex metadata is refused before another SQLite open", async () => {
  const home = profile();
  mkdirSync(home);
  const storage = createSmithCreateJournalStorage(home);
  await storage.exclusive(async () => undefined);

  const mutex = join(home, "smith-create-journal", "locks", "journal.sqlite");
  const oversized = Buffer.alloc(65_537, 0x61);
  writeFileSync(mutex, oversized);

  await expect(storage.exclusive(async () => "unexpected")).rejects.toThrow(
    "metadata exceeds its byte limit",
  );
  expect(readFileSync(mutex)).toEqual(oversized);
  expect(readdirSync(join(home, "smith-create-journal", "locks"))).toEqual([
    "journal.sqlite",
  ]);
});

test("pre-existing unprotected mutex is refused without repair or byte changes", async () => {
  const home = profile();
  mkdirSync(home);
  const root = join(home, "smith-create-journal");
  const records = join(root, "records");
  const locks = join(root, "locks");
  ensurePrivateHome(root);
  ensurePrivateHome(records);
  ensurePrivateHome(locks);
  const mutex = join(locks, "journal.sqlite");
  const originalBytes = Buffer.from("leave this existing mutex alone");
  writeFileSync(mutex, originalBytes, { mode: 0o644, flag: "wx" });
  if (process.platform !== "win32") chmodSync(mutex, 0o644);
  const beforeMode = statSync(mutex).mode;
  const beforeAcl =
    process.platform === "win32" ? nativeWindowsAcl().read(mutex) : null;
  const storage = createSmithCreateJournalStorage(home);

  await expect(storage.exclusive(async () => "opened")).rejects.toThrow();

  expect(readFileSync(mutex)).toEqual(originalBytes);
  expect(statSync(mutex).mode).toBe(beforeMode);
  if (beforeAcl !== null)
    expect(nativeWindowsAcl().read(mutex)).toEqual(beforeAcl);
  expect(readdirSync(locks)).toEqual(["journal.sqlite"]);
});

test("pre-existing unprotected SQLite sidecars are refused without repair", async () => {
  const home = profile();
  mkdirSync(home);
  const storage = createSmithCreateJournalStorage(home);
  await storage.exclusive(async () => undefined);

  const locks = join(home, "smith-create-journal", "locks");
  const sidecar = join(locks, "journal.sqlite-journal");
  const originalBytes = Buffer.from("leave this existing sidecar alone");
  writeFileSync(sidecar, originalBytes, { mode: 0o644, flag: "wx" });
  if (process.platform !== "win32") chmodSync(sidecar, 0o644);
  const beforeMode = statSync(sidecar).mode;
  const beforeAcl =
    process.platform === "win32" ? nativeWindowsAcl().read(sidecar) : null;

  await expect(storage.exclusive(async () => "opened")).rejects.toThrow();

  expect(readFileSync(sidecar)).toEqual(originalBytes);
  expect(statSync(sidecar).mode).toBe(beforeMode);
  if (beforeAcl !== null)
    expect(nativeWindowsAcl().read(sidecar)).toEqual(beforeAcl);
  expect(readdirSync(locks).sort()).toEqual([
    "journal.sqlite",
    "journal.sqlite-journal",
  ]);
});
