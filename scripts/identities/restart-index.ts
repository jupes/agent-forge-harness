import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  opendirSync,
  openSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { WindowsAcl } from "../hearth/acl-windows";
import {
  assertOwnerOnly,
  makeOwnerOnly,
  nativeWindowsAcl,
} from "../hearth/acl-windows";
import {
  ensurePrivateHome,
  type HomeCheckOptions,
  readHomeFile,
  readHomeFileBounded,
} from "../hearth/home-guard";
import { writeOwnerOnly } from "../hearth/token";
import { workspaceKey } from "../projects/scope";
import { withQueueLock } from "../scheduler/queue-lock";
import {
  sessionProjectIdSchema,
  sessionRequestHashSchema,
  sessionRequestIdSchema,
} from "../sessions/identity-protocol";

export const MAX_RESTART_IDENTITY_ROWS = 1_000;
export const MAX_RESTART_IDENTITY_EVENTS = 3_000;
export const MAX_RESTART_IDENTITY_EVENT_BYTES = 8 * 1024;
export const MAX_RESTART_IDENTITY_JOURNAL_BYTES = 24 * 1024 * 1024;
export const MAX_RESTART_IDENTITY_NAMESPACE_ENTRIES = 3_006;

const DIRECTORY = "restart-identities";
const LOCK_FILE = "transaction.lock.db";
const EVENT_NAME = /^event-(\d{8})-([a-f0-9]{64})\.json$/;
const SQLITE_SIDECARS = new Set([
  `${LOCK_FILE}-journal`,
  `${LOCK_FILE}-wal`,
  `${LOCK_FILE}-shm`,
]);
const HASH = z.string().regex(/^[a-f0-9]{64}$/);
const absolutePath = z
  .string()
  .min(1)
  .max(1_024)
  .refine(
    (value) =>
      value.startsWith("/") ||
      value.startsWith("\\\\") ||
      /^[a-zA-Z]:[\\/]/.test(value),
  )
  .refine((value) => value === value.trim() && !/[\p{Cc}\p{Cs}]/u.test(value));
const workspaceSchema = absolutePath.refine(
  (value) => workspaceKey(value) === value,
);
const addressSchema = z
  .object({
    family: z.literal("owned-session-start"),
    projectId: sessionProjectIdSchema,
  })
  .strict();
const baseSchema = z
  .object({
    version: z.literal(1),
    address: addressSchema,
    workspace: workspaceSchema,
    requestId: sessionRequestIdSchema,
    requestHash: sessionRequestHashSchema,
    provider: z.enum(["claude", "codex", "gemini"]),
    mode: z.enum(["task", "chat"]),
  })
  .strict();
export const restartIdentityRowSchema = baseSchema.extend({
  state: z.enum(["reserved", "attempted", "admitted", "retired"]),
});
export type RestartIdentityRow = z.infer<typeof restartIdentityRowSchema>;
export type RestartIdentityInput = z.infer<typeof baseSchema>;
export type RestartIdentityScope = Pick<
  RestartIdentityInput,
  "address" | "workspace"
>;
export type RestartIdentityOperation =
  | "reserve"
  | "attempt"
  | "admit"
  | "retire";

const eventSchema = z
  .object({
    version: z.literal(1),
    sequence: z.number().int().min(1).max(MAX_RESTART_IDENTITY_EVENTS),
    parentDigest: HASH.nullable(),
    operation: z.enum(["reserve", "attempt", "admit", "retire"]),
    row: restartIdentityRowSchema,
  })
  .strict();
type JournalEvent = z.infer<typeof eventSchema>;
type StoredEvent = {
  event: JournalEvent;
  text: string;
  digest: string;
  name: string;
};
type JournalState = {
  rows: Map<string, RestartIdentityRow>;
  events: StoredEvent[];
  bytes: number;
};

export interface RestartIdentityJournalOptions extends HomeCheckOptions {
  /** Existing ACL helper injection seam; production leaves this unset. */
  acl?: WindowsAcl;
}

export class RestartIdentityJournalError extends Error {
  constructor(
    readonly kind: "invalid" | "conflict" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "RestartIdentityJournalError";
  }
}

