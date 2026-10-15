/**
 * Vite integration: proxy `/__agent-forge/*` to the hearth.
 *
 * Routes registered in this plugin run before Vite's own proxy middleware, so
 * the guard below sees every API request first. The hearth cannot tell a proxied
 * request from a local one (its peer is always the dev server), so the loopback
 * check has to happen here, on the real client address.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpProxy, Plugin } from "vite";
import { followTrackerWrites } from "./follow-tracker-writes";
import { isLoopbackAddress } from "./gate";
import { hearthHome } from "./home";
import { API_PREFIX } from "./paths";
import { createSupervisor, type HearthSupervisor } from "./supervisor";

/**
 * Served by `rebuildPagesPlugin` (`scripts/dashboard/rebuild-pages.ts`), which
 * refuses a non-loopback client itself; never proxied.
 */
const LOCAL_ONLY_PATH = `${API_PREFIX}/rebuild-pages`;

export interface HearthPluginOptions {
  home?: string;
  /** Replace process supervision (tests attach to an in-process hearth). */
  supervisor?: HearthSupervisor;
  /**
   * Called after the hearth has written to the tracker, found by polling the
   * hearth's ledger for `bead.transitioned` (`follow-tracker-writes.ts`). A
   * write made with `bd` outside the hearth is not seen. Not polled when absent.
   */
  onTrackerWrite?: () => void;
  /** How long the tracker-write follower waits between polls. */
  trackerWritePollMs?: number;
}

function refuse(
  res: ServerResponse,
  error = "The control-plane APIs are available only from this machine",
): void {
  res.statusCode = 403;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ ok: false, data: null, error }));
}

/**
 * Whether Vite's proxy would forward this path to the hearth. Matches the proxy's
 * own rule (a bare prefix, no trailing slash), so `/__agent-forgeX/../…` cannot
 * slip past a stricter-looking guard.
 * `rebuild-pages` is excluded because `rebuildPagesPlugin` (registered first)
 * answers it before the proxy is reached.
 */
export function isProxiedPath(pathname: string): boolean {
  return pathname.startsWith(API_PREFIX) && pathname !== LOCAL_ONLY_PATH;
}

/** The headers the hearth's front door decides on; each may be sent at most once. */
const FRONT_DOOR_HEADERS = new Set(["host", "origin", "sec-fetch-site"]);

/**
 * Whether the client sent `Host`, `Origin` or `Sec-Fetch-Site` more than once.
 * Counted in `rawHeaders`, names in lower case: Node keeps the sender's letter
 * case there. The proxy forwards `req.headers`, where a repeat is already
 * merged (Node joins a repeated `Origin` or `Sec-Fetch-Site` and keeps the
 * first `Host`; Bun keeps the last of each), so the hearth cannot see it.
 */
function repeatsFrontDoorHeader(req: IncomingMessage): boolean {
  const seen = new Set<string>();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = (req.rawHeaders[i] ?? "").toLowerCase();
    if (!FRONT_DOOR_HEADERS.has(name)) continue;
    if (seen.has(name)) return true;
    seen.add(name);
  }
  return false;
}

/**
 * Fail closed for non-loopback clients: Vite may be bound beyond loopback
 * (`DASHBOARD_HOST`), and a proxied request would otherwise look local to the
 * hearth. Refuse a loopback client that sends `Host`, `Origin` or
 * `Sec-Fetch-Site` more than once: behind the proxy the hearth receives one
 * value and cannot count the repeat itself.
 */
export function guardRequest(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const pathname = (req.url ?? "").split("?")[0] ?? "";
  if (!isProxiedPath(pathname)) return true;
  if (isLoopbackAddress(req.socket.remoteAddress)) {
    if (!repeatsFrontDoorHeader(req)) return true;
    refuse(
      res,
      "The control-plane APIs refuse a request that sends Host, Origin or Sec-Fetch-Site more than once",
    );
    return false;
  }
  refuse(res);
  return false;
}

