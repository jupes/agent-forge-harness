import { randomUUID } from "node:crypto";
import { createReadStream, realpathSync, statSync } from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { connect } from "node:net";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { frontDoorOrigin, hasAmbiguousPath } from "./gate";
import { hearthHome, tokenPath } from "./home";
import { launchUrl, requestLaunch } from "./launch";
import { loopbackProxyVariable } from "./loopback";
import { API_PREFIX } from "./paths";
import { createSupervisor, type HearthSupervisor } from "./supervisor";
import { readToken } from "./token";

export interface DesktopHostOptions {
  root: string;
  assetsRoot: string;
  home?: string;
  hearthCommand?: readonly string[];
  port?: number;
  supervisor?: HearthSupervisor;
}

export interface DesktopHost {
  url: string;
  /** Native-side lifecycle owner; never sent to the renderer. */
  owner: string;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};
const CSP =
  "default-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);
// The operator runner allows 30 seconds for normal commands; leave headroom
// before treating a proxy target as unavailable. Long SSE bodies have no timer.
const UPSTREAM_HEADER_TIMEOUT_MS = 40_000;

function reply(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Security-Policy": CSP,
  });
  res.end(message);
}

function fileFor(assetsRoot: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const segments = decoded.split("/").filter(Boolean);
  if (
    segments.some(
      (part) =>
        part === "." ||
        part === ".." ||
        part.includes("\\") ||
        part.includes(":"),
    )
  )
    return null;
  let candidate = resolve(assetsRoot, ...segments);
  try {
    if (statSync(candidate).isDirectory())
      candidate = resolve(candidate, "index.html");
    else if (segments.length === 0)
      candidate = resolve(assetsRoot, "index.html");
    const real = realpathSync(candidate);
    const rel = relative(assetsRoot, real);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      return null;
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

function isApiPath(pathname: string): boolean {
  return pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`);
}

export async function startDesktopHost(
  options: DesktopHostOptions,
): Promise<DesktopHost> {
  const root = resolve(options.root);
  const assetsRoot = realpathSync(resolve(options.assetsRoot));
  if (!statSync(assetsRoot).isDirectory())
    throw new Error("Desktop assets root is not a directory");
  const home = resolve(options.home ?? hearthHome());
  const proxyVariable = loopbackProxyVariable(process.env, "bun");
  if (proxyVariable !== null)
    throw new Error(
      `Refusing desktop host startup: ${proxyVariable} can proxy loopback. Add 127.0.0.1 to both NO_PROXY and no_proxy.`,
    );
  const owner = randomUUID();
  const supervisor =
    options.supervisor ??
    createSupervisor({
      root,
      home,
      id: owner,
      ...(options.hearthCommand ? { command: options.hearthCommand } : {}),
    });
  const sockets = new Set<import("node:net").Socket>();
  const upstreams = new Set<import("node:http").ClientRequest>();
  const upstreamResponses = new Set<IncomingMessage>();
  let closing: Promise<void> | null = null;
  let server: ReturnType<typeof createServer> | null = null;
  try {
    const port = await supervisor.ensure();
    server = createServer(
      {
        headersTimeout: 10_000,
        requestTimeout: 30_000,
        keepAliveTimeout: 5_000,
      },
      (req, res) => {
        void handle(req, res);
      },
    );
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    async function handle(
      req: IncomingMessage,
      res: ServerResponse,
    ): Promise<void> {
      const origin = frontDoorOrigin(req);
      if (origin === null) return reply(res, 403, "Forbidden");
      const target = req.url ?? "/";
      if (!target.startsWith("/")) return reply(res, 400, "Bad request");
      let url: URL;
      try {
        url = new URL(target, `${origin}/`);
      } catch {
        return reply(res, 400, "Bad request");
      }
      const pathname = target.split("?", 1)[0] ?? "/";
      if (url.origin !== origin || hasAmbiguousPath(pathname))
        return reply(res, 400, "Bad request");
      if (isApiPath(pathname)) {
        let targetPort: number;
        try {
          targetPort = await supervisor.ensure();
        } catch {
          return reply(res, 503, "Control plane unavailable");
        }
        const headers = Object.fromEntries(
          Object.entries(req.headers).filter(
            ([name]) => !HOP_HEADERS.has(name),
          ),
        );
        const upstream = httpRequest({
          host: "127.0.0.1",
          port: targetPort,
          method: req.method,
          path: req.url,
          headers,
          agent: false,
          createConnection: () =>
            connect({ host: "127.0.0.1", port: targetPort }),
        });
        upstreams.add(upstream);
        let incoming: IncomingMessage | null = null;
        const cancel = () => {
          incoming?.destroy();
          upstream.destroy();
          upstream.socket?.destroy();
        };
        const remove = () => {
          upstreams.delete(upstream);
        };
        upstream.once("close", remove);
        req.once("aborted", cancel);
        req.socket.once("close", cancel);
        res.once("close", () => {
          if (!res.writableEnded) cancel();
        });
        const headerTimeout = setTimeout(
          () => upstream.destroy(new Error("Upstream timed out")),
          UPSTREAM_HEADER_TIMEOUT_MS,
        );
        headerTimeout.unref();
        upstream.once("close", () => clearTimeout(headerTimeout));
        upstream.once("response", (response) => {
          clearTimeout(headerTimeout);
          incoming = response;
          upstreamResponses.add(response);
          response.once("close", () => upstreamResponses.delete(response));
          res.writeHead(
            response.statusCode ?? 502,
            response.statusMessage,
            response.headers,
          );
          response.once("aborted", () =>
            res.destroy(new Error("Upstream response was truncated")),
          );
          response.pipe(res);
        });
        upstream.once("error", () => {
          if (!res.headersSent) reply(res, 502, "Control plane unavailable");
          else res.destroy();
        });
        req.pipe(upstream);
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.setHeader("Allow", "GET, HEAD");
        return reply(res, 405, "Method not allowed");
      }
      const file = fileFor(assetsRoot, pathname);
      if (file === null) return reply(res, 404, "Not found");
      res.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Security-Policy": CSP,
        "Content-Type":
          MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      createReadStream(file)
        .on("error", () => {
          if (!res.headersSent) reply(res, 404, "Not found");
          else res.destroy();
        })
        .pipe(res);
    }
    await new Promise<void>((resolveListen, reject) => {
      server!.once("error", reject);
      server!.listen(options.port ?? 0, "127.0.0.1", () => {
        server!.removeListener("error", reject);
        resolveListen();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Desktop host did not bind a TCP port");
    const token = readToken(tokenPath(home, root));
    if (!token)
      throw new Error("The control plane operator token is unavailable");
    const minted = await requestLaunch({
      home,
      root,
      port,
      token,
      surface: "ui",
    });
    return {
      url: launchUrl(`http://127.0.0.1:${address.port}/`, minted.secret),
      owner,
      close() {
        closing ??= (async () => {
          for (const response of upstreamResponses) response.destroy();
          for (const upstream of upstreams) upstream.destroy();
          for (const socket of sockets) socket.destroy();
          if (server?.listening)
            await new Promise<void>((done) => server!.close(() => done()));
          await supervisor.stopIfOwner();
        })();
        return closing;
      },
    };
  } catch (error) {
    for (const response of upstreamResponses) response.destroy();
    for (const upstream of upstreams) upstream.destroy();
    for (const socket of sockets) socket.destroy();
    if (server?.listening)
      await new Promise<void>((done) => server!.close(() => done()));
    await supervisor.stopIfOwner();
    throw error;
  }
}
