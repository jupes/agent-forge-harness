import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  type AclEntry,
  type AclReading,
  type AclTarget,
  DIRECTORY_ACE_FLAGS,
  FILE_ALL_ACCESS,
  nativeWindowsAcl,
  ownerOnlyProblem,
  SYSTEM_SID,
  type WindowsAcl,
} from "./acl-windows";
import { dashboardRecordPath, lockPath, sessionsPath, tokenPath } from "./home";
import { createHearth } from "./server";
import { fakeBd, fakeCommands } from "./testing";
import {
  createToken,
  OWNER_ONLY_FIX,
  readToken,
  tokenMatches,
  writeNonSecret,
  writeOwnerOnly,
} from "./token";

const TOKEN = "a".repeat(64);

test("tokenMatches accepts the exact token and nothing else", () => {
  expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
  expect(tokenMatches(TOKEN, `${"a".repeat(63)}b`)).toBe(false);
  expect(tokenMatches(TOKEN, TOKEN.toUpperCase())).toBe(false);
  expect(tokenMatches(TOKEN, ` ${TOKEN}`)).toBe(false);
  expect(tokenMatches(TOKEN, `${TOKEN}\n`)).toBe(false);
});

test("tokenMatches refuses a token of another length without throwing", () => {
  expect(tokenMatches(TOKEN, "a")).toBe(false);
  expect(tokenMatches(TOKEN, "a".repeat(65))).toBe(false);
  expect(tokenMatches(TOKEN, "a".repeat(100_000))).toBe(false);
});

test("tokenMatches refuses when either side is missing, empty or not a string", () => {
  expect(tokenMatches(null, TOKEN)).toBe(false);
  expect(tokenMatches("", "")).toBe(false);
  expect(tokenMatches("", TOKEN)).toBe(false);
  expect(tokenMatches(TOKEN, "")).toBe(false);
  expect(tokenMatches(TOKEN, undefined)).toBe(false);
  expect(tokenMatches(TOKEN, [TOKEN])).toBe(false);
  expect(tokenMatches(TOKEN, [TOKEN, TOKEN])).toBe(false);
});

// ── Owner-only files: shared ───────────────────────────────────────────────

const REPO = resolve(import.meta.dir, "..", "..");
const ON_WINDOWS = process.platform === "win32";

const temps: string[] = [];

