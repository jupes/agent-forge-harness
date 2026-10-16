import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import {
  type AclEntry,
  type AclReading,
  FILE_ALL_ACCESS,
  INHERITED_ACE,
  nativeWindowsAcl,
  SYSTEM_SID,
  type WindowsAcl,
} from "./acl-windows";
import { freshLaunchLink, NoLaunchLink } from "./dashboard-open";
import { lockPath, tokenPath } from "./home";
import {
  ADMINISTRATORS_SID,
  checkHomeInBun,
  ensurePrivateHome,
  homeWriteProblem,
  posixWriteFinding,
  windowsWriteFinding,
} from "./home-guard";
import { requestLaunch } from "./launch";
import type { HearthLock } from "./lock";
import { createHearthMcpServer } from "./mcp";
import { HEALTH_ROUTE, OPERATOR_HEADER } from "./paths";
import { createHearth } from "./server";
import { createSupervisor } from "./supervisor";
import {
  fakeBd,
  fakeCommands,
  icaclsDacl,
  privateTempDir,
  system32,
  whoamiSid,
} from "./testing";

const REPO = resolve(import.meta.dir, "..", "..");
const ON_WINDOWS = process.platform === "win32";
const USER = "S-1-5-21-1-2-3-1001";
const AUTHENTICATED_USERS = "S-1-5-11";
/** Not a real token: what a client would send is all these tests look for. */
const FABRICATED_TOKEN = "0123456789abcdef".repeat(4);

const temps: string[] = [];
const servers: Server[] = [];

