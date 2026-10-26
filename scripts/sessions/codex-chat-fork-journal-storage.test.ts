import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { CodexChatForkOriginal } from "../../types/codex-chat-fork";
import {
  type AclReading,
  FILE_ALL_ACCESS,
  SYSTEM_SID,
  type WindowsAcl,
} from "../hearth/acl-windows";
import { scratchDirs } from "../test-scratch";
import { createCodexChatForkJournal } from "./codex-chat-fork-journal";
import {
  CODEX_CHAT_FORK_JOURNAL_DIRECTORY,
  createCodexChatForkJournalStorage,
} from "./codex-chat-fork-journal-storage";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());

const requestId = "0199a213-81c0-7800-8aa1-bbab2a035a55",
  throughTurnRequestId = "0199a213-81c0-7800-8aa1-bbab2a035a54",
  parentSessionId = "session-0199a213-81c0-7800-8aa1-bbab2a035a51",
  childSessionId = "session-0199a213-81c0-7800-8aa1-bbab2a035a60",
  projectId = "project-00000000-0000-4000-8000-000000000001",
  userSid = "S-1-5-21-1000";

function privateReading(target: "directory" | "file"): AclReading {
  const flags = target === "directory" ? 3 : 0;
  return {
    owner: userSid,
    protected: true,
    entries: [
      { type: 0, flags, mask: FILE_ALL_ACCESS, sid: userSid },
      { type: 0, flags, mask: FILE_ALL_ACCESS, sid: SYSTEM_SID },
    ],
  };
}

/** Injected ACL only: no native ACL calls or child processes occur in these tests. */
function fakeAcl(): WindowsAcl {
  const readings = new Map<string, AclReading>(),
    reading = (path: string): AclReading => {
      const saved = readings.get(path);
      if (saved) return saved;
      const info = lstatSync(path);
      return privateReading(info.isDirectory() ? "directory" : "file");
    };
  return {
    userSid: () => userSid,
    defaultOwnerSid: () => userSid,
    apply(path, target) {
      readings.set(path, privateReading(target));
    },
    read: reading,
    readInFolder(folder, name, maxBytes) {
      if (!existsSync(folder)) return null;
      const file = name === null ? null : join(folder, name);
      if (file === null || !existsSync(file))
        return { folder: reading(folder), file: null };
      const bytes = readFileSync(file);
      if (bytes.byteLength > maxBytes)
        throw new Error("test ACL reader exceeded its byte bound");
      return {
        folder: reading(folder),
        file: { reading: reading(file), bytes },
      };
    },
  };
}

function journal(
  root: string,
  home: string,
  acl = fakeAcl(),
  afterMutexDirectorySnapshot?: (empty: boolean) => void,
) {
  return createCodexChatForkJournal({
    root,
    home,
    now: () => "2026-10-25T00:00:00.000Z",
    createChildAppSessionId: () => childSessionId,
    storageOptions: {
      platform: "win32",
      acl,
      ...(afterMutexDirectorySnapshot === undefined
        ? {}
        : { afterMutexDirectorySnapshot }),
    },
  });
}

function unprotectedReading(target: "directory" | "file"): AclReading {
  return {
    ...privateReading(target),
    protected: false,
    entries: [
      ...(privateReading(target).entries ?? []),
      { type: 0, flags: 0x10, mask: 1, sid: "S-1-1-0" },
    ],
  };
}

function ref(record: CodexChatForkOriginal) {
  return {
    projectId: record.projectId,
    workspaceKey: record.workspaceKey,
    requestId: record.requestId,
    requestHash: record.requestHash,
    parentSessionId: record.parentSessionId,
    throughTurnRequestId: record.throughTurnRequestId,
    protocolVersion: record.protocolVersion,
    childAppSessionId: record.childAppSessionId,
  };
}

test("read-only storage inspection does not create a profile-wide namespace", () => {
  const home = scratch.make("codex-fork-profile-");
  const storage = createCodexChatForkJournalStorage(home, {
    platform: "win32",
    acl: fakeAcl(),
  });

  expect([...storage.listEvents()]).toEqual([]);
  expect(existsSync(join(home, CODEX_CHAT_FORK_JOURNAL_DIRECTORY))).toBe(false);
});

