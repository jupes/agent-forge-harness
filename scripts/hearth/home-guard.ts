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
 * Under Node (the dashboard's Vite) there is no `bun:ffi` to read a Windows
 * ACL with, so the same check runs under Bun in a child process
 * (`checkHomeInBun`, through `home-guard-cli.ts`), as the dashboard already
 * starts the hearth with `bun`.
 *
 * Not covered: the folders above the home. A home inside a folder others may
 * rename or replace is not protected by its own ACL.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  type AclReading,
  type AclTarget,
  hasBunFfi,
  makeOwnerOnly,
  nativeWindowsAcl,
  SYSTEM_SID,
  type WindowsAcl,
} from "./acl-windows";

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

function lockFix(lock: string, windows: boolean): string {
  return `Delete it (a hearth writes it again when it starts): ${windows ? "del" : "rm"} "${lock}"`;
}

/** The finding for `path` by the rules of `platform`, or null; throws when it cannot be read. */
function findingFor(
  path: string,
  target: AclTarget,
  windows: boolean,
  acl: WindowsAcl | null,
): WriteFinding | null {
  if (!windows) {
    const uid = process.getuid?.() ?? 0;
    return posixWriteFinding(statSync(path), uid);
  }
  if (acl === null) throw new Error("no Windows ACL functions");
  return windowsWriteFinding(acl.read(path), target, acl.userSid());
}

/**
 * Why a client must not trust a lock in `home`, or the hearth start there:
 * the home, or the lock file `lock` in it when it exists, can be written by
 * someone other than this user, SYSTEM and the Administrators. Null when
 * neither can, and for a home that does not exist, which holds no lock to
 * trust. The answer names the path, who can write it, and the fix. A home
 * that cannot be read is a refusal too.
 */
export function homeWriteProblem(
  home: string,
  lock?: string,
  options: HomeCheckOptions = {},
): string | null {
  if (!existsSync(home)) return null;
  const windows = (options.platform ?? process.platform) === "win32";
  if (windows && options.acl === undefined && !hasBunFfi())
    return checkHomeInBun(home, lock);
  let acl: WindowsAcl | null = null;
  let userSid: string | null = null;
  try {
    if (windows) acl = options.acl ?? nativeWindowsAcl();
    userSid = acl?.userSid() ?? null;
    const finding = findingFor(home, "directory", windows, acl);
    if (finding !== null)
      return `The hearth home ${home} can be written by others: ${finding.reason}. Anyone who can write it can point a client at a port of their own and be sent the operator token. ${homeFix(home, finding, windows, userSid)}.`;
  } catch (error) {
    return `The hearth home ${home} could not be checked (${error instanceof Error ? error.message : String(error)}), so nothing in it is trusted. ${DEFAULT_HOME_FIX}.`;
  }
  if (lock === undefined || !existsSync(lock)) return null;
  try {
    const finding = findingFor(lock, "file", windows, acl);
    if (finding !== null)
      return `The lock file ${lock} in the hearth home can be written by others: ${finding.reason}. Anyone who can write it can point a client at a port of their own and be sent the operator token. ${lockFix(lock, windows)}.`;
  } catch (error) {
    // Removed meanwhile, as a hearth that closes removes it: no lock to trust.
    if (!existsSync(lock)) return null;
    return `The lock file ${lock} could not be checked (${error instanceof Error ? error.message : String(error)}), so it is not trusted. ${lockFix(lock, windows)}.`;
  }
  return null;
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
 * `homeWriteProblem` run under Bun in a child process: how a runtime without
 * `bun:ffi` (the dashboard's Vite, under Node) reads a Windows ACL. A child
 * that cannot run or answers otherwise is a refusal.
 */
export function checkHomeInBun(
  home: string,
  lock: string | undefined,
): string | null {
  const result = spawnSync(
    bunExecutable(),
    [GUARD_CLI, home, ...(lock === undefined ? [] : [lock])],
    {
      cwd: dirname(GUARD_CLI),
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    },
  );
  if (result.status === 0) return null;
  const said = (result.stdout ?? "").trim();
  if (result.status === PROBLEM_EXIT && said !== "") return said;
  const why =
    result.error !== undefined
      ? `bun could not be run: ${result.error.message}`
      : `the check under bun exited ${result.status ?? "on a signal"}`;
  return `The hearth home ${home} could not be checked (${why}), so nothing in it is trusted. ${DEFAULT_HOME_FIX}.`;
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
