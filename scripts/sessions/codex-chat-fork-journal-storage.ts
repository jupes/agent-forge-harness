/** Private profile-wide immutable event publication for Codex Fork originals. */
import { randomUUID } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  rmSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { agentForgeHome } from "../agent-forge-home";
import {
  assertOwnerOnly,
  makeOwnerOnly,
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
  /** Bounded, path-free diagnostics used only by the opt-in native witness. */
  onMutexDiagnostic?: (diagnostic: CodexChatForkMutexDiagnostic) => void;
  /** Deterministic test barrier immediately after the mutex directory snapshot. */
  afterMutexDirectorySnapshot?: (empty: boolean) => void;
}

export interface CodexChatForkMutexDiagnostic {
  phase:
    | "existing-preflight"
    | "peer-wait-initial"
    | "peer-wait-poll"
    | "creator-open"
    | "creator-protection"
    | "creator-readback"
    | "sidecar-layout";
  fileSize: number | null;
  identityStable: boolean | null;
  failure: "privacy" | "identity" | "other";
}

interface MutexState {
  identity: FileIdentity;
  sidecars: ReadonlyMap<string, FileIdentity>;
}

/** A new SQLite sidecar may only be normalized from this process token's owner. */
function trustedNewSidecarOwner(
  owner: string | null,
  userSid: string,
  defaultOwnerSid: string,
): boolean {
  return owner === userSid || owner === defaultOwnerSid;
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

  const reportMutexDiagnostic = (
    phase: CodexChatForkMutexDiagnostic["phase"],
    error: unknown,
    expected?: FileIdentity,
  ): void => {
    if (options.onMutexDiagnostic === undefined) return;
    let fileSize: number | null = null,
      identityStable: boolean | null = expected === undefined ? null : false;
    try {
      const info = lstatSync(mutex, { bigint: true });
      fileSize = Number(
        info.size > BigInt(MUTEX_BYTES) ? BigInt(MUTEX_BYTES) : info.size,
      );
      if (expected !== undefined)
        identityStable =
          info.isFile() &&
          !info.isSymbolicLink() &&
          sameIdentity(identity(info), expected);
    } catch {
      // Missing or inaccessible mutex is represented by null size and false identity.
    }
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    const failure: CodexChatForkMutexDiagnostic["failure"] =
      /owner.only|dacl|readable by this os user only/.test(message)
        ? "privacy"
        : /changed|linked|identity|stable/.test(message)
          ? "identity"
          : "other";
    try {
      options.onMutexDiagnostic({ phase, fileSize, identityStable, failure });
    } catch {
      // A diagnostic observer must never change storage behavior.
    }
  };

  const ensureDirectoryChain = (path: string): FileIdentity => {
    const components: string[] = [];
    let current = resolve(path);
    for (;;) {
      components.unshift(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    let parentIdentity: FileIdentity | null = null,
      result: FileIdentity | null = null;
    for (const component of components) {
      let info: BigIntStats | null;
      try {
        info = lstatSync(component, { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        info = null;
      }
      if (info === null) {
        if (parentIdentity === null)
          throw new Error("The private Codex Fork path has no stable parent.");
        const parent = dirname(component),
          before = lstatSync(parent, { bigint: true });
        if (
          !before.isDirectory() ||
          before.isSymbolicLink() ||
          !sameIdentity(identity(before), parentIdentity) ||
          !safePath(parent)
        )
          throw new Error(
            "The private Codex Fork parent changed before creation.",
          );
        // ensurePrivateHome now receives exactly one missing leaf; its parent already exists and was checked.
        ensurePrivateHome(component, undefined, homeOptions);
        info = lstatSync(component, { bigint: true });
        const after = lstatSync(parent, { bigint: true });
        if (
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          !sameIdentity(identity(after), parentIdentity) ||
          !safePath(component)
        )
          throw new Error(
            "The private Codex Fork path changed during creation.",
          );
      }
      if (!info.isDirectory() || info.isSymbolicLink() || !safePath(component))
        throw new Error(
          "The private Codex Fork path contains a linked component.",
        );
      const found = identity(info);
      if (parentIdentity !== null) {
        const parent = lstatSync(dirname(component), { bigint: true });
        if (
          !parent.isDirectory() ||
          parent.isSymbolicLink() ||
          !sameIdentity(identity(parent), parentIdentity)
        )
          throw new Error(
            "The private Codex Fork parent changed during inspection.",
          );
      }
      parentIdentity = found;
      result = found;
    }
    if (result === null)
      throw new Error("The private Codex Fork path is invalid.");
    return result;
  };

  const checkedDirectory = (path: string): FileIdentity => {
    ensureDirectoryChain(path);
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

  const assertPlainLockFile = (
    path: string,
    expected?: FileIdentity,
  ): BigIntStats => {
    const info = lstatSync(path, { bigint: true });
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1n ||
      !safePath(path) ||
      info.size > BigInt(MUTEX_BYTES) ||
      (expected !== undefined && !sameIdentity(identity(info), expected))
    )
      throw new Error(
        "The private Codex Fork mutex entry is linked or changed.",
      );
    return info;
  };

  const assertPrivateLockFile = (
    path: string,
    expected?: FileIdentity,
  ): BigIntStats => {
    const info = assertPlainLockFile(path, expected);
    assertPrivateMetadata(path, "file", info, options);
    return info;
  };

  const waitForPrivateMutex = async (
    expectedRoot: FileIdentity,
    expectedLocks: FileIdentity,
    expectedMutex?: FileIdentity,
  ): Promise<FileIdentity> => {
    if ((options.platform ?? process.platform) !== "win32")
      throw new Error(
        "An existing non-private Fork mutex cannot be waited on.",
      );
    const initial = assertPlainLockFile(mutex, expectedMutex),
      mutexIdentity = identity(initial),
      acl = options.acl ?? nativeWindowsAcl(),
      owner = acl.read(mutex).owner;
    if (
      !trustedNewSidecarOwner(
        owner,
        acl.userSid(),
        acl.defaultOwnerSid?.() ?? acl.userSid(),
      )
    ) {
      reportMutexDiagnostic(
        "peer-wait-initial",
        new Error("untrusted mutex owner"),
        mutexIdentity,
      );
      throw new Error(
        "The existing Fork mutex is not a safe initialization candidate.",
      );
    }
    let initiallyPrivate = false;
    try {
      assertPrivateMetadata(mutex, "file", initial, options);
      initiallyPrivate = true;
    } catch (error) {
      if (initial.size !== 0n) {
        reportMutexDiagnostic("peer-wait-initial", error, mutexIdentity);
        throw new Error(
          "The existing Fork mutex is not a safe initialization candidate.",
          { cause: error },
        );
      }
    }
    if (initiallyPrivate) {
      assertPlainLockFile(mutex, mutexIdentity);
      assertPrivateMetadata(
        root,
        "directory",
        lstatSync(root, { bigint: true }),
        options,
      );
      assertPrivateMetadata(
        locks,
        "directory",
        lstatSync(locks, { bigint: true }),
        options,
      );
      assertStableDirectory(root, expectedRoot);
      assertStableDirectory(locks, expectedLocks);
      return mutexIdentity;
    }

    const requestedWait = options.waitMs ?? 1_000,
      waitMs = Number.isFinite(requestedWait)
        ? Math.max(0, Math.min(requestedWait, 1_000))
        : 1_000,
      deadline = Date.now() + waitMs;
    for (;;) {
      assertStableDirectory(root, expectedRoot);
      assertStableDirectory(locks, expectedLocks);
      const info = assertPlainLockFile(mutex, mutexIdentity),
        currentOwner = acl.read(mutex).owner;
      if (
        !trustedNewSidecarOwner(
          currentOwner,
          acl.userSid(),
          acl.defaultOwnerSid?.() ?? acl.userSid(),
        )
      )
        throw new Error(
          "The existing Fork mutex changed during initialization.",
        );
      let isPrivate = false;
      try {
        assertPrivateMetadata(mutex, "file", info, options);
        isPrivate = true;
      } catch (error) {
        if (info.size !== 0n) {
          reportMutexDiagnostic("peer-wait-poll", error, mutexIdentity);
          throw new Error(
            "The unprotected Fork mutex changed during initialization.",
            {
              cause: error,
            },
          );
        }
        if (Date.now() >= deadline) {
          reportMutexDiagnostic("peer-wait-poll", error, mutexIdentity);
          throw new Error(
            "The existing Fork mutex did not become owner-only before the initialization deadline.",
            { cause: error },
          );
        }
      }
      if (isPrivate) {
        assertPlainLockFile(mutex, mutexIdentity);
        assertPrivateMetadata(
          root,
          "directory",
          lstatSync(root, { bigint: true }),
          options,
        );
        assertPrivateMetadata(
          locks,
          "directory",
          lstatSync(locks, { bigint: true }),
          options,
        );
        assertStableDirectory(root, expectedRoot);
        assertStableDirectory(locks, expectedLocks);
        return mutexIdentity;
      }
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
    }
  };

  const secureNewSidecar = (
    path: string,
    expected: FileIdentity,
    expectedSize: bigint,
    lockIdentity: FileIdentity,
  ): void => {
    const before = assertPlainLockFile(path, expected);
    if (before.size !== expectedSize)
      throw new Error(
        "The new private Codex Fork SQLite sidecar changed size.",
      );
    if ((options.platform ?? process.platform) === "win32") {
      const acl = options.acl ?? nativeWindowsAcl(),
        owner = acl.read(path).owner;
      if (
        !trustedNewSidecarOwner(
          owner,
          acl.userSid(),
          acl.defaultOwnerSid?.() ?? acl.userSid(),
        )
      )
        throw new Error(
          "The new private Codex Fork SQLite sidecar has a foreign owner.",
        );
      assertStableDirectory(locks, lockIdentity);
      assertPlainLockFile(path, expected);
      makeOwnerOnly(path, "file", acl);
    } else {
      const uid = BigInt(process.getuid?.() ?? 0);
      if (before.uid !== uid)
        throw new Error(
          "The new private Codex Fork SQLite sidecar has a foreign owner.",
        );
      const descriptor = openSync(
        path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const opened = fstatSync(descriptor, { bigint: true });
        if (
          !opened.isFile() ||
          opened.nlink !== 1n ||
          opened.uid !== uid ||
          !sameIdentity(identity(opened), expected) ||
          opened.size !== expectedSize
        )
          throw new Error("The new private Codex Fork SQLite sidecar changed.");
        fchmodSync(descriptor, 0o600);
      } finally {
        closeSync(descriptor);
      }
    }
    const secured = assertPrivateLockFile(path, expected);
    if (secured.size !== expectedSize)
      throw new Error(
        "The new private Codex Fork SQLite sidecar changed size.",
      );
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

  const inspectLockMetadata = (
    known: ReadonlyMap<string, FileIdentity> = new Map(),
    protectNewSidecars = false,
    requireMutex = true,
  ): ReadonlyMap<string, FileIdentity> => {
    const lockIdentity = inspectDirectory(locks);
    if (lockIdentity === null)
      throw new Error("The private Codex Fork lock directory is missing.");
    const names = directoryNames(locks, MUTEX_ENTRIES.size + 1).sort();
    const found = names.map((name) => {
      if (!MUTEX_ENTRIES.has(name))
        throw new Error("The private Codex Fork lock has an unknown sidecar.");
      const path = join(locks, name),
        info = assertPlainLockFile(path),
        fileIdentity = identity(info),
        previous = known.get(name);
      if (previous !== undefined && !sameIdentity(fileIdentity, previous))
        throw new Error("The private Codex Fork mutex sidecar changed.");
      if (name === MUTEX_FILE || previous !== undefined || !protectNewSidecars)
        assertPrivateMetadata(path, "file", info, options);
      return { name, path, info, identity: fileIdentity };
    });
    if (requireMutex && !names.includes(MUTEX_FILE))
      throw new Error("The private Codex Fork SQLite mutex is missing.");
    if (!requireMutex && names.length > 0 && !names.includes(MUTEX_FILE))
      throw new Error("The private Codex Fork SQLite mutex is incomplete.");
    let totalBytes = 0n;
    const sidecars = new Map<string, FileIdentity>();
    for (const entry of found) {
      totalBytes += entry.info.size;
      if (totalBytes > BigInt(MUTEX_BYTES))
        throw new Error(
          "The private Codex Fork mutex metadata exceeds its limit.",
        );
      if (
        entry.name !== MUTEX_FILE &&
        !known.has(entry.name) &&
        protectNewSidecars
      ) {
        secureNewSidecar(
          entry.path,
          entry.identity,
          entry.info.size,
          lockIdentity,
        );
      }
      const verified = assertPrivateLockFile(entry.path, entry.identity);
      if (verified.size !== entry.info.size)
        throw new Error("The private Codex Fork mutex metadata changed.");
      if (entry.name !== MUTEX_FILE) sidecars.set(entry.name, entry.identity);
    }
    const afterNames = directoryNames(locks, MUTEX_ENTRIES.size + 1).sort();
    if (afterNames.join("\0") !== names.join("\0"))
      throw new Error("The private Codex Fork mutex entries changed.");
    assertStableDirectory(locks, lockIdentity);
    return sidecars;
  };

  const checkLockFiles = (): void => {
    inspectLockMetadata();
  };

  const ensureMutex = async (
    rootIdentity: FileIdentity,
    lockIdentity: FileIdentity,
  ): Promise<MutexState> => {
    assertStableDirectory(root, rootIdentity);
    assertStableDirectory(locks, lockIdentity);
    // A peer can observe an owner's empty mutex between exclusive creation and
    // ACL protection. Wait only for that exact, empty, owned file to settle.
    const existingNames = directoryNames(locks, MUTEX_ENTRIES.size + 1).sort();
    options.afterMutexDirectorySnapshot?.(existingNames.length === 0);
    let readyMutex: FileIdentity | undefined;
    if (existingNames.length === 1 && existingNames[0] === MUTEX_FILE) {
      const info = assertPlainLockFile(mutex),
        existingIdentity = identity(info);
      try {
        assertPrivateMetadata(mutex, "file", info, options);
        readyMutex = existingIdentity;
      } catch (error) {
        reportMutexDiagnostic("existing-preflight", error, existingIdentity);
        if ((options.platform ?? process.platform) !== "win32")
          throw new Error("The existing Fork mutex is not owner-only.");
        readyMutex = await waitForPrivateMutex(
          rootIdentity,
          lockIdentity,
          existingIdentity,
        );
      }
    } else if (existingNames.length > 0) {
      try {
        inspectLockMetadata(new Map(), false, false);
      } catch (error) {
        reportMutexDiagnostic("sidecar-layout", error);
        throw error;
      }
    }
    let descriptor: number | undefined, expectedMutex: FileIdentity | undefined;
    if (readyMutex === undefined) {
      try {
        descriptor = openSync(mutex, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          reportMutexDiagnostic("creator-open", error);
          throw error;
        }
        readyMutex = await waitForPrivateMutex(rootIdentity, lockIdentity);
      }
    }
    if (descriptor !== undefined) {
      try {
        const opened = fstatSync(descriptor, { bigint: true });
        if (!opened.isFile() || opened.nlink !== 1n)
          throw new Error(
            "The new private Codex Fork SQLite mutex is not a plain file.",
          );
        expectedMutex = identity(opened);
        fsyncSync(descriptor);
        assertStableDirectory(root, rootIdentity);
        assertStableDirectory(locks, lockIdentity);
        const beforeAcl = lstatSync(mutex, { bigint: true });
        if (
          !beforeAcl.isFile() ||
          beforeAcl.isSymbolicLink() ||
          beforeAcl.nlink !== 1n ||
          !sameIdentity(identity(beforeAcl), expectedMutex) ||
          !sameIdentity(
            identity(fstatSync(descriptor, { bigint: true })),
            expectedMutex,
          )
        )
          throw new Error("The new private Codex Fork SQLite mutex changed.");
        if ((options.platform ?? process.platform) === "win32") {
          try {
            makeOwnerOnly(mutex, "file", options.acl ?? nativeWindowsAcl());
          } catch (error) {
            reportMutexDiagnostic("creator-protection", error, expectedMutex);
            throw error;
          }
        } else {
          const owner = fstatSync(descriptor, { bigint: true }),
            uid = BigInt(process.getuid?.() ?? 0);
          if (
            !sameIdentity(identity(owner), expectedMutex) ||
            owner.uid !== uid
          )
            throw new Error(
              "The new private Codex Fork SQLite mutex has a foreign owner.",
            );
          fchmodSync(descriptor, 0o600);
        }
        const afterAcl = lstatSync(mutex, { bigint: true }),
          stillOpen = fstatSync(descriptor, { bigint: true });
        if (
          !afterAcl.isFile() ||
          afterAcl.isSymbolicLink() ||
          afterAcl.nlink !== 1n ||
          !sameIdentity(identity(afterAcl), expectedMutex) ||
          !sameIdentity(identity(stillOpen), expectedMutex)
        )
          throw new Error("The new private Codex Fork SQLite mutex changed.");
        try {
          assertPrivateLockFile(mutex, expectedMutex);
        } catch (error) {
          reportMutexDiagnostic("creator-readback", error, expectedMutex);
          throw error;
        }
        fsyncSync(descriptor);
        assertStableDirectory(root, rootIdentity);
        assertStableDirectory(locks, lockIdentity);
      } finally {
        closeSync(descriptor);
      }
    }
    assertStableDirectory(root, rootIdentity);
    assertStableDirectory(locks, lockIdentity);
    let mutexInfo: BigIntStats;
    try {
      mutexInfo = assertPrivateLockFile(mutex, expectedMutex ?? readyMutex);
    } catch (error) {
      reportMutexDiagnostic(
        "sidecar-layout",
        error,
        expectedMutex ?? readyMutex,
      );
      throw error;
    }
    const mutexIdentity = identity(mutexInfo),
      sidecars = (() => {
        try {
          return inspectLockMetadata(new Map([[MUTEX_FILE, mutexIdentity]]));
        } catch (error) {
          reportMutexDiagnostic("sidecar-layout", error, mutexIdentity);
          throw error;
        }
      })();
    return { identity: mutexIdentity, sidecars };
  };

  const assertMutex = (
    expected: FileIdentity,
    expectedRoot: FileIdentity,
    expectedLocks: FileIdentity,
    knownSidecars: ReadonlyMap<string, FileIdentity>,
    protectNewSidecars = false,
  ): ReadonlyMap<string, FileIdentity> => {
    assertStableDirectory(root, expectedRoot);
    assertStableDirectory(locks, expectedLocks);
    assertPrivateLockFile(mutex, expected);
    return inspectLockMetadata(
      new Map([[MUTEX_FILE, expected], ...knownSidecars]),
      protectNewSidecars,
    );
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
      if (!safePath(events))
        throw new Error("The private Codex Fork namespace is linked.");
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
      ensureDirectoryChain(profile);
      ensurePrivateHome(profile, undefined, homeOptions);
      const rootIdentity = checkedDirectory(root),
        eventsIdentity = checkedDirectory(events),
        locksIdentity = checkedDirectory(locks);
      if (
        !sameIdentity(rootIdentity, identity(lstatSync(root, { bigint: true })))
      )
        throw new Error("The private Codex Fork root changed during setup.");
      checkRootLayout();
      const mutexState = await ensureMutex(rootIdentity, locksIdentity);
      let knownSidecars = assertMutex(
        mutexState.identity,
        rootIdentity,
        locksIdentity,
        mutexState.sidecars,
      );
      const locked = await withQueueLock(
        mutex,
        async () => {
          knownSidecars = assertMutex(
            mutexState.identity,
            rootIdentity,
            locksIdentity,
            knownSidecars,
            true,
          );
          if (insideExclusive)
            throw new Error(
              "The private Codex Fork mutex cannot be re-entered.",
            );
          insideExclusive = true;
          try {
            assertStableDirectory(events, eventsIdentity);
            return await work();
          } finally {
            insideExclusive = false;
            knownSidecars = assertMutex(
              mutexState.identity,
              rootIdentity,
              locksIdentity,
              knownSidecars,
            );
            assertStableDirectory(root, rootIdentity);
            assertStableDirectory(events, eventsIdentity);
            assertStableDirectory(locks, locksIdentity);
          }
        },
        options.waitMs === undefined ? {} : { waitMs: options.waitMs },
      );
      if (!locked.ok)
        throw new Error("The private Codex Fork profile mutex is unavailable.");
      assertMutex(
        mutexState.identity,
        rootIdentity,
        locksIdentity,
        knownSidecars,
      );
      return locked.value;
    },
  };
}