test("private immutable records reopen through independent profile-wide stores", async () => {
  const root = scratch.make("codex-fork-root-"),
    home = join(scratch.make("codex-fork-profile-"), "profile");
  mkdirSync(home, { recursive: true });
  await createCodexChatForkJournalStorage(home, {
    platform: "win32",
    acl: fakeAcl(),
  }).exclusive(async () => undefined);
  const first = journal(root, home),
    reserved = await first.reserve(projectId, parentSessionId, {
      requestId,
      throughTurnRequestId,
    }),
    second = journal(root, home);

  expect(second.read(projectId, requestId)).toEqual(reserved);
  expect(
    await second.reserve(projectId, parentSessionId, {
      requestId,
      throughTurnRequestId,
    }),
  ).toEqual(reserved);
  expect(
    readdirSync(join(home, CODEX_CHAT_FORK_JOURNAL_DIRECTORY, "events")),
  ).toHaveLength(1);
});

test("two independent filesystem stores serialize the one-shot dispatch claim", async () => {
  const root = scratch.make("codex-fork-root-"),
    home = join(scratch.make("codex-fork-profile-"), "profile");
  mkdirSync(home, { recursive: true });
  const first = journal(root, home),
    reserved = await first.reserve(projectId, parentSessionId, {
      requestId,
      throughTurnRequestId,
    }),
    second = journal(root, home),
    claims = await Promise.all([
      first.markAttempted(ref(reserved)),
      second.markAttempted(ref(reserved)),
    ]);

  expect(claims.filter((claim) => claim.mayDispatch)).toHaveLength(1);
  expect(claims.every((claim) => claim.record.state === "attempted")).toBe(
    true,
  );
  expect(
    (await journal(root, home).markAttempted(ref(reserved))).mayDispatch,
  ).toBe(false);
});

test("unknown event debris fails closed and remains untouched", async () => {
  const root = scratch.make("codex-fork-root-"),
    home = join(scratch.make("codex-fork-profile-"), "profile");
  mkdirSync(home, { recursive: true });
  const first = journal(root, home),
    reserved = await first.reserve(projectId, parentSessionId, {
      requestId,
      throughTurnRequestId,
    }),
    events = join(home, CODEX_CHAT_FORK_JOURNAL_DIRECTORY, "events"),
    debris = join(events, "interrupted-publication.tmp");
  writeFileSync(debris, "do not remove or interpret");

  expect(() => first.read(projectId, requestId)).toThrow();
  await expect(
    first.reserve(projectId, parentSessionId, {
      requestId,
      throughTurnRequestId,
    }),
  ).rejects.toThrow();
  expect(readFileSync(debris, "utf8")).toBe("do not remove or interpret");
});

test("lock preflight refuses a linked SQLite mutex before opening it", async () => {
  const home = join(scratch.make("codex-fork-profile-"), "profile");
  mkdirSync(home, { recursive: true });
  const storage = createCodexChatForkJournalStorage(home, {
    platform: "win32",
    acl: fakeAcl(),
  });
  await storage.exclusive(async () => undefined);
  const locks = join(home, CODEX_CHAT_FORK_JOURNAL_DIRECTORY, "locks"),
    mutex = join(locks, "journal.sqlite"),
    outside = join(home, "outside.txt");
  writeFileSync(outside, "preserve this file");
  rmSync(mutex);
  linkSync(outside, mutex);

  await expect(storage.exclusive(async () => undefined)).rejects.toThrow();
  expect(readFileSync(outside, "utf8")).toBe("preserve this file");
});

test("existing inherited read access is refused before mutation or SQLite", async () => {
  const home = join(scratch.make("codex-fork-profile-"), "profile");
  mkdirSync(home, { recursive: true });
  const initial = createCodexChatForkJournalStorage(home, {
    platform: "win32",
    acl: fakeAcl(),
  });
  await initial.exclusive(async () => undefined);

  const root = join(home, CODEX_CHAT_FORK_JOURNAL_DIRECTORY),
    mutex = join(root, "locks", "journal.sqlite"),
    before = lstatSync(mutex, { bigint: true }),
    acl = fakeAcl(),
    read = acl.read.bind(acl);
  let aclRepairs = 0,
    enteredWork = false;
  acl.apply = () => {
    aclRepairs++;
    // The namespace already exists; any attempt to repair it is a failure.
    throw new Error("unexpected ACL repair");
  };
  acl.read = (path) =>
    path === root
      ? {
          owner: userSid,
          protected: false,
          entries: [
            ...(privateReading("directory").entries ?? []),
            {
              type: 0,
              flags: 0x10,
              mask: 1,
              sid: "S-1-1-0",
            },
          ],
        }
      : read(path);

  const reopened = createCodexChatForkJournalStorage(home, {
    platform: "win32",
    acl,
  });
  await expect(
    reopened.exclusive(async () => {
      enteredWork = true;
    }),
  ).rejects.toThrow();
  const after = lstatSync(mutex, { bigint: true });
  expect(aclRepairs).toBe(0);
  expect(enteredWork).toBe(false);
  expect(after.ino).toBe(before.ino);
  expect(after.mtimeNs).toBe(before.mtimeNs);
});

