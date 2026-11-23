import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  type AclTarget,
  assertOwnerOnly,
  makeOwnerOnly,
  nativeWindowsAcl,
  type WindowsAcl,
} from "./acl-windows";

/** What a refusal to write a secret tells the operator to do. */
export const OWNER_ONLY_FIX =
  "Use the default home (leave AGENT_FORGE_HOME unset: ~/.agent-forge, in your user profile) or set AGENT_FORGE_HOME to a folder on an NTFS drive";

/** How `writeOwnerOnly` protects what it writes; tests hand in their own. */
export interface OwnerOnlyOptions {
  /** Whose protection applies: Windows' ACLs or POSIX modes. This process's platform by default. */
  platform?: NodeJS.Platform;
  /** Windows' ACL functions (`acl-windows.ts`); advapi32's by default. */
  acl?: WindowsAcl;
  /** Called with the temp file once its content is written, before it is renamed over the file. */
  beforeRename?: (temp: string) => void;
}

/**
 * Mode `mode` where the file system keeps POSIX modes; a no-op elsewhere.
 * Best effort, as it always was: a file system without POSIX modes rejects it.
 */
function posixMode(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Best effort: filesystems without POSIX modes reject chmod.
  }
}

function posixOwnerOnly(path: string, target: AclTarget): void {
  posixMode(path, target === "directory" ? 0o700 : 0o600);
}

function refusal(file: string, error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(`Refusing to write ${file}: ${reason}. ${OWNER_ONLY_FIX}.`, {
    cause: error,
  });
}

/**
 * Replace `file` with `content`: its directory made, then given `protect`;
 * then a new temp file beside `file`, given `protect` while it is still
 * empty; then the content, and a rename over `file`. A reader sees the old
 * content or the new, never part of either. Nothing is left of the temp file
 * when any step throws.
 */
function replaceFile(
  file: string,
  content: string,
  protect: (path: string, target: AclTarget) => void,
  beforeRename?: (temp: string) => void,
  create?: (temp: string) => void,
): void {
  const dir = dirname(file);
  mkdirSync(dirname(dir), { recursive: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  protect(dir, "directory");
  const temp = `${file}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  if (create !== undefined) {
    create(temp);
    return;
  }
  let fd: number | null = null;
  try {
    fd = openSync(temp, "wx", 0o600);
    protect(temp, "file");
    writeFileSync(fd, content);
    closeSync(fd);
    fd = null;
    beforeRename?.(temp);
    renameSync(temp, file);
  } catch (error) {
    if (fd !== null) closeSync(fd);
    rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * Replace `file` with `content`, readable by this OS user only, and make the
 * directory it is in so too: give each such file a directory of its own (the
 * hearth's is `tokens/` under its home).
 *
 * - POSIX: the directory 0700, the file 0600.
 * - Windows, where modes mean nothing: an explicit DACL on each, protected
 *   (nothing inherited from the folder above) and granting full control to
 *   this user and SYSTEM only, with this user as owner (`acl-windows.ts`);
 *   the directory's entries are inherited by what is created in it. Each is
 *   read back, and anything else is refused with nothing written: a file
 *   system without ACLs (FAT32, exFAT) cannot hold a secret. Set on every
 *   write, so a directory or a file from before is tightened too; setting
 *   the directory's replaces what the files already in it inherited from the
 *   folder above.
 *
 * The directory first, then a new temp file beside `file`, made owner-only
 * while it is still empty, then the content, then a rename over `file`: a
 * reader sees the old content or the new, never part of either, and never a
 * file with another ACL. On Windows the temp file is created with its
 * owner-only ACL already set, and written and renamed through that one
 * handle (`createOwnerOnly`): a folder on the way renamed or swapped after
 * the directory was checked can neither open it under the ACL of the folder
 * it is made in nor take its bytes (`rmo0`). The renamed file is read back
 * once more, and removed if it is not owner-only.
 *
 * The Windows ACL is set through `bun:ffi`, which only Bun has: under Node
 * (the dashboard's Vite) every write here refuses on Windows.
 */
export function writeOwnerOnly(
  file: string,
  content: string,
  options: OwnerOnlyOptions = {},
): void {
  const windows = (options.platform ?? process.platform) === "win32";
  const protect = (path: string, target: AclTarget): void => {
    try {
      if (windows) makeOwnerOnly(path, target, options.acl);
      else posixOwnerOnly(path, target);
    } catch (error) {
      throw refusal(file, error);
    }
  };
  let create: ((temp: string) => void) | undefined;
  if (windows) {
    let acl: WindowsAcl;
    try {
      acl = options.acl ?? nativeWindowsAcl();
    } catch (error) {
      throw refusal(file, error);
    }
    const createOwnerOnly = acl.createOwnerOnly;
    if (createOwnerOnly !== undefined)
      create = (temp) => {
        try {
          createOwnerOnly(
            temp,
            file,
            Buffer.from(content, "utf8"),
            options.beforeRename,
          );
        } catch (error) {
          throw refusal(file, error);
        }
      };
  }
  replaceFile(file, content, protect, options.beforeRename, create);
  if (!windows) return;
  try {
    assertOwnerOnly(file, "file", options.acl);
  } catch (error) {
    rmSync(file, { force: true });
    throw refusal(file, error);
  }
}

/**
 * Replace `file` with `content` as `writeOwnerOnly` does, for a file that
 * holds no secret: the dashboard record, which the dashboard writes under
 * Node, where no Windows ACL can be set. The same modes on POSIX (the
 * directory 0700, the file 0600); on Windows, the ACL its folder gives it.
 */
export function writeNonSecret(file: string, content: string): void {
  replaceFile(file, content, (path, target) => {
    if (process.platform !== "win32") posixOwnerOnly(path, target);
  });
}

/**
 * Create a fresh per-boot operator token and write it to `file`, readable by
 * this OS user only (`writeOwnerOnly`: 0600 on POSIX, an owner-only DACL on
 * Windows). Throws, with nothing written, where that cannot be made so.
 */
export function createToken(
  file: string,
  options: OwnerOnlyOptions = {},
): string {
  const token = randomBytes(32).toString("hex");
  writeOwnerOnly(file, `${token}\n`, options);
  return token;
}

export function readToken(file: string): string | null {
  try {
    const value = readFileSync(file, "utf8").trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Whether `presented` is the expected token.
 *
 * Both sides are hashed first, so the comparison takes the same time whatever
 * the presented value's length or content, and `timingSafeEqual` never sees
 * buffers of different lengths. Anything but a non-empty string on either side
 * is a refusal: no token minted yet, a header sent twice, a header not sent.
 */
export function tokenMatches(
  expected: string | null,
  presented: unknown,
): boolean {
  if (expected === null || expected.length === 0) return false;
  if (typeof presented !== "string" || presented.length === 0) return false;
  const digest = (value: string): Buffer =>
    createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(expected), digest(presented));
}
