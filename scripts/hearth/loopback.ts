/**
 * Requests this process sends to a hearth on `127.0.0.1`, over a socket of its
 * own, and the health probe that asks a port whether it is the hearth a lock
 * names.
 *
 * Shared by the MCP server (`mcp.ts`), the dashboard's supervisor and a hearth
 * started directly (`isHealthy` in `supervisor.ts`), so that none of them sends
 * a loopback request to a proxy.
 */

import { connect } from "node:net";
import type { HearthLock } from "./lock";
import { HEALTH_ROUTE } from "./paths";

// ── The loopback exchange ───────────────────────────────────────────────────

/** One request to the hearth. */
export interface LoopbackRequest {
  port: number;
  method: "GET" | "POST";
  /** The request target: a path, and a query when there is one. */
  target: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  timeoutMs: number;
  maxBytes: number;
  /** How long a body over 64 kB is held back after the head; `EARLY_ANSWER_MS` when not given. */
  holdBodyMs?: number;
}

export interface LoopbackAnswer {
  status: number;
  body: string;
}

export type Exchange = (request: LoopbackRequest) => Promise<LoopbackAnswer>;

/** What an exchange fails with when no answer came within its `timeoutMs`. */
export class NoAnswerInTime extends Error {}

/**
 * A body up to this size is written with the head; a larger one waits
 * `EARLY_ANSWER_MS` for a refusal given on the head alone. A wait, not a
 * guarantee: a peer slower than that to refuse has its refusal lost as before,
 * and every large request that is accepted takes that much longer.
 */
const BODY_WITH_HEAD_BYTES = 65_536;
const EARLY_ANSWER_MS = 100;
const HEAD_END = Buffer.from("\r\n\r\n");
const CRLF = Buffer.from("\r\n");
/** What a request target, a header name and a header value may be made of: nothing that could begin another line. */
const REQUEST_TARGET = /^\/[\x21-\x7e]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE = /^[\x20-\x7e]*$/;

type Reading =
  | { state: "more" }
  | { state: "done"; answer: LoopbackAnswer }
  | { state: "bad"; why: string };

const bad = (why: string): Reading => ({ state: "bad", why });

/**
 * What the bytes received so far amount to. `ended` says the peer has closed,
 * so nothing more is coming. No message quotes the bytes.
 */
function readAnswer(bytes: Buffer, ended: boolean): Reading {
  const headEnd = bytes.indexOf(HEAD_END);
  if (headEnd === -1)
    return ended
      ? bad("the answer ended before its headers")
      : { state: "more" };
  const lines = bytes.subarray(0, headEnd).toString("latin1").split("\r\n");
  const status = /^HTTP\/1\.[01] (\d{3})(?: |$)/.exec(lines[0] ?? "");
  if (!status) return bad("the answer is not HTTP");
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon <= 0) return bad("the answer has a malformed header");
    const name = line.slice(0, colon).trim().toLowerCase();
    // A framing given twice is two ways to read the same bytes.
    if (
      headers.has(name) &&
      (name === "content-length" || name === "transfer-encoding")
    )
      return bad("the answer says twice how long it is");
    headers.set(name, line.slice(colon + 1).trim());
  }
  const rest = bytes.subarray(headEnd + HEAD_END.length);
  /** One answer is read. Bytes after it would be a second one. */
  const done = (body: Buffer, after: number): Reading =>
    after > 0
      ? bad("the peer sent more than one answer")
      : {
          state: "done",
          answer: { status: Number(status[1]), body: body.toString("utf8") },
        };
  const unfinished = (): Reading =>
    ended ? bad("the answer ended inside its body") : { state: "more" };

  const encoding = headers.get("transfer-encoding");
  if (encoding !== undefined) {
    if (encoding.toLowerCase() !== "chunked" || headers.has("content-length"))
      return bad("the answer is framed in a way this client does not read");
    const parts: Buffer[] = [];
    let at = 0;
    for (;;) {
      const lineEnd = rest.indexOf(CRLF, at);
      if (lineEnd === -1) return unfinished();
      const [sizeText = ""] = rest
        .subarray(at, lineEnd)
        .toString("latin1")
        .split(";");
      if (!/^[0-9a-fA-F]{1,8}$/.test(sizeText.trim()))
        return bad("the answer has a malformed chunk");
      const size = Number.parseInt(sizeText.trim(), 16);
      const start = lineEnd + CRLF.length;
      if (size === 0) {
        // After the last chunk: an empty line, or trailers and then one.
        const trailersEnd = rest.indexOf(HEAD_END, lineEnd);
        const end = rest.subarray(start, start + CRLF.length).equals(CRLF)
          ? start + CRLF.length
          : trailersEnd === -1
            ? -1
            : trailersEnd + HEAD_END.length;
        if (end === -1) return unfinished();
        return done(Buffer.concat(parts), rest.length - end);
      }
      if (rest.length < start + size + CRLF.length) return unfinished();
      if (!rest.subarray(start + size, start + size + CRLF.length).equals(CRLF))
        return bad("the answer has a malformed chunk");
      parts.push(rest.subarray(start, start + size));
      at = start + size + CRLF.length;
    }
  }
  const length = headers.get("content-length");
  if (length !== undefined) {
    if (!/^\d{1,10}$/.test(length))
      return bad("the answer has a malformed length");
    if (rest.length < Number(length)) return unfinished();
    return done(rest.subarray(0, Number(length)), rest.length - Number(length));
  }
  // Neither: the body is whatever arrives before the peer closes.
  return ended ? done(rest, 0) : { state: "more" };
}