export interface RestartIdentityJournal {
  reserve(input: RestartIdentityInput): Promise<RestartIdentityRow>;
  list(scope: RestartIdentityScope): Promise<RestartIdentityRow[]>;
  lookup(
    scope: RestartIdentityScope,
    requestId: string,
  ): Promise<RestartIdentityRow | null>;
  beginAttempt(input: RestartIdentityInput): Promise<RestartIdentityRow>;
  retireReserved(input: RestartIdentityInput): Promise<RestartIdentityRow>;
  reconcileAdmitted(
    input: RestartIdentityInput,
    sourceProof: RestartIdentityInput,
  ): Promise<RestartIdentityRow>;
}

type FileIdentity = { dev: string; ino: string };
const fileIdentity = (info: { dev: bigint; ino: bigint }): FileIdentity => ({
  dev: String(info.dev),
  ino: String(info.ino),
});
const sameIdentity = (left: FileIdentity, right: FileIdentity) =>
  left.dev === right.dev && left.ino === right.ino;
const canonicalPath = (path: string) => {
  const value = resolve(path).replaceAll("\\", "/");
  return process.platform === "win32" ? value.toLowerCase() : value;
};
const fileDigest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const bytesOf = (text: string) => Buffer.byteLength(text, "utf8");
const rowKey = (requestId: string) => requestId;
const sameBase = (left: RestartIdentityInput, right: RestartIdentityInput) =>
  left.address.family === right.address.family &&
  left.address.projectId === right.address.projectId &&
  left.workspace === right.workspace &&
  left.requestId === right.requestId &&
  left.requestHash === right.requestHash &&
  left.provider === right.provider &&
  left.mode === right.mode;
const scopeMatches = (row: RestartIdentityRow, scope: RestartIdentityScope) =>
  row.address.family === scope.address.family &&
  row.address.projectId === scope.address.projectId &&
  row.workspace === scope.workspace;
const isActive = (row: RestartIdentityRow) =>
  row.state === "reserved" || row.state === "attempted";
const unavailable = () =>
  new RestartIdentityJournalError(
    "unavailable",
    "The private Session Start identity journal is unavailable; saved identity evidence was kept.",
  );
const conflict = () =>
  new RestartIdentityJournalError(
    "conflict",
    "This Session Start conflicts with a saved identity or is already held.",
  );

function validateInput(input: unknown): RestartIdentityInput {
  const parsed = baseSchema.safeParse(input);
  if (!parsed.success) {
    throw new RestartIdentityJournalError(
      "invalid",
      "Expected a bounded Session Start identity and server-derived scope.",
    );
  }
  return parsed.data;
}
function digestText(text: string): string {
  return fileDigest(Buffer.from(text, "utf8"));
}
function eventName(sequence: number, digest: string): string {
  return `event-${String(sequence).padStart(8, "0")}-${digest}.json`;
}
function eventText(event: JournalEvent): string {
  return JSON.stringify(event);
}
function identityError(): never {
  throw unavailable();
}

function readBytes(path: string): number {
  const info = lstatSync(path, { bigint: true });
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size < 0n ||
    info.size > BigInt(Number.MAX_SAFE_INTEGER)
  )
    identityError();
  return Number(info.size);
}

function assertDirectory(
  path: string,
  expected?: FileIdentity,
  options: HomeCheckOptions = {},
): FileIdentity {
  let info: BigIntStats;
  try {
    info = lstatSync(path, { bigint: true });
  } catch {
    identityError();
  }
  if (!info.isDirectory() || info.isSymbolicLink()) identityError();
  const found = fileIdentity(info);
  if (expected !== undefined && !sameIdentity(found, expected)) identityError();
  if (canonicalPath(realpathSync.native(path)) !== canonicalPath(path))
    identityError();
  const checked = readHomeFile(path, undefined, options);
  if (checked.problem !== null) identityError();
  return found;
}

function assertPrivateFile(
  path: string,
  expected?: FileIdentity,
  expectedLinks = 1n,
  options: HomeCheckOptions = {},
): FileIdentity {
  let info: BigIntStats;
  try {
    info = lstatSync(path, { bigint: true });
  } catch {
    identityError();
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== expectedLinks)
    identityError();
  const found = fileIdentity(info);
  if (expected !== undefined && !sameIdentity(found, expected)) identityError();
  if (canonicalPath(realpathSync.native(path)) !== canonicalPath(path))
    identityError();
  if ((options.platform ?? process.platform) === "win32") {
    try {
      assertOwnerOnly(path, "file", options.acl);
    } catch {
      identityError();
    }
  } else if (
    info.uid !== BigInt(process.getuid?.() ?? 0) ||
    (info.mode & 0o077n) !== 0n
  ) {
    identityError();
  }
  return found;
}

