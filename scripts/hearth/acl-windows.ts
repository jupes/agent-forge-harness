/**
 * Owner-only access control on Windows, where POSIX modes mean nothing: a
 * file written with mode 0600 there only inherits the ACL of the folder it is
 * created in (`token.ts` holds the secrets this protects).
 *
 * `makeOwnerOnly` gives a file or a directory an explicit DACL, protected so
 * nothing is inherited from its parent, that grants full control to this
 * process's user and to SYSTEM and to no one else, and makes that user its
 * owner. On a directory the two entries are inheritable, so a file created in
 * it starts out owner-only too. It then reads the owner and the DACL back and
 * throws `OwnerOnlyError` unless they are that (`ownerOnlyProblem`): a file
 * system that keeps no ACL (FAT32 and exFAT keep none), whether it refuses the
 * call or takes it and keeps nothing, is refused, not trusted.
 *
 * SYSTEM is granted because the operating system's own services (backup,
 * restore, indexing, antivirus) run as SYSTEM, and SYSTEM can read any file
 * through its backup privilege whatever the DACL says: leaving it out would
 * keep no one out and break those services. The user profile, where the
 * default home is, grants it too.
 *
 * Through `bun:ffi` (advapi32), as `scripts/executors/tree-guard.ts` uses
 * kernel32: no child process, nothing found on `PATH`, no text output to parse
 * in the user's language, and SIDs compared as SIDs. `bun:ffi` is looked up
 * when it is first needed, not imported (`bunFfi`): Vite loads this module
 * under Node, through `token.ts` and `launch.ts`.
 */

import type * as BunFfi from "bun:ffi";

type Pointer = BunFfi.Pointer;

/** What `makeOwnerOnly` protects: a directory's entries are also inherited by what is created in it. */
export type AclTarget = "directory" | "file";

/** One entry of a DACL as read back. */
export interface AclEntry {
  /** `ACCESS_ALLOWED_ACE_TYPE` is 0, `ACCESS_DENIED_ACE_TYPE` 1; anything else is another kind. */
  type: number;
  /** The ACE flags: inheritance (`OI` 0x1, `CI` 0x2, `IO` 0x8) and `INHERITED_ACE` (0x10). */
  flags: number;
  mask: number;
  /** `S-1-…`; null for an entry of a kind that does not hold its SID where an allow or deny entry does. */
  sid: string | null;
}

/** A file's or a directory's owner and DACL, as read back. */
export interface AclReading {
  owner: string | null;
  /** Whether the DACL is protected: nothing inherited from the parent. */
  protected: boolean;
  /** Null when there is no DACL at all, which grants everyone everything. */
  entries: AclEntry[] | null;
}

/** What `makeOwnerOnly` asks of Windows; a test hands in its own. */
export interface WindowsAcl {
  /** This process's user, `S-1-…`. */
  userSid(): string;
  /** Replace `path`'s DACL with the owner-only one and make this user its owner. Throws on an API error. */
  apply(path: string, target: AclTarget): void;
  /** `path`'s owner and DACL. Throws on an API error. */
  read(path: string): AclReading;
}

export const SYSTEM_SID = "S-1-5-18";

/** `FILE_ALL_ACCESS`: what each of the two entries grants. */
export const FILE_ALL_ACCESS = 0x001f01ff;
export const ACCESS_ALLOWED_ACE_TYPE = 0;
const OBJECT_INHERIT_ACE = 0x1;
const CONTAINER_INHERIT_ACE = 0x2;
const INHERIT_ONLY_ACE = 0x8;
export const INHERITED_ACE = 0x10;
/** The flags of a directory's two entries: inherited by the files and the directories created in it. */
export const DIRECTORY_ACE_FLAGS = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;

/** Thrown when `path` could not be made owner-only, or did not read back so. */
export class OwnerOnlyError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`${path} could not be made readable by this OS user only: ${reason}`);
    this.name = "OwnerOnlyError";
  }
}

// ── SIDs and ACLs as bytes ─────────────────────────────────────────────────