/**
 * One HTTP/1.1 exchange over a socket this process opens to `127.0.0.1`.
 *
 * Not `fetch` and not `node:http`: under Bun both take `HTTP_PROXY` from the
 * environment the process started with, and neither a request option nor a
 * change at run time turns that off, so a loopback request, operator token
 * included, would go to the proxy. A socket of our own goes where it is told:
 * no proxy, no redirect followed, no name resolved.
 */
export const loopbackExchange: Exchange = (request) =>
  new Promise((resolve, reject) => {
    const { port, method, target, headers, body } = request;
    // Checked before a socket exists. What is written is exactly these lines,
    // so none of them may hold anything that could begin another.
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      return reject(new Error("the port is not a port"));
    if (!REQUEST_TARGET.test(target))
      return reject(
        new Error("the request target is not one this client sends"),
      );
    for (const [name, value] of Object.entries(headers))
      if (!HEADER_NAME.test(name) || !HEADER_VALUE.test(value))
        return reject(
          new Error("a request header is not one this client sends"),
        );
    const lines = [
      `${method} ${target} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      "Connection: close",
    ];
    for (const [name, value] of Object.entries(headers))
      lines.push(`${name}: ${value}`);
    const payload = body === undefined ? null : Buffer.from(body, "utf8");
    if (payload) lines.push(`Content-Length: ${payload.byteLength}`);
    const head = Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1");

    if (request.signal?.aborted)
      return reject(new Error("the request was cancelled"));
    const socket = connect({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let bodyTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: LoopbackAnswer | Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(bodyTimer);
      request.signal?.removeEventListener("abort", onAbort);
      // The peer may keep its end open; one answer is all that is read.
      socket.destroy();
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };
    const onAbort = (): void => finish(new Error("the request was cancelled"));
    const timer = setTimeout(
      () =>
        finish(new NoAnswerInTime(`no answer within ${request.timeoutMs} ms`)),
      request.timeoutMs,
    );
    request.signal?.addEventListener("abort", onAbort, { once: true });
    const judge = (ended: boolean): void => {
      const reading = readAnswer(Buffer.concat(chunks), ended);
      if (reading.state === "done") finish(reading.answer);
      else if (reading.state === "bad") finish(new Error(reading.why));
    };
    socket.once("connect", () => {
      if (!payload || payload.byteLength <= BODY_WITH_HEAD_BYTES) {
        socket.write(payload ? Buffer.concat([head, payload]) : head);
        return;
      }
      // A large body is held back for a moment. A peer that refuses on the
      // head alone (a token it does not honour) answers at once and closes;
      // written to a peer that has stopped reading, the body would have that
      // answer discarded on the way back.
      socket.write(head);
      bodyTimer = setTimeout(
        () => socket.write(payload),
        request.holdBodyMs ?? EARLY_ANSWER_MS,
      );
    });
    socket.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > request.maxBytes)
        return finish(
          new Error(`the answer is over ${request.maxBytes} bytes`),
        );
      chunks.push(chunk);
      judge(false);
    });
    socket.once("end", () => judge(true));
    socket.once("close", () =>
      finish(new Error("the connection closed before an answer")),
    );
    socket.once("error", (error: NodeJS.ErrnoException) =>
      finish(
        new Error(
          error.code === "ECONNREFUSED"
            ? "nothing is listening on the port"
            : "the connection failed",
        ),
      ),
    );
  });

// ── The health probe ────────────────────────────────────────────────────────

/** How long the probe waits for an answer, and how much of one it reads. */
const HEALTH_TIMEOUT_MS = 2000;
const HEALTH_MAX_BYTES = 16_384;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface HealthProbeOptions {
  /** `loopbackExchange` when not given. */
  exchange?: Exchange;
  signal?: AbortSignal | undefined;
}

/**
 * What the health probe found on the lock's port: the hearth the lock names
 * (`problem` null), or why not. `silent` says the problem is that no answer
 * came within the probe's time, which a hearth too busy to answer also gives.
 */
export interface HealthReport {
  problem: string | null;
  silent: boolean;
}

/**
 * Why what answers on the lock's port is not the hearth the lock names, or
 * null when it is: the health route answers 200 with an `ok` envelope whose
 * data holds the lock's pid and the very root string the lock holds. The
 * health route is all that is asked, with no header of the caller's. Whether
 * the lock's pid is alive is not looked at here.
 */
export async function healthProblem(
  lock: Pick<HearthLock, "pid" | "port" | "root">,
  options: HealthProbeOptions = {},
): Promise<string | null> {
  return (await healthReport(lock, options)).problem;
}

/** `healthProblem`, and whether its problem is that nothing answered in time. */
export async function healthReport(
  lock: Pick<HearthLock, "pid" | "port" | "root">,
  options: HealthProbeOptions = {},
): Promise<HealthReport> {
  const exchange = options.exchange ?? loopbackExchange;
  let answer: LoopbackAnswer;
  try {
    answer = await exchange({
      port: lock.port,
      method: "GET",
      target: HEALTH_ROUTE,
      headers: {},
      timeoutMs: HEALTH_TIMEOUT_MS,
      maxBytes: HEALTH_MAX_BYTES,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    return {
      problem: `its port did not answer as a hearth (${(error as Error).message})`,
      silent: error instanceof NoAnswerInTime,
    };
  }
  let health: unknown = null;
  try {
    health = JSON.parse(answer.body);
  } catch {
    // Not JSON: not a hearth.
  }
  const data =
    isRecord(health) && health["ok"] === true ? health["data"] : null;
  // The hearth answers the very string it wrote into its lock.
  if (
    answer.status !== 200 ||
    !isRecord(data) ||
    data["pid"] !== lock.pid ||
    data["root"] !== lock.root
  )
    return {
      problem: "what answers on its port is not that hearth",
      silent: false,
    };
  return { problem: null, silent: false };
}