/** A temp directory, removed after the test; its name has a space, as a profile path may. */
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix} `));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

/** The files in `dir`, none if it does not exist. */
function filesIn(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}

// ── Windows, with the ACL functions handed in (runs on every platform) ─────

const FAKE_USER = "S-1-5-21-1-2-3-1001";
const USERS_SID = "S-1-5-32-545";

function ownerOnlyReading(target: AclTarget): AclReading {
  const flags = target === "directory" ? DIRECTORY_ACE_FLAGS : 0;
  return {
    owner: FAKE_USER,
    protected: true,
    entries: [FAKE_USER, SYSTEM_SID].map(
      (sid): AclEntry => ({ type: 0, flags, mask: FILE_ALL_ACCESS, sid }),
    ),
  };
}

/** What a folder that lets Users read reads as: inherited, and Users in it. */
const LOOSE: AclReading = {
  owner: FAKE_USER,
  protected: false,
  entries: [
    { type: 0, flags: 0x10, mask: 0x120089, sid: USERS_SID },
    { type: 0, flags: 0x10, mask: FILE_ALL_ACCESS, sid: FAKE_USER },
  ],
};

interface FakeAcl extends WindowsAcl {
  /** Each `apply`, with the size of the file at the time (null for a directory). */
  applied: Array<{ path: string; target: AclTarget; size: number | null }>;
}

/**
 * Windows' ACL functions as a test arranges them. By default `apply` works
 * and a temp file's ACL goes with it when it is renamed, as on NTFS.
 */
function fakeAcl(
  arranged: {
    apply?: (path: string, target: AclTarget) => void;
    /** Whether `apply` takes the call and keeps nothing (a file system without ACLs). */
    keepsNothing?: boolean;
    /** Whether the renamed file reads back loose although its temp file did not. */
    loseOnRename?: boolean;
  } = {},
): FakeAcl {
  const set = new Map<string, AclTarget>();
  const fake: FakeAcl = {
    applied: [],
    userSid: () => FAKE_USER,
    apply(path, target) {
      fake.applied.push({
        path,
        target,
        size: target === "file" ? statSync(path).size : null,
      });
      arranged.apply?.(path, target);
      if (!arranged.keepsNothing) set.set(path, target);
    },
    read(path) {
      if (arranged.keepsNothing)
        return { owner: null, protected: false, entries: null };
      const target =
        set.get(path) ??
        (arranged.loseOnRename
          ? undefined
          : [...set].find(
              ([applied]) =>
                applied.startsWith(`${path}.`) && applied.endsWith(".tmp"),
            )?.[1]);
      return target === undefined ? LOOSE : ownerOnlyReading(target);
    },
  };
  return fake;
}

test("Windows ACL handed in: the tokens folder is made owner-only first, then the temp file while it is still empty, and nothing else", () => {
  const home = temp("af-acl-fake");
  const file = tokenPath(home, "/r");
  const acl = fakeAcl();
  const token = createToken(file, { platform: "win32", acl });
  expect(readToken(file)).toBe(token);
  expect(acl.applied.map(({ target, size }) => ({ target, size }))).toEqual([
    { target: "directory", size: null },
    { target: "file", size: 0 },
  ]);
  expect(acl.applied[0]?.path).toBe(dirname(file));
  expect(acl.applied[1]?.path.startsWith(`${file}.`)).toBe(true);
  expect(filesIn(dirname(file))).toEqual([basename(file)]);
});

test("Windows ACL handed in: an ACL that cannot be set writes nothing, and the error names the folder, the reason and the fix", () => {
  const home = temp("af-acl-fake");
  const file = tokenPath(home, "/r");
  const acl = fakeAcl({
    apply() {
      throw new Error(
        "Windows refused to set its ACL (error 50, the request is not supported)",
      );
    },
  });
  let message = "";
  try {
    createToken(file, { platform: "win32", acl });
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toContain(`Refusing to write ${file}`);
  expect(message).toContain(
    `${dirname(file)} could not be made readable by this OS user only`,
  );
  expect(message).toContain("error 50, the request is not supported");
  expect(message).toContain(OWNER_ONLY_FIX);
  // Refused at the folder: no file was ever created in it.
  expect(acl.applied.map(({ target }) => target)).toEqual(["directory"]);
  expect(filesIn(dirname(file))).toEqual([]);
});

test("Windows ACL handed in: a file system that takes the call and keeps no ACL is refused by the read-back, with nothing written", () => {
  const home = temp("af-acl-fake");
  const file = sessionsPath(home, "/r");
  let message = "";
  try {
    writeOwnerOnly(file, "{}\n", {
      platform: "win32",
      acl: fakeAcl({ keepsNothing: true }),
    });
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toContain(
    "it has no DACL at all, which lets everyone in (a file system that keeps no ACL)",
  );
  expect(message).toContain(OWNER_ONLY_FIX);
  expect(filesIn(dirname(file))).toEqual([]);
});

test("Windows ACL handed in: a temp file whose ACL cannot be set is removed, and the file it would replace is kept", () => {
  const home = temp("af-acl-fake");
  const file = sessionsPath(home, "/r");
  writeOwnerOnly(file, "old\n", { platform: "win32", acl: fakeAcl() });
  const acl = fakeAcl({
    apply(_path, target) {
      if (target === "file")
        throw new Error(
          "Windows refused to set its ACL (error 5, access denied)",
        );
    },
  });
  expect(() =>
    writeOwnerOnly(file, "new\n", { platform: "win32", acl }),
  ).toThrow("error 5, access denied");
  expect(readFileSync(file, "utf8")).toBe("old\n");
  expect(filesIn(dirname(file))).toEqual([basename(file)]);
});

test("Windows ACL handed in: a file that does not read back owner-only once renamed is removed", () => {
  const home = temp("af-acl-fake");
  const file = tokenPath(home, "/r");
  let message = "";
  try {
    createToken(file, {
      platform: "win32",
      acl: fakeAcl({ loseOnRename: true }),
    });
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toContain(
    `${file} could not be made readable by this OS user only: its DACL is not protected`,
  );
  expect(filesIn(dirname(file))).toEqual([]);
});

// ── POSIX ──────────────────────────────────────────────────────────────────

test.skipIf(ON_WINDOWS)(
  "POSIX: the token and sessions files are 0600 and the tokens folder 0700, also when they were left looser",
  () => {
    const home = temp("af-mode");
    const file = tokenPath(home, "/r");
    const dir = dirname(file);
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    chmodSync(dir, 0o755);
    writeFileSync(file, "old\n", { mode: 0o644 });
    chmodSync(file, 0o644);
    createToken(file);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const sessions = sessionsPath(home, "/r");
    writeOwnerOnly(sessions, "{}\n");
    expect(statSync(sessions).mode & 0o777).toBe(0o600);
    // A fresh folder too.
    const fresh = tokenPath(temp("af-mode"), "/r");
    createToken(fresh);
    expect(statSync(dirname(fresh)).mode & 0o777).toBe(0o700);
    expect(statSync(fresh).mode & 0o777).toBe(0o600);
  },
);

test.skipIf(ON_WINDOWS)(
  "POSIX: writeNonSecret gives the dashboard record the same modes, 0600 in a 0700 folder",
  () => {
    const record = dashboardRecordPath(temp("af-mode"), "/r");
    writeNonSecret(record, "{}\n");
    expect(statSync(dirname(record)).mode & 0o777).toBe(0o700);
    expect(statSync(record).mode & 0o777).toBe(0o600);
  },
);

test("writeNonSecret replaces the file through a temp file it leaves nothing of", () => {
  const record = dashboardRecordPath(temp("af-record"), "/r");
  writeNonSecret(record, "one\n");
  writeNonSecret(record, "two\n");
  expect(readFileSync(record, "utf8")).toBe("two\n");
  expect(filesIn(dirname(record))).toEqual([basename(record)]);
});

// ── Windows, for real (runs only on Windows) ───────────────────────────────

const SYSTEM32 = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32");

/** A program in System32 by its absolute path, with argv only; throws unless it exits 0. */
function system32(program: string, args: string[]): string {
  const result = Bun.spawnSync([join(SYSTEM32, program), ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(
      `${program} exited ${result.exitCode}: ${result.stdout.toString()}${result.stderr.toString()}`,
    );
  return result.stdout.toString();
}

/** This user's SID as `whoami` prints it, not as the code under test reads it. */
function whoamiSid(): string {
  const line = system32("whoami.exe", ["/user", "/fo", "csv", "/nh"]).trim();
  const sid = /^"[^"]*","(S-1-\d+(?:-\d+)+)"$/.exec(line)?.[1];
  if (sid === undefined) throw new Error("whoami printed no SID");
  return sid;
}

/** A temp home that lets Users read everything created under it, inherited. */
function looseHome(): string {
  const home = temp("af-acl-home");
  system32("icacls.exe", [home, "/grant", `*${USERS_SID}:(OI)(CI)(R)`]);
  return home;
}

/** What SDDL calls by a short name, for the trustees these tests meet. */
const SDDL_ALIASES: Record<string, string> = {
  SY: SYSTEM_SID,
  BU: USERS_SID,
  WD: "S-1-1-0",
  AU: "S-1-5-11",
  BA: "S-1-5-32-544",
  OW: "S-1-3-4",
};

interface IcaclsAce {
  type: string;
  flags: string;
  rights: string;
  sid: string;
}

/**
 * `path`'s DACL as `icacls /save` writes it: SDDL, with SIDs as SIDs whatever
 * the system's language. Saved to a file in `scratch`, outside the folders
 * under test.
 */
function icaclsDacl(
  path: string,
  scratch: string,
): { protected: boolean; aces: IcaclsAce[] } {
  const saved = join(scratch, `${randomUUID()}.acl`);
  system32("icacls.exe", [path, "/save", saved]);
  const sddl = readFileSync(saved).toString("utf16le").split(/\r?\n/)[1] ?? "";
  rmSync(saved);
  const match = /^D:([A-Z]*)((?:\([^)]*\))*)$/.exec(sddl);
  if (match === null) throw new Error(`icacls saved no DACL for ${path}`);
  const aces = [...(match[2] ?? "").matchAll(/\(([^)]*)\)/g)].map((ace) => {
    const [type = "", flags = "", rights = "", , , sid = ""] = (
      ace[1] ?? ""
    ).split(";");
    return { type, flags, rights, sid: SDDL_ALIASES[sid] ?? sid };
  });
  return { protected: (match[1] ?? "").includes("P"), aces };
}

/** Asserted twice: through the reader the code verifies with, and through icacls. */
function expectOwnerOnly(
  path: string,
  target: AclTarget,
  user: string,
  scratch: string,
): void {
  const reading = nativeWindowsAcl().read(path);
  expect(reading.owner).toBe(user);
  expect(reading.protected).toBe(true);
  expect(reading.entries?.map((entry) => entry.sid).sort()).toEqual(
    [user, SYSTEM_SID].sort(),
  );
  expect(ownerOnlyProblem(reading, target, user)).toBeNull();

  const saved = icaclsDacl(path, scratch);
  expect(saved.protected).toBe(true);
  expect(saved.aces.map((ace) => ace.sid).sort()).toEqual(
    [user, SYSTEM_SID].sort(),
  );
  for (const ace of saved.aces) {
    expect(ace.type).toBe("A");
    expect(ace.rights).toBe("FA");
    // Not inherited; on a folder, inherited by what is created in it.
    expect(ace.flags).toBe(target === "directory" ? "OICI" : "");
  }
}

/** Whether icacls lists any of Users, Everyone or Authenticated Users on `path`. */
function grantsOthers(path: string, scratch: string): boolean {
  return icaclsDacl(path, scratch).aces.some((ace) =>
    [USERS_SID, "S-1-1-0", "S-1-5-11"].includes(ace.sid),
  );
}

test.skipIf(!ON_WINDOWS)(
  "Windows: under a home that lets Users read, createToken leaves the tokens folder and the token file owner-only (protected, this user and SYSTEM only), read back and through icacls",
  () => {
    const home = looseHome();
    const scratch = temp("af-acl-scratch");
    const user = whoamiSid();
    // What the home gives a file written there as before: Users can read it.
    const plain = join(home, "plain.txt");
    writeFileSync(plain, "x");
    expect(grantsOthers(plain, scratch)).toBe(true);

    const file = tokenPath(home, "/r");
    const token = createToken(file);
    expect(readToken(file)).toBe(token);
    expectOwnerOnly(dirname(file), "directory", user, scratch);
    expectOwnerOnly(file, "file", user, scratch);
    expect(grantsOthers(dirname(file), scratch)).toBe(false);
    expect(grantsOthers(file, scratch)).toBe(false);
  },
);

test.skipIf(!ON_WINDOWS)(
  "Windows: under a home that lets Users read, writeOwnerOnly leaves the sessions file owner-only, read back and through icacls",
  () => {
    const home = looseHome();
    const scratch = temp("af-acl-scratch");
    const user = whoamiSid();
    const file = sessionsPath(home, "/r");
    writeOwnerOnly(file, '{"version":2,"sessions":[]}\n');
    expectOwnerOnly(dirname(file), "directory", user, scratch);
    expectOwnerOnly(file, "file", user, scratch);
  },
);

test.skipIf(!ON_WINDOWS)(
  "Windows: a tokens folder and a token file left with loose ACLs of their own are tightened by the next createToken",
  () => {
    const home = looseHome();
    const scratch = temp("af-acl-scratch");
    const user = whoamiSid();
    const file = tokenPath(home, "/r");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "old\n");
    // Explicit entries, which setting the folder's ACL would not replace.
    system32("icacls.exe", [dirname(file), "/grant", "*S-1-1-0:(OI)(CI)(R)"]);
    system32("icacls.exe", [file, "/grant", "*S-1-5-11:(R)"]);
    expect(grantsOthers(dirname(file), scratch)).toBe(true);
    expect(grantsOthers(file, scratch)).toBe(true);

    createToken(file);
    expectOwnerOnly(dirname(file), "directory", user, scratch);
    expectOwnerOnly(file, "file", user, scratch);
  },
);

test.skipIf(!ON_WINDOWS)(
  "Windows: a sessions file left from before, readable by Users through its folder, is tightened when createToken sets the folder's ACL",
  () => {
    const home = looseHome();
    const scratch = temp("af-acl-scratch");
    const user = whoamiSid();
    const sessions = sessionsPath(home, "/r");
    mkdirSync(dirname(sessions), { recursive: true });
    writeFileSync(sessions, '{"version":2,"sessions":[]}\n');
    expect(grantsOthers(sessions, scratch)).toBe(true);

    createToken(tokenPath(home, "/r"));
    // Not rewritten: what it inherits is now the folder's owner-only entries.
    const saved = icaclsDacl(sessions, scratch);
    expect(saved.aces.map((ace) => ace.sid).sort()).toEqual(
      [user, SYSTEM_SID].sort(),
    );
    expect(grantsOthers(sessions, scratch)).toBe(false);
  },
);

test.skipIf(!ON_WINDOWS)(
  "Windows: the temp file is owner-only, with its content, before it is renamed over the token file",
  () => {
    const home = looseHome();
    const scratch = temp("af-acl-scratch");
    const user = whoamiSid();
    const file = tokenPath(home, "/r");
    const seen: string[] = [];
    const token = createToken(file, {
      beforeRename(temp) {
        seen.push(temp);
        expect(existsSync(file)).toBe(false);
        expect(readFileSync(temp, "utf8").trim()).toMatch(/^[0-9a-f]{64}$/);
        expectOwnerOnly(temp, "file", user, scratch);
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.startsWith(`${file}.`)).toBe(true);
    expect(existsSync(seen[0] ?? "")).toBe(false);
    expect(readToken(file)).toBe(token);
  },
);

test.skipIf(!ON_WINDOWS)(
  "Windows: writeNonSecret sets no ACL: the dashboard record, which holds no secret, keeps what its folder gives it",
  () => {
    const home = looseHome();
    const scratch = temp("af-acl-scratch");
    const record = dashboardRecordPath(home, "/r");
    writeNonSecret(record, "{}\n");
    expect(icaclsDacl(record, scratch).protected).toBe(false);
    expect(grantsOthers(record, scratch)).toBe(true);
  },
);

/**
 * A home whose `tokens` folder this user owns but may not change the ACL of:
 * an `OWNER RIGHTS` entry takes the owner's implicit right to change it away.
 * A real refusal from Windows, the nearest this machine has to a drive
 * without ACLs. The folder can still be deleted (`M` includes delete).
 */
function lockedTokensHome(): string {
  const home = temp("af-acl-locked");
  const dir = join(home, "tokens");
  mkdirSync(dir);
  system32("icacls.exe", [
    dir,
    "/inheritance:r",
    "/grant:r",
    "*S-1-3-4:(OI)(CI)(M)",
  ]);
  return home;
}

test.skipIf(!ON_WINDOWS)(
  "Windows: a tokens folder whose ACL this user may not change: createToken writes nothing and the error names the folder, the reason and the fix",
  () => {
    const home = lockedTokensHome();
    const file = tokenPath(home, "/r");
    let message = "";
    try {
      createToken(file);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(
      `Refusing to write ${file}: ${dirname(file)} could not be made readable by this OS user only: Windows refused to set its ACL (error 5, access denied). ${OWNER_ONLY_FIX}.`,
    );
    expect(filesIn(dirname(file))).toEqual([]);
  },
);

test.skipIf(!ON_WINDOWS)(
  "Windows: the hearth does not start under such a home: the start fails naming the home, the reason and the fix, and leaves no lock and no token",
  async () => {
    const home = lockedTokensHome();
    const root = temp("af-acl-root");
    mkdirSync(join(root, ".git"));
    const scratch = temp("af-acl-scratch");
    const bd = fakeBd();
    let message = "";
    try {
      const hearth = await createHearth({
        root,
        home,
        harnessRoot: REPO,
        environment: { COUNCIL_RUNS_DIR: join(scratch, "council-runs") },
        councilRunCommand: fakeCommands().run,
        api: {
          ledgerPath: join(scratch, "ledger.db"),
          runBd: (args, options) => bd.run(args, options),
          configHome: scratch,
        },
      });
      await (hearth.kind === "started" ? hearth.close() : Promise.resolve());
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toStartWith(
      `The hearth will not start with home ${home}: `,
    );
    expect(message).toContain(
      "Windows refused to set its ACL (error 5, access denied)",
    );
    expect(message).toContain(OWNER_ONLY_FIX);
    expect(existsSync(lockPath(home, root))).toBe(false);
    expect(filesIn(join(home, "tokens"))).toEqual([]);
  },
);

test.skipIf(!ON_WINDOWS)(
  "Windows: bun run hearth under such a home exits 1 and prints why, with no lock and no token left",
  async () => {
    const home = lockedTokensHome();
    const root = temp("af-acl-root");
    mkdirSync(join(root, ".git"));
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env))
      if (value !== undefined && key.toUpperCase() !== "AGENT_FORGE_HOME")
        env[key] = value;
    env["AGENT_FORGE_HOME"] = home;
    const child = Bun.spawn(
      [
        process.execPath,
        join(REPO, "scripts", "hearth", "server.ts"),
        "--root",
        root,
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    // A hearth that started after all would never exit: end it, and fail.
    const timer = setTimeout(() => child.kill(), 30_000);
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    clearTimeout(timer);
    expect(code).toBe(1);
    expect(stderr).toContain(`The hearth will not start with home ${home}: `);
    expect(stderr).toContain(
      "Windows refused to set its ACL (error 5, access denied)",
    );
    expect(stderr).toContain(OWNER_ONLY_FIX);
    expect(existsSync(lockPath(home, root))).toBe(false);
    expect(filesIn(join(home, "tokens"))).toEqual([]);
  },
  40_000,
);
