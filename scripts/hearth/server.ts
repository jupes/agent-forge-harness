/**
 * Hearth — the standalone loopback control-plane server (`bun run hearth`).
 *
 * Hosts the handlers that used to live in Vite middleware (forge-run,
 * repos-knowledge, council) behind one front-door check, publishes a per-root
 * lock so a dashboard can find it, and mints a per-boot operator token.
 *
 * The operator API (`api.ts`, `routes/operator.ts`) is mounted ahead of those
 * handlers. Every mutation goes through it: a POST needs the token, and the
 * token is honoured only while the file the lock names still holds what this
 * hearth minted.
 *
 * A page gets the token from the token route only with a dashboard session,
 * which it gets once by exchanging a launch secret minted with the token
 * (`launch.ts`): the launch, session and token routes are served here, before
 * the table.
 */

import { rmSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import type { LedgerEventInput } from "../../types/hearth";
import type {
  CouncilAppend,
  CouncilAttachResolver,
} from "../council/ledger-events";
import { type CommandRunner, runLocalCommand } from "../council/pr-source";
import { createCouncilService } from "../council/service";
import { loadDashboardServerEnvironment } from "../dashboard/server-environment";
import { ownInterrupts } from "../executors/supervisor";
import { isMain } from "../is-main";
import { type AppendResult, appendEvent } from "../ledger/append";
import { resolveCheckout } from "../ledger/workspace";
import { SHIFTS_DIR } from "../scheduler/shift-store";
import type { GitRun } from "../scheduler/worktrees";
import { type ApiRoute, createOperatorApi } from "./api";
import {
  frontDoorOrigin,
  hasAmbiguousPath,
  isDeclaredSameOrigin,
} from "./gate";
import { hearthHome, lockPath, sessionsPath, tokenPath } from "./home";
import { ensurePrivateHome } from "./home-guard";
import {
  createLaunchSecrets,
  createSessionStore,
  launchRoutes,
  sessionCookieName,
} from "./launch";
import {
  type AcquireResult,
  acquireLock,
  type HearthLock,
  readLock,
  releaseLock,
} from "./lock";
import {
  API_PREFIX,
  HEALTH_ROUTE,
  LAUNCH_ROUTE,
  NO_SESSION_ERROR,
  SESSION_ROUTE,
  TOKEN_ROUTE,
} from "./paths";
import { councilHttpHandler } from "./routes/council";
import {
  type BdRunner,
  bdRunner,
  devApiHttpHandler,
  localStateRoot,
} from "./routes/dev-api";
import { operatorRoutes } from "./routes/operator";
import { hearthLedger } from "./routes/operator-reads";
import { QUEUE_LOCK_FILE } from "./routes/queue";
import {
  createShiftStarts,
  endLiveShifts,
  type ShiftLauncher,
  superviseShift,
} from "./shift-launcher";
import { isHealthy } from "./supervisor";
import { createToken, readToken } from "./token";

export interface HearthOptions {
  root: string;
  /** Hearth state directory; defaults to `AGENT_FORGE_HOME` / `~/.agent-forge`. */
  home?: string;
  /** Where `councils/` lives; defaults to `root` (the harness checkout). */
  harnessRoot?: string;
  /** 0 (default) lets the OS pick a free port. */
  port?: number;
  /** Environment handed to the council service; defaults to the dashboard's. */
  environment?: Record<string, string | undefined>;
  /**
   * The ledger that council runs started through this hearth are recorded in,
   * and how each is attributed. Absent by default, and then they record
   * nothing: `main()` supplies it, tests leave it out.
   */
  councilLedger?: {
    appendEvent: CouncilAppend;
    resolveAttach: CouncilAttachResolver;
  };
  /**
   * Runs `bd`, `git` and `gh` for the council's bead and pr sources; the real
   * one by default. A test hands in a fake (`testing.ts` does, one that refuses
   * what the test did not arrange), because the `runBd` of `api` is the
   * operator API's runner and does not reach the council. Either way `bd` runs
   * where the hearth's own `bd` runs (`hearthCouncilRunner`).
   */
  councilRunCommand?: CommandRunner;
  /** What the operator API reads and writes, when not the defaults. Tests inject these. */
  api?: OperatorApiOverrides;
  /**
   * Awaited once the server listens and before the lock is taken and the
   * token file written, with the port. A test holds the start there to ask
   * the hearth while it is still starting; a throw fails the start.
   */
  onListening?: (port: number) => void | Promise<void>;
  /**
   * The clock launch secrets and dashboard sessions are timed by
   * (`launch.ts`), in milliseconds; the system's by default. A test hands in
   * its own to see one expire.
   */
  launchNow?: () => number;
}

/**
 * The council's command runner as this hearth runs it: `bd` in the checkout
 * that holds the tracker (`localStateRoot`, the directory the hearth's own `bd`
 * runner uses — from a linked worktree, `bd` may find no tracker), and `git`
 * and `gh` where the council asked, the hearth's root.
 */
export function hearthCouncilRunner(
  root: string,
  run: CommandRunner = runLocalCommand,
): CommandRunner {
  const tracker = localStateRoot(root);
  return (command, cwd) => run(command, command[0] === "bd" ? tracker : cwd);
}

export interface OperatorApiOverrides {
  /** The ledger file; defaults to `ledger.db` in the hearth's home. */
  ledgerPath?: string;
  /** Runs `bd` with an argument array; defaults to the real one, in the main checkout. */
  runBd?: BdRunner;
  /** How long a queue read may take before it is reported as failed. */
  bdTimeoutMs?: number;
  /** The OS home the machine config file is read from. */
  configHome?: string;
  /** How often an open stream looks for new ledger events. */
  streamPollMs?: number;
  streamKeepaliveMs?: number;
  /** The append of audit rows and of the outcome a row records; defaults to the ledger's. */
  appendEvent?: (event: LedgerEventInput) => AppendResult;
  /** Runs git for the worktree registry (`GET /worktrees`, the Repos page); defaults to the real one. */
  git?: GitRun;
  /** Wrap the table before it is mounted (a test observing an effect). */
  decorate?: (routes: readonly ApiRoute[]) => readonly ApiRoute[];
  /** Starts a shift's child (`POST /shifts`); `superviseShift` by default. A test hands in a stand-in. */
  launchShift?: ShiftLauncher;
  /** Mints the id of a shift `POST /shifts` starts; one at the current second by default. */
  mintShiftId?: () => string;
  /** How long `close()` waits for the shifts it started to stop; `SHIFT_STOP_GRACE_MS` by default. */
  shiftStopGraceMs?: number;
  /** The clock a start's `startedAt` (and a minted id) is read from; the system's by default. */
  shiftNow?: () => Date;
  /** How long an action's body may take to arrive; 10 s when not given. */
  bodyTimeoutMs?: number;
}

export interface StartedHearth {
  kind: "started";
  port: number;
  url: string;
  token: string;
  /** The operator API's mounted table. */
  routes: readonly ApiRoute[];
  close(): Promise<void>;
}

export interface ReusedHearth {
  kind: "reused";
  port: number;
  url: string;
  lock: HearthLock;
}

export type Hearth = StartedHearth | ReusedHearth;

function reply(
  res: ServerResponse,
  status: number,
  data: unknown,
  error: string | null = null,
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(
    JSON.stringify({ ok: error === null, data: error ? null : data, error }),
  );
}

/**
 * The ledger's `appendEvent` for `file`, opening the file with the hearth's
 * first-open wait (`LEDGER_FIRST_OPEN_WAIT_MS`, none: the runner's three audit
 * attempts, 25 ms apart, are the wait). A file that could not be opened in
 * time is reported as the ledger's error ("database is locked"), which the
 * runner treats as busy.
 */
function hearthAppend(file: string): (event: LedgerEventInput) => AppendResult {
  return (event) => {
    let ledger: { path: string };
    try {
      ledger = hearthLedger(file);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    return appendEvent(event, ledger);
  };
}

function reusedHearth(lock: HearthLock): ReusedHearth {
  return {
    kind: "reused",
    port: lock.port,
    url: `http://127.0.0.1:${lock.port}`,
    lock,
  };
}

export async function createHearth(options: HearthOptions): Promise<Hearth> {
  const root = resolve(options.root);
  const home = options.home ?? hearthHome();
  const lockFile = lockPath(home, root);

  // Before anything is read from the home or written to it: a home, or a
  // lock file, that others can write lets them point clients, and the
  // operator token, at a port of their own (`home-guard.ts`). A home that
  // does not exist yet is created owner-only.
  try {
    ensurePrivateHome(home, lockFile);
  } catch (error) {
    throw new Error(
      `The hearth will not start: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  // Reused only once its port has answered the health route with its pid and
  // root. Any other lock is stale, also when its pid is alive: a killed
  // hearth's pid can belong to another process by now.
  const existing = readLock(lockFile);
  if (existing && (await isHealthy(existing))) return reusedHearth(existing);
  if (existing) releaseLock(lockFile, existing.pid);

  const service = createCouncilService({
    workspaceRoot: root,
    harnessRoot: options.harnessRoot ?? root,
    environment:
      options.environment ??
      loadDashboardServerEnvironment({ mode: "development", root }),
    ...(options.councilLedger
      ? {
          appendEvent: options.councilLedger.appendEvent,
          resolveAttach: options.councilLedger.resolveAttach,
        }
      : {}),
    runCommand: hearthCouncilRunner(root, options.councilRunCommand),
  });
  const tokenFile = tokenPath(home, root);
  let token = "";
  /**
   * The token a mutation, or a read of a stored council run, must present: the
   * one minted at this start, and only while the published file still holds
   * it. Before it is minted, or once the file is gone or says something else,
   * nothing is honoured.
   */
  const expectedToken = (): string | null =>
    token !== "" && readToken(tokenFile) === token ? token : null;
  const council = councilHttpHandler(service, { expectedToken });

  const ledgerFile = options.api?.ledgerPath ?? join(home, "ledger.db");
  const workspace = resolveCheckout(root).workspace;
  // One appender for the runner's audit rows and for the outcome a row records.
  const append = options.api?.appendEvent ?? hearthAppend(ledgerFile);
  // The dashboard's session (`launch.ts`): launch secrets live in this
  // process only; sessions in a file beside the token file, so a page keeps
  // its session when the dashboard starts this hearth again.
  const clock = options.launchNow ? { now: options.launchNow } : {};
  const launch = launchRoutes({
    launches: createLaunchSecrets(clock),
    sessions: createSessionStore(sessionsPath(home, root), clock),
    cookieName: sessionCookieName(home, root),
    expectedToken,
    appendEvent: append,
    workspace,
  });
  // Under the same home: a shift given it keeps its record and stop request there.
  const shiftsDir = join(home, SHIFTS_DIR);
  // A shift this hearth starts runs in its root with its home, so it takes
  // the same queue lock and writes the same ledger and shifts directory.
  const shiftStarts = createShiftStarts({
    root,
    home,
    shiftsDir,
    workspace,
    environment: process.env,
    launch: options.api?.launchShift ?? superviseShift,
    mintShiftId: options.api?.mintShiftId,
    stopGraceMs: options.api?.shiftStopGraceMs,
    now: options.api?.shiftNow,
  });
  const table = operatorRoutes({
    root,
    workspace,
    ledgerPath: ledgerFile,
    council: service,
    // The Beads database is machine-local: from a linked worktree, bd finds
    // none unless it runs in the main checkout.
    runBd: options.api?.runBd ?? bdRunner(localStateRoot(root)),
    appendEvent: append,
    // Under the home, with the ledger: a shift given the same home takes the same lock.
    queueLockFile: join(home, QUEUE_LOCK_FILE),
    shiftsDir,
    shiftStarts,
    bdTimeoutMs: options.api?.bdTimeoutMs,
    configHome: options.api?.configHome,
    git: options.api?.git,
    streamPollMs: options.api?.streamPollMs,
    streamKeepaliveMs: options.api?.streamKeepaliveMs,
  });
  const api = createOperatorApi(
    {
      workspace,
      expectedToken,
      appendEvent: append,
      ...(options.api?.bodyTimeoutMs !== undefined
        ? { bodyTimeoutMs: options.api.bodyTimeoutMs }
        : {}),
    },
    options.api?.decorate?.(table.routes) ?? table.routes,
  );

  const server: Server = createServer((req, res) => {
    const pathname = (req.url ?? "").split("?")[0] ?? "";
    // A launch secret presented to the exchange is spent before anything
    // else about the request is looked at, the front door included.
    const launchLive = pathname === SESSION_ROUTE ? launch.spend(req) : false;
    const origin = frontDoorOrigin(req);
    if (origin === null) {
      reply(
        res,
        403,
        null,
        "The control plane is available only from the local dashboard",
      );
      return;
    }
    if (hasAmbiguousPath(pathname)) {
      return reply(res, 400, null, "Unsupported path");
    }
    const failed = (): void => {
      if (!res.headersSent) reply(res, 500, null, "The request failed");
    };
    if (pathname === LAUNCH_ROUTE) {
      launch.mint(req, res).catch(failed);
      return;
    }
    if (pathname === SESSION_ROUTE) {
      launch.exchange(req, res, launchLive).catch(failed);
      return;
    }
    if (pathname === TOKEN_ROUTE) {
      if (req.method !== "GET")
        return reply(res, 405, null, "Method not allowed");
      if (!isDeclaredSameOrigin(req)) {
        return reply(
          res,
          403,
          null,
          "The token is served only to a same-origin request",
        );
      }
      // Only to a page that holds a session from a launch link: declaring the
      // hearth's origin is something any local program can do.
      if (!launch.hasSession(req))
        return reply(res, 401, null, NO_SESSION_ERROR);
      // Never serve a token the check would refuse.
      const current = expectedToken();
      if (current === null) {
        return reply(
          res,
          503,
          null,
          token === ""
            ? "The control plane is still starting"
            : "The operator token file no longer matches this control plane; restart it",
        );
      }
      return reply(res, 200, { token: current });
    }
    if (pathname === HEALTH_ROUTE) {
      return reply(res, 200, { pid: process.pid, root });
    }
    const notFound = (): void => {
      // A path the table serves, asked with a method nothing serves.
      const allow = api.allowedMethods(pathname);
      if (allow.length === 0) {
        reply(res, 404, null, "Unknown control-plane route");
        return;
      }
      res.setHeader("Allow", allow.join(", "));
      reply(res, 405, null, "Method not allowed");
    };
    void api.handle(req, res, () => {
      void devApiHttpHandler(
        root,
        req,
        res,
        () => {
          void council(req, res, notFound);
        },
        { git: options.api?.git },
      );
    });
  });
  // A request that says `Expect: 100-continue` is handled like any other, and
  // nothing is sent for it here: with no listener the runtime would answer
  // `100 Continue` at once, before anything had looked at the request. The
  // runner sends it when it begins to read a body it will use (`requestBody`
  // in `api.ts`), so a refusal decided on the head goes out with the body
  // never asked for. Nothing else here reads a body.
  server.on("checkContinue", (req, res) => {
    server.emit("request", req, res);
  });

  const stop = async (): Promise<void> => {
    try {
      table.close();
      await service.close();
      server.closeAllConnections();
      // Called back with an error, which changes nothing here, when it never listened.
      await new Promise<void>((done) => server.close(() => done()));
    } finally {
      // Last, with nothing answering any more: each shift this hearth started
      // is asked to stop and given time to put its beads back, then ended.
      await shiftStarts.close();
    }
  };

  let lockTaken = false;
  const begin = async (): Promise<{ port: number; claimed: AcquireResult }> => {
    await new Promise<void>((done, fail) => {
      server.once("error", fail);
      server.listen(options.port ?? 0, "127.0.0.1", done);
    });
    const port = (server.address() as AddressInfo).port;
    await options.onListening?.(port);
    const claimed = acquireLock(lockFile, {
      pid: process.pid,
      port,
      root,
      startedAt: new Date().toISOString(),
      tokenFile,
    });
    lockTaken = claimed.kind === "acquired";
    // Written only once the lock is ours, so a losing racer never overwrites the
    // winner's token file. Where it cannot be made readable by this user only
    // (`writeOwnerOnly`), nothing is written and the start fails, leaving
    // nothing behind (below): `bun run hearth` prints why and exits 1.
    if (lockTaken) token = mintToken(tokenFile, home);
    return { port, claimed };
  };
  let begun: { port: number; claimed: AcquireResult };
  try {
    begun = await begin();
  } catch (error) {
    // A start that fails leaves nothing behind: a server still listening would
    // answer the health route for a lock that names it, and its token route
    // would say "still starting" for as long as this process lived.
    if (lockTaken) releaseLock(lockFile, process.pid);
    await stop();
    throw error;
  }
  const { port, claimed } = begun;

  if (claimed.kind === "held") {
    // Lost a start-up race to another hearth for this root: defer to it, once
    // its health route has confirmed it.
    await stop();
    if (await isHealthy(claimed.lock)) return reusedHearth(claimed.lock);
    throw new Error(
      `The hearth lock ${lockFile} names pid ${claimed.lock.pid}, which does not answer as a hearth for ${claimed.lock.root}`,
    );
  }

  return {
    kind: "started",
    port,
    url: `http://127.0.0.1:${port}`,
    token,
    routes: api.routes,
    close: async () => {
      releaseLock(lockFile, process.pid);
      rmSync(tokenFile, { force: true });
      await stop();
    },
  };
}

/** `createToken`, its refusal naming the home it was refused under. */
function mintToken(tokenFile: string, home: string): string {
  try {
    return createToken(tokenFile);
  } catch (error) {
    throw new Error(
      `The hearth will not start with home ${home}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function argValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main(argv: string[]): Promise<void> {
  const root = argValue(argv, "--root") ?? process.cwd();
  const requested = process.env["HEARTH_PORT"];
  // Loaded here, not at the top: `createHearth` records council runs only when
  // it is handed a ledger for them, and a test that hands it none must get none.
  const { operatorCouncilLedger } = await import("../council/ledger-wiring");
  const hearth = await createHearth({
    root,
    councilLedger: operatorCouncilLedger(),
    ...(requested ? { port: Number(requested) } : {}),
  });
  process.stdout.write(
    `hearth ${hearth.kind === "started" ? "listening" : "already running"} on ${hearth.url}\n`,
  );
  if (hearth.kind === "reused") return;
  closeOnSignal(hearth);
}

/** The exit code of a hearth whose close was cut short by a second signal. */
export const INTERRUPTED_EXIT = 130;

/**
 * End a started hearth on `SIGINT` or `SIGTERM`: its whole `close()`, the
 * shifts it started asked to stop and waited for, then `exit(0)`. A second
 * signal while that runs does not wait: the tree of every shift still running
 * is ended at once (`endLiveShifts`) and the hearth exits
 * `INTERRUPTED_EXIT` (130, as an interrupted command does). A shift ended so
 * needs `forge:shift recover`. The hearth is the process's interrupt owner
 * (`ownInterrupts`, `scripts/executors/supervisor.ts`), so the supervisor's
 * own handler, which a child run through `supervise()` in this process would
 * install and which kills every supervised child and exits 130 at once, waits
 * for it: what `supervise()` started is ended by the exit hook once the hearth
 * exits. Returns the release of that ownership. A hearth ended with no chance
 * to run code (`SIGKILL`; on Windows, `TerminateProcess`, which is how the
 * dashboard ends it) never gets here.
 */
export function closeOnSignal(
  hearth: StartedHearth,
  exit: (code: number) => void = (code) => process.exit(code),
): () => void {
  let closing = false;
  return ownInterrupts(() => {
    if (closing) {
      endLiveShifts();
      exit(INTERRUPTED_EXIT);
      return true;
    }
    closing = true;
    void hearth.close().finally(() => exit(0));
    return true;
  });
}

if (isMain(import.meta)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