function ensurePrivateDirectory(
  path: string,
  options: HomeCheckOptions,
): FileIdentity {
  try {
    const existing = lstatSync(path, { bigint: true });
    if (existing.isSymbolicLink() || !existing.isDirectory()) identityError();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    ensurePrivateHome(path, undefined, options);
  } catch {
    identityError();
  }
  return assertDirectory(path, undefined, options);
}

function ensureLockFile(
  path: string,
  directory: string,
  options: HomeCheckOptions,
): FileIdentity {
  let created = false;
  let fd: number | undefined;
  try {
    fd = openSync(path, "wx", 0o600);
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") identityError();
  }
  if (created && fd !== undefined) {
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n) identityError();
      const expected = fileIdentity(opened);
      const named = lstatSync(path, { bigint: true });
      if (
        !named.isFile() ||
        named.isSymbolicLink() ||
        named.nlink !== 1n ||
        !sameIdentity(fileIdentity(named), expected)
      )
        identityError();
      if ((options.platform ?? process.platform) === "win32")
        makeOwnerOnly(path, "file", options.acl);

      fsyncSync(fd);
      if (
        !sameIdentity(fileIdentity(fstatSync(fd, { bigint: true })), expected)
      )
        identityError();
      closeSync(fd);
      fd = undefined;
      assertPrivateFile(path, expected, 1n, options);
      assertDirectory(directory, undefined, options);
      return expected;
    } catch {
      if (fd !== undefined) closeSync(fd);
      identityError();
    }
  }
  if (fd !== undefined) closeSync(fd);
  return assertPrivateFile(path, undefined, 1n, options);
}

function syncFile(
  path: string,
  expected: FileIdentity,
  options: HomeCheckOptions,
): void {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDWR |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
  } catch {
    identityError();
  }
  try {
    const info = fstatSync(fd, { bigint: true });
    if (
      !info.isFile() ||
      info.nlink !== 1n ||
      !sameIdentity(fileIdentity(info), expected)
    )
      identityError();
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  assertPrivateFile(path, expected, 1n, options);
}

function syncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function inspectSidecars(
  directory: string,
  options: HomeCheckOptions,
  previous?: ReadonlyMap<string, FileIdentity>,
  allowNew = false,
): Map<string, FileIdentity> {
  const result = new Map<string, FileIdentity>();
  for (const name of entries(directory)) {
    if (!SQLITE_SIDECARS.has(name)) continue;
    const path = join(directory, name);
    let current: FileIdentity;
    try {
      const info = lstatSync(path, { bigint: true });
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1n ||
        info.size > 65_536n
      )
        identityError();
      current = fileIdentity(info);
    } catch {
      identityError();
    }
    const known = previous?.get(name);
    if (known !== undefined) {
      if (!sameIdentity(current, known)) identityError();
    } else if (previous !== undefined) {
      if (!allowNew) identityError();
      if ((options.platform ?? process.platform) === "win32") {
        const acl = options.acl ?? nativeWindowsAcl();
        const owner = acl.read(path).owner;
        if (
          owner !== acl.userSid() &&
          owner !== (acl.defaultOwnerSid?.() ?? acl.userSid())
        )
          identityError();
        makeOwnerOnly(path, "file", acl);
      } else {
        if (
          lstatSync(path, { bigint: true }).uid !==
          BigInt(process.getuid?.() ?? 0)
        )
          identityError();
        chmodSync(path, 0o600);
      }
    }
    assertPrivateFile(path, current, 1n, options);
    result.set(name, current);
  }
  return result;
}
function entries(directory: string): string[] {
  let handle: ReturnType<typeof opendirSync> | undefined;
  try {
    handle = opendirSync(directory);
    const names: string[] = [];
    while (true) {
      const entry = handle.readSync();
      if (entry === null) return names;
      names.push(entry.name);
      if (names.length > MAX_RESTART_IDENTITY_NAMESPACE_ENTRIES)
        identityError();
    }
  } catch {
    identityError();
  } finally {
    handle?.closeSync();
  }
  return identityError();
}

