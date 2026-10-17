/**
 * Whether a hearth home may be trusted: nobody but this OS user, SYSTEM and
 * the Administrators may write it (`x1gs.3.36`).
 *
 * A client finds the hearth through the lock file in the home and sends the
 * operator token to the port the lock names. Anyone who can write the home,
 * or the lock file, can name a port of their own and be sent the token: the
 * health check they must pass first only asks that port to echo the pid and
 * the root the lock names. So the hearth refuses to start in such a home, and
 * every client refuses to trust a lock in one, through this one check
 * (`homeWriteProblem`):
 *
 * - Windows: the home's (and the lock file's) owner and DACL, read through
 *   `acl-windows.ts`. An allow entry for anyone but this user, SYSTEM,
 *   Administrators or CREATOR OWNER (and OWNER RIGHTS, while the owner is one
 *   of those) that grants a right to create, replace, delete or re-permission
 *   what is in it is refused (`WRITE_RIGHTS`), inherited or not, inherit-only
 *   or not; so is an owner who is someone else, and a missing DACL. Deny
 *   entries are not counted, so an allow they would override still refuses.
 * - POSIX: a home or lock file that is group- or world-writable, or owned by
 *   another user than this one or root.
 *
 * A home the hearth creates is created owner-only (`ensurePrivateHome`); an
 * existing one is only checked, never changed: a folder the user chose may
 * hold other things, and setting its ACL would reach them too. The refusal
 * says how to make it the user's own.
 *
 * What is judged is what is used (`x1gs.3.38`). A client reads the lock (and
 * `dashboard:open` the dashboard record) through `readHomeFile`, which checks
 * and reads in one act: on Windows the folder the home's path reaches is
 * opened once and judged through that handle (so a junction is judged by its
 * target, and its own ACL, who may point it elsewhere, by its path), and the
 * file is opened relative to that handle and judged and read through its own.
 * A folder above the home renamed, or a junction pointed elsewhere, after
 * that open changes nothing that is read; one renamed before it is judged as
 * the folder it is, and a folder someone else made is theirs and refused. On
 * POSIX the file is judged from its own open descriptor: a file another user
 * made is theirs. `requestLaunch` reads the lock so once more just before it
 * sends the token, and sends it only to the port that lock names.
 *
 * Under Node (the dashboard's Vite) there is no `bun:ffi` to read a Windows
 * ACL with, so the same check and read run under Bun in a child process
 * (`checkHomeInBun`, through `home-guard-cli.ts`), as the dashboard already
 * starts the hearth with `bun`. The child hands back the text it read, and
 * is trusted only with its answer to a nonce of that call: exit code 0 alone
 * is not an answer.
 *
 * Not covered (`scripts/hearth/AGENTS.md` has the detail): the hearth writes
 * its own files by path, and the folders above the home are not judged; a
 * file this user wrote whose permissions someone else could once change.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { resetSpawnClock } from "../spawn-clock";
import {
  type AclReading,
  type AclTarget,
  hasBunFfi,
  makeOwnerOnly,
  nativeWindowsAcl,
  SYSTEM_SID,
  type WindowsAcl,
} from "./acl-windows";
import { type HearthLock, parseLock } from "./lock";

export const ADMINISTRATORS_SID = "S-1-5-32-544";
const CREATOR_OWNER_SID = "S-1-3-0";
const OWNER_RIGHTS_SID = "S-1-3-4";

/**
 * The rights that let a trustee create, replace, delete or re-permission what
 * is in a folder, or change a file: the same bits on both, named for each.
 */
const WRITE_RIGHTS: ReadonlyArray<
  readonly [bit: number, folder: string, file: string]
> = [
  [0x2, "FILE_ADD_FILE", "FILE_WRITE_DATA"],
  [0x4, "FILE_ADD_SUBDIRECTORY", "FILE_APPEND_DATA"],
  [0x40, "FILE_DELETE_CHILD", "FILE_DELETE_CHILD"],
  [0x10000, "DELETE", "DELETE"],
  [0x40000, "WRITE_DAC", "WRITE_DAC"],
  [0x80000, "WRITE_OWNER", "WRITE_OWNER"],
  [0x10000000, "GENERIC_ALL", "GENERIC_ALL"],
  [0x40000000, "GENERIC_WRITE", "GENERIC_WRITE"],
];

