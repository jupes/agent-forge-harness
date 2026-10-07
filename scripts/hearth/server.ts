/**
 * Hearth — the standalone loopback control-plane server (`bun run hearth`).
 *
 * Hosts the handlers that used to live in Vite middleware (forge-run,
 * repos-knowledge, council) behind one front-door check, publishes a per-root
 * lock so a dashboard can find it, and mints a per-boot operator token. The
 * token is created and served here; enforcing it on mutating routes belongs to
 * the operator API that builds on this server.
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { createCouncilService } from "../council/service";
import { loadDashboardServerEnvironment } from "../dashboard/server-environment";
import { frontDoorOrigin, isDeclaredSameOrigin } from "./gate";
import { hearthHome, lockPath, tokenPath } from "./home";
import {
  acquireLock,
  type HearthLock,
  isPidAlive,
  readLock,
  releaseLock,
} from "./lock";
import { councilHttpHandler } from "./routes/council";
import { devApiHttpHandler } from "./routes/dev-api";
import { createToken } from "./token";

export const API_PREFIX = "/__agent-forge";
export const TOKEN_ROUTE = `${API_PREFIX}/token`;
export const HEALTH_ROUTE = `${API_PREFIX}/health`;

export interface HearthOptions {
  root: string;
  /** Hearth state directory; defaults to `AGENT_FORGE_HOME` / `~/.agent-forge`. */
  home?: string;
  /** 0 (default) lets the OS pick a free port. */
  port?: number;
  /** Environment handed to the council service; defaults to the dashboard's. */
  environment?: Record<string, string | undefined>;
}

export interface StartedHearth {
  kind: "started";
  port: number;
  url: string;
  token: string;
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
    harnessRoot: root,
    environment:
      options.environment ??
      loadDashboardServerEnvironment({ mode: "development", root }),
  });
  const council = councilHttpHandler(service);
  const tokenFile = tokenPath(home, root);
  let token = "";

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
      return reply(res, 200, { token });
    }
    if (pathname === HEALTH_ROUTE) {
      return reply(res, 200, { pid: process.pid, root });
    }
    const notFound = (): void =>
      reply(res, 404, null, "Unknown control-plane route");
    void devApiHttpHandler(root, req, res, () => {
      void council(req, res, notFound);
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
    close: async () => {
      releaseLock(lockFile, process.pid);
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
  const hearth = await createHearth({
    root,
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