/** A temp directory of this user's own, removed after the test. */
function temp(prefix: string): string {
  const dir = privateTempDir(`${prefix} `);
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((done) => server.close(() => done()));
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

// ── What the check counts (pure; runs on every platform) ───────────────────

function entry(
  sid: string | null,
  mask: number,
  change: Partial<AclEntry> = {},
): AclEntry {
  return { type: 0, flags: 0x3, mask, sid, ...change };
}

function reading(entries: AclEntry[] | null, owner = USER): AclReading {
  return { owner, protected: false, entries };
}

const OWNER_ONLY = [
  entry(USER, FILE_ALL_ACCESS),
  entry(SYSTEM_SID, FILE_ALL_ACCESS),
  entry(ADMINISTRATORS_SID, FILE_ALL_ACCESS),
];
/** `M`, as icacls calls it: read, write, execute and delete. */
const MODIFY = 0x1301bf;
/** `RX`. */
const READ_EXECUTE = 0x1200a9;

test("windowsWriteFinding: this user, SYSTEM, Administrators, CREATOR OWNER and OWNER RIGHTS of a trusted owner may write; others only read", () => {
  expect(
    windowsWriteFinding(reading(OWNER_ONLY), "directory", USER),
  ).toBeNull();
  expect(
    windowsWriteFinding(
      reading([
        ...OWNER_ONLY,
        entry("S-1-5-32-545", READ_EXECUTE),
        entry("S-1-3-0", FILE_ALL_ACCESS, { flags: 0xb }),
        entry("S-1-3-4", MODIFY),
        // A deny entry grants nothing.
        entry("S-1-1-0", FILE_ALL_ACCESS, { type: 1 }),
      ]),
      "directory",
      USER,
    ),
  ).toBeNull();
  // An owner among the trusted: SYSTEM, the Administrators.
  expect(
    windowsWriteFinding(
      reading(OWNER_ONLY, ADMINISTRATORS_SID),
      "directory",
      USER,
    ),
  ).toBeNull();
});

test("windowsWriteFinding names who may write, with which rights, and which entries are its own", () => {
  const inherited = windowsWriteFinding(
    reading([
      ...OWNER_ONLY,
      entry(AUTHENTICATED_USERS, MODIFY, { flags: 0x13 }),
    ]),
    "directory",
    USER,
  );
  expect(inherited).toEqual({
    reason:
      "NT AUTHORITY\\Authenticated Users (S-1-5-11) may FILE_ADD_FILE, FILE_ADD_SUBDIRECTORY, DELETE (inherited)",
    explicit: [],
    foreignOwner: false,
  });
  const own = windowsWriteFinding(
    reading([...OWNER_ONLY, entry("S-1-1-0", 0x40000000)]),
    "file",
    USER,
  );
  expect(own?.reason).toBe("Everyone (S-1-1-0) may GENERIC_WRITE");
  expect(own?.explicit).toEqual(["S-1-1-0"]);
  // Each right on its own is enough, and an inherit-only entry counts too.
  for (const [mask, name] of [
    [0x2, "FILE_WRITE_DATA"],
    [0x4, "FILE_APPEND_DATA"],
    [0x40, "FILE_DELETE_CHILD"],
    [0x10000, "DELETE"],
    [0x40000, "WRITE_DAC"],
    [0x80000, "WRITE_OWNER"],
    [0x10000000, "GENERIC_ALL"],
  ] as const)
    expect(
      windowsWriteFinding(
        reading([
          ...OWNER_ONLY,
          entry("S-1-5-21-9-9-9-1002", mask, { flags: 0xb }),
        ]),
        "file",
        USER,
      )?.reason,
    ).toBe(`S-1-5-21-9-9-9-1002 may ${name}`);
  // OWNER RIGHTS speaks for the owner, who here is someone else.
  const foreign = windowsWriteFinding(
    reading([...OWNER_ONLY, entry("S-1-3-4", MODIFY)], "S-1-5-21-9-9-9-1002"),
    "directory",
    USER,
  );
  expect(foreign?.foreignOwner).toBe(true);
  expect(foreign?.reason).toContain(
    "its owner is S-1-5-21-9-9-9-1002, who can change its permissions whatever they say",
  );
  expect(foreign?.reason).toContain("S-1-3-4 may FILE_ADD_FILE");
  expect(windowsWriteFinding(reading(null), "directory", USER)?.reason).toBe(
    "it has no DACL, which lets everyone write it",
  );
});

test("posixWriteFinding refuses a group- or world-writable mode and another user's ownership; root and 0700, 0755 pass", () => {
  expect(posixWriteFinding({ mode: 0o40700, uid: 501 }, 501)).toBeNull();
  expect(posixWriteFinding({ mode: 0o40755, uid: 0 }, 501)).toBeNull();
  expect(posixWriteFinding({ mode: 0o40775, uid: 501 }, 501)?.reason).toBe(
    "it is group-writable (mode 775)",
  );
  expect(posixWriteFinding({ mode: 0o40777, uid: 501 }, 501)?.reason).toBe(
    "it is group-writable (mode 777); it is world-writable (mode 777)",
  );
  expect(posixWriteFinding({ mode: 0o40700, uid: 502 }, 501)).toEqual({
    reason: "it belongs to uid 502, not to you (uid 501)",
    explicit: [],
    foreignOwner: true,
  });
});

/** Windows' ACL functions as a test arranges them: one reading per path. */
function readings(byPath: Record<string, AclReading>): WindowsAcl {
  return {
    userSid: () => USER,
    apply: () => undefined,
    read(path) {
      const found = byPath[path];
      if (found === undefined) throw new Error(`no reading for ${path}`);
      return found;
    },
  };
}

test("homeWriteProblem names the home, who may write it and the icacls commands to make it the user's own (Windows rules, handed in)", () => {
  const home = temp("af-guard-fake");
  const problem = homeWriteProblem(home, undefined, {
    platform: "win32",
    acl: readings({
      [home]: reading([
        ...OWNER_ONLY,
        entry(AUTHENTICATED_USERS, MODIFY, { flags: 0x13 }),
        entry("S-1-1-0", MODIFY),
      ]),
    }),
  });
  expect(problem).toBe(
    `The hearth home ${home} can be written by others: NT AUTHORITY\\Authenticated Users (S-1-5-11) may FILE_ADD_FILE, FILE_ADD_SUBDIRECTORY, DELETE (inherited); Everyone (S-1-1-0) may FILE_ADD_FILE, FILE_ADD_SUBDIRECTORY, DELETE. Anyone who can write it can point a client at a port of their own and be sent the operator token. Use the default home (leave AGENT_FORGE_HOME unset: ~/.agent-forge, in your user profile), or make this folder yours only, by running: icacls "${home}" /inheritance:r /grant:r *${USER}:(OI)(CI)F *S-1-5-18:(OI)(CI)F then icacls "${home}" /remove:g *S-1-1-0.`,
  );
});

test("homeWriteProblem: a lock file others may write is refused, with how to remove it; a home that does not exist, or a missing lock, is no problem (Windows rules, handed in)", () => {
  const home = temp("af-guard-fake");
  const lock = join(home, "hearth-000000000000.lock");
  writeFileSync(lock, "{}");
  const acl = readings({
    [home]: reading(OWNER_ONLY),
    [lock]: reading([
      ...OWNER_ONLY,
      entry("S-1-5-32-545", MODIFY, { flags: 0x10 }),
    ]),
  });
  expect(homeWriteProblem(home, lock, { platform: "win32", acl })).toBe(
    `The lock file ${lock} in the hearth home can be written by others: BUILTIN\\Users (S-1-5-32-545) may FILE_WRITE_DATA, FILE_APPEND_DATA, DELETE (inherited). Anyone who can write it can point a client at a port of their own and be sent the operator token. Delete it (a hearth writes it again when it starts): del "${lock}".`,
  );
  expect(
    homeWriteProblem(home, join(home, "missing.lock"), {
      platform: "win32",
      acl,
    }),
  ).toBeNull();
  expect(
    homeWriteProblem(join(home, "not yet"), undefined, {
      platform: "win32",
      acl,
    }),
  ).toBeNull();
  // One that cannot be read is not trusted.
  expect(
    homeWriteProblem(home, lock, {
      platform: "win32",
      acl: readings({}),
    }),
  ).toContain(
    `The hearth home ${home} could not be checked (no reading for ${home})`,
  );
});

// ── Real homes: one others may write (runs on every platform) ──────────────

/**
 * Let others write `path`: on Windows Authenticated Users get Modify,
 * inherited by what is created in a folder; on POSIX mode 0777 (0666 a file).
 */
function openToOthers(path: string, folder: boolean): void {
  if (ON_WINDOWS)
    system32("icacls.exe", [
      path,
      "/grant",
      `*${AUTHENTICATED_USERS}:${folder ? "(OI)(CI)" : ""}(M)`,
    ]);
  else chmodSync(path, folder ? 0o777 : 0o666);
}

function writableHome(): string {
  const home = temp("af-guard-open");
  openToOthers(home, true);
  return home;
}

/** What each platform's refusal says about who can write the home. */
const WHO_WRITES = ON_WINDOWS
  ? "NT AUTHORITY\\Authenticated Users (S-1-5-11) may FILE_ADD_FILE, FILE_ADD_SUBDIRECTORY, DELETE"
  : "it is group-writable (mode 777); it is world-writable (mode 777)";

interface StandIn {
  port: number;
  /** Every request it was sent: method, path and headers. */
  requests: Array<{
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
  }>;
}

/**
 * A listener another user could run: it answers the health route with the
 * pid and root of the lock it was planted with, which is all a client asks of
 * a port before it sends the token, and records everything it is sent.
 */
async function standIn(pid: number, root: string): Promise<StandIn> {
  const requests: StandIn["requests"] = [];
  const server = createServer((req, res) => {
    requests.push({
      method: req.method ?? "",
      url: req.url ?? "",
      headers: { ...req.headers },
    });
    req.resume();
    res.setHeader("Content-Type", "application/json");
    if (req.url === HEALTH_ROUTE) {
      res.end(JSON.stringify({ ok: true, data: { pid, root }, error: null }));
      return;
    }
    res.end(
      JSON.stringify({
        ok: true,
        data: {
          secret: "1".repeat(64),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        error: null,
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { port: (server.address() as AddressInfo).port, requests };
}

/** A lock and a token file planted in `home` for `root`, naming `port`, as another user could. */
function plant(home: string, root: string, port: number): HearthLock {
  const lock: HearthLock = {
    pid: process.pid,
    port,
    root,
    startedAt: new Date().toISOString(),
    tokenFile: tokenPath(home, root),
  };
  writeFileSync(lockPath(home, root), JSON.stringify(lock));
  mkdirSync(join(home, "tokens"), { recursive: true });
  writeFileSync(tokenPath(home, root), `${FABRICATED_TOKEN}\n`);
  return lock;
}

function operatorHeadersSent(listener: StandIn): unknown[] {
  return listener.requests
    .map((request) => request.headers[OPERATOR_HEADER.toLowerCase()])
    .filter((value) => value !== undefined);
}

function checkout(): string {
  const root = temp("af-guard-root");
  mkdirSync(join(root, ".git"));
  return root;
}

test("a lock planted in a home others may write, naming a listener that passes the health check: requestLaunch, dashboard:open, the dashboard's supervisor and the MCP server each refuse, and the listener is sent no operator token", async () => {
  const home = writableHome();
  const root = checkout();
  const listener = await standIn(process.pid, root);
  plant(home, root, listener.port);

  let refused = "";
  try {
    await requestLaunch({
      home,
      root,
      port: listener.port,
      token: FABRICATED_TOKEN,
      surface: "cli",
    });
  } catch (error) {
    refused = (error as Error).message;
  }
  // Checked after each client: what the listener was sent is the point.
  expect(operatorHeadersSent(listener)).toEqual([]);
  expect(refused).toStartWith(
    `Refusing to send the operator token: The hearth home ${home} can be written by others: ${WHO_WRITES}`,
  );

  let opened = "";
  try {
    await freshLaunchLink({ home, root, url: "http://127.0.0.1:4321/" });
  } catch (error) {
    expect(error).toBeInstanceOf(NoLaunchLink);
    opened = (error as Error).message;
  }
  expect(operatorHeadersSent(listener)).toEqual([]);
  expect(opened).toContain(`The hearth home ${home} can be written by others`);

  let supervised = "";
  try {
    await createSupervisor({ root, home, id: "guard-test" }).ensure();
  } catch (error) {
    supervised = (error as Error).message;
  }
  expect(supervised).toStartWith(
    `Refusing to use the control plane for ${resolve(root)}: The hearth home ${home} can be written by others`,
  );

  const server = await createHearthMcpServer({
    root,
    home,
    operator: true,
    council: null,
    readToken: () => FABRICATED_TOKEN,
  });
  const client = new Client({ name: "guard-test", version: "0" });
  const [near, far] = InMemoryTransport.createLinkedPair();
  await server.connect(far);
  await client.connect(near);
  try {
    const result = await client.callTool({
      name: "forge_council_cancel",
      arguments: { id: "run-1" },
    });
    expect(operatorHeadersSent(listener)).toEqual([]);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      `A lock was found and not used: ${lockPath(home, root).split(/[\\/]/).pop()}: The hearth home`,
    );
  } finally {
    await client.close();
    await server.close();
  }

  // dashboard:open asked its health route; nothing was sent the token.
  expect(operatorHeadersSent(listener)).toEqual([]);
  expect(listener.requests.filter((r) => r.method !== "GET")).toEqual([]);
});

test("a lock file others may write, in a home only this user may write, is refused: by requestLaunch and by the hearth at start", async () => {
  const home = temp("af-guard-home");
  const root = checkout();
  const listener = await standIn(process.pid, root);
  plant(home, root, listener.port);
  openToOthers(lockPath(home, root), false);
  expect(homeWriteProblem(home)).toBeNull();

  let refused = "";
  try {
    await requestLaunch({
      home,
      root,
      port: listener.port,
      token: FABRICATED_TOKEN,
    });
  } catch (error) {
    refused = (error as Error).message;
  }
  expect(refused).toStartWith(
    `Refusing to send the operator token: The lock file ${lockPath(home, root)} in the hearth home can be written by others`,
  );
  expect(refused).toContain(`"${lockPath(home, root)}"`);

  let started = "";
  try {
    const hearth = await startHearth(home, root);
    await (hearth.kind === "started" ? hearth.close() : Promise.resolve());
  } catch (error) {
    started = (error as Error).message;
  }
  expect(started).toStartWith(
    `The hearth will not start: The lock file ${lockPath(home, root)} in the hearth home can be written by others`,
  );
  expect(operatorHeadersSent(listener)).toEqual([]);
});

function startHearth(home: string, root: string) {
  const scratch = temp("af-guard-scratch");
  const bd = fakeBd();
  return createHearth({
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
}

test("bun run hearth in a home others may write exits 1, saying who may write it and how to fix it, and leaves no lock and no token", async () => {
  const home = writableHome();
  const root = checkout();
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
  expect(stderr).toContain(
    `The hearth will not start: The hearth home ${home} can be written by others: ${WHO_WRITES}`,
  );
  expect(stderr).toContain(
    ON_WINDOWS
      ? `icacls "${home}" /inheritance:r /grant:r *${whoamiSid()}:(OI)(CI)F *S-1-5-18:(OI)(CI)F`
      : `chmod 700 "${home}"`,
  );
  expect(existsSync(lockPath(home, root))).toBe(false);
  expect(existsSync(join(home, "tokens"))).toBe(false);
}, 40_000);

test("the check run under Bun in a child process, as the dashboard under Node runs it, says what the check in this process says", () => {
  const home = writableHome();
  const own = temp("af-guard-home");
  expect(checkHomeInBun(home, undefined)).toBe(homeWriteProblem(home));
  expect(checkHomeInBun(own, undefined)).toBeNull();
}, 30_000);

// ── A home the hearth creates ──────────────────────────────────────────────

test("a home that does not exist is created by the hearth for this user only, under a folder others may write (Windows: protected, this user and SYSTEM, through icacls; POSIX: 0700)", async () => {
  const parent = writableHome();
  const home = join(parent, "home");
  const root = checkout();
  const hearth = await startHearth(home, root);
  try {
    expect(hearth.kind).toBe("started");
    expect(homeWriteProblem(home)).toBeNull();
    if (ON_WINDOWS) {
      const user = whoamiSid();
      const saved = icaclsDacl(home, temp("af-guard-scratch"));
      expect(saved.protected).toBe(true);
      expect(
        saved.aces.map((ace) => [ace.type, ace.flags, ace.rights, ace.sid]),
      ).toEqual([
        ["A", "OICI", "FA", user],
        ["A", "OICI", "FA", SYSTEM_SID],
      ]);
      const read = nativeWindowsAcl().read(home);
      expect(read.owner).toBe(user);
      expect(read.entries?.some((e) => (e.flags & INHERITED_ACE) !== 0)).toBe(
        false,
      );
    } else expect(statSync(home).mode & 0o777).toBe(0o700);
  } finally {
    if (hearth.kind === "started") await hearth.close();
  }
  // Nothing was left beside it.
  expect(readdirSync(parent)).toEqual(["home"]);
});

test("ensurePrivateHome leaves an existing home as it is: it refuses one others may write and changes nothing in it", () => {
  const home = writableHome();
  const before = ON_WINDOWS
    ? JSON.stringify(nativeWindowsAcl().read(home))
    : String(statSync(home).mode);
  expect(() => ensurePrivateHome(home)).toThrow(
    `The hearth home ${home} can be written by others`,
  );
  const after = ON_WINDOWS
    ? JSON.stringify(nativeWindowsAcl().read(home))
    : String(statSync(home).mode);
  expect(after).toBe(before);
});

// ── The default home (read only) ───────────────────────────────────────────

test.skipIf(!ON_WINDOWS)(
  "Windows: the default home in the user profile, as it is on this machine, passes the check, which reads it and changes nothing",
  () => {
    const home = join(homedir(), ".agent-forge");
    if (!existsSync(home)) {
      // As the isolation guard re-runs this file, with the profile elsewhere.
      expect(homeWriteProblem(home)).toBeNull();
      expect(existsSync(home)).toBe(false);
      return;
    }
    const before = JSON.stringify(nativeWindowsAcl().read(home));
    expect(homeWriteProblem(home)).toBeNull();
    expect(JSON.stringify(nativeWindowsAcl().read(home))).toBe(before);
  },
);

// ── What the dashboard says when its hearth will not start ─────────────────

test.skipIf(!ON_WINDOWS)(
  "Windows: a hearth the dashboard starts that exits at once (its tokens folder cannot be made owner-only) is reported at once, with its exit code and how to see why, not after the start timeout",
  async () => {
    const home = temp("af-guard-home");
    const tokens = join(home, "tokens");
    mkdirSync(tokens);
    // OWNER RIGHTS takes this user's implicit right to change the folder's ACL away.
    system32("icacls.exe", [
      tokens,
      "/inheritance:r",
      "/grant:r",
      "*S-1-3-4:(OI)(CI)(M)",
    ]);
    const root = checkout();
    const started = performance.now();
    let said = "";
    try {
      await createSupervisor({
        root,
        home,
        id: "guard-test",
        startTimeoutMs: 20_000,
      }).ensure();
    } catch (error) {
      said = (error as Error).message;
    }
    expect(said).toBe(
      `The hearth exited with code 1 before it answered. It says why when started directly: bun run hearth, with AGENT_FORGE_HOME=${home}, in ${resolve(root)}`,
    );
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(existsSync(lockPath(home, root))).toBe(false);
  },
  30_000,
);