/** Deny entries: `ACCESS_DENIED`, its object and callback forms. They grant nothing. */
const DENY_TYPES = new Set([1, 6, 10, 12]);

/** Names for the trustees a refusal most often names; any other is its SID. */
const KNOWN_NAMES: Record<string, string> = {
  "S-1-1-0": "Everyone",
  "S-1-5-11": "NT AUTHORITY\\Authenticated Users",
  "S-1-5-32-545": "BUILTIN\\Users",
  "S-1-5-4": "NT AUTHORITY\\INTERACTIVE",
  "S-1-5-32-546": "BUILTIN\\Guests",
  "S-1-3-1": "CREATOR GROUP",
};

function trusteeName(sid: string | null): string {
  if (sid === null) return "a trustee of an unknown kind of entry";
  const name = KNOWN_NAMES[sid];
  return name === undefined ? sid : `${name} (${sid})`;
}

/** What makes a path writable by others, and what the fix must undo. */
export interface WriteFinding {
  /** Who, and with which rights, in words. */
  reason: string;
  /** Trustees whose own entries (not inherited ones) grant it: `icacls /remove:g`. */
  explicit: string[];
  /** Whether the owner is someone else, who can change its permissions whatever they say. */
  foreignOwner: boolean;
}

/**
 * What lets anyone but `userSid`, SYSTEM and the Administrators write a
 * folder or file with the owner and DACL `reading`, or null when nothing does.
 */
export function windowsWriteFinding(
  reading: AclReading,
  target: AclTarget,
  userSid: string,
): WriteFinding | null {
  const owners = new Set([userSid, SYSTEM_SID, ADMINISTRATORS_SID]);
  const ownerTrusted = reading.owner !== null && owners.has(reading.owner);
  const trusted = new Set([...owners, CREATOR_OWNER_SID]);
  if (ownerTrusted) trusted.add(OWNER_RIGHTS_SID);
  const reasons: string[] = [];
  const explicit: string[] = [];
  if (!ownerTrusted)
    reasons.push(
      `its owner is ${trusteeName(reading.owner)}, who can change its permissions whatever they say`,
    );
  if (reading.entries === null)
    reasons.push("it has no DACL, which lets everyone write it");
  for (const entry of reading.entries ?? []) {
    if (DENY_TYPES.has(entry.type)) continue;
    if (entry.sid !== null && trusted.has(entry.sid)) continue;
    const rights = WRITE_RIGHTS.filter(([bit]) => (entry.mask & bit) !== 0).map(
      ([, folder, file]) => (target === "directory" ? folder : file),
    );
    if (rights.length === 0) continue;
    const inherited = (entry.flags & 0x10) !== 0;
    reasons.push(
      `${trusteeName(entry.sid)} may ${rights.join(", ")}${inherited ? " (inherited)" : ""}`,
    );
    if (!inherited && entry.sid !== null && !explicit.includes(entry.sid))
      explicit.push(entry.sid);
  }
  return reasons.length === 0
    ? null
    : { reason: reasons.join("; "), explicit, foreignOwner: !ownerTrusted };
}

/** What lets anyone but this user (or root) write a folder or file with `stats`, or null. */
export function posixWriteFinding(
  stats: Pick<Stats, "mode" | "uid">,
  uid: number,
): WriteFinding | null {
  const reasons: string[] = [];
  const mode = (stats.mode & 0o777).toString(8).padStart(3, "0");
  if ((stats.mode & 0o020) !== 0)
    reasons.push(`it is group-writable (mode ${mode})`);
  if ((stats.mode & 0o002) !== 0)
    reasons.push(`it is world-writable (mode ${mode})`);
  const foreignOwner = stats.uid !== uid && stats.uid !== 0;
  if (foreignOwner)
    reasons.push(`it belongs to uid ${stats.uid}, not to you (uid ${uid})`);
  return reasons.length === 0
    ? null
    : { reason: reasons.join("; "), explicit: [], foreignOwner };
}

/** How the check reads what it judges; tests hand in their own. */
export interface HomeCheckOptions {
  /** Whose rules apply: Windows' ACLs or POSIX modes. This process's platform by default. */
  platform?: NodeJS.Platform;
  /**
   * Windows' ACL functions: advapi32's where this runtime has `bun:ffi`;
   * elsewhere (Node) the check runs under Bun in a child (`checkHomeInBun`).
   */
  acl?: WindowsAcl;
}