/** A SID's text form, `S-<revision>-<authority>-<sub>-…`, from its binary form. */
export function sidText(bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint8(1);
  let authority = 0;
  for (let i = 2; i < 8; i++) authority = authority * 256 + view.getUint8(i);
  const parts = [`S-${view.getUint8(0)}-${authority}`];
  for (let i = 0; i < count; i++)
    parts.push(String(view.getUint32(8 + 4 * i, true)));
  return parts.join("-");
}

/** A SID's binary form from its text form; throws on anything else. */
export function sidBytes(text: string): Uint8Array {
  const match = /^S-1-(\d+)((?:-\d+){1,15})$/.exec(text);
  if (match === null) throw new Error(`not a SID: ${text}`);
  const authority = Number(match[1]);
  const subs = (match[2] ?? "").slice(1).split("-").map(Number);
  if (
    !Number.isSafeInteger(authority) ||
    authority >= 2 ** 48 ||
    subs.some((sub) => sub > 0xffffffff)
  )
    throw new Error(`not a SID: ${text}`);
  const bytes = new Uint8Array(8 + 4 * subs.length);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 1);
  view.setUint8(1, subs.length);
  let rest = authority;
  for (let i = 7; i >= 2; i--) {
    view.setUint8(i, rest % 256);
    rest = Math.floor(rest / 256);
  }
  for (const [i, sub] of subs.entries()) view.setUint32(8 + 4 * i, sub, true);
  return bytes;
}

/** `ACL_REVISION`. */
const ACL_REVISION = 2;

/** The owner-only DACL for `target`: full control for `userSid` and SYSTEM, in that order. */
export function ownerOnlyDacl(userSid: string, target: AclTarget): Uint8Array {
  const flags = target === "directory" ? DIRECTORY_ACE_FLAGS : 0;
  const sids = [sidBytes(userSid), sidBytes(SYSTEM_SID)];
  const size = 8 + sids.reduce((sum, sid) => sum + 8 + sid.length, 0);
  const acl = new Uint8Array(size);
  const view = new DataView(acl.buffer);
  view.setUint8(0, ACL_REVISION);
  view.setUint16(2, size, true);
  view.setUint16(4, sids.length, true);
  let at = 8;
  for (const sid of sids) {
    view.setUint8(at, ACCESS_ALLOWED_ACE_TYPE);
    view.setUint8(at + 1, flags);
    view.setUint16(at + 2, 8 + sid.length, true);
    view.setUint32(at + 4, FILE_ALL_ACCESS, true);
    acl.set(sid, at + 8);
    at += 8 + sid.length;
  }
  return acl;
}

/** The length in bytes of the SID at `at` in `bytes`, from its sub-authority count; null when it does not fit. */
function sidLength(bytes: Uint8Array, at: number): number | null {
  if (at + 8 > bytes.length) return null;
  const length = 8 + 4 * (bytes[at + 1] ?? 0);
  return at + length <= bytes.length ? length : null;
}

/** The entries of a DACL in its binary form. Throws on one that does not hold together. */
export function parseDacl(acl: Uint8Array): AclEntry[] {
  const view = new DataView(acl.buffer, acl.byteOffset, acl.byteLength);
  if (acl.length < 8) throw new Error("the DACL read back is truncated");
  const size = view.getUint16(2, true);
  const count = view.getUint16(4, true);
  if (size > acl.length) throw new Error("the DACL read back is truncated");
  const entries: AclEntry[] = [];
  let at = 8;
  for (let i = 0; i < count; i++) {
    if (at + 8 > size) throw new Error("the DACL read back is truncated");
    const type = view.getUint8(at);
    const flags = view.getUint8(at + 1);
    const aceSize = view.getUint16(at + 2, true);
    if (aceSize < 8 || at + aceSize > size)
      throw new Error("the DACL read back is malformed");
    const mask = view.getUint32(at + 4, true);
    let sid: string | null = null;
    // An allow or deny entry holds its SID right after the mask.
    if (type === 0 || type === 1) {
      const body = acl.subarray(at + 8, at + aceSize);
      const length = sidLength(body, 0);
      if (length === null) throw new Error("the DACL read back is malformed");
      sid = sidText(body.subarray(0, length));
    }
    entries.push({ type, flags, mask, sid });
    at += aceSize;
  }
  return entries;
}