function decodeCanonicalEvent(text: string, name: string): StoredEvent {
  if (bytesOf(text) > MAX_RESTART_IDENTITY_EVENT_BYTES) identityError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    identityError();
  }
  const canonical = JSON.stringify(parsed);
  if (canonical !== text) identityError();
  const match = EVENT_NAME.exec(name);
  if (match === null) identityError();
  const validated = eventSchema.safeParse(parsed);
  if (!validated.success) identityError();
  const digest = digestText(text);
  if (match[2] !== digest || Number(match[1]) !== validated.data.sequence)
    identityError();
  return { event: validated.data, text, digest, name };
}

function validateRowTransition(state: JournalState, stored: StoredEvent): void {
  const { event } = stored;
  const row = event.row;
  const prior = state.rows.get(rowKey(row.requestId));
  if (event.operation === "reserve") {
    if (row.state !== "reserved" || prior !== undefined) identityError();
    if (
      [...state.rows.values()].some(
        (item) =>
          item.requestId === row.requestId ||
          (scopeMatches(item, row) && isActive(item)),
      )
    )
      identityError();
  } else if (event.operation === "attempt") {
    if (row.state !== "attempted") identityError();
    if (prior !== undefined) {
      if (prior.state !== "reserved" || !sameBase(prior, row)) identityError();
    } else if (
      [...state.rows.values()].some(
        (item) =>
          item.requestId === row.requestId ||
          (scopeMatches(item, row) && isActive(item)),
      )
    ) {
      identityError();
    }
  } else if (event.operation === "admit") {
    if (
      row.state !== "admitted" ||
      prior?.state !== "attempted" ||
      !sameBase(prior, row)
    )
      identityError();
  } else {
    if (
      row.state !== "retired" ||
      prior?.state !== "reserved" ||
      !sameBase(prior, row)
    )
      identityError();
  }
  state.rows.set(row.requestId, row);
}

function replay(events: StoredEvent[]): JournalState {
  if (events.length > MAX_RESTART_IDENTITY_EVENTS) identityError();
  const state: JournalState = { rows: new Map(), events: [], bytes: 0 };
  let parentDigest: string | null = null;
  for (let index = 0; index < events.length; index++) {
    const stored = events[index];
    if (stored === undefined) identityError();
    const sequence = index + 1;
    if (
      stored.event.sequence !== sequence ||
      stored.event.parentDigest !== parentDigest ||
      stored.name !== eventName(sequence, stored.digest)
    )
      identityError();
    validateRowTransition(state, stored);
    state.events.push(stored);
    state.bytes += bytesOf(stored.text);
    if (state.bytes > MAX_RESTART_IDENTITY_JOURNAL_BYTES) identityError();
    parentDigest = stored.digest;
  }
  return state;
}

function scan(
  directory: string,
  lockIdentity: FileIdentity,
  options: HomeCheckOptions,
): JournalState {
  const names = entries(directory);
  const events: StoredEvent[] = [];
  let total = 0;
  for (const name of names) {
    const path = join(directory, name);
    if (name === LOCK_FILE) {
      assertPrivateFile(path, lockIdentity, 1n, options);
      continue;
    }
    if (SQLITE_SIDECARS.has(name)) {
      const size = readBytes(path);
      if (size > 65_536) identityError();
      assertPrivateFile(path, undefined, 1n, options);
      continue;
    }
    const match = EVENT_NAME.exec(name);
    if (match === null) identityError();
    const beforeBytes = readBytes(path);
    if (beforeBytes > MAX_RESTART_IDENTITY_EVENT_BYTES) identityError();
    const beforeIdentity = assertPrivateFile(path, undefined, 1n, options);
    const found = readHomeFileBounded(
      directory,
      path,
      MAX_RESTART_IDENTITY_EVENT_BYTES,
      options,
    );
    if (found.problem !== null || found.text === null) identityError();
    const afterIdentity = assertPrivateFile(path, beforeIdentity, 1n, options);
    if (
      beforeBytes !== bytesOf(found.text) ||
      !sameIdentity(beforeIdentity, afterIdentity)
    )
      identityError();
    const stored = decodeCanonicalEvent(found.text, name);
    events.push(stored);
    total += beforeBytes;
    if (total > MAX_RESTART_IDENTITY_JOURNAL_BYTES) identityError();
  }
  if (!names.includes(LOCK_FILE)) identityError();
  return replay(events);
}

