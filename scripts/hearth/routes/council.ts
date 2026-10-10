import type { IncomingMessage, ServerResponse } from "node:http";
import { sanitizeContent } from "../../council/context";
import type { createCouncilService } from "../../council/service";
import { passesFrontDoor } from "../gate";

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
  return passesFrontDoor(req);
}

/**
 * The council routes that only read: profiles, the run list, one run, and a
 * run's event stream. Starting and cancelling a run are action rows of the
 * operator API (`./operator.ts`), at these same paths; nothing here mutates.
 */
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
      const match = /^\/runs\/([^/]+)(?:\/(cancel|events))?$/.exec(route);
      if (!match) return send(res, 404, null, "Council endpoint not found");
      const runId = decodeURIComponent(match[1]!);
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
        if (value.status !== "running" && value.status !== "cancelling")
          res.end();
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