// ── What makes a reading owner-only ────────────────────────────────────────

/**
 * Why `reading` is not an owner-only ACL for `target`, or null when it is:
 * owned by `userSid`, a protected DACL, nothing in it but allow entries for
 * `userSid` and SYSTEM, none inherited or inherit-only, each inherited by what
 * is created in a directory, and one giving `userSid` full control.
 */
export function ownerOnlyProblem(
  reading: AclReading,
  target: AclTarget,
  userSid: string,
): string | null {
  if (reading.entries === null)
    return "it has no DACL at all, which lets everyone in (a file system that keeps no ACL)";
  if (reading.owner !== userSid)
    return `its owner is ${reading.owner ?? "nobody"}, not this user (${userSid})`;
  if (!reading.protected)
    return "its DACL is not protected: it still inherits from the folder above";
  const allowed = new Set([userSid, SYSTEM_SID]);
  for (const entry of reading.entries) {
    if (entry.type !== ACCESS_ALLOWED_ACE_TYPE)
      return `its DACL holds an entry of type ${entry.type}, not an allow entry`;
    if (entry.sid === null || !allowed.has(entry.sid))
      return `its DACL grants ${entry.sid ?? "an unknown trustee"}`;
    if ((entry.flags & INHERITED_ACE) !== 0)
      return `its DACL holds an inherited entry for ${entry.sid}`;
    if ((entry.flags & INHERIT_ONLY_ACE) !== 0)
      return `its DACL's entry for ${entry.sid} does not apply to it`;
    if (
      target === "directory" &&
      (entry.flags & DIRECTORY_ACE_FLAGS) !== DIRECTORY_ACE_FLAGS
    )
      return `its DACL's entry for ${entry.sid} is not inherited by what is created in it`;
  }
  const user = reading.entries.find((entry) => entry.sid === userSid);
  if (user === undefined || (user.mask & FILE_ALL_ACCESS) !== FILE_ALL_ACCESS)
    return "its DACL does not give this user full control";
  return null;
}