function append(
  directory: string,
  state: JournalState,
  operation: RestartIdentityOperation,
  row: RestartIdentityRow,
  options: HomeCheckOptions,
): StoredEvent {
  if (
    state.events.length >= MAX_RESTART_IDENTITY_EVENTS ||
    state.rows.size > MAX_RESTART_IDENTITY_ROWS
  )
    throw unavailable();
  const sequence = state.events.length + 1;
  const parentDigest = state.events.at(-1)?.digest ?? null;
  const event: JournalEvent = {
    version: 1,
    sequence,
    parentDigest,
    operation,
    row,
  };
  const text = eventText(event);
  const size = bytesOf(text);
  if (
    size > MAX_RESTART_IDENTITY_EVENT_BYTES ||
    state.bytes + size > MAX_RESTART_IDENTITY_JOURNAL_BYTES
  )
    throw unavailable();
  const digest = digestText(text);
  const name = eventName(sequence, digest);
  const target = join(directory, name);
  if (existsSync(target)) identityError();
  const stage = `${target}.${process.pid}-${randomUUID()}.tmp`;
  if (existsSync(stage)) identityError();
  let stageIdentity: FileIdentity | undefined;
  let published = false;
  try {
    writeOwnerOnly(stage, text, options);
    const stagedSize = readBytes(stage);
    if (stagedSize !== size) identityError();
    stageIdentity = assertPrivateFile(stage, undefined, 1n, options);
    syncFile(stage, stageIdentity, options);
    if (existsSync(target)) identityError();
    linkSync(stage, target);
    published = true;
    const publishedIdentity = assertPrivateFile(
      target,
      stageIdentity,
      2n,
      options,
    );
    if (!sameIdentity(publishedIdentity, stageIdentity)) identityError();
    assertPrivateFile(stage, stageIdentity, 2n, options);
    rmSync(stage);
    const finalIdentity = assertPrivateFile(target, stageIdentity, 1n, options);
    if (!sameIdentity(finalIdentity, stageIdentity)) identityError();
    syncDirectory(directory);
    const readback = readHomeFileBounded(
      directory,
      target,
      MAX_RESTART_IDENTITY_EVENT_BYTES,
      options,
    );
    if (readback.problem !== null || readback.text !== text) identityError();
    assertPrivateFile(target, stageIdentity, 1n, options);
    return { event, text, digest, name };
  } catch (error) {
    if (!published && stageIdentity !== undefined) {
      try {
        const targetInfo = lstatSync(target, { bigint: true });
        if (sameIdentity(fileIdentity(targetInfo), stageIdentity)) throw error;
      } catch (targetError) {
        if ((targetError as NodeJS.ErrnoException).code !== "ENOENT")
          throw unavailable();
      }
      try {
        const stageInfo = lstatSync(stage, { bigint: true });
        if (
          stageInfo.isFile() &&
          !stageInfo.isSymbolicLink() &&
          sameIdentity(fileIdentity(stageInfo), stageIdentity)
        )
          rmSync(stage);
      } catch {
        // Leftover staging evidence blocks future journal operations.
      }
    }
    if (error instanceof RestartIdentityJournalError) throw error;
    throw unavailable();
  }
}

function exactRow(
  row: RestartIdentityRow,
  input: RestartIdentityInput,
): boolean {
  return sameBase(row, input);
}

function activeAtAddress(
  state: JournalState,
  input: RestartIdentityInput,
): RestartIdentityRow | undefined {
  return [...state.rows.values()].find(
    (row) => scopeMatches(row, input) && isActive(row),
  );
}

function appendRow(state: JournalState, stored: StoredEvent): void {
  validateRowTransition(state, stored);
  state.events.push(stored);
  state.bytes += bytesOf(stored.text);
}

