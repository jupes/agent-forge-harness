#!/usr/bin/env bun
/**
 * The hearth's MCP server (`bun run hearth:mcp`, stdio).
 *
 * A client of the running hearth and nothing more. Each `forge_*` tool is one
 * row of `FORGE_TOOLS` naming a route of the operator API; a call is one
 * request to that route, and the route's `{ ok, data, error }` envelope is the
 * result. Nothing here reads the ledger, runs `bd` or answers in the hearth's
 * place. The council's own tools are re-exported beside them, unchanged.
 *
 * Every session is given the same tool list. What a session may do is decided
 * when a tool is called: a row whose route is an action is governed, and a
 * session started without `--operator` is refused there before its arguments
 * are looked at, before any file is read and before anything is sent.
 */

import { readdirSync, realpathSync } from "node:fs";
import { connect } from "node:net";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import {
  type CallToolRequestParams,
  type CallToolResult,
  InMemoryTransport,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type Tool,
  type Transport,
} from "@modelcontextprotocol/server";
import {
  type StdioServerHandle,
  serveStdio,
} from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { type OperatorEnvelope, QUEUE_STATES } from "../../types/hearth";
import { createCouncilMcpServer } from "../council/mcp";
import { comparableCheckout } from "../forge/runs";
import { resolveCheckout } from "../ledger/workspace";
import { hearthHome, lockPath, tokenPath } from "./home";
import { type HearthLock, isPidAlive, readLock } from "./lock";
import {
  API_PREFIX,
  HEALTH_ROUTE,
  OPERATOR_HEADER,
  SURFACE_HEADER,
} from "./paths";
import { readToken } from "./token";
import { validateOperatorEnvelope } from "./validate";

/** `agent`: any session. `operator`: the route is an action and needs the operator token. */
export type ToolAuthority = "agent" | "operator";

/**
 * Which hearths may answer a row. A `workspace` row reads the ledger or Beads,
 * the same from any hearth of the workspace; a `checkout` row reads the
 * hearth's own root (run state, config files, the council's directory).
 */
export type ToolScope = "workspace" | "checkout";

/** One tool: a route of the operator API, and who may call it. */
export interface ForgeTool {
  name: string;
  authority: ToolAuthority;
  scope: ToolScope;
  /** Kept short: every session that loads the server pays for it. */
  description: string;
  /**
   * The route's parameters by the route's own names, types only: which values
   * are allowed is the hearth's to say. An argument named by a `:name` segment
   * of `path` fills it; every other one is a query parameter of a GET or a
   * field of the JSON body of a POST.
   */
  input: z.ZodObject;
  method: "GET" | "POST";
  /** Below `/__agent-forge`, as the route table spells it. */
  path: string;
}

/**
 * The one value rule that is this server's own: what may fill a path segment.
 * Nothing that could turn one route into another.
 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const segment = z.string().regex(SEGMENT);
/** A filter of a GET: bounded so the request line stays a request line. */
const filter = z.string().max(1000);
const whole = z.number().int().min(0);
const none = z.strictObject({});

const OPERATOR_ONLY = "Operator session only.";