/** Why `path` does not read back owner-only for `target`, or null; an error is a reason too. */
function readBackProblem(
  path: string,
  target: AclTarget,
  acl: WindowsAcl,
): string | null {
  return ownerOnlyProblem(acl.read(path), target, acl.userSid());
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Give `path` the owner-only ACL for `target` and read it back. Throws
 * `OwnerOnlyError`, naming the reason, when it cannot be set (an API error, the
 * APIs not there) or does not read back so.
 */
export function makeOwnerOnly(
  path: string,
  target: AclTarget,
  acl?: WindowsAcl,
): void {
  let problem: string | null;
  try {
    const api = acl ?? nativeWindowsAcl();
    api.apply(path, target);
    problem = readBackProblem(path, target, api);
  } catch (error) {
    problem = reasonOf(error);
  }
  if (problem !== null) throw new OwnerOnlyError(path, problem);
}

/** Read `path`'s ACL back and throw `OwnerOnlyError` unless it is owner-only for `target`. */
export function assertOwnerOnly(
  path: string,
  target: AclTarget,
  acl?: WindowsAcl,
): void {
  let problem: string | null;
  try {
    problem = readBackProblem(path, target, acl ?? nativeWindowsAcl());
  } catch (error) {
    problem = reasonOf(error);
  }
  if (problem !== null) throw new OwnerOnlyError(path, problem);
}

// ── advapi32 through bun:ffi ───────────────────────────────────────────────

/** `SE_FILE_OBJECT`. */
const SE_FILE_OBJECT = 1;
const OWNER_SECURITY_INFORMATION = 0x1;
const DACL_SECURITY_INFORMATION = 0x4;
const PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000;
/** `TOKEN_QUERY`. */
const TOKEN_QUERY = 0x0008;
/** `TokenUser`, the `TOKEN_INFORMATION_CLASS` that holds the token's user. */
const TOKEN_USER = 1;
/** `GetCurrentProcess()`: the pseudo-handle of this process. */
const CURRENT_PROCESS = -1;
/** In a security descriptor's control word. */
const SE_DACL_PRESENT = 0x0004;
const SE_DACL_PROTECTED = 0x1000;

const ERROR_TEXT: Record<number, string> = {
  2: "the file was not found",
  3: "the path was not found",
  5: "access denied",
  50: "the request is not supported",
  87: "an invalid parameter",
  1307: "this user cannot be its owner",
  1336: "the ACL is invalid",
};

function apiError(call: string, code: number): Error {
  const text = ERROR_TEXT[code];
  return new Error(
    `Windows refused ${call} (error ${code}${text === undefined ? "" : `, ${text}`})`,
  );
}

/**
 * `bun:ffi`, looked up rather than imported. Vite loads this module under
 * Node (through `token.ts` and `launch.ts`), and importing a `bun:` module
 * there fails as the module loads: the import boundary
 * `scripts/council/ledger-events.test.ts` holds. Under Node the lookup finds
 * nothing and every Windows ACL call refuses, so nothing written under Node
 * on Windows can be owner-only: the hearth, which writes the secrets, runs
 * under Bun.
 */
export function bunFfi(
  lookup: (id: string) => object | undefined = (id) =>
    typeof process.getBuiltinModule === "function"
      ? process.getBuiltinModule(id)
      : undefined,
): typeof BunFfi {
  const ffi = lookup("bun:ffi");
  if (ffi === undefined || !("dlopen" in ffi))
    throw new Error(
      "this runtime has no bun:ffi, so it cannot set a Windows ACL (the hearth runs under Bun)",
    );
  // The runtime's own `bun:ffi`, checked above: the lookup's type cannot name it.
  return ffi as typeof BunFfi;
}

/** Both are known DLLs: Windows loads them from System32, whatever the current folder holds. */
function openApi(ffi: typeof BunFfi) {
  const { dlopen, FFIType } = ffi;
  const advapi32 = dlopen("advapi32.dll", {
    OpenProcessToken: {
      args: [FFIType.i64, FFIType.u32, FFIType.ptr],
      returns: FFIType.i32,
    },
    GetTokenInformation: {
      args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr],
      returns: FFIType.i32,
    },
    SetNamedSecurityInfoW: {
      args: [
        FFIType.ptr,
        FFIType.i32,
        FFIType.u32,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
      ],
      returns: FFIType.u32,
    },
    GetNamedSecurityInfoW: {
      args: [
        FFIType.ptr,
        FFIType.i32,
        FFIType.u32,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
      ],
      returns: FFIType.u32,
    },
  }).symbols;
  const kernel32 = dlopen("kernel32.dll", {
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    LocalFree: { args: [FFIType.ptr], returns: FFIType.ptr },
  }).symbols;
  return { advapi32, kernel32, ffi };
}

type Api = ReturnType<typeof openApi>;

/** A path as Windows takes it: UTF-16, NUL-terminated. */
function wide(path: string): Buffer {
  return Buffer.from(`${path}\0`, "utf16le");
}

/**
 * The address Windows wrote into an out-parameter, as `bun:ffi` takes one. A
 * user-space address on 64-bit Windows is below 2^47, so a number holds it.
 */
function address(out: BigUint64Array): Pointer {
  return Number(out[0] ?? 0n) as Pointer;
}

/** Copy `length` bytes at native address `at`. */
function copyOut(api: Api, at: Pointer, length: number): Uint8Array {
  return new Uint8Array(api.ffi.toArrayBuffer(at, 0, length)).slice();
}

