/** Private, bounded file storage for the Smith create journal state machine. */

import { randomUUID } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  opendirSync,
  openSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { agentForgeHome } from "../agent-forge-home";
import {
  assertOwnerOnly,
  makeOwnerOnly,
  nativeWindowsAcl,
} from "../hearth/acl-windows";
import { ensurePrivateHome, readHomeFile } from "../hearth/home-guard";
import { writeOwnerOnly } from "../hearth/token";
import { withQueueLock } from "../scheduler/queue-lock";
import type {
  SmithCreateJournalEntry,
  SmithCreateJournalStorage,
} from "./smith-create-journal-core";
import {
  SMITH_CREATE_JOURNAL_FILES,
  SMITH_CREATE_JOURNAL_LIMITS,
  type SmithCreateJournalFile,
} from "./smith-create-journal-protocol";
import {
  SMITH_CONFIG_CREATE_LIMITS,
  smithConfigRequestIdSchema,
} from "./smith-create-protocol";
import { canonicalSmithCreateDirectory } from "./smith-create-trusted-directory";
import { windowsConfigLeafKind } from "./transaction-windows";

const JOURNAL_DIRECTORY = "smith-create-journal";
const RECORDS_DIRECTORY = "records";
const LOCKS_DIRECTORY = "locks";
const MUTEX_FILE = "journal.sqlite";
const MUTEX_SIDECARS = new Set([
  MUTEX_FILE,
  `${MUTEX_FILE}-journal`,
  `${MUTEX_FILE}-wal`,
  `${MUTEX_FILE}-shm`,
]);
const MAX_LOCK_ENTRIES = MUTEX_SIDECARS.size;
const sameIdentity = (a: FileIdentity, b: FileIdentity) =>
  a.dev === b.dev && a.ino === b.ino;
const canonicalPath = (path: string) =>
  process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);

type FileIdentity = Readonly<{ dev: string; ino: string }>;
type MutexState = Readonly<{
  identity: FileIdentity;
  sidecars: ReadonlyMap<string, FileIdentity>;
}>;

/** Only a known new SQLite entry may be normalized from this process token's owner. */
export function isTrustedNewSmithSidecarOwner(
  owner: string | null,
  userSid: string,
  defaultOwnerSid: string,
): boolean {
  return owner === userSid || owner === defaultOwnerSid;
}

function identity(info: BigIntStats): FileIdentity {
  return { dev: String(info.dev), ino: String(info.ino) };
}

function bytes(info: BigIntStats): number {
  if (info.size < 0n || info.size > BigInt(Number.MAX_SAFE_INTEGER))
    return Number.MAX_SAFE_INTEGER;
  return Number(info.size);
}

function errorOf(result: { problem: string | null }): void {
  if (result.problem !== null) throw new Error(result.problem);
}

function ensurePrivateDirectory(path: string): FileIdentity {
  ensurePrivateHome(path);
  const read = readHomeFile(path);
  errorOf(read);
  const info = lstatSync(path, { bigint: true });
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    canonicalPath(realpathSync.native(path)) !== canonicalPath(path)
  )
    throw new Error(
      "The private Smith create journal directory is not canonical.",
    );
  return identity(info);
}

function inspectPrivateDirectory(path: string): FileIdentity | null {
  const read = readHomeFile(path);
  errorOf(read);
  let info: BigIntStats;
  try {
    info = lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    canonicalPath(realpathSync.native(path)) !== canonicalPath(path)
  )
    throw new Error(
      "The private Smith create journal directory is not canonical.",
    );
  return identity(info);
}

function assertStableDirectory(path: string, expected: FileIdentity): void {
  const found = inspectPrivateDirectory(path);
  if (found === null || !sameIdentity(found, expected))
    throw new Error("The private Smith create journal directory changed.");
}

function* directoryNames(path: string, limit: number): Iterable<string> {
  const directory = opendirSync(path);
  let count = 0;
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) return;
      if (++count > limit)
        throw new Error(
          "The private Smith create journal directory exceeds its entry limit.",
        );
      yield entry.name;
    }
  } finally {
    directory.closeSync();
  }
}

