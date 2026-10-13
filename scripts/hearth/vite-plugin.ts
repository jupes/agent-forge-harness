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
import { isLoopbackAddress } from "./gate";
import { hearthHome } from "./home";
import { API_PREFIX } from "./paths";
import { createSupervisor, type HearthSupervisor } from "./supervisor";

/** Served by `rebuildPagesApiPlugin` in the dashboard config; never proxied. */
const LOCAL_ONLY_PATH = `${API_PREFIX}/rebuild-pages`;

export interface HearthPluginOptions {
  home?: string;
  /** Replace process supervision (tests attach to an in-process hearth). */
  supervisor?: HearthSupervisor;
}

function refuse(res: ServerResponse): void {
  res.statusCode = 403;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(
    JSON.stringify({
      ok: false,
      data: null,
      error: "The control-plane APIs are available only from this machine",
    }),
  );
}

/**
 * Whether Vite's proxy would forward this path to the hearth. Matches the proxy's
 * own rule (a bare prefix, no trailing slash), so `/__agent-forgeX/../…` cannot
 * slip past a stricter-looking guard.
 * `rebuild-pages` is excluded because `rebuildPagesApiPlugin` (registered first)
 * answers it before the proxy is reached.
 */
export function isProxiedPath(pathname: string): boolean {
  return pathname.startsWith(API_PREFIX) && pathname !== LOCAL_ONLY_PATH;
}

/**
 * Fail closed for non-loopback clients: Vite may be bound beyond loopback
 * (`DASHBOARD_HOST`), and a proxied request would otherwise look local to the
 * hearth.
 */
export function guardRequest(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const pathname = (req.url ?? "").split("?")[0] ?? "";
  if (!isProxiedPath(pathname)) return true;
  if (isLoopbackAddress(req.socket.remoteAddress)) return true;
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
          configure: closeWithUpstream,
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

      server.httpServer?.once("close", () => {
        void supervisor.stopIfOwner();
      });
    },
  };
}