/** The user of this process's token, `S-1-…`. */
function processUserSid(api: Api): string {
  const handle = new BigUint64Array(1);
  if (api.advapi32.OpenProcessToken(CURRENT_PROCESS, TOKEN_QUERY, handle) === 0)
    throw new Error(
      "Windows refused OpenProcessToken: this user's SID could not be read",
    );
  try {
    // `TOKEN_USER`: a pointer to the SID (in the same buffer), then its attributes.
    const info = new Uint8Array(256);
    // Taken before the call and passed as is: the SID pointer it writes is an
    // address in this buffer, read back as an offset from this one.
    const base = api.ffi.ptr(info);
    const needed = new Uint32Array(1);
    const ok = api.advapi32.GetTokenInformation(
      handle[0] ?? 0n,
      TOKEN_USER,
      base,
      info.length,
      needed,
    );
    if (ok === 0)
      throw new Error(
        "Windows refused GetTokenInformation: this user's SID could not be read",
      );
    const sidAt =
      Number(new DataView(info.buffer).getBigUint64(0, true)) - base;
    const length = sidLength(info, sidAt);
    if (sidAt < 0 || length === null)
      throw new Error(
        "this user's SID could not be read from the process token",
      );
    return sidText(info.subarray(sidAt, sidAt + length));
  } finally {
    api.kernel32.CloseHandle(handle[0] ?? 0n);
  }
}

function nativeAcl(api: Api): WindowsAcl {
  let user: string | undefined;
  const userSid = (): string => {
    user ??= processUserSid(api);
    return user;
  };
  return {
    userSid,
    apply(path, target) {
      const sid = userSid();
      const name = wide(path);
      // The DACL first: on a folder this user owns but holds no `WRITE_OWNER`
      // on (one created under `C:\`), owning it gives `WRITE_DAC`, and the new
      // DACL's full control gives `WRITE_OWNER` for the second call.
      const dacl = ownerOnlyDacl(sid, target);
      const set = api.advapi32.SetNamedSecurityInfoW(
        name,
        SE_FILE_OBJECT,
        // `|` makes a signed 32-bit number; `>>> 0` makes it the unsigned flags again.
        (DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION) >>> 0,
        null,
        null,
        dacl,
        null,
      );
      if (set !== 0) throw apiError("to set its ACL", set);
      // An owner keeps the right to change the DACL whatever it says.
      const owned = api.advapi32.SetNamedSecurityInfoW(
        name,
        SE_FILE_OBJECT,
        OWNER_SECURITY_INFORMATION,
        sidBytes(sid),
        null,
        null,
        null,
      );
      if (owned !== 0) throw apiError("to make this user its owner", owned);
    },
    read(path) {
      const name = wide(path);
      const owner = new BigUint64Array(1);
      const dacl = new BigUint64Array(1);
      const descriptor = new BigUint64Array(1);
      const got = api.advapi32.GetNamedSecurityInfoW(
        name,
        SE_FILE_OBJECT,
        OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        owner,
        null,
        dacl,
        null,
        descriptor,
      );
      if (got !== 0) throw apiError("to read its ACL", got);
      const sd = address(descriptor);
      try {
        // A self-relative security descriptor: revision, padding, then the control word.
        const { read } = api.ffi;
        const control = read.u16(sd, 2);
        const ownerAt = address(owner);
        const daclAt = address(dacl);
        const ownerSid =
          ownerAt === 0
            ? null
            : sidText(copyOut(api, ownerAt, 8 + 4 * read.u8(ownerAt, 1)));
        const entries =
          (control & SE_DACL_PRESENT) !== 0 && daclAt !== 0
            ? parseDacl(copyOut(api, daclAt, read.u16(daclAt, 2)))
            : null;
        return {
          owner: ownerSid,
          protected: (control & SE_DACL_PROTECTED) !== 0,
          entries,
        };
      } finally {
        if (sd !== 0) api.kernel32.LocalFree(sd);
      }
    },
  };
}

let native: WindowsAcl | undefined;

/** advapi32's security functions, loaded once. Throws where they cannot be loaded. */
export function nativeWindowsAcl(): WindowsAcl {
  native ??= nativeAcl(openApi(bunFfi()));
  return native;
}