export const FORGE_TOOLS: readonly ForgeTool[] = [
  {
    name: "forge_sessions_list",
    authority: "agent",
    scope: "workspace",
    description:
      "Agent sessions recorded for this workspace, newest first. open: only those with no end recorded.",
    input: z.strictObject({
      open: z.boolean().optional(),
      limit: whole.default(50),
    }),
    method: "GET",
    path: "/sessions",
  },
  {
    name: "forge_runs_list",
    authority: "agent",
    scope: "checkout",
    description: "Forge runs of this checkout and the phase each is in.",
    input: none,
    method: "GET",
    path: "/runs",
  },
  {
    name: "forge_run_get",
    authority: "agent",
    scope: "checkout",
    description:
      "One forge run: its summary, stored state and newest 200 ledger events (large).",
    input: z.strictObject({ slug: segment }),
    method: "GET",
    path: "/runs/:slug",
  },
  {
    name: "forge_events_query",
    authority: "agent",
    scope: "workspace",
    description:
      "Ledger events of this workspace: the newest, or with after (an event id) the next ones in order. Filter by bead, run, session, kind (comma list) or since (ISO time).",
    input: z.strictObject({
      bead: filter.optional(),
      beadExact: z.boolean().optional(),
      run: filter.optional(),
      session: filter.optional(),
      since: filter.optional(),
      kind: filter.optional(),
      after: whole.optional(),
      limit: whole.default(50),
    }),
    method: "GET",
    path: "/events",
  },
  {
    name: "forge_queue_list",
    authority: "agent",
    scope: "workspace",
    description: "Beads carrying a queue state, optionally only some states.",
    input: z.strictObject({ state: z.array(z.enum(QUEUE_STATES)).optional() }),
    method: "GET",
    path: "/queue",
  },
  {
    name: "forge_reservations_list",
    authority: "agent",
    scope: "workspace",
    description: "File reservations held by running sessions.",
    input: none,
    method: "GET",
    path: "/reservations",
  },
  {
    name: "forge_smiths_list",
    authority: "agent",
    scope: "checkout",
    description: "Configured smiths, benches and the default smith.",
    input: none,
    method: "GET",
    path: "/smiths",
  },
  {
    name: "forge_config_get",
    authority: "agent",
    scope: "checkout",
    description: "The merged harness config, with where each value came from.",
    input: none,
    method: "GET",
    path: "/config",
  },
  {
    name: "forge_council_start",
    authority: "operator",
    scope: "checkout",
    description: `${OPERATOR_ONLY} Start a council review on the hearth, recorded as an operator action. sourceType: file, plan, pr or text.`,
    input: z.strictObject({
      sourceType: z.string(),
      source: z.string(),
      profile: z.string().optional(),
      maxUsd: z.number().optional(),
      maxBytes: z.number().optional(),
      runId: z.string().optional(),
      redactSecrets: z.boolean().optional(),
      beadId: z.string().optional(),
    }),
    method: "POST",
    path: "/council/runs",
  },
  {
    name: "forge_council_cancel",
    authority: "operator",
    scope: "checkout",
    description: `${OPERATOR_ONLY} Cancel a council run started on the hearth.`,
    input: z.strictObject({ id: segment }),
    method: "POST",
    path: "/council/runs/:id/cancel",
  },
];

/** A row as `tools/list` shows it. */
function listed(tool: ForgeTool): Tool {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(tool.input, {
    io: "input",
    // The bound zod puts on every whole number says nothing a caller needs.
    override: ({ jsonSchema }) => {
      if (jsonSchema.maximum === Number.MAX_SAFE_INTEGER)
        delete jsonSchema.maximum;
    },
  });
  return {
    name: tool.name,
    description: tool.description,
    // justification: a strict zod object always converts to a JSON Schema of type "object".
    inputSchema: schema as Tool["inputSchema"],
    annotations:
      tool.authority === "operator"
        ? { readOnlyHint: false, destructiveHint: false }
        : { readOnlyHint: true },
  };
}

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
}

export interface LoopbackAnswer {
  status: number;
  body: string;
}