const DEFAULT_HOME_FIX =
  "Use the default home (leave AGENT_FORGE_HOME unset: ~/.agent-forge, in your user profile)";

function homeFix(
  home: string,
  finding: WriteFinding,
  windows: boolean,
  userSid: string | null,
): string {
  if (!windows)
    return finding.foreignOwner
      ? `${DEFAULT_HOME_FIX}, or a folder of your own`
      : `${DEFAULT_HOME_FIX}, or make this folder yours only: chmod 700 "${home}"`;
  const user = userSid ?? "<your SID: whoami /user>";
  const commands = [
    `icacls "${home}" /inheritance:r /grant:r *${user}:(OI)(CI)F *${SYSTEM_SID}:(OI)(CI)F`,
    ...finding.explicit.map((sid) => `icacls "${home}" /remove:g *${sid}`),
    ...(finding.foreignOwner ? [`icacls "${home}" /setowner *${user}`] : []),
  ];
  return `${DEFAULT_HOME_FIX}, or make this folder yours only, by running: ${commands.join(" then ")}`;
}

function fileFix(file: string, windows: boolean): string {
  const who = isLockFile(file)
    ? "a hearth writes it again when it starts"
    : "the dashboard writes it again when it starts";
  return `Delete it (${who}): ${windows ? "del" : "rm"} "${file}"`;
}

function isLockFile(file: string): boolean {
  return file.endsWith(".lock");
}

/** The most a file in the home that a client reads (a lock, a dashboard record) may hold. */
export const MAX_HOME_FILE_BYTES = 65_536;

/**
 * What a client may use from a file in the hearth home (`readHomeFile`):
 * its text, read in the same breath as the check, or why nothing in it is
 * to be used. `text` is null when there is no such file (or no home), and
 * always when there is a problem.
 */
export type HomeRead =
  | { problem: string; text: null }
  | { problem: null; text: string | null };

function refused(problem: string): HomeRead {
  return { problem, text: null };
}

const WRITE_RISK =
  "Anyone who can write it can point a client at a port of their own and be sent the operator token";

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uncheckable(home: string, error: unknown): HomeRead {
  return refused(
    `The hearth home ${home} could not be checked (${reasonOf(error)}), so nothing in it is trusted. ${DEFAULT_HOME_FIX}.`,
  );
}

/** `file` as a name relative to `home`, or null when it is not in it. */
function nameInHome(home: string, file: string): string | null {
  const name = relative(home, file);
  return name === "" || name.startsWith("..") || isAbsolute(name) ? null : name;
}

/** The folder `home` leads to, for words only: what is judged is what its handle holds. */
function leadsTo(home: string): string | null {
  try {
    const real = realpathSync.native(home);
    return comparablePath(real) === comparablePath(home) ? null : real;
  } catch {
    return null;
  }
}