test("a peer waits read-only for the same empty mutex to become private", async () => {
  const root = scratch.make("codex-fork-root-"),
    home = join(scratch.make("codex-fork-profile-"), "profile"),
    acl = fakeAcl();
  mkdirSync(home, { recursive: true });
  await createCodexChatForkJournalStorage(home, {
    platform: "win32",
    acl,
  }).exclusive(async () => undefined);
  const mutex = join(
      home,
      CODEX_CHAT_FORK_JOURNAL_DIRECTORY,
      "locks",
      "journal.sqlite",
    ),
    strictRead = acl.read.bind(acl);
  truncateSync(mutex);
  const before = lstatSync(mutex, { bigint: true });
  let ready = false,
    repairs = 0;
  acl.read = (path) =>
    path === mutex && !ready ? unprotectedReading("file") : strictRead(path);
  const apply = acl.apply.bind(acl);
  acl.apply = (path, target) => {
    if (path === mutex) repairs++;
    apply(path, target);
  };
  setTimeout(() => {
    ready = true;
  }, 40);

  const first = journal(root, home, acl),
    second = journal(root, home, acl),
    reserved = await Promise.all([
      first.reserve(projectId, parentSessionId, {
        requestId,
        throughTurnRequestId,
      }),
      second.reserve(projectId, parentSessionId, {
        requestId,
        throughTurnRequestId,
      }),
    ]);

  expect(reserved[0]).toEqual(reserved[1]);
  expect(reserved[0].state).toBe("reserved");
  expect(
    readdirSync(join(home, CODEX_CHAT_FORK_JOURNAL_DIRECTORY, "events")),
  ).toHaveLength(1);
  expect(repairs).toBe(0);
  const after = lstatSync(mutex, { bigint: true });
  expect(after.ino).toBe(before.ino);
  expect(after.size).toBeGreaterThan(0n);
});

test("a non-empty inherited mutex is refused without mutation", async () => {
  const home = join(scratch.make("codex-fork-profile-"), "profile");
  mkdirSync(home, { recursive: true });
  await createCodexChatForkJournalStorage(home, {
    platform: "win32",
    acl: fakeAcl(),
  }).exclusive(async () => undefined);
  const mutex = join(
      home,
      CODEX_CHAT_FORK_JOURNAL_DIRECTORY,
      "locks",
      "journal.sqlite",
    ),
    marker = "preserve the existing non-empty mutex bytes";
  writeFileSync(mutex, marker, { flag: "a" });
  const before = lstatSync(mutex, { bigint: true }),
    acl = fakeAcl(),
    read = acl.read.bind(acl);
  let aclRepairs = 0,
    enteredWork = false;
  const apply = acl.apply.bind(acl);
  acl.apply = (path, target) => {
    if (path === mutex) aclRepairs++;
    apply(path, target);
  };
  acl.read = (path) =>
    path === mutex ? unprotectedReading("file") : read(path);

  await expect(
    createCodexChatForkJournalStorage(home, {
      platform: "win32",
      acl,
    }).exclusive(async () => {
      enteredWork = true;
    }),
  ).rejects.toThrow();

  const after = lstatSync(mutex, { bigint: true });
  expect(enteredWork).toBe(false);
  expect(aclRepairs).toBe(0);
  expect(readFileSync(mutex, "utf8")).toBe(marker);
  expect(after.dev).toBe(before.dev);
  expect(after.ino).toBe(before.ino);
});

