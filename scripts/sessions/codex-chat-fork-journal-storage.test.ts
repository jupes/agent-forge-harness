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

function journal(root: string, home: string) {
  return createCodexChatForkJournal({
    root,
    home,
    now: () => "2026-10-25T00:00:00.000Z",
    createChildAppSessionId: () => childSessionId,
    storageOptions: { platform: "win32", acl: fakeAcl() },
  });
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