function comparablePath(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * The check and the read of `file` in `home`, as one act: what is judged is
 * what is read (`x1gs.3.38`). A client reads the lock (or the dashboard
 * record) through this, never by a path of its own after a check, so a folder
 * above the home renamed, or a junction pointed elsewhere, between a check
 * and a read cannot hand it a file nobody judged.
 *
 * - Windows: the home as its path names it (a junction's own ACL: who may
 *   point it elsewhere); then the folder the path reaches, opened once, its
 *   owner and DACL read through that handle (a junction's target); then
 *   `file`, opened relative to that handle and through no junction or link,
 *   its owner and DACL and its bytes read through its own handle. Each by the
 *   rules of `windowsWriteFinding`.
 * - POSIX: the home's mode and owner (a symbolic link followed), then `file`
 *   opened without following a link, its mode and owner read from the open
 *   descriptor, and its bytes from it. A file another user made is theirs,
 *   and cannot be made this user's.
 *
 * `file` must be in `home`; without it only the home is checked. A home that
 * does not exist holds nothing: no problem and no text. A file of more than
 * `MAX_HOME_FILE_BYTES`, or not UTF-8, is a refusal. Under Node on Windows it
 * runs under Bun in a child (`checkHomeInBun`), which hands back the text.
 */
export function readHomeFile(
  home: string,
  file?: string,
  options: HomeCheckOptions = {},
): HomeRead {
  if (!existsSync(home)) return { problem: null, text: null };
  const windows = (options.platform ?? process.platform) === "win32";
  const name = file === undefined ? null : nameInHome(home, file);
  if (file !== undefined && name === null)
    return refused(
      `${file} is not in the hearth home ${home}, so it is not trusted.`,
    );
  if (windows && options.acl === undefined && !hasBunFfi())
    return checkHomeInBun(home, file);
  return windows
    ? readWindowsHomeFile(home, file, name, options.acl)
    : readPosixHomeFile(home, file);
}

function homeRefusal(
  home: string,
  finding: WriteFinding,
  windows: boolean,
  userSid: string | null,
): HomeRead {
  return refused(
    `The hearth home ${home} can be written by others: ${finding.reason}. ${WRITE_RISK}. ${homeFix(home, finding, windows, userSid)}.`,
  );
}

function fileRefusal(
  file: string,
  finding: WriteFinding,
  windows: boolean,
): HomeRead {
  return refused(
    `The ${isLockFile(file) ? "lock file" : "file"} ${file} in the hearth home can be written by others: ${finding.reason}. ${WRITE_RISK}. ${fileFix(file, windows)}.`,
  );
}

function decoded(file: string, bytes: Uint8Array, windows: boolean): HomeRead {
  try {
    return { problem: null, text: UTF8.decode(bytes) };
  } catch {
    return refused(
      `The file ${file} in the hearth home is not text, so it is not trusted. ${fileFix(file, windows)}.`,
    );
  }
}

function readWindowsHomeFile(
  home: string,
  file: string | undefined,
  name: string | null,
  given: WindowsAcl | undefined,
): HomeRead {
  let userSid: string | null = null;
  try {
    const acl = given ?? nativeWindowsAcl();
    userSid = acl.userSid();
    // The home as its path names it: for a junction, who may point it elsewhere.
    const own = windowsWriteFinding(acl.read(home), "directory", userSid);
    if (own !== null) return homeRefusal(home, own, true, userSid);
    if (acl.readInFolder === undefined)
      throw new Error("these ACL functions cannot read through a handle");
    const read = acl.readInFolder(home, name, MAX_HOME_FILE_BYTES);
    // Removed meanwhile: it holds nothing.
    if (read === null) return { problem: null, text: null };
    const reached = windowsWriteFinding(read.folder, "directory", userSid);
    if (reached !== null) {
      const real = leadsTo(home);
      return real === null
        ? homeRefusal(home, reached, true, userSid)
        : refused(
            `The hearth home ${home} leads to ${real}, which can be written by others: ${reached.reason}. ${WRITE_RISK}. ${homeFix(real, reached, true, userSid)}.`,
          );
    }
    if (read.file === null || file === undefined)
      return { problem: null, text: null };
    const finding = windowsWriteFinding(read.file.reading, "file", userSid);
    if (finding !== null) return fileRefusal(file, finding, true);
    return decoded(file, read.file.bytes, true);
  } catch (error) {
    return uncheckable(home, error);
  }
}

function readPosixHomeFile(home: string, file: string | undefined): HomeRead {
  const uid = process.getuid?.() ?? 0;
  try {
    const finding = posixWriteFinding(statSync(home), uid);
    if (finding !== null) return homeRefusal(home, finding, false, null);
  } catch (error) {
    // Removed meanwhile: it holds nothing.
    if (!existsSync(home)) return { problem: null, text: null };
    return uncheckable(home, error);
  }
  if (file === undefined) return { problem: null, text: null };
  let fd: number;
  try {
    // Without following a link, and without waiting on a FIFO someone left in its place.
    fd = openSync(
      file,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    // None there, as a hearth that closes removes its lock: nothing to trust.
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { problem: null, text: null };
    return refused(
      `The file ${file} in the hearth home could not be read (${reasonOf(error)}), so it is not trusted. ${fileFix(file, false)}.`,
    );
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile())
      return refused(
        `${file} in the hearth home is not a file, so it is not trusted. ${fileFix(file, false)}.`,
      );
    const finding = posixWriteFinding(stats, uid);
    if (finding !== null) return fileRefusal(file, finding, false);
    if (stats.size > MAX_HOME_FILE_BYTES)
      return refused(
        `The file ${file} in the hearth home is larger than ${MAX_HOME_FILE_BYTES} bytes, so it is not trusted. ${fileFix(file, false)}.`,
      );
    const bytes = Buffer.alloc(MAX_HOME_FILE_BYTES + 1);
    let at = 0;
    for (;;) {
      const got = readSync(fd, bytes, at, bytes.length - at, null);
      if (got === 0) break;
      at += got;
      if (at > MAX_HOME_FILE_BYTES)
        return refused(
          `The file ${file} in the hearth home is larger than ${MAX_HOME_FILE_BYTES} bytes, so it is not trusted. ${fileFix(file, false)}.`,
        );
    }
    return decoded(file, bytes.subarray(0, at), false);
  } catch (error) {
    return refused(
      `The file ${file} in the hearth home could not be read (${reasonOf(error)}), so it is not trusted. ${fileFix(file, false)}.`,
    );
  } finally {
    closeSync(fd);
  }
}

/** A lock read by `readHomeLock`: the lock (null when there is none, or it is not one), or why it is not used. */
export type HomeLockRead =
  | { problem: string; lock: null }
  | { problem: null; lock: HearthLock | null };

/**
 * The lock file `file` in `home` read with `readHomeFile`: what a client
 * that sends the operator token to the port a lock names reads it with.
 */
export function readHomeLock(
  home: string,
  file: string,
  options: HomeCheckOptions = {},
): HomeLockRead {
  const read = readHomeFile(home, file, options);
  if (read.problem !== null) return { problem: read.problem, lock: null };
  return {
    problem: null,
    lock: read.text === null ? null : parseLock(read.text),
  };
}

/**
 * Why a client must not trust a lock in `home`, or the hearth start there:
 * the home, or the lock file `lock` in it when it exists, can be written by
 * someone other than this user, SYSTEM and the Administrators. Null when
 * neither can, and for a home that does not exist, which holds no lock to
 * trust. The answer names the path, who can write it, and the fix. A home
 * that cannot be read is a refusal too. `readHomeFile`'s check, without the
 * text: a client that goes on to use the lock reads it with `readHomeFile`.
 */
export function homeWriteProblem(
  home: string,
  lock?: string,
  options: HomeCheckOptions = {},
): string | null {
  return readHomeFile(home, lock, options).problem;
}

/** The exit code of `home-guard-cli.ts` when it found a problem; its text is on stdout. */
export const PROBLEM_EXIT = 3;
/**
 * The check as a process: a file of its own, because Vite bundles this one as
 * CommonJS, where an entry check's `import.meta` is empty. Found through
 * `__dirname`, not `import.meta`: this module is loaded under Bun, by Vite's
 * config bundler (which sets `__dirname` to each module's own folder) and by
 * the browser suite's runner as CommonJS, where `import.meta` does not parse.
 */
const GUARD_CLI = join(__dirname, "home-guard-cli.ts");

/**
 * The `bun` to run the check with: this process's own under Bun; under Node,
 * the one `bun run` names in `npm_execpath` when it started this process (the
 * browser suite starts the dashboard so, with no `bun` on its `PATH`), else
 * `bun` on the `PATH`.
 */
function bunExecutable(): string {
  if (typeof Bun !== "undefined") return process.execPath;
  const started = process.env["npm_execpath"];
  if (started !== undefined && /(^|[\\/])bun(\.exe)?$/i.test(started))
    return started;
  return "bun";
}

/**
 * The first line of `home-guard-cli.ts`'s answer when nothing in the home is
 * a problem, followed by the nonce it was given. Exit code 0 alone is not
 * that answer (`x1gs.3.38`): a program that is not the check, or a check
 * whose entry was never run, exits 0 too.
 */
export const GUARD_ANSWER = "agent-forge home-guard: trusted";
const NONCE = /^[0-9a-f]{32}$/;
const ANSWER =
  /^agent-forge home-guard: trusted ([0-9a-f]{32})\n(?:none|file ([A-Za-z0-9+/]*={0,2}))\n$/;

/**
 * What `home-guard-cli.ts` prints when the check passed: `GUARD_ANSWER` and
 * the nonce, then `none`, or `file` and the file's text in base64.
 */
export function guardAnswer(nonce: string, text: string | null): string {
  const payload =
    text === null ? "none" : `file ${Buffer.from(text).toString("base64")}`;
  return `${GUARD_ANSWER} ${nonce}\n${payload}\n`;
}

/** The text `stdout` hands back when it is the answer to `nonce`; undefined when it is not. */
function answered(stdout: string, nonce: string): string | null | undefined {
  const match = ANSWER.exec(stdout);
  if (match === null || match[1] !== nonce) return undefined;
  const encoded = match[2];
  if (encoded === undefined) return null;
  const bytes = Buffer.from(encoded, "base64");
  // Only base64 that decodes to exactly what was sent.
  if (bytes.toString("base64") !== encoded) return undefined;
  try {
    return UTF8.decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * `readHomeFile` run under Bun in a child process: how a runtime without
 * `bun:ffi` (the dashboard's Vite, under Node) reads a Windows ACL. The child
 * reads `file` itself, through the handle it judged, and hands its text back,
 * so this process uses what was checked and never reads the file by its path.
 * Trusted only with the child's answer to a nonce of this call
 * (`guardAnswer`); a child that cannot run, exits 0 without that answer, or
 * answers anything else is a refusal.
 */
export function checkHomeInBun(
  home: string,
  file: string | undefined,
): HomeRead {
  const program = bunExecutable();
  const nonce = randomBytes(16).toString("hex");
  const args = [GUARD_CLI, nonce, home, ...(file === undefined ? [] : [file])];
  const cwd = dirname(GUARD_CLI);
  resetSpawnClock();
  const result = spawnSync(program, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 4 * MAX_HOME_FILE_BYTES,
  });
  const stdout = result.stdout ?? "";
  if (result.status === 0 && result.error === undefined) {
    const text = answered(stdout, nonce);
    if (text !== undefined) return { problem: null, text };
  }
  const said = stdout.trim();
  if (result.status === PROBLEM_EXIT && said !== "") return refused(said);
  const why =
    result.error !== undefined
      ? `bun could not be run: ${result.error.message}`
      : result.status === 0
        ? "the check under bun exited 0 without its answer"
        : `the check under bun exited ${result.status ?? "on a signal"}`;
  return refused(
    `The hearth home ${home} could not be checked (${why}), so nothing in it is trusted. ${DEFAULT_HOME_FIX}.`,
  );
}

/** Whether `nonce` is one `checkHomeInBun` sends: the CLI answers no other. */
export function isGuardNonce(nonce: string): boolean {
  return NONCE.test(nonce);
}

/** Thrown when a home is not the user's own: its message is `homeWriteProblem`'s. */
export class HomeNotPrivateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HomeNotPrivateError";
  }
}

/**
 * Create `home` readable and writable by this user only: on POSIX with mode
 * 0700; on Windows as a folder beside it given the owner-only DACL
 * (`makeOwnerOnly`) and then renamed into place, so it never exists with
 * another ACL. A home created meanwhile by someone else is left to the check.
 */
function createPrivateHome(home: string, options: HomeCheckOptions): void {
  mkdirSync(dirname(home), { recursive: true });
  if ((options.platform ?? process.platform) !== "win32") {
    try {
      mkdirSync(home, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return;
  }
  const temp = `${home}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  mkdirSync(temp);
  try {
    makeOwnerOnly(temp, "directory", options.acl);
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    throw new HomeNotPrivateError(
      `The hearth home ${home} could not be created readable by you only: ${error instanceof Error ? error.message : String(error)}. ${DEFAULT_HOME_FIX}, or set AGENT_FORGE_HOME to a folder on an NTFS drive.`,
    );
  }
  try {
    renameSync(temp, home);
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    if (!existsSync(home)) throw error;
  }
}

/**
 * The hearth's own check at start: `home` created owner-only when it does not
 * exist, then `homeWriteProblem` for it and `lock`. Throws
 * `HomeNotPrivateError` with the refusal.
 */
export function ensurePrivateHome(
  home: string,
  lock?: string,
  options: HomeCheckOptions = {},
): void {
  if (!existsSync(home)) createPrivateHome(home, options);
  const problem = homeWriteProblem(home, lock, options);
  if (problem !== null) throw new HomeNotPrivateError(problem);
}