function entryMetadata(
  directory: string,
  name: string,
): SmithCreateJournalEntry {
  const path = join(directory, name);
  try {
    const info = lstatSync(path, { bigint: true });
    const plain =
      info.isFile() &&
      !info.isSymbolicLink() &&
      info.nlink === 1n &&
      (process.platform !== "win32" || windowsPlain(path));
    return { name, bytes: bytes(info), plain };
  } catch {
    return { name, bytes: 0, plain: false };
  }
}

function windowsPlain(path: string): boolean {
  try {
    return windowsConfigLeafKind(path) === "plain";
  } catch {
    return false;
  }
}

function assertPlainFile(
  path: string,
  expected?: FileIdentity,
  expectedLinks = 1n,
): BigIntStats {
  const info = lstatSync(path, { bigint: true });
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== expectedLinks ||
    (process.platform === "win32" && !windowsPlain(path))
  )
    throw new Error("The private Smith create record is not a plain file.");
  if (expected !== undefined && !sameIdentity(identity(info), expected))
    throw new Error("The private Smith create record changed identity.");
  if (canonicalPath(realpathSync.native(path)) !== canonicalPath(path))
    throw new Error("The private Smith create record path is not canonical.");
  return info;
}

function assertPrivateFile(
  path: string,
  expected?: FileIdentity,
  expectedLinks = 1n,
): BigIntStats {
  const info = assertPlainFile(path, expected, expectedLinks);
  if (process.platform === "win32") {
    assertOwnerOnly(path, "file", nativeWindowsAcl());
  } else {
    const uid = BigInt(process.getuid?.() ?? 0);
    if (info.uid !== uid || (info.mode & 0o077n) !== 0n)
      throw new Error("The private Smith create record is not owner-only.");
  }
  return info;
}

function syncFile(path: string, expected: FileIdentity): void {
  const fd = openSync(
    path,
    constants.O_RDWR |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      !sameIdentity(identity(opened), expected)
    )
      throw new Error("The private Smith create staging record changed.");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  assertPrivateFile(path, expected);
}

