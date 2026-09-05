import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { sanitizeContent } from "./context";
import { createCouncilService } from "./service";

export const COUNCIL_API = "/__agent-forge/council-api";
type Service = ReturnType<typeof createCouncilService>;

function send(
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

export function isLocalCouncilRequest(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress;
  if (
    remote !== "127.0.0.1" &&
    remote !== "::1" &&
    remote !== "::ffff:127.0.0.1"
  )
    return false;
  try {
    const host = new URL(`http://${req.headers.host ?? ""}`);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host.hostname))
      return false;
    if (req.headers.origin && req.headers.origin !== host.origin) return false;
    return req.headers["sec-fetch-site"] !== "cross-site";
  } catch {
    return false;
  }
}

async function bodyJson(req: IncomingMessage): Promise<unknown> {
  if (!req.headers["content-type"]?.startsWith("application/json")) {
    throw new Error("Use application/json for council requests");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 2_100_000) throw new Error("Council request exceeds 2 MB");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("Council request must contain valid JSON");
  }
}

export function councilHttpHandler(service: Service) {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith(`${COUNCIL_API}/`)) return next();
    if (!isLocalCouncilRequest(req))
      return send(
        res,
        403,
        null,
        "Council execution is available only from this local dashboard",
      );
    try {
      const route = url.pathname.slice(COUNCIL_API.length);
      if (req.method === "GET" && route === "/profiles")
        return send(res, 200, await service.profiles());
      if (req.method === "GET" && route === "/runs")
        return send(res, 200, await service.list());
      if (req.method === "POST" && route === "/runs") {
        const input = await bodyJson(req);
        return send(
          res,
          202,
          service.start(input as Parameters<Service["start"]>[0]),
        );
      }
      const match = /^\/runs\/([^/]+)(?:\/(cancel|events))?$/.exec(route);
      if (!match) return send(res, 404, null, "Council endpoint not found");
      const runId = decodeURIComponent(match[1]!);
      if (req.method === "POST" && match[2] === "cancel") {
        await bodyJson(req);
        return send(res, 200, await service.cancel(runId));
      }
      if (req.method !== "GET")
        return send(res, 405, null, "Method not allowed");
      const job = await service.get(runId);
      if (match[2] !== "events") return send(res, 200, job);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const snapshot = (value: typeof job): void => {
        if (res.destroyed || res.writableEnded) return;
        res.write(`event: snapshot\ndata: ${JSON.stringify(value)}\n\n`);
        if (value.status !== "running") res.end();
      };
      let unsubscribe = () => {};
      const heartbeat = setInterval(() => {
        if (!res.destroyed && !res.writableEnded) res.write(": keepalive\n\n");
      }, 15_000);
      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      res.once("close", cleanup);
      unsubscribe = service.subscribe(runId, snapshot);
      if (res.writableEnded || res.destroyed) cleanup();
    } catch (error) {
      if (!res.headersSent) {
        const message = sanitizeContent(
          error instanceof Error ? error.message : String(error),
          "redact",
        ).text;
        send(res, 400, null, message);
      } else res.end();
    }
  };
}

export function councilDashboardPlugin(root: string): Plugin {
  return {
    name: "agent-forge-council",
    configureServer(server) {
      const service = createCouncilService({
        workspaceRoot: root,
        harnessRoot: root,
      });
      const handler = councilHttpHandler(service);
      server.middlewares.use((req, res, next) => {
        void handler(req, res, next);
      });
      server.httpServer?.once("close", () => {
        void service.close();
      });
    },
  };
}