export function createRestartIdentityJournal(
  profileHome: string,
  options: RestartIdentityJournalOptions = {},
): RestartIdentityJournal {
  const directory = join(profileHome, DIRECTORY);
  const lockPath = join(directory, LOCK_FILE);

  const withState = async <T>(
    work: (state: JournalState) => T | Promise<T>,
  ): Promise<T> => {
    let profileIdentity: FileIdentity;
    try {
      profileIdentity = ensurePrivateDirectory(profileHome, options);
      assertDirectory(profileHome, profileIdentity, options);
      const directoryIdentity = ensurePrivateDirectory(directory, options);
      const lockIdentity = ensureLockFile(lockPath, directory, options);
      const sidecarsBefore = inspectSidecars(directory, options);
      assertDirectory(profileHome, profileIdentity, options);
      assertDirectory(directory, directoryIdentity, options);
      const locked = await withQueueLock(lockPath, async () => {
        assertDirectory(profileHome, profileIdentity, options);
        assertDirectory(directory, directoryIdentity, options);
        assertPrivateFile(lockPath, lockIdentity, 1n, options);
        const sidecarsDuringLock = inspectSidecars(
          directory,
          options,
          sidecarsBefore,
          true,
        );
        const state = scan(directory, lockIdentity, options);
        const result = await work(state);
        assertDirectory(profileHome, profileIdentity, options);
        assertDirectory(directory, directoryIdentity, options);
        assertPrivateFile(lockPath, lockIdentity, 1n, options);
        inspectSidecars(directory, options, sidecarsDuringLock);
        return result;
      });
      if (!locked.ok) throw unavailable();
      assertDirectory(profileHome, profileIdentity, options);
      assertDirectory(directory, directoryIdentity, options);
      assertPrivateFile(lockPath, lockIdentity, 1n, options);
      inspectSidecars(directory, options, sidecarsBefore);
      return locked.value;
    } catch (error) {
      if (error instanceof RestartIdentityJournalError) throw error;
      throw unavailable();
    }
  };

  const commit = (
    state: JournalState,
    operation: RestartIdentityOperation,
    row: RestartIdentityRow,
  ): RestartIdentityRow => {
    const stored = append(directory, state, operation, row, options);
    appendRow(state, stored);
    return row;
  };

  return {
    reserve(raw) {
      const input = validateInput(raw);
      return withState((state) => {
        const existing = state.rows.get(input.requestId);
        if (existing !== undefined) {
          if (!exactRow(existing, input) || existing.state === "retired")
            throw conflict();
          return existing;
        }
        if (
          activeAtAddress(state, input) !== undefined ||
          state.rows.size >= MAX_RESTART_IDENTITY_ROWS
        )
          throw conflict();
        const row: RestartIdentityRow = { ...input, state: "reserved" };
        return commit(state, "reserve", row);
      });
    },
    list(rawScope) {
      const parsed = z
        .object({ address: addressSchema, workspace: workspaceSchema })
        .strict()
        .safeParse(rawScope);
      if (!parsed.success)
        throw new RestartIdentityJournalError(
          "invalid",
          "Expected an exact Session Start identity scope.",
        );
      return withState((state) =>
        [...state.rows.values()].filter((row) =>
          scopeMatches(row, parsed.data),
        ),
      );
    },
    lookup(rawScope, requestId) {
      const parsed = z
        .object({ address: addressSchema, workspace: workspaceSchema })
        .strict()
        .safeParse(rawScope);
      if (
        !parsed.success ||
        !sessionRequestIdSchema.safeParse(requestId).success
      )
        throw new RestartIdentityJournalError(
          "invalid",
          "Expected an exact Session Start identity scope and UUID.",
        );
      return withState((state) => {
        const row = state.rows.get(requestId);
        return row !== undefined && scopeMatches(row, parsed.data) ? row : null;
      });
    },
    beginAttempt(raw) {
      const input = validateInput(raw);
      return withState((state) => {
        const existing = state.rows.get(input.requestId);
        if (existing !== undefined) {
          if (!exactRow(existing, input) || existing.state === "retired")
            throw conflict();
          if (existing.state === "attempted" || existing.state === "admitted")
            return existing;
          return commit(state, "attempt", { ...existing, state: "attempted" });
        }
        if (
          activeAtAddress(state, input) !== undefined ||
          state.rows.size >= MAX_RESTART_IDENTITY_ROWS
        )
          throw conflict();
        return commit(state, "attempt", { ...input, state: "attempted" });
      });
    },
    retireReserved(raw) {
      const input = validateInput(raw);
      return withState((state) => {
        const existing = state.rows.get(input.requestId);
        if (existing === undefined || !exactRow(existing, input))
          throw conflict();
        if (existing.state === "retired") return existing;
        if (existing.state !== "reserved") throw conflict();
        return commit(state, "retire", { ...existing, state: "retired" });
      });
    },
    reconcileAdmitted(raw, rawProof) {
      const input = validateInput(raw);
      const proof = validateInput(rawProof);
      return withState((state) => {
        const existing = state.rows.get(input.requestId);
        if (
          existing === undefined ||
          !exactRow(existing, input) ||
          !exactRow(existing, proof)
        )
          throw conflict();
        if (existing.state === "admitted") return existing;
        if (existing.state !== "attempted") throw conflict();
        return commit(state, "admit", { ...existing, state: "admitted" });
      });
    },
  };
}