function syncDirectory(path: string): void {
  // Node does not expose a Windows directory flush handle. File bytes are
  // flushed there; the readback below confirms visibility, not power-loss
  // durability of the directory entry on that platform.
  if (process.platform === "win32") return;
  const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function hasPath(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function removeOwnStage(path: string, expected: FileIdentity): void {
  try {
    const info = lstatSync(path, { bigint: true });
    if (
      info.isFile() &&
      !info.isSymbolicLink() &&
      sameIdentity(identity(info), expected)
    )
      rmSync(path);
  } catch {
    // A failed cleanup leaves an unknown entry, which later reads hold in place.
  }
}

function removeStageOnlyWhenUnpublished(
  stage: string,
  target: string,
  expected: FileIdentity,
): void {
  try {
    const published = lstatSync(target, { bigint: true });
    if (sameIdentity(identity(published), expected)) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
  }
  removeOwnStage(stage, expected);
}

/**
 * Build the private storage boundary beneath the trusted Agent Forge profile.
 * The optional profileHome is an internal test seam; routes never select it.
 */
export function createSmithCreateJournalStorage(
  profileHome: string = agentForgeHome(),
): SmithCreateJournalStorage {
  const profile = canonicalSmithCreateDirectory(profileHome);
  const root = join(profile, JOURNAL_DIRECTORY),
    records = join(root, RECORDS_DIRECTORY),
    locks = join(root, LOCKS_DIRECTORY),
    mutex = join(locks, MUTEX_FILE);
  let insideExclusive = false;

  const checkRootLayout = (): void => {
    const rootIdentity = inspectPrivateDirectory(root);
    if (rootIdentity === null) return;
    const names = [...directoryNames(root, 3)];
    if (
      names.some(
        (name) => name !== RECORDS_DIRECTORY && name !== LOCKS_DIRECTORY,
      )
    )
      throw new Error(
        "The private Smith create journal contains an unknown entry.",
      );
    for (const name of names) {
      const path = join(root, name);
      if (inspectPrivateDirectory(path) === null)
        throw new Error("The private Smith create journal layout changed.");
    }
    assertStableDirectory(root, rootIdentity);
  };

  const inspectLockMetadata = (
    known: ReadonlyMap<string, FileIdentity> = new Map(),
    protectNewSidecars = false,
  ): ReadonlyMap<string, FileIdentity> => {
    const lockDirectory = inspectPrivateDirectory(locks);
    if (lockDirectory === null) return new Map();
    const names = [...directoryNames(locks, MAX_LOCK_ENTRIES + 1)];
    const found = names.map((name) => {
      if (!MUTEX_SIDECARS.has(name))
        throw new Error(
          "The private Smith create mutex contains an unknown entry.",
        );
      const path = join(locks, name),
        info = assertPlainFile(path),
        fileIdentity = identity(info);
      const previous = known.get(name);
      if (previous !== undefined && !sameIdentity(fileIdentity, previous))
        throw new Error("The private Smith create mutex sidecar changed.");
      return { name, path, identity: fileIdentity, bytes: bytes(info) };
    });
    let total = 0;
    for (const entry of found) {
      total += entry.bytes;
      if (total > SMITH_CONFIG_CREATE_LIMITS.privateLockBytes)
        throw new Error(
          "The private Smith create mutex metadata exceeds its byte limit.",
        );
    }
    const sidecars = new Map<string, FileIdentity>();
    for (const entry of found) {
      if (
        entry.name !== MUTEX_FILE &&
        !known.has(entry.name) &&
        protectNewSidecars
      ) {
        if (process.platform === "win32") {
          const acl = nativeWindowsAcl();
          if (
            !isTrustedNewSmithSidecarOwner(
              acl.read(entry.path).owner,
              acl.userSid(),
              acl.defaultOwnerSid?.() ?? acl.userSid(),
            )
          )
            throw new Error(
              "The new private Smith create SQLite sidecar has a foreign owner.",
            );
          assertStableDirectory(locks, lockDirectory);
          const before = assertPlainFile(entry.path, entry.identity);
          if (bytes(before) !== entry.bytes)
            throw new Error(
              "The new private Smith create SQLite sidecar changed size.",
            );
          makeOwnerOnly(entry.path, "file", acl);
        }
      } else if (entry.name !== MUTEX_FILE && !known.has(entry.name)) {
        // Existing sidecars are never repaired. A private one is safe to
        // inspect; an unprotected one fails this check without being changed.
        assertPrivateFile(entry.path, entry.identity);
      }
      const info = assertPrivateFile(entry.path, entry.identity);
      if (bytes(info) !== entry.bytes)
        throw new Error("The private Smith create mutex metadata changed.");
      sidecars.set(entry.name, entry.identity);
    }
    const afterNames = [...directoryNames(locks, MAX_LOCK_ENTRIES + 1)].sort();
    if (afterNames.join("\0") !== [...names].sort().join("\0"))
      throw new Error("The private Smith create mutex entries changed.");
    let afterTotal = 0;
    for (const entry of found) {
      const info = assertPrivateFile(entry.path, entry.identity);
      const size = bytes(info);
      afterTotal += size;
      if (size !== entry.bytes)
        throw new Error("The private Smith create mutex metadata changed.");
    }
    if (afterTotal > SMITH_CONFIG_CREATE_LIMITS.privateLockBytes)
      throw new Error(
        "The private Smith create mutex metadata exceeds its byte limit.",
      );
    assertStableDirectory(locks, lockDirectory);
    return sidecars;
  };

  const recordDirectory = (requestId: string): string | null => {
    if (!smithConfigRequestIdSchema.safeParse(requestId).success)
      throw new Error("The private Smith create request identity is invalid.");
    const recordsIdentity = inspectPrivateDirectory(records);
    if (recordsIdentity === null) return null;
    const path = join(records, requestId);
    if (!hasPath(path)) return null;
    if (inspectPrivateDirectory(path) === null)
      throw new Error("The Smith create request directory is unavailable.");
    assertStableDirectory(records, recordsIdentity);
    return path;
  };

  const listOperationEntries = (path: string): SmithCreateJournalEntry[] =>
    Array.from(
      directoryNames(path, SMITH_CREATE_JOURNAL_FILES.length + 1),
      (name) => entryMetadata(path, name),
    );

  const ensureMutex = (): MutexState => {
    const rootIdentity = ensurePrivateDirectory(root);
    const expectedLockDirectory = ensurePrivateDirectory(locks);
    if (expectedLockDirectory === null)
      throw new Error(
        "The private Smith create mutex directory is unavailable.",
      );
    checkRootLayout();
    let fd: number | undefined;
    let expectedMutex: FileIdentity | undefined;
    try {
      fd = openSync(mutex, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (fd !== undefined) {
      try {
        const opened = fstatSync(fd, { bigint: true });
        if (!opened.isFile() || opened.nlink !== 1n)
          throw new Error(
            "The private Smith create mutex is not a plain file.",
          );
        expectedMutex = identity(opened);
        fsyncSync(fd);
        const createdMutex = expectedMutex;
        assertStableDirectory(root, rootIdentity);
        assertStableDirectory(locks, expectedLockDirectory);
        const beforeAcl = lstatSync(mutex, { bigint: true });
        if (
          !beforeAcl.isFile() ||
          beforeAcl.isSymbolicLink() ||
          beforeAcl.nlink !== 1n ||
          !sameIdentity(identity(beforeAcl), createdMutex) ||
          !sameIdentity(identity(fstatSync(fd, { bigint: true })), createdMutex)
        )
          throw new Error("The newly created Smith create mutex changed.");
        if (process.platform === "win32")
          makeOwnerOnly(mutex, "file", nativeWindowsAcl());
        const afterAcl = lstatSync(mutex, { bigint: true });
        const stillOpen = fstatSync(fd, { bigint: true });
        if (
          !afterAcl.isFile() ||
          afterAcl.isSymbolicLink() ||
          afterAcl.nlink !== 1n ||
          !sameIdentity(identity(afterAcl), createdMutex) ||
          !sameIdentity(identity(stillOpen), createdMutex)
        )
          throw new Error("The newly created Smith create mutex changed.");
        assertPrivateFile(mutex, expectedMutex);
        fsyncSync(fd);
        assertStableDirectory(root, rootIdentity);
        assertStableDirectory(locks, expectedLockDirectory);
      } finally {
        closeSync(fd);
      }
    }
    assertStableDirectory(root, rootIdentity);
    assertStableDirectory(locks, expectedLockDirectory);
    const info = assertPrivateFile(mutex, expectedMutex);
    if (bytes(info) > SMITH_CONFIG_CREATE_LIMITS.privateLockBytes)
      throw new Error(
        "The private Smith create mutex metadata exceeds its byte limit.",
      );
    const mutexIdentity = identity(info);
    const sidecars = inspectLockMetadata(
      new Map([[MUTEX_FILE, mutexIdentity]]),
    );
    return { identity: mutexIdentity, sidecars };
  };

  const assertMutex = (
    expected: FileIdentity,
    expectedRoot: FileIdentity,
    expectedLockDirectory: FileIdentity,
    knownSidecars: ReadonlyMap<string, FileIdentity>,
    protectNewSidecars = false,
  ): ReadonlyMap<string, FileIdentity> => {
    assertStableDirectory(root, expectedRoot);
    assertStableDirectory(locks, expectedLockDirectory);
    const found = assertPrivateFile(mutex, expected);
    if (bytes(found) > SMITH_CONFIG_CREATE_LIMITS.privateLockBytes)
      throw new Error(
        "The private Smith create mutex metadata exceeds its byte limit.",
      );
    return inspectLockMetadata(knownSidecars, protectNewSidecars);
  };

  return {
    inspect(requestId) {
      if (!smithConfigRequestIdSchema.safeParse(requestId).success)
        throw new Error(
          "The private Smith create request identity is invalid.",
        );
      checkRootLayout();
      inspectLockMetadata();
      const path = recordDirectory(requestId);
      return path === null ? null : listOperationEntries(path);
    },
    *operations() {
      checkRootLayout();
      inspectLockMetadata();
      const recordsIdentity = inspectPrivateDirectory(records);
      if (recordsIdentity === null) return;
      try {
        for (const name of directoryNames(
          records,
          SMITH_CREATE_JOURNAL_LIMITS.operations + 1,
        )) {
          const path = join(records, name);
          if (!smithConfigRequestIdSchema.safeParse(name).success) {
            yield { requestId: name, entries: [entryMetadata(records, name)] };
            continue;
          }
          if (inspectPrivateDirectory(path) === null) {
            yield {
              requestId: name,
              entries: [{ name: "", bytes: 0, plain: false }],
            };
            continue;
          }
          yield { requestId: name, entries: listOperationEntries(path) };
        }
      } finally {
        assertStableDirectory(records, recordsIdentity);
      }
    },
    read(requestId, entry, maxBytes) {
      if (
        !smithConfigRequestIdSchema.safeParse(requestId).success ||
        !SMITH_CREATE_JOURNAL_FILES.some((name) => name === entry.name) ||
        !Number.isSafeInteger(maxBytes) ||
        maxBytes !== SMITH_CREATE_JOURNAL_LIMITS.fileBytes
      )
        throw new Error("The private Smith create record request is invalid.");
      checkRootLayout();
      const path = recordDirectory(requestId);
      if (path === null)
        throw new Error("The private Smith create record is missing.");
      const beforeDirectory = inspectPrivateDirectory(path);
      if (beforeDirectory === null)
        throw new Error("The Smith create request directory is unavailable.");
      const file = join(path, entry.name),
        metadata = entryMetadata(path, entry.name);
      if (!metadata.plain || metadata.bytes !== entry.bytes)
        throw new Error(
          "The private Smith create record changed before its bounded read.",
        );
      const beforeFile = assertPrivateFile(file);
      const found = readHomeFile(records, file);
      errorOf(found);
      if (found.text === null)
        throw new Error("The private Smith create record is missing.");
      const encodedBytes = new TextEncoder().encode(found.text).byteLength;
      if (encodedBytes > maxBytes || encodedBytes !== entry.bytes)
        throw new Error(
          "The private Smith create record exceeds its byte limit.",
        );
      const afterFile = assertPrivateFile(file, identity(beforeFile));
      if (
        afterFile.size !== beforeFile.size ||
        afterFile.mtimeNs !== beforeFile.mtimeNs
      )
        throw new Error(
          "The private Smith create record changed during its bounded read.",
        );
      assertStableDirectory(path, beforeDirectory);
      return found.text;
    },
    writeOnce(requestId, file, text) {
      if (!insideExclusive)
        throw new Error(
          "Private Smith create records require the journal mutex.",
        );
      if (
        !smithConfigRequestIdSchema.safeParse(requestId).success ||
        !SMITH_CREATE_JOURNAL_FILES.some((name) => name === file)
      )
        throw new Error(
          "The private Smith create request identity is invalid.",
        );
      const encodedBytes = new TextEncoder().encode(text).byteLength;
      if (encodedBytes > SMITH_CREATE_JOURNAL_LIMITS.fileBytes)
        throw new Error(
          "The private Smith create record exceeds its byte limit.",
        );
      checkRootLayout();
      const rootIdentity = ensurePrivateDirectory(root);
      const recordsIdentity = ensurePrivateDirectory(records);
      const path = join(records, requestId);
      const operationExisted = hasPath(path);
      ensurePrivateDirectory(path);
      const directoryIdentity = inspectPrivateDirectory(path);
      if (directoryIdentity === null)
        throw new Error("The Smith create request directory is unavailable.");
      const target = join(path, file);
      if (hasPath(target))
        throw new Error("The private Smith create record already exists.");
      const stage = `${target}.${process.pid}-${randomUUID()}.tmp`;
      assertStableDirectory(root, rootIdentity);
      assertStableDirectory(records, recordsIdentity);
      writeOwnerOnly(stage, text);
      let stageIdentity: FileIdentity | undefined;
      try {
        const stageInfo = assertPrivateFile(stage);
        stageIdentity = identity(stageInfo);
        if (
          bytes(stageInfo) !== encodedBytes ||
          bytes(stageInfo) > SMITH_CREATE_JOURNAL_LIMITS.fileBytes
        )
          throw new Error(
            "The private Smith create staging record changed size.",
          );
        syncFile(stage, stageIdentity);
        assertStableDirectory(root, rootIdentity);
        assertStableDirectory(records, recordsIdentity);
        assertStableDirectory(path, directoryIdentity);
        if (hasPath(target))
          throw new Error("The private Smith create record already exists.");
        linkSync(stage, target);
        const published = assertPrivateFile(target, stageIdentity, 2n);
        const staged = lstatSync(stage, { bigint: true });
        if (
          !sameIdentity(identity(published), stageIdentity) ||
          !sameIdentity(identity(staged), stageIdentity) ||
          published.nlink !== 2n ||
          staged.nlink !== 2n
        )
          throw new Error(
            "The private Smith create record publication identity changed.",
          );
        rmSync(stage);
        const final = assertPrivateFile(target, stageIdentity);
        if (final.nlink !== 1n || bytes(final) !== encodedBytes)
          throw new Error(
            "The private Smith create record publication was not confirmed.",
          );
        syncDirectory(path);
        if (!operationExisted) syncDirectory(records);
        const readback = readHomeFile(records, target);
        errorOf(readback);
        if (
          readback.text === null ||
          new TextEncoder().encode(readback.text).byteLength !== encodedBytes ||
          readback.text !== text
        )
          throw new Error(
            "The private Smith create record readback did not match.",
          );
        assertStableDirectory(root, rootIdentity);
        assertStableDirectory(records, recordsIdentity);
        assertStableDirectory(path, directoryIdentity);
      } catch (error) {
        if (stageIdentity !== undefined)
          removeStageOnlyWhenUnpublished(stage, target, stageIdentity);
        throw error;
      }
    },
    async exclusive<T>(work: () => Promise<T>): Promise<T> {
      checkRootLayout();
      const rootIdentity = ensurePrivateDirectory(root);
      ensurePrivateDirectory(locks);
      const lockDirectoryIdentity = inspectPrivateDirectory(locks);
      if (lockDirectoryIdentity === null)
        throw new Error(
          "The private Smith create mutex directory is unavailable.",
        );
      const mutexState = ensureMutex();
      let knownSidecars = assertMutex(
        mutexState.identity,
        rootIdentity,
        lockDirectoryIdentity,
        mutexState.sidecars,
      );
      const locked = await withQueueLock(mutex, async () => {
        knownSidecars = assertMutex(
          mutexState.identity,
          rootIdentity,
          lockDirectoryIdentity,
          knownSidecars,
          true,
        );
        if (insideExclusive)
          throw new Error(
            "The private Smith create mutex cannot be re-entered.",
          );
        insideExclusive = true;
        try {
          return await work();
        } finally {
          insideExclusive = false;
          knownSidecars = assertMutex(
            mutexState.identity,
            rootIdentity,
            lockDirectoryIdentity,
            knownSidecars,
          );
        }
      });
      if (!locked.ok) throw new Error(locked.error);
      assertMutex(
        mutexState.identity,
        rootIdentity,
        lockDirectoryIdentity,
        knownSidecars,
      );
      return locked.value;
    },
  };
}