test("a peer waits when a fresh mutex appears after the empty-directory preflight", async () => {
  const root = scratch.make("codex-fork-root-"),
    home = join(scratch.make("codex-fork-profile-"), "profile"),
    acl = fakeAcl();
  mkdirSync(home, { recursive: true });
  const locks = join(home, CODEX_CHAT_FORK_JOURNAL_DIRECTORY, "locks"),
    mutex = join(locks, "journal.sqlite"),
    strictRead = acl.read.bind(acl);
  let mutexAclReads = 0,
    inserted = false,
    privacyReady = false,
    mutexAclApplications = 0,
    insertedIdentity = "";
  const apply = acl.apply.bind(acl);
  acl.apply = (path, target) => {
    if (path === mutex) mutexAclApplications++;
    apply(path, target);
  };
  acl.read = (path) => {
    if (path === mutex && inserted) {
      mutexAclReads++;
      if (mutexAclReads <= 3) return unprotectedReading("file");
      privacyReady = true;
    }
    return strictRead(path);
  };

  const afterMutexDirectorySnapshot = (empty: boolean) => {
    expect(empty).toBe(true);
    expect(readdirSync(locks)).toEqual([]);
    writeFileSync(mutex, "", { flag: "wx" });
    inserted = true;
    const info = lstatSync(mutex, { bigint: true });
    insertedIdentity = `${info.dev}:${info.ino}`;
  };
  const result = await journal(
    root,
    home,
    acl,
    afterMutexDirectorySnapshot,
  ).reserve(projectId, parentSessionId, { requestId, throughTurnRequestId });
  const after = lstatSync(mutex, { bigint: true });

  expect(inserted).toBe(true);
  expect(privacyReady).toBe(true);
  expect(result.state).toBe("reserved");
  expect(mutexAclApplications).toBe(0);
  expect(insertedIdentity).toBe(`${after.dev}:${after.ino}`);
  expect(
    readdirSync(join(home, CODEX_CHAT_FORK_JOURNAL_DIRECTORY, "events")),
  ).toHaveLength(1);
});

test("a mutex that stays non-private times out untouched before callback", async () => {
  const home = join(scratch.make("codex-fork-profile-"), "profile"),
    acl = fakeAcl();
  mkdirSync(home, { recursive: true });
  await createCodexChatForkJournalStorage(home, {
    platform: "win32",
    acl,
  }).exclusive(async () => undefined);
  const mutex = join(
      home,
      CODEX_CHAT_FORK_JOURNAL_DIRECTORY,
      "locks",
      "journal.sqlite",
    ),
    strictRead = acl.read.bind(acl);
  truncateSync(mutex);
  const before = lstatSync(mutex, { bigint: true });
  let repairs = 0,
    enteredWork = false;
  acl.read = (path) =>
    path === mutex ? unprotectedReading("file") : strictRead(path);
  const apply = acl.apply.bind(acl);
  acl.apply = (path, target) => {
    if (path === mutex) repairs++;
    apply(path, target);
  };
  const storage = createCodexChatForkJournalStorage(home, {
    platform: "win32",
    acl,
    waitMs: 50,
  });

  await expect(
    storage.exclusive(async () => {
      enteredWork = true;
    }),
  ).rejects.toThrow("did not become owner-only");
  const after = lstatSync(mutex, { bigint: true });
  expect(enteredWork).toBe(false);
  expect(repairs).toBe(0);
  expect(after.ino).toBe(before.ino);
  expect(after.mtimeNs).toBe(before.mtimeNs);
  expect(readFileSync(mutex)).toHaveLength(0);
});

test("a junction ancestor is refused before creating any nested profile component", async () => {
  const base = scratch.make("codex-fork-linked-profile-"),
    target = join(base, "target"),
    alias = join(base, "alias"),
    home = join(alias, "missing", "nested", "profile");
  mkdirSync(target);
  symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
  const storage = createCodexChatForkJournalStorage(home, {
    platform: "win32",
    acl: fakeAcl(),
  });

  await expect(storage.exclusive(async () => undefined)).rejects.toThrow();
  expect(readdirSync(target)).toEqual([]);
  expect(existsSync(join(target, "missing"))).toBe(false);
});

test("a missing nested profile is created one verified directory at a time", async () => {
  const home = join(
      scratch.make("codex-fork-nested-profile-"),
      "one",
      "two",
      "profile",
    ),
    storage = createCodexChatForkJournalStorage(home, {
      platform: "win32",
      acl: fakeAcl(),
    });

  await storage.exclusive(async () => undefined);
  expect(
    existsSync(join(home, CODEX_CHAT_FORK_JOURNAL_DIRECTORY, "events")),
  ).toBe(true);
  expect(
    existsSync(join(home, CODEX_CHAT_FORK_JOURNAL_DIRECTORY, "locks")),
  ).toBe(true);
});
