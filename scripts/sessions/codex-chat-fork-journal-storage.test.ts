import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  CodexChatForkOriginal,
  CodexChatForkReservationKind,
} from "../../types/codex-chat-fork";
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
  type CodexChatForkMutexDiagnostic,
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
const testSourceSeal = {
  parentRequestHash: "a".repeat(64),
  parentTurnHash: "b".repeat(64),
  parentNativeThreadId: "0199a213-81c0-7800-8aa1-bbab2a035a70",
  throughNativeTurnId: "0199a213-81c0-7800-8aa1-bbab2a035a71",
  sourceSettingsHash: "c".repeat(64),
};

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
function fakeAcl(beforeRead?: (path: string) => void): WindowsAcl {
  const readings = new Map<string, AclReading>(),
    reading = (path: string): AclReading => {
      beforeRead?.(path);
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
    createOwnerOnlyExclusive(path) {
      let descriptor: number;
      try {
        descriptor = openSync(path, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          return { kind: "exists" };
        throw error;
      }
      readings.set(path, privateReading("file"));
      let closed = false;
      return {
        kind: "created",
        remove() {
          unlinkSync(path);
        },
        close() {
          if (closed) return;
          closed = true;
          closeSync(descriptor);
        },
      };
    },
  };
}

function sqlitePageFixture(): Uint8Array {
  const path = join(scratch.make("codex-fork-sqlite-page-"), "page.sqlite");
  const database = new Database(path, { create: true });
  try {
    database.exec("PRAGMA busy_timeout = 0");
    database.exec("BEGIN EXCLUSIVE");
    database.exec("COMMIT");
  } finally {
    database.close();
  }
  const bytes = readFileSync(path);
  rmSync(path);
  return bytes;
}

function journal(
  root: string,
  home: string,
  acl = fakeAcl(),
  afterMutexDirectorySnapshot?: (empty: boolean) => void,
) {
  const actual = createCodexChatForkJournal({
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
  return {
    ...actual,
    reserve: (
      project: string,
      parent: string,
      intent: Parameters<typeof actual.reserve>[2],
      reservationKind?: CodexChatForkReservationKind,
    ) =>
      actual.reserve(project, parent, intent, testSourceSeal, reservationKind),
  };
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

async function prepareDiagnosticProfile(home: string, acl: WindowsAcl) {
  await createCodexChatForkJournalStorage(home, {
    platform: "win32",
    acl,
  }).exclusive(async () => undefined);
  const locks = join(home, CODEX_CHAT_FORK_JOURNAL_DIRECTORY, "locks");
  return { locks, mutex: join(locks, "journal.sqlite") };
}

function guardCapture(
  home: string,
  acl: WindowsAcl,
  beforeExclusivePreLockAssert: () => void,
) {
  const diagnostics: CodexChatForkMutexDiagnostic[] = [];
  const storage = createCodexChatForkJournalStorage(home, {
    platform: "win32",
    acl,
    beforeExclusivePreLockAssert,
    onMutexDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  return { storage, diagnostics };
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
    sourceSeal: record.sourceSeal,
    reservationKind: record.reservationKind,
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

test("failed verification removes only the exact newly created mutex handle", async () => {
  const root = scratch.make("codex-fork-root-"),
    home = join(scratch.make("codex-fork-profile-"), "profile"),
    acl = fakeAcl();
  mkdirSync(home, { recursive: true });
  const mutex = join(
      home,
      CODEX_CHAT_FORK_JOURNAL_DIRECTORY,
      "locks",
      "journal.sqlite",
    ),
    read = acl.read.bind(acl),
    create = acl.createOwnerOnlyExclusive!.bind(acl);
  let refuseReadback = false;
  acl.createOwnerOnlyExclusive = (path) => {
    const result = create(path);
    if (result.kind === "created") refuseReadback = true;
    return result;
  };
  acl.read = (path) =>
    refuseReadback && path === mutex
      ? { ...privateReading("file"), protected: false }
      : read(path);

  await expect(
    createCodexChatForkJournalStorage(home, {
      platform: "win32",
      acl,
    }).exclusive(async () => undefined),
  ).rejects.toThrow();
  expect(existsSync(mutex)).toBe(false);
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
    reserved = await first.reserve(
      projectId,
      parentSessionId,
      {
        requestId,
        throughTurnRequestId,
      },
      "direct-v1",
    ),
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
    beforeBytes = readFileSync(mutex),
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
  expect(readFileSync(mutex)).toEqual(beforeBytes);
  expect(after.dev).toBe(before.dev);
  expect(after.ino).toBe(before.ino);
  expect(after.size).toBe(before.size);
  expect(after.mtimeNs).toBe(before.mtimeNs);
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

test("unknown lock debris after an empty snapshot refuses callback and preserves bytes", async () => {
  const home = join(scratch.make("codex-fork-profile-"), "profile");
  mkdirSync(home, { recursive: true });
  const locks = join(home, CODEX_CHAT_FORK_JOURNAL_DIRECTORY, "locks"),
    events = join(home, CODEX_CHAT_FORK_JOURNAL_DIRECTORY, "events"),
    debris = join(locks, "interrupted-peer-entry.tmp"),
    contents = "preserve unknown lock debris";
  let insertedIdentity = "",
    enteredWork = false;
  const storage = createCodexChatForkJournalStorage(home, {
    platform: "win32",
    acl: fakeAcl(),
    afterMutexDirectorySnapshot(empty) {
      expect(empty).toBe(true);
      expect(readdirSync(locks)).toEqual([]);
      writeFileSync(debris, contents, { flag: "wx" });
      const info = lstatSync(debris, { bigint: true });
      insertedIdentity = `${info.dev}:${info.ino}`;
    },
  });

  await expect(
    storage.exclusive(async () => {
      enteredWork = true;
    }),
  ).rejects.toThrow();

  const after = lstatSync(debris, { bigint: true });
  expect(enteredWork).toBe(false);
  expect(readFileSync(debris, "utf8")).toBe(contents);
  expect(insertedIdentity).toBe(`${after.dev}:${after.ino}`);
  expect(readdirSync(events)).toEqual([]);
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

test("pre-lock diagnostics distinguish stable mutex size from replaced identity", async () => {
  const oversizedHome = join(scratch.make("codex-fork-size-"), "profile"),
    oversizedAcl = fakeAcl(),
    oversized = await prepareDiagnosticProfile(oversizedHome, oversizedAcl),
    beforeSize = lstatSync(oversized.mutex, { bigint: true }),
    sizeCapture = guardCapture(oversizedHome, oversizedAcl, () =>
      writeFileSync(oversized.mutex, "x".repeat(65_537)),
    );
  await expect(
    sizeCapture.storage.exclusive(async () => undefined),
  ).rejects.toThrow("linked or changed");
  const sizeFailure = sizeCapture.diagnostics.find(
    (entry) => entry.guard === "mutex-size",
  );
  expect(sizeFailure).toMatchObject({
    phase: "exclusive-pre-lock-assert",
    identityStable: true,
  });
  expect(lstatSync(oversized.mutex, { bigint: true }).ino).toBe(beforeSize.ino);

  const replacedHome = join(scratch.make("codex-fork-identity-"), "profile"),
    replacedAcl = fakeAcl(),
    replaced = await prepareDiagnosticProfile(replacedHome, replacedAcl),
    saved = `${replaced.mutex}.saved`,
    replacement = `${replaced.mutex}.replacement`,
    originalBytes = readFileSync(replaced.mutex),
    originalIdentity = lstatSync(replaced.mutex, { bigint: true }),
    identityCapture = guardCapture(replacedHome, replacedAcl, () => {
      writeFileSync(replacement, "replacement mutex");
      renameSync(replaced.mutex, saved);
      renameSync(replacement, replaced.mutex);
    });
  await expect(
    identityCapture.storage.exclusive(async () => undefined),
  ).rejects.toThrow("linked or changed");
  expect(
    identityCapture.diagnostics.find(
      (entry) => entry.guard === "mutex-identity",
    ),
  ).toMatchObject({
    phase: "exclusive-pre-lock-assert",
    identityStable: false,
  });
  expect(readFileSync(saved)).toEqual(originalBytes);
  expect(lstatSync(replaced.mutex, { bigint: true }).ino).not.toBe(
    originalIdentity.ino,
  );
});

test("pre-lock private-metadata diagnostics keep privacy and foreign-owner refusals", async () => {
  for (const variant of ["privacy", "foreign"] as const) {
    const home = join(scratch.make(`codex-fork-${variant}-`), "profile"),
      acl = fakeAcl(),
      prepared = await prepareDiagnosticProfile(home, acl),
      beforeBytes = readFileSync(prepared.mutex),
      strictRead = acl.read.bind(acl);
    let change = false;
    acl.read = (path) => {
      if (path === prepared.mutex && change)
        return variant === "privacy"
          ? unprotectedReading("file")
          : { ...privateReading("file"), owner: "S-1-5-21-9999" };
      return strictRead(path);
    };
    const capture = guardCapture(home, acl, () => {
      change = true;
    });
    await expect(
      capture.storage.exclusive(async () => undefined),
    ).rejects.toThrow();
    expect(
      capture.diagnostics.find((entry) => entry.guard === "mutex-private"),
    ).toMatchObject({ phase: "exclusive-pre-lock-assert" });
    expect(readFileSync(prepared.mutex)).toEqual(beforeBytes);
  }
});

test("pre-lock diagnostics identify linked mutexes and unknown lock entries", async () => {
  const linkedHome = join(scratch.make("codex-fork-linked-mutex-"), "profile"),
    linkedAcl = fakeAcl(),
    linked = await prepareDiagnosticProfile(linkedHome, linkedAcl),
    linkedAlias = join(linked.locks, "journal.sqlite-wal"),
    mutexBytes = readFileSync(linked.mutex),
    linkedCapture = guardCapture(linkedHome, linkedAcl, () =>
      linkSync(linked.mutex, linkedAlias),
    );
  await expect(
    linkedCapture.storage.exclusive(async () => undefined),
  ).rejects.toThrow("linked or changed");
  expect(
    linkedCapture.diagnostics.find((entry) => entry.guard === "mutex-kind"),
  ).toMatchObject({ phase: "exclusive-pre-lock-assert" });
  expect(readFileSync(linked.mutex)).toEqual(mutexBytes);
  expect(readFileSync(linkedAlias)).toEqual(mutexBytes);

  const debrisHome = join(scratch.make("codex-fork-debris-"), "profile"),
    debrisAcl = fakeAcl(),
    debris = await prepareDiagnosticProfile(debrisHome, debrisAcl),
    unexpected = join(debris.locks, "unknown-entry.tmp"),
    debrisBytes = "preserve unknown lock entry",
    debrisCapture = guardCapture(debrisHome, debrisAcl, () =>
      writeFileSync(unexpected, debrisBytes, { flag: "wx" }),
    );
  await expect(
    debrisCapture.storage.exclusive(async () => undefined),
  ).rejects.toThrow("unknown sidecar");
  expect(
    debrisCapture.diagnostics.find(
      (entry) => entry.guard === "lock-namespace-name",
    ),
  ).toMatchObject({ phase: "exclusive-pre-lock-assert" });
  expect(readFileSync(unexpected, "utf8")).toBe(debrisBytes);
});

test("the pre-lock snapshot accepts only SQLite's private initial 4096-byte page", async () => {
  const home = join(scratch.make("codex-fork-initial-page-"), "profile"),
    initialAcl = fakeAcl();
  mkdirSync(home, { recursive: true });
  const prepared = await prepareDiagnosticProfile(home, initialAcl);
  truncateSync(prepared.mutex);
  let mutexReads = 0,
    enteredWork = false;
  const acl = fakeAcl((path) => {
    if (path !== prepared.mutex || ++mutexReads !== 3) return;
    const database = new Database(prepared.mutex, { create: true });
    try {
      database.exec("PRAGMA busy_timeout = 0");
      database.exec("BEGIN EXCLUSIVE");
      database.exec("COMMIT");
    } finally {
      database.close();
    }
  });

  await createCodexChatForkJournalStorage(home, {
    platform: "win32",
    acl,
  }).exclusive(async () => {
    enteredWork = true;
  });
  expect(enteredWork).toBe(true);
  expect(lstatSync(prepared.mutex, { bigint: true }).size).toBe(4096n);
});

test("the pre-lock SQLite page exception rejects malformed and nonzero-start changes", async () => {
  for (const variant of ["malformed", "nonzero-start"] as const) {
    const home = join(
        scratch.make(`codex-fork-initial-page-${variant}-`),
        "profile",
      ),
      initialAcl = fakeAcl();
    mkdirSync(home, { recursive: true });
    const prepared = await prepareDiagnosticProfile(home, initialAcl),
      validPage = sqlitePageFixture();
    truncateSync(prepared.mutex, variant === "nonzero-start" ? 1 : 0);
    let mutexReads = 0,
      enteredWork = false;
    const acl = fakeAcl((path) => {
      if (path !== prepared.mutex || ++mutexReads !== 3) return;
      if (variant === "malformed") {
        const database = new Database(prepared.mutex, { create: true });
        try {
          database.exec("PRAGMA busy_timeout = 0");
          database.exec("BEGIN EXCLUSIVE");
          database.exec("COMMIT");
        } finally {
          database.close();
        }
        const bytes = readFileSync(prepared.mutex);
        bytes[0] = 0;
        writeFileSync(prepared.mutex, bytes);
      } else writeFileSync(prepared.mutex, validPage);
    });

    await expect(
      createCodexChatForkJournalStorage(home, {
        platform: "win32",
        acl,
      }).exclusive(async () => {
        enteredWork = true;
      }),
    ).rejects.toThrow();
    expect(enteredWork).toBe(false);
  }
});

test("the exclusive pre-lock snapshot accepts the same verified SQLite first page", async () => {
  const home = join(scratch.make("codex-fork-prelock-page-"), "profile"),
    initialAcl = fakeAcl();
  mkdirSync(home, { recursive: true });
  const prepared = await prepareDiagnosticProfile(home, initialAcl);
  truncateSync(prepared.mutex);
  let mutexReads = 0,
    enteredWork = false;
  const acl = fakeAcl((path) => {
    if (path !== prepared.mutex || ++mutexReads !== 7) return;
    const database = new Database(prepared.mutex, { create: true });
    try {
      database.exec("PRAGMA busy_timeout = 0");
      database.exec("BEGIN EXCLUSIVE");
      database.exec("COMMIT");
    } finally {
      database.close();
    }
  });

  await createCodexChatForkJournalStorage(home, {
    platform: "win32",
    acl,
  }).exclusive(async () => {
    enteredWork = true;
  });
  expect(enteredWork).toBe(true);
  expect(lstatSync(prepared.mutex, { bigint: true }).size).toBe(4096n);
});

test("the initial-page allowance does not permit an inside-lock size change", async () => {
  const home = join(scratch.make("codex-fork-in-lock-size-"), "profile"),
    initialAcl = fakeAcl();
  mkdirSync(home, { recursive: true });
  const prepared = await prepareDiagnosticProfile(home, initialAcl);
  let mutexReads = 0,
    enteredWork = false;
  const acl = fakeAcl((path) => {
    if (path === prepared.mutex && ++mutexReads === 11)
      writeFileSync(prepared.mutex, new Uint8Array(4097));
  });

  await expect(
    createCodexChatForkJournalStorage(home, {
      platform: "win32",
      acl,
    }).exclusive(async () => {
      enteredWork = true;
    }),
  ).rejects.toThrow();
  expect(enteredWork).toBe(false);
});