/**
 * Close the client's response when the hearth's answer is cut off. The proxy
 * pipes the hearth's answer through and ends the client's response only when
 * the answer ends cleanly; when the hearth's socket closes mid-answer (its
 * process was killed), the client's response stayed open with nothing more to
 * come, and a page's event stream went deaf until its own silence limit. The
 * response is destroyed, not ended, so a cut-off answer never reads as a
 * complete one; the page's stream client then retries and resumes.
 *
 * A cut-off answer is one that closed without ending (`readableEnded`). Not
 * `complete`: under Bun that is already true when a cut-off answer closes.
 */
function closeWithUpstream(proxy: HttpProxy.Server): void {
  proxy.on("proxyRes", (proxyRes, _req, res) => {
    proxyRes.once("close", () => {
      if (!proxyRes.readableEnded && !res.writableEnded) res.destroy();
    });
  });
}

/**
 * Drop the request to the hearth when the client leaves before the hearth's
 * answer has ended. The proxy aborts its own request only on the client
 * request's `aborted` event, which Node emits only for a request whose body
 * had not ended: a GET the page gave up before the hearth answered (a hearth
 * that hangs) left the proxy's connection to the hearth open, one per request.
 * Under Node a client that leaves closes the response; under Bun it closes the
 * request's socket and not the response. Both are listened to. An answer that
 * ended cleanly is left alone, and the listeners are taken off then.
 */
function dropWithClient(proxy: HttpProxy.Server): void {
  proxy.on("proxyReq", (proxyReq, req, res) => {
    const socket = req.socket;
    const forget = (): void => {
      res.off("close", leave);
      socket.off("close", leave);
    };
    let answered = false;
    function leave(): void {
      forget();
      if (!answered) proxyReq.destroy();
    }
    proxyReq.once("response", (proxyRes) => {
      proxyRes.once("end", () => {
        answered = true;
        forget();
      });
    });
    // The proxy reports its request once it has a socket: the client may be
    // gone already.
    if (res.destroyed || socket.destroyed) {
      leave();
      return;
    }
    res.once("close", leave);
    socket.once("close", leave);
  });
}

export function hearthPlugin(
  root: string,
  options: HearthPluginOptions = {},
): Plugin {
  return {
    name: "agent-forge-hearth",
    async configureServer(server) {
      const supervisor =
        options.supervisor ??
        createSupervisor({
          root,
          home: options.home ?? hearthHome(),
          id: randomUUID(),
        });
      const port = await supervisor.ensure();

      // Set before Vite builds its proxy middleware, which runs after every
      // `configureServer` hook has finished.
      server.config.server.proxy = {
        ...server.config.server.proxy,
        [API_PREFIX]: {
          target: `http://127.0.0.1:${port}`,
          changeOrigin: false,
          configure: (proxy) => {
            closeWithUpstream(proxy);
            dropWithClient(proxy);
          },
        },
      };

      server.middlewares.use((req, res, next) => {
        if (!guardRequest(req, res)) return;
        const pathname = (req.url ?? "").split("?")[0] ?? "";
        if (!isProxiedPath(pathname)) {
          next();
          return;
        }
        // The hearth may have been stopped by another dashboard on this root;
        // start it again on the same port so the proxy target stays valid.
        supervisor.ensure().then(
          () => next(),
          (error: unknown) => {
            res.statusCode = 502;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(
              JSON.stringify({
                ok: false,
                data: null,
                error: error instanceof Error ? error.message : String(error),
              }),
            );
          },
        );
      });

      const { onTrackerWrite } = options;
      // Each poll asks the supervisor, as a proxied request does, so it
      // follows a hearth that was started again.
      const follower = onTrackerWrite
        ? followTrackerWrites({
            port: () => supervisor.ensure(),
            onWrite: onTrackerWrite,
            ...(options.trackerWritePollMs !== undefined
              ? { pollMs: options.trackerWritePollMs }
              : {}),
          })
        : null;

      server.httpServer?.once("close", () => {
        follower?.stop();
        void supervisor.stopIfOwner();
      });
    },
  };
}
