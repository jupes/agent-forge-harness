/** Private profile-wide immutable event publication for Codex Fork originals. */
import { randomUUID } from "node:crypto";
import {
  type BigIntStats,
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  rmSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { agentForgeHome } from "../agent-forge-home";
import {
  assertOwnerOnly,
  nativeWindowsAcl,
  type WindowsAcl,
} from "../hearth/acl-windows";
import {
  ensurePrivateHome,
  type HomeCheckOptions,
  readHomeFile,
  readHomeFileBounded,
} from "../hearth/home-guard";
import { writeOwnerOnly } from "../hearth/token";
import { withQueueLock } from "../scheduler/queue-lock";
import type {
  CodexChatForkEventEntry,
  CodexChatForkJournalStorage,
} from "./codex-chat-fork-journal";
import {
  CODEX_CHAT_FORK_LIMITS,
  canonicalCodexChatForkJournalEvent,
  codexChatForkJournalEventSchema,
} from "./codex-chat-fork-protocol";

export const CODEX_CHAT_FORK_JOURNAL_DIRECTORY = "codex-chat-fork-journal";
const EVENTS_DIRECTORY = "events";
const LOCKS_DIRECTORY = "locks";
const MUTEX_FILE = "journal.sqlite";
const MUTEX_ENTRIES = new Set([
  MUTEX_FILE,
  `${MUTEX_FILE}-journal`,
  `${MUTEX_FILE}-wal`,
  `${MUTEX_FILE}-shm`,
]);
const MUTEX_BYTES = 65_536;
interface FileIdentity {
  dev: string;
  ino: string;
}

export interface CodexChatForkJournalStorageOptions {
  /** Injected only by no-child storage tests. */
  platform?: NodeJS.Platform;
  /** Injected only by no-child storage tests. */
  acl?: WindowsAcl;
  waitMs?: number;
}

function identity(info: BigIntStats): FileIdentity {
  return { dev: String(info.dev), ino: String(info.ino) };
}
function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}
function safePath(path: string): boolean {
  try {
    let current = resolve(path);
    for (;;) {
      const info = lstatSync(current, { bigint: true });
      if (info.isSymbolicLink()) return false;
      const parent = resolve(current, "..");
      if (parent === current) break;
      current = parent;
    }
    return true;
  } catch {
    return false;
  }
}

function directoryNames(path: string, limit: number): string[] {
  const directory = opendirSync(path),
    names: string[] = [];
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) return names;
      if (names.length >= limit)
        throw new Error(
          "The private Codex Fork directory exceeds its entry limit.",
        );
      names.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
}

function eventFileName(name: string): boolean {
  return /^\d{8}-[a-f0-9]{64}\.json$/.test(name);
}

function assertPrivateMetadata(
  path: string,
  target: "directory" | "file",
  info: BigIntStats,
  options: CodexChatForkJournalStorageOptions,
): void {
  if ((options.platform ?? process.platform) === "win32") {
    assertOwnerOnly(path, target, options.acl ?? nativeWindowsAcl());
    return;
  }
  const uid = BigInt(process.getuid?.() ?? 0),
    requiredMode = target === "directory" ? 0o700n : 0o600n;
  if (info.uid !== uid || (info.mode & 0o7777n) !== requiredMode)
    throw new Error("The private Codex Fork file is not owner-only.");
}

