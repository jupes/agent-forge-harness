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
import { createCouncilService } from "../council/service";
import { loadDashboardServerEnvironment } from "../dashboard/server-environment";
import { type AppendResult, appendEvent } from "../ledger/append";
import { resolveCheckout } from "../ledger/workspace";
import { type ApiRoute, createOperatorApi } from "./api";
import {
  frontDoorOrigin,
  hasAmbiguousPath,
  isDeclaredSameOrigin,
} from "./gate";
import { hearthHome, lockPath, tokenPath } from "./home";
import {
  acquireLock,
  type HearthLock,
  isPidAlive,
  readLock,
  releaseLock,
} from "./lock";
import { API_PREFIX, HEALTH_ROUTE, TOKEN_ROUTE } from "./paths";
import { councilHttpHandler } from "./routes/council";
import {
  type BdRunner,
  bdRunner,
  devApiHttpHandler,
  localStateRoot,
} from "./routes/dev-api";
import { operatorRoutes } from "./routes/operator";
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
  /** What the operator API reads and writes, when not the defaults. Tests inject these. */
  api?: OperatorApiOverrides;
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
  /** The audit append; defaults to the ledger's. */
  appendEvent?: (event: LedgerEventInput) => AppendResult;
  /** Wrap the table before it is mounted (a test observing an effect). */
  decorate?: (routes: readonly ApiRoute[]) => readonly ApiRoute[];
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

function liveLock(path: string, root: string): HearthLock | null {
  const lock = readLock(path);
  if (!lock || !isPidAlive(lock.pid)) return null;
  return resolve(lock.root) === resolve(root) ? lock : null;
}

export async function createHearth(options: HearthOptions): Promise<Hearth> {
  const root = resolve(options.root);
  const home = options.home ?? hearthHome();
  const lockFile = lockPath(home, root);

  const existing = liveLock(lockFile, root);
  if (existing) {
    return {
      kind: "reused",
      port: existing.port,
      url: `http://127.0.0.1:${existing.port}`,
      lock: existing,
    };
  }

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
  });
  const council = councilHttpHandler(service);
  const tokenFile = tokenPath(home, root);
  let token = "";
  /**
   * The token a mutation must present: the one minted at this start, and only
   * while the published file still holds it. Before it is minted, or once the
   * file is gone or says something else, nothing is honoured.
   */
  const expectedToken = (): string | null =>
    token !== "" && readToken(tokenFile) === token ? token : null;

  const ledgerFile = options.api?.ledgerPath ?? join(home, "ledger.db");
  const workspace = resolveCheckout(root).workspace;
  const table = operatorRoutes({
    root,
    workspace,
    ledgerPath: ledgerFile,
    council: service,
    // The Beads database is machine-local: from a linked worktree, bd finds
    // none unless it runs in the main checkout.
    runBd: options.api?.runBd ?? bdRunner(localStateRoot(root)),
    bdTimeoutMs: options.api?.bdTimeoutMs,
    configHome: options.api?.configHome,
    streamPollMs: options.api?.streamPollMs,
    streamKeepaliveMs: options.api?.streamKeepaliveMs,
  });
  const api = createOperatorApi(
    {
      workspace,
      expectedToken,
      appendEvent:
        options.api?.appendEvent ??
        ((event) => appendEvent(event, { path: ledgerFile })),
    },
    options.api?.decorate?.(table.routes) ?? table.routes,
  );

  const server: Server = createServer((req, res) => {
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
    const pathname = (req.url ?? "").split("?")[0] ?? "";
    if (hasAmbiguousPath(pathname)) {
      return reply(res, 400, null, "Unsupported path");
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
      void devApiHttpHandler(root, req, res, () => {
        void council(req, res, notFound);
      });
    });
  });

  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(options.port ?? 0, "127.0.0.1", done);
  });
  const port = (server.address() as AddressInfo).port;

  const lock: HearthLock = {
    pid: process.pid,
    port,
    root,
    startedAt: new Date().toISOString(),
    tokenFile,
  };
  const claimed = acquireLock(lockFile, lock);

  const stop = async (): Promise<void> => {
    table.close();
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  };

  if (claimed.kind === "held") {
    // Lost a start-up race to another hearth for this root: defer to it.
    await stop();
    return {
      kind: "reused",
      port: claimed.lock.port,
      url: `http://127.0.0.1:${claimed.lock.port}`,
      lock: claimed.lock,
    };
  }

  // Written only once the lock is ours, so a losing racer never overwrites the
  // winner's token file.
  token = createToken(tokenFile);

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
  const shutdown = (): void => {
    void hearth.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