export type Exchange = (request: LoopbackRequest) => Promise<LoopbackAnswer>;

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
    const finish = (outcome: LoopbackAnswer | Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      // The peer may keep its end open; one answer is all that is read.
      socket.destroy();
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };
    const onAbort = (): void => finish(new Error("the request was cancelled"));
    const timer = setTimeout(
      () => finish(new Error(`no answer within ${request.timeoutMs} ms`)),
      request.timeoutMs,
    );
    request.signal?.addEventListener("abort", onAbort, { once: true });
    const judge = (ended: boolean): void => {
      const reading = readAnswer(Buffer.concat(chunks), ended);
      if (reading.state === "done") finish(reading.answer);
      else if (reading.state === "bad") finish(new Error(reading.why));
    };
    socket.once("connect", () => {
      socket.write(payload ? Buffer.concat([head, payload]) : head);
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

// ── Finding the hearth ──────────────────────────────────────────────────────

/** A hearth that passed every check. */
interface Hearth {
  port: number;
  /** As the hearth spells it: in its lock, and in its health answer. */
  root: string;
  /** Where this server computes that hearth's token file to be. Never a path taken from the lock. */
  tokenFile: string;
}

interface Located {
  /** The hearth of the checkout the session works in. */
  own: Hearth | null;
  /** The hearth of the main checkout, when the session works in a linked worktree of it. */
  workspace: Hearth | null;
  /** Why a lock naming one of those checkouts was not used. */
  rejected: string[];
}

const LOCK_FILE = /^hearth-[0-9a-f]{12}\.lock$/;
/** What `createToken` writes. Anything else in a token file is not sent anywhere. */
const TOKEN = /^[0-9a-f]{64}$/;
/** The probe that asks a port whether it is the hearth its lock names. */
const HEALTH_TIMEOUT_MS = 2000;
const HEALTH_MAX_BYTES = 16_384;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A directory as the file system knows it, so that two spellings of one place
 * (a link, a Windows short name, another letter case) compare equal. The
 * native call: under Bun the plain one leaves a short name as it is.
 */
function onDisk(path: string): string {
  try {
    return comparableCheckout(realpathSync.native(path));
  } catch {
    return comparableCheckout(resolve(path));
  }
}

/** Why this lock is not used, or null when everything about it holds. */
async function unusable(
  home: string,
  file: string,
  lock: HearthLock,
  exchange: Exchange,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  // A hearth writes its lock under the name of the root inside it, and names
  // the token file of that root in this home. A lock that says otherwise was
  // not written by a hearth of this home.
  if (file !== basename(lockPath(home, lock.root)))
    return "it is not the lock file of the checkout it names";
  const tokenFile = tokenPath(home, lock.root);
  if (
    basename(lock.tokenFile) !== basename(tokenFile) ||
    onDisk(dirname(lock.tokenFile)) !== onDisk(dirname(tokenFile))
  )
    return "the token file it names is not this home's";
  if (!Number.isInteger(lock.port) || lock.port < 1 || lock.port > 65535)
    return "it names no usable port";
  if (!isPidAlive(lock.pid)) return "the process it names is not running";

  // Only now is anything sent, and only this question: a port can outlive the
  // hearth that published it and belong to another program.
  let answer: LoopbackAnswer;
  try {
    answer = await exchange({
      port: lock.port,
      method: "GET",
      target: HEALTH_ROUTE,
      headers: {},
      timeoutMs: HEALTH_TIMEOUT_MS,
      maxBytes: HEALTH_MAX_BYTES,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    return `its port did not answer as a hearth (${(error as Error).message})`;
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
    return "what answers on its port is not that hearth";
  return null;
}

/**
 * The live hearths this session may talk to. Every lock in the home is read,
 * in name order, and judged by the directory it names, not by a name this
 * server would have derived: a hearth started on another spelling of the
 * checkout is the same hearth.
 */
async function locateHearth(
  home: string,
  root: string,
  exchange: Exchange,
  signal: AbortSignal | undefined,
): Promise<Located> {
  const located: Located = { own: null, workspace: null, rejected: [] };
  const start = resolve(root);
  const checkout = resolveCheckout(start);
  const own = new Set([onDisk(start), onDisk(checkout.worktree)]);
  const main = onDisk(checkout.workspace);
  let files: string[];
  try {
    files = readdirSync(home)
      .filter((name) => LOCK_FILE.test(name))
      .sort();
  } catch {
    return located;
  }
  for (const file of files) {
    const lock = readLock(join(home, file));
    // A relative root names no particular directory.
    if (!lock || !isAbsolute(lock.root)) continue;
    const place = onDisk(lock.root);
    const kind = own.has(place) ? "own" : place === main ? "workspace" : null;
    if (kind === null || located[kind] !== null) continue;
    const problem = await unusable(home, file, lock, exchange, signal);
    if (problem !== null) located.rejected.push(`${file}: ${problem}`);
    else
      located[kind] = {
        port: lock.port,
        root: lock.root,
        tokenFile: tokenPath(home, lock.root),
      };
  }
  return located;
}

// ── A call as a request ─────────────────────────────────────────────────────

/** How long one request may take. A queue read that waits behind another can take 32 s. */
const REQUEST_TIMEOUT_MS = 45_000;
const ANSWER_MAX_BYTES = 4_000_000;

/**
 * The request a row's validated arguments become. Path parameters are checked
 * again here, whatever the row's schema says; the query is built by
 * `URLSearchParams`, so a value stays one value whatever characters it holds.
 */
function requestFor(
  tool: ForgeTool,
  input: Record<string, unknown>,
): { target: string; body?: string } {
  const fields = { ...input };
  const path = tool.path
    .split("/")
    .map((part) => {
      if (!part.startsWith(":")) return part;
      const name = part.slice(1);
      const value = fields[name];
      delete fields[name];
      if (typeof value !== "string" || !SEGMENT.test(value))
        throw new Error(`${name}: not a name this server puts in a path`);
      return value;
    })
    .join("/");
  if (tool.method === "POST")
    return { target: `${API_PREFIX}${path}`, body: JSON.stringify(fields) };
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    // False and an empty list are what the route assumes when not told, and
    // it refuses some of them spelled out (`beadExact` without `bead`).
    if (value === undefined || value === false) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    query.set(
      name,
      value === true
        ? "1"
        : Array.isArray(value)
          ? value.join(",")
          : String(value),
    );
  }
  const text = query.toString();
  return { target: `${API_PREFIX}${path}${text ? `?${text}` : ""}` };
}

function refusal(error: string): OperatorEnvelope {
  return { ok: false, data: null, error };
}

/** An envelope as a tool result: one text item, and nothing beside it. */
function result(envelope: OperatorEnvelope): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    isError: !envelope.ok,
  };
}

/** The envelope with every occurrence of the token replaced: a hearth that repeats what it was sent must not hand it on. */
function withoutToken(
  envelope: OperatorEnvelope,
  token: string | null,
): OperatorEnvelope {
  if (token === null) return envelope;
  const text = JSON.stringify(envelope);
  if (!text.includes(token)) return envelope;
  return JSON.parse(text.split(token).join("[operator token]"));
}

// ── The council's tools ─────────────────────────────────────────────────────

/** A server whose tools are re-exported: the council's `McpServer`, or a stand-in. */
export interface CouncilServer {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

interface CouncilBridge {
  /** The council's own `tools/list` entries, as it gave them. */
  tools: Tool[];
  has(name: string): boolean;
  /** Forward one call as it came; `signal` is the only thing that ends it early. */
  call(
    params: CallToolRequestParams,
    signal: AbortSignal,
  ): Promise<CallToolResult>;
  close(): Promise<void>;
}

const COUNCIL_PREFIX = "council_";
/**
 * The largest delay a timer takes: no limit of the bridge's own. The SDK
 * client inside it would otherwise give a call 60 s and then cancel it, and
 * the council turns a cancelled review into a cancelled run.
 */
const NO_TIME_LIMIT = 2_147_483_647;

/**
 * The council's registry, re-exported and not copied: its server is built
 * unchanged and reached by a client in this process, so whatever tools it has,
 * with whatever descriptions and schemas, are the ones listed and called.
 *
 * Its tools keep the council's own authority. They need no operator token and
 * never reach the hearth; a review one of them starts is the calling
 * session's, as it is under `bun run council:mcp`. The one thing checked is
 * their names, so that none can answer in a forge tool's place.
 */
async function bridgeCouncil(council: CouncilServer): Promise<CouncilBridge> {
  const client = new Client({ name: "agent-forge", version: SERVER_VERSION });
  const [near, far] = InMemoryTransport.createLinkedPair();
  await council.connect(far);
  await client.connect(near);
  const close = async (): Promise<void> => {
    await client.close();
    await council.close();
  };
  const { tools } = await client.listTools();
  const names = new Set<string>();
  for (const { name } of tools) {
    const problem =
      !name.startsWith(COUNCIL_PREFIX) || name === COUNCIL_PREFIX
        ? `is not a ${COUNCIL_PREFIX} tool`
        : names.has(name)
          ? "is offered twice"
          : null;
    if (problem !== null) {
      await close();
      throw new Error(
        `The council registry offers a tool named "${name}", which ${problem}; this server does not start with it.`,
      );
    }
    names.add(name);
  }
  return {
    tools,
    has: (name) => names.has(name),
    call: (params, signal) =>
      client.callTool(params, { signal, timeout: NO_TIME_LIMIT }),
    close,
  };
}

// ── The server ──────────────────────────────────────────────────────────────

const SERVER_VERSION = "0.1.0";

export interface HearthMcpOptions {
  /** Where the session works; the hearth is looked for from here. */
  root: string;
  /** Hearth state directory; defaults to `AGENT_FORGE_HOME` / `~/.agent-forge`. */
  home?: string;
  /** True only for a server launched with `--operator`. */
  operator: boolean;
  /** Builds the server whose tools are re-exported; null re-exports none. No default: forgetting it must not drop them. */
  council: (() => CouncilServer) | null;
  /** How requests reach the hearth. Tests wrap the real one to see what was sent. */
  exchange?: Exchange;
  /** How a token file is read. Tests wrap the real one to see that it was, or was not. */
  readToken?: (file: string) => string | null;
  /** How long one request to the hearth may take. */
  requestTimeoutMs?: number;
  /** Aborts when the client has gone. The stdio entry aborts it when input ends, which the transport does not notice. */
  gone?: AbortSignal;
}

export async function createHearthMcpServer(
  options: HearthMcpOptions,
): Promise<Server> {
  const home = options.home ?? hearthHome();
  const exchange = options.exchange ?? loopbackExchange;
  const readTokenFile = options.readToken ?? readToken;
  /**
   * How an operator session gets the token for one call. An agent session has
   * no such function: nothing in it can read a token file.
   */
  const operatorToken = options.operator
    ? (file: string): string | null => {
        const value = readTokenFile(file);
        return value !== null && TOKEN.test(value) ? value : null;
      }
    : null;
  const needsOperator = (name: string): OperatorEnvelope =>
    refusal(
      `${name} needs an operator session: this server was started without --operator and holds no operator token.`,
    );

  const lifetime = new AbortController();
  if (options.gone?.aborted) lifetime.abort();
  options.gone?.addEventListener("abort", () => lifetime.abort(), {
    once: true,
  });

  const forge = new Map(FORGE_TOOLS.map((tool) => [tool.name, tool]));
  const bridge = options.council
    ? await bridgeCouncil(options.council())
    : null;
  const tools = [...FORGE_TOOLS.map(listed), ...(bridge?.tools ?? [])];

  /** One call of a forge tool, after the authority rule: arguments, the hearth, the token, one request. */
  async function callForge(
    tool: ForgeTool,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<OperatorEnvelope> {
    const parsed = tool.input.safeParse(args);
    if (!parsed.success)
      return refusal(
        `${tool.name}: ${parsed.error.issues
          .map(
            (issue) =>
              `${issue.path.join(".") || "arguments"}: ${issue.message}`,
          )
          .join("; ")}`,
      );
    let request: { target: string; body?: string };
    try {
      request = requestFor(tool, parsed.data);
    } catch (error) {
      return refusal(`${tool.name}: ${(error as Error).message}`);
    }

    const located = await locateHearth(home, options.root, exchange, signal);
    // A row that reads the hearth's own checkout is answered only by the
    // hearth of this one: the main checkout's would answer for other files.
    const hearth =
      located.own ?? (tool.scope === "workspace" ? located.workspace : null);
    if (!hearth) {
      if (located.workspace)
        return refusal(
          `${tool.name} is answered only by the hearth of this checkout (${options.root}), and none is running. The hearth of the main checkout (${located.workspace.root}) is running, but its runs, config and council are that checkout's.`,
        );
      const found =
        located.rejected.length > 0
          ? ` A lock was found and not used: ${located.rejected.join("; ")}.`
          : "";
      return refusal(
        `No hearth is running for ${options.root}. The operator starts one there with \`bun run hearth\` (the dashboard starts one too); an agent session does not start it.${found}`,
      );
    }

    const headers: Record<string, string> = {
      Origin: `http://127.0.0.1:${hearth.port}`,
      [SURFACE_HEADER]: "mcp",
    };
    if (request.body !== undefined)
      headers["Content-Type"] = "application/json";
    let token: string | null = null;
    if (tool.authority === "operator") {
      if (!operatorToken) return needsOperator(tool.name);
      // Read for this call and kept no longer: a restarted hearth has a new one.
      token = operatorToken(hearth.tokenFile);
      if (token === null)
        return refusal(
          `${tool.name}: no operator token could be read from this hearth's token file, so nothing was sent.`,
        );
      headers[OPERATOR_HEADER] = token;
    }

    let answer: LoopbackAnswer;
    try {
      answer = await exchange({
        port: hearth.port,
        method: tool.method,
        target: request.target,
        headers,
        ...(request.body !== undefined ? { body: request.body } : {}),
        ...(signal ? { signal } : {}),
        timeoutMs: options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
        maxBytes: ANSWER_MAX_BYTES,
      });
    } catch (error) {
      return refusal(
        `The hearth at 127.0.0.1:${hearth.port} could not be asked: ${(error as Error).message}.`,
      );
    }
    let body: unknown = null;
    try {
      body = JSON.parse(answer.body);
    } catch {
      // Judged below: not an envelope.
    }
    const envelope = validateOperatorEnvelope(body);
    if (!envelope.ok)
      return refusal(
        `The hearth answered HTTP ${answer.status} with something that is not the operator API's envelope.`,
      );
    // The three fields, and nothing else the answer may have carried.
    const { value } = envelope;
    return withoutToken(
      value.ok
        ? { ok: true, data: value.data, error: null }
        : { ok: false, data: null, error: value.error },
      token,
    );
  }

  const server = new Server(
    { name: "agent-forge", version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler("tools/list", async () => ({ tools }));
  server.setRequestHandler("tools/call", async (request, ctx) => {
    const { name } = request.params;
    // Ends with the caller's own cancellation, or when the client has gone.
    const signal = AbortSignal.any([ctx.mcpReq.signal, lifetime.signal]);
    const tool = forge.get(name);
    if (!tool) {
      if (bridge?.has(name)) return bridge.call(request.params, signal);
      // What the SDK's own server answers for a name it does not know.
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Tool ${name} not found`,
      );
    }
    // First, before the arguments are looked at: an agent session gets this
    // and nothing else from a governed tool, whatever it sent.
    if (tool.authority === "operator" && !options.operator)
      return result(needsOperator(name));
    return result(
      await callForge(tool, request.params.arguments ?? {}, signal),
    );
  });

  // A call still waiting when its client has gone is ended: nobody is left to
  // answer. The council itself is not closed for that; a review it began on
  // its own account runs to its end, as it does under `bun run council:mcp`.
  server.onclose = () => lifetime.abort();
  const close = server.close.bind(server);
  server.close = async () => {
    lifetime.abort();
    await bridge?.close();
    await close();
  };
  return server;
}

// ── Over stdio ──────────────────────────────────────────────────────────────

/**
 * Serve over this process's stdio. The one way the server is served: the
 * entry point below calls it with the real council, tests with a stand-in.
 *
 * Two things the SDK's stdio entry leaves undone are done here. The first
 * server is built at once, so a council registry this server will not serve
 * stops the process with one line and exit code 1, instead of answering every
 * message with an internal error. And the end of input is noticed, which the
 * transport does not do: calls still waiting are ended, so that a call which
 * never settles cannot keep the process alive after its client has gone.
 */
export function serveHearthMcp(
  options: Omit<HearthMcpOptions, "gone">,
): StdioServerHandle {
  const gone = new AbortController();
  const build = (): Promise<Server> =>
    createHearthMcpServer({ ...options, gone: gone.signal }).catch(
      (error: unknown) => {
        process.stderr.write(
          `hearth:mcp cannot start: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exit(1);
      },
    );
  let first: Promise<Server> | null = build();
  void first.then(() =>
    process.stderr.write(
      `hearth:mcp: serving ${resolve(options.root)} as ${
        options.operator
          ? "an operator session"
          : "an agent session (no operator token)"
      }\n`,
    ),
  );
  for (const event of ["end", "close"] as const)
    process.stdin.once(event, () => gone.abort());
  return serveStdio(() => {
    const server = first ?? build();
    first = null;
    return server;
  });
}

export type ParsedArgs =
  | { ok: true; operator: boolean; root: string | null }
  | { ok: false; error: string };

/**
 * `--operator` and `--root <dir>`, each at most once, and nothing else. A
 * mistyped `--operator` must stop the server, not start an agent session its
 * operator believes is something else.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let operator = false;
  let root: string | null = null;
  const fail = (error: string): ParsedArgs => ({ ok: false, error });
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? "";
    if (arg === "--operator") {
      if (operator) return fail("--operator is given twice");
      operator = true;
    } else if (arg === "--root" || arg.startsWith("--root=")) {
      if (root !== null) return fail("--root is given twice");
      const value =
        arg === "--root" ? argv[++index] : arg.slice("--root=".length);
      if (value === undefined || value === "" || value.startsWith("--"))
        return fail("--root needs a directory");
      root = value;
    } else return fail(`unknown argument ${JSON.stringify(arg)}`);
  }
  return { ok: true, operator, root };
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.ok) {
    process.stderr.write(
      `hearth:mcp: ${args.error}\nUsage: bun run hearth:mcp [--operator] [--root <dir>]\n`,
    );
    process.exit(2);
  }
  // Loaded here, not at the top: the ledger needs Bun's SQLite, and a
  // re-exported council tool records its run as it does under council:mcp.
  const { councilLedger } = await import("../council/ledger-wiring");
  serveHearthMcp({
    root: args.root ?? process.cwd(),
    operator: args.operator,
    council: () => createCouncilMcpServer(councilLedger(process.env)),
  });
}