/** The profile home is trusted; this directory tree is created private and never repaired if linked. */
export function createCodexChatForkJournalStorage(
  profileHome: string = agentForgeHome(),
  options: CodexChatForkJournalStorageOptions = {},
): CodexChatForkJournalStorage {
  if (!isAbsolute(profileHome))
    throw new Error("The private Codex Fork profile path must be absolute.");
  const profile = resolve(profileHome),
    root = join(profile, CODEX_CHAT_FORK_JOURNAL_DIRECTORY),
    events = join(root, EVENTS_DIRECTORY),
    locks = join(root, LOCKS_DIRECTORY),
    mutex = join(locks, MUTEX_FILE),
    homeOptions: HomeCheckOptions = {
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      ...(options.acl === undefined ? {} : { acl: options.acl }),
    },
    ownerOptions = {
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      ...(options.acl === undefined ? {} : { acl: options.acl }),
    };
  let insideExclusive = false;

  const checkedDirectory = (path: string): FileIdentity => {
    ensurePrivateHome(path, undefined, homeOptions);
    const checked = readHomeFile(path, undefined, homeOptions);
    if (checked.problem !== null) throw new Error(checked.problem);
    const info = lstatSync(path, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || !safePath(path))
      throw new Error("The private Codex Fork directory is linked or invalid.");
    assertPrivateMetadata(path, "directory", info, options);
    return identity(info);
  };

  const inspectDirectory = (path: string): FileIdentity | null => {
    const checked = readHomeFile(path, undefined, homeOptions);
    if (checked.problem !== null) throw new Error(checked.problem);
    let info: BigIntStats;
    try {
      info = lstatSync(path, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink() || !safePath(path))
      throw new Error("The private Codex Fork directory is linked or invalid.");
    assertPrivateMetadata(path, "directory", info, options);
    return identity(info);
  };

  const assertStableDirectory = (
    path: string,
    expected: FileIdentity,
  ): void => {
    const found = inspectDirectory(path);
    if (found === null || !sameIdentity(found, expected))
      throw new Error("The private Codex Fork directory changed.");
  };

  const assertPrivateFile = (
    directory: string,
    path: string,
    maximumBytes: number,
    expected?: FileIdentity,
    expectedLinks = 1n,
  ): BigIntStats => {
    const info = lstatSync(path, { bigint: true });
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== expectedLinks ||
      !safePath(path) ||
      (expected !== undefined && !sameIdentity(identity(info), expected))
    )
      throw new Error("The private Codex Fork file is linked or changed.");
    const file = readHomeFileBounded(
      directory,
      path,
      maximumBytes,
      homeOptions,
    );
    if (
      file.problem !== null ||
      file.text === null ||
      byteLength(file.text) !== Number(info.size)
    )
      throw new Error("The private Codex Fork file could not be read safely.");
    assertPrivateMetadata(path, "file", info, options);
    return info;
  };

  const checkRootLayout = (): FileIdentity | null => {
    const rootIdentity = inspectDirectory(root);
    if (rootIdentity === null) return null;
    const names = directoryNames(root, 3).sort();
    if (
      names.length !== 2 ||
      names[0] !== EVENTS_DIRECTORY ||
      names[1] !== LOCKS_DIRECTORY
    )
      throw new Error("The private Codex Fork journal layout is invalid.");
    const eventIdentity = inspectDirectory(events),
      lockIdentity = inspectDirectory(locks);
    if (eventIdentity === null || lockIdentity === null)
      throw new Error("The private Codex Fork journal layout is incomplete.");
    assertStableDirectory(root, rootIdentity);
    return rootIdentity;
  };

  const checkLockFiles = (requireMutex = true): void => {
    const lockIdentity = inspectDirectory(locks);
    if (lockIdentity === null)
      throw new Error("The private Codex Fork lock directory is missing.");
    const names = directoryNames(locks, MUTEX_ENTRIES.size + 1).sort();
    for (const name of names) {
      if (!MUTEX_ENTRIES.has(name))
        throw new Error("The private Codex Fork lock has an unknown sidecar.");
      const path = join(locks, name),
        info = lstatSync(path, { bigint: true });
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1n ||
        !safePath(path) ||
        info.size > BigInt(MUTEX_BYTES)
      )
        throw new Error(
          "The private Codex Fork lock sidecar is linked or invalid.",
        );
      assertPrivateMetadata(path, "file", info, options);
    }
    if (requireMutex && !names.includes(MUTEX_FILE))
      throw new Error("The private Codex Fork SQLite lock is missing.");
    if (!requireMutex && names.length > 0 && !names.includes(MUTEX_FILE))
      throw new Error("The private Codex Fork SQLite lock is incomplete.");
    assertStableDirectory(locks, lockIdentity);
  };

  const tightenLockFiles = (): void => {
    if ((options.platform ?? process.platform) !== "win32") {
      for (const name of directoryNames(locks, MUTEX_ENTRIES.size + 1)) {
        if (!MUTEX_ENTRIES.has(name))
          throw new Error(
            "The private Codex Fork lock has an unknown sidecar.",
          );
        chmodSync(join(locks, name), 0o600);
      }
    }
  };

  const entry = (name: string): CodexChatForkEventEntry => {
    const path = join(events, name);
    try {
      const info = lstatSync(path, { bigint: true }),
        plain =
          eventFileName(name) &&
          info.isFile() &&
          !info.isSymbolicLink() &&
          info.nlink === 1n &&
          safePath(path) &&
          info.size <= BigInt(CODEX_CHAT_FORK_LIMITS.eventBytes);
      if (plain)
        assertPrivateFile(events, path, CODEX_CHAT_FORK_LIMITS.eventBytes);
      return {
        name,
        bytes:
          info.size > BigInt(Number.MAX_SAFE_INTEGER)
            ? Number.MAX_SAFE_INTEGER
            : Number(info.size),
        plain,
      };
    } catch {
      return { name, bytes: 0, plain: false };
    }
  };

  const syncFile = (path: string, expected: FileIdentity): void => {
    const descriptor = openSync(
      path,
      constants.O_RDWR |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    try {
      const opened = fstatSync(descriptor, { bigint: true });
      if (
        !opened.isFile() ||
        opened.nlink !== 1n ||
        !sameIdentity(identity(opened), expected)
      )
        throw new Error("The private Codex Fork staging file changed.");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    assertPrivateFile(
      events,
      path,
      CODEX_CHAT_FORK_LIMITS.eventBytes,
      expected,
    );
  };

  const syncDirectory = (path: string): void => {
    // Node has no supported Windows directory flush handle. The event is still read-back verified there.
    if ((options.platform ?? process.platform) === "win32") return;
    const descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
    );
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  };

  return {
    listEvents(): Iterable<CodexChatForkEventEntry> {
      const rootIdentity = checkRootLayout();
      if (rootIdentity === null) return [];
      checkLockFiles();
      const eventIdentity = inspectDirectory(events);
      if (eventIdentity === null)
        throw new Error("The private Codex Fork event directory is missing.");
      const names = directoryNames(events, CODEX_CHAT_FORK_LIMITS.events + 1),
        entries = names.map(entry);
      assertStableDirectory(events, eventIdentity);
      assertStableDirectory(root, rootIdentity);
      return entries;
    },
    read(selected: CodexChatForkEventEntry, maxBytes: number): string {
      if (
        !eventFileName(selected.name) ||
        !Number.isSafeInteger(maxBytes) ||
        maxBytes !== CODEX_CHAT_FORK_LIMITS.eventBytes
      )
        throw new Error("The private Codex Fork read request is invalid.");
      const rootIdentity = checkRootLayout();
      if (rootIdentity === null)
        throw new Error("The private Codex Fork journal is missing.");
      checkLockFiles();
      const eventIdentity = inspectDirectory(events);
      if (eventIdentity === null)
        throw new Error("The private Codex Fork event directory is missing.");
      const path = join(events, selected.name),
        before = assertPrivateFile(
          events,
          path,
          CODEX_CHAT_FORK_LIMITS.eventBytes,
        );
      if (
        !selected.plain ||
        Number(before.size) !== selected.bytes ||
        Number(before.size) > maxBytes
      )
        throw new Error(
          "The private Codex Fork event changed before its bounded read.",
        );
      const found = readHomeFileBounded(events, path, maxBytes, homeOptions);
      if (found.problem !== null || found.text === null)
        throw new Error(
          "The private Codex Fork event could not be read safely.",
        );
      const text = found.text,
        checked = assertPrivateFile(
          events,
          path,
          CODEX_CHAT_FORK_LIMITS.eventBytes,
          identity(before),
        );
      if (
        byteLength(text) !== selected.bytes ||
        checked.size !== before.size ||
        checked.mtimeNs !== before.mtimeNs
      )
        throw new Error(
          "The private Codex Fork event changed during its bounded read.",
        );
      assertStableDirectory(events, eventIdentity);
      assertStableDirectory(root, rootIdentity);
      return text;
    },
    writeOnce(name: string, text: string): void {
      if (!insideExclusive)
        throw new Error("Private Codex Fork events require the profile mutex.");
      if (
        !eventFileName(name) ||
        byteLength(text) > CODEX_CHAT_FORK_LIMITS.eventBytes
      )
        throw new Error(
          "The private Codex Fork event write is invalid or over limit.",
        );
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new Error("The private Codex Fork event is invalid JSON.");
      }
      const checked = codexChatForkJournalEventSchema.safeParse(raw);
      if (
        !checked.success ||
        canonicalCodexChatForkJournalEvent(checked.data) !== text ||
        name !==
          `${String(checked.data.sequence).padStart(8, "0")}-${checked.data.eventHash}.json`
      )
        throw new Error(
          "The private Codex Fork event bytes are not canonical.",
        );
      const rootIdentity = checkRootLayout();
      if (rootIdentity === null)
        throw new Error("The private Codex Fork journal is unavailable.");
      const eventIdentity = inspectDirectory(events);
      if (eventIdentity === null)
        throw new Error(
          "The private Codex Fork event directory is unavailable.",
        );
      const target = join(events, name);
      try {
        lstatSync(target);
        throw new Error("The private Codex Fork event already exists.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const stage = join(events, `${name}.${process.pid}-${randomUUID()}.tmp`);
      ensurePrivateHome(profile, undefined, homeOptions);
      writeOwnerOnly(stage, text, ownerOptions);
      const stageInfo = assertPrivateFile(
          events,
          stage,
          CODEX_CHAT_FORK_LIMITS.eventBytes,
        ),
        stageIdentity = identity(stageInfo);
      if (byteLength(text) !== Number(stageInfo.size))
        throw new Error("The private Codex Fork staging bytes changed.");
      syncFile(stage, stageIdentity);
      assertStableDirectory(root, rootIdentity);
      assertStableDirectory(events, eventIdentity);
      try {
        lstatSync(target);
        throw new Error("The private Codex Fork event already exists.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      linkSync(stage, target);
      const published = assertPrivateFile(
        events,
        target,
        CODEX_CHAT_FORK_LIMITS.eventBytes,
        stageIdentity,
        2n,
      );
      const staged = lstatSync(stage, { bigint: true });
      if (
        !sameIdentity(identity(published), stageIdentity) ||
        !sameIdentity(identity(staged), stageIdentity) ||
        published.nlink !== 2n ||
        staged.nlink !== 2n
      )
        throw new Error(
          "The private Codex Fork event publication changed identity.",
        );
      rmSync(stage);
      const final = assertPrivateFile(
        events,
        target,
        CODEX_CHAT_FORK_LIMITS.eventBytes,
        stageIdentity,
      );
      if (final.nlink !== 1n || Number(final.size) !== byteLength(text))
        throw new Error(
          "The private Codex Fork event publication was not confirmed.",
        );
      syncDirectory(events);
      const readback = readHomeFileBounded(
        events,
        target,
        CODEX_CHAT_FORK_LIMITS.eventBytes,
        homeOptions,
      );
      if (
        readback.problem !== null ||
        readback.text !== text ||
        byteLength(readback.text) !== byteLength(text)
      )
        throw new Error("The private Codex Fork event readback did not match.");
      assertStableDirectory(root, rootIdentity);
      assertStableDirectory(events, eventIdentity);
    },
    async exclusive<T>(work: () => Promise<T>): Promise<T> {
      if (insideExclusive)
        throw new Error(
          "The private Codex Fork journal lock cannot be nested.",
        );
      ensurePrivateHome(profile, undefined, homeOptions);
      const rootIdentity = checkedDirectory(root),
        eventsIdentity = checkedDirectory(events),
        locksIdentity = checkedDirectory(locks);
      if (
        !sameIdentity(rootIdentity, identity(lstatSync(root, { bigint: true })))
      )
        throw new Error("The private Codex Fork root changed during setup.");
      checkRootLayout();
      // Check the persistent lock name and every existing sidecar before SQLite opens any path.
      checkLockFiles(false);
      const locked = await withQueueLock(
        mutex,
        async () => {
          insideExclusive = true;
          try {
            assertStableDirectory(root, rootIdentity);
            assertStableDirectory(events, eventsIdentity);
            assertStableDirectory(locks, locksIdentity);
            checkRootLayout();
            tightenLockFiles();
            checkLockFiles();
            return await work();
          } finally {
            try {
              checkLockFiles();
              assertStableDirectory(root, rootIdentity);
              assertStableDirectory(events, eventsIdentity);
              assertStableDirectory(locks, locksIdentity);
            } finally {
              insideExclusive = false;
            }
          }
        },
        options.waitMs === undefined ? {} : { waitMs: options.waitMs },
      );
      if (!locked.ok)
        throw new Error("The private Codex Fork profile mutex is unavailable.");
      return locked.value;
    },
  };
}
