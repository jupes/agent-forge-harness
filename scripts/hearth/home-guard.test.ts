import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
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
  makeOwnerOnly,
  nativeWindowsAcl,
  SYSTEM_SID,
  type WindowsAcl,
} from "./acl-windows";
import { freshLaunchLink, NoLaunchLink } from "./dashboard-open";
import { lockPath, sessionsPath, tokenPath } from "./home";
import {
  ADMINISTRATORS_SID,
  checkHomeInBun,
  ensurePrivateHome,
  homeWriteProblem,
  posixWriteFinding,
  windowsWriteFinding,
} from "./home-guard";
import { createSessionStore, requestLaunch } from "./launch";
import { type HearthLock, readLock } from "./lock";
import type { Exchange } from "./loopback";
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

/**
 * Windows' ACL functions as a test arranges them: one reading per path, the
 * same through a handle; a file read through one holds `{}`.
 */
function readings(byPath: Record<string, AclReading>): WindowsAcl {
  const read = (path: string): AclReading => {
    const found = byPath[path];
    if (found === undefined) throw new Error(`no reading for ${path}`);
    return found;
  };
  return {
    userSid: () => USER,
    apply: () => undefined,
    read,
    readInFolder(folder, name) {
      if (!existsSync(folder)) return null;
      const file = name === null ? null : join(folder, name);
      return {
        folder: read(folder),
        file:
          file === null || !existsSync(file)
            ? null
            : { reading: read(file), bytes: new TextEncoder().encode("{}") },
      };
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
  expect(checkHomeInBun(home, undefined).problem).toBe(homeWriteProblem(home));
  expect(checkHomeInBun(own, undefined).problem).toBeNull();
}, 30_000);

test("checkHomeInBun gives a slow check its whole limit after a shorter gap", async () => {
  const home = temp("af-guard-clock");
  const executable = join(home, ON_WINDOWS ? "check.exe" : "check");
  const real = process.execPath;
  const build = Bun.spawn(
    [
      real,
      "build",
      "--compile",
      join(import.meta.dir, "..", "fixtures", "spawn-clock-home-check.ts"),
      "--outfile",
      executable,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stderr] = await Promise.all([
    build.exited,
    new Response(build.stderr).text(),
    new Response(build.stdout).text(),
  ]);
  expect({ exitCode, stderr }).toEqual({
    exitCode: 0,
    stderr: expect.any(String),
  });
  // The real 30 s limit must allow a 22 s check even after 12 s idle.
  // Without a reset, Windows kills the check about 18 s in.
  const run = Bun.spawn(
    [
      real,
      join(import.meta.dir, "..", "fixtures", "spawn-clock-caller.ts"),
      "home",
      executable,
      home,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [status, stdout, error] = await Promise.all([
    run.exited,
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
  ]);
  expect({ status, error }).toEqual({ status: 0, error: "" });
  let problem: unknown;
  try {
    problem = JSON.parse(stdout);
  } catch {
    throw new Error(`the home-check driver printed invalid JSON: ${stdout}`);
  }
  expect(problem).toBeNull();
  expect(readFileSync(join(home, "checked.txt"), "utf8")).toBe(
    "started\nfinished\n",
  );
}, 90_000);

// ── x1gs.3.38: what is judged is what is used ──────────────────────────────

/** `scripts/fixtures/home-check-stand-in.ts` compiled, under the name that picks how it answers. */
async function homeCheckStandIn(mode: "silent" | "stale"): Promise<string> {
  const dir = temp("af-guard-stand-in");
  const program = join(
    dir,
    ON_WINDOWS ? `stand-in-${mode}.exe` : `stand-in-${mode}`,
  );
  const build = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      join(import.meta.dir, "..", "fixtures", "home-check-stand-in.ts"),
      "--outfile",
      program,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stderr] = await Promise.all([
    build.exited,
    new Response(build.stderr).text(),
    new Response(build.stdout).text(),
  ]);
  expect({ exitCode, stderr }).toEqual({
    exitCode: 0,
    stderr: expect.any(String),
  });
  return program;
}

test("checkHomeInBun trusts only the check's own answer: a program in bun's place that exits 0 with nothing, or with an answer to another request, is a refusal", async () => {
  const own = temp("af-guard-home");
  const real = process.execPath;
  const said: Record<string, string | null> = {};
  for (const mode of ["silent", "stale"] as const) {
    const program = await homeCheckStandIn(mode);
    // What the stand-in prints, so that a refusal below is for what it said.
    const printed = Bun.spawnSync([program]).stdout.toString();
    expect({ mode, printed }).toEqual({
      mode,
      printed:
        mode === "stale"
          ? `agent-forge home-guard: trusted ${"0".repeat(32)}\nnone\n`
          : "",
    });
    process.execPath = program;
    try {
      said[mode] = checkHomeInBun(own, undefined).problem;
    } finally {
      process.execPath = real;
    }
  }
  for (const mode of ["silent", "stale"])
    expect({ mode, said: said[mode] }).toEqual({
      mode,
      said: `The hearth home ${own} could not be checked (the check under bun exited 0 without its answer), so nothing in it is trusted. Use the default home (leave AGENT_FORGE_HOME unset: ~/.agent-forge, in your user profile).`,
    });
  // The check itself still answers, and is trusted, with the text of the file it read.
  expect(checkHomeInBun(own, undefined)).toEqual({ problem: null, text: null });
  const lock = join(own, "hearth-000000000000.lock");
  writeFileSync(lock, '{"port":1}\n');
  expect(checkHomeInBun(own, lock)).toEqual({
    problem: null,
    text: '{"port":1}\n',
  });
  expect(checkHomeInBun(own, join(own, "missing.lock"))).toEqual({
    problem: null,
    text: null,
  });
}, 90_000);

test.skipIf(!ON_WINDOWS)(
  "Windows: a home that is a junction is judged by the folder it leads to: a target others may write is refused, here and under Bun in a child, and requestLaunch sends nothing to a lock in it that is owner-only itself",
  async () => {
    const base = temp("af-guard-junction");
    const target = join(base, "target");
    mkdirSync(target);
    openToOthers(target, true);
    const home = join(base, "home");
    symlinkSync(target, home, "junction");
    // The premise: the junction's own ACL, which reading its path returns, lets nobody else write.
    expect(
      windowsWriteFinding(
        nativeWindowsAcl().read(home),
        "directory",
        whoamiSid(),
      ),
    ).toBeNull();
    const root = checkout();
    const listener = await standIn(process.pid, root);
    // Planted in the target (Bun's recursive mkdir does not pass through a junction).
    plant(target, root, listener.port);
    // A lock that is owner-only itself, in a target others may write.
    makeOwnerOnly(lockPath(target, root), "file");
    expect(existsSync(lockPath(home, root))).toBe(true);

    const problem = homeWriteProblem(home);
    expect(problem).toStartWith(
      `The hearth home ${home} leads to ${realpathSync.native(target)}, which can be written by others: ${WHO_WRITES}`,
    );
    expect(problem).toContain(
      `icacls "${realpathSync.native(target)}" /inheritance:r`,
    );
    expect(checkHomeInBun(home, undefined).problem).toBe(problem);

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
    expect(operatorHeadersSent(listener)).toEqual([]);
    expect(refused).toStartWith(
      `Refusing to send the operator token: The hearth home ${home} leads to`,
    );
  },
  30_000,
);

test("requestLaunch sends the token only to the port the lock in the home names: another port, or no lock at all, is refused and sent nothing", async () => {
  const home = temp("af-guard-home");
  const root = checkout();
  const named = await standIn(process.pid, root);
  const other = await standIn(process.pid, root);

  const refusals: string[] = [];
  for (const planted of [false, true]) {
    if (planted) plant(home, root, named.port);
    try {
      await requestLaunch({
        home,
        root,
        port: other.port,
        token: FABRICATED_TOKEN,
      });
      refusals.push("sent");
    } catch (error) {
      refusals.push((error as Error).message);
    }
  }
  expect(operatorHeadersSent(other)).toEqual([]);
  expect(refusals).toEqual([
    `Refusing to send the operator token: there is no lock file of a hearth for ${resolve(root)} in ${home} (${lockPath(home, root)})`,
    `Refusing to send the operator token: the lock file ${lockPath(home, root)} names port ${named.port}, not ${other.port}`,
  ]);
  // The port it names is sent the token.
  await requestLaunch({
    home,
    root,
    port: named.port,
    token: FABRICATED_TOKEN,
  });
  expect(operatorHeadersSent(named)).toEqual([FABRICATED_TOKEN]);
});

test("the lock is judged by what was read through the handle it was read with (Windows rules, handed in): a lock its path calls owner-only, read through a handle that says others may write it, is refused", () => {
  const home = temp("af-guard-fake");
  const lock = join(home, "hearth-000000000000.lock");
  writeFileSync(lock, "{}");
  const acl: WindowsAcl = {
    ...readings({
      [home]: reading(OWNER_ONLY),
      // A second look at the path, as a swapped-back folder would show it.
      [lock]: reading(OWNER_ONLY),
    }),
    readInFolder: (folder, name) => ({
      folder: reading(OWNER_ONLY),
      file:
        name === null
          ? null
          : {
              reading: reading([
                ...OWNER_ONLY,
                entry("S-1-5-21-9-9-9-1002", MODIFY, { flags: 0x10 }),
              ]),
              bytes: new TextEncoder().encode(`{"read":"${folder}"}`),
            },
    }),
  };
  expect(homeWriteProblem(home, lock, { platform: "win32", acl })).toBe(
    `The lock file ${lock} in the hearth home can be written by others: S-1-5-21-9-9-9-1002 may FILE_WRITE_DATA, FILE_APPEND_DATA, DELETE (inherited). Anyone who can write it can point a client at a port of their own and be sent the operator token. Delete it (a hearth writes it again when it starts): del "${lock}".`,
  );
});

test("a folder above the home swapped while dashboard:open reads the lock and back before the token is sent: the lock it read is the one judged, and its port is sent nothing", async () => {
  const base = temp("af-guard-swap");
  const home = join(base, "home");
  const saved = join(base, "saved");
  const theirs = join(base, "theirs");
  const root = checkout();
  // The real home: this user's own, with the token and a lock naming the hearth.
  mkdirSync(home);
  const hearthPort = 1;
  plant(home, root, hearthPort);
  // Theirs: a lock naming their port, in a file others may write (as one they made would be).
  mkdirSync(theirs);
  const theirPort = 2;
  plant(theirs, root, theirPort);
  openToOthers(lockPath(theirs, root), false);

  const sent: Array<{ port: number; target: string; token?: string }> = [];
  let swappedBack = false;
  const exchange: Exchange = async (request) => {
    const token = request.headers[OPERATOR_HEADER];
    sent.push({
      port: request.port,
      target: request.target,
      ...(token === undefined ? {} : { token }),
    });
    if (request.target === HEALTH_ROUTE) {
      // Theirs answers its health check, and the real home is put back.
      if (!swappedBack) {
        renameSync(home, theirs);
        renameSync(saved, home);
        swappedBack = true;
      }
      return {
        status: 200,
        body: JSON.stringify({
          ok: true,
          data: { pid: process.pid, root },
          error: null,
        }),
      };
    }
    return {
      status: 200,
      body: JSON.stringify({
        ok: true,
        data: {
          secret: "1".repeat(64),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        error: null,
      }),
    };
  };

  renameSync(home, saved);
  renameSync(theirs, home);
  let opened = "";
  try {
    opened = await freshLaunchLink({
      home,
      root,
      url: "http://127.0.0.1:4321/",
      exchange,
    });
  } catch (error) {
    expect(error).toBeInstanceOf(NoLaunchLink);
    opened = (error as Error).message;
  }
  expect(sent.filter((request) => request.token !== undefined)).toEqual([]);
  expect(opened).toStartWith(
    `The lock file ${lockPath(home, root)} in the hearth home can be written by others`,
  );
});

test("the supervisor writes back only the lock it checked: a folder above the home swapped in while it asks the hearth's health is never given a lock of this user's naming their port", async () => {
  const base = temp("af-guard-swap");
  const home = join(base, "home");
  const saved = join(base, "saved");
  const theirs = join(base, "theirs");
  const root = checkout();
  mkdirSync(home);
  mkdirSync(theirs);
  // The hearth: answers its health as the lock names it, and while it is
  // asked, their folder is put in the home's place.
  let swapped = false;
  const server = createServer((req, res) => {
    req.resume();
    if (req.url === HEALTH_ROUTE && !swapped) {
      renameSync(home, saved);
      renameSync(theirs, home);
      swapped = true;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        ok: true,
        data: { pid: process.pid, root },
        error: null,
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const hearthPort = (server.address() as AddressInfo).port;
  plant(home, root, hearthPort);
  const theirPort = hearthPort === 2 ? 3 : 2;
  plant(theirs, root, theirPort);

  const port = await createSupervisor({ root, home, id: "swap-test" }).ensure();
  expect(swapped).toBe(true);
  expect(port).toBe(hearthPort);
  // Every lock this supervisor wrote (marked with its id), wherever its path led.
  const written = [lockPath(home, root), lockPath(saved, root)]
    .map((file) => readLock(file))
    .filter((lock) => lock?.supervisor === "swap-test")
    .map((lock) => lock?.port);
  expect(written.filter((written) => written !== hearthPort)).toEqual([]);
});

test("the hearth's sessions are read with the check: a sessions file in a folder swapped in above the home is no session, and a new session is not stored over it", () => {
  const base = temp("af-guard-swap");
  const home = join(base, "home");
  const saved = join(base, "saved");
  const theirs = join(base, "theirs");
  mkdirSync(home);
  mkdirSync(join(theirs, "tokens"), { recursive: true });
  // Theirs: a session whose cookie and key they made, in a file others may write.
  const value = "a".repeat(64);
  const key = "b".repeat(64);
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const planted = sessionsPath(theirs, "/r");
  writeFileSync(
    planted,
    JSON.stringify({
      version: 2,
      sessions: [
        {
          hash: sha(value),
          keyHash: sha(key),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    }),
  );
  openToOthers(planted, false);
  // The store's clock is read just before each read of the file: their folder goes in then.
  const now = (): number => {
    if (existsSync(theirs)) {
      renameSync(home, saved);
      renameSync(theirs, home);
    }
    return Date.now();
  };
  const store = createSessionStore(sessionsPath(home, "/r"), { now });
  const valid = store.valid([value], [key]);
  let created = "";
  try {
    store.create();
    created = "a session was stored";
  } catch (error) {
    created = (error as Error).message;
  }
  const refusal = `The file ${sessionsPath(home, "/r")} in the hearth home can be written by others`;
  expect({
    valid,
    created: created.startsWith(refusal) ? refusal : created,
  }).toEqual({ valid: false, created: refusal });
});

// ── A home the hearth creates ──────────────────────────────────────────────

// The independent DACL oracle may start PowerShell for a domain SDDL alias.
// Its bounded 30s child must finish before this test's deadline.
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
}, 45_000);

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
