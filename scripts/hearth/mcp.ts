#!/usr/bin/env bun
/**
 * The hearth's MCP server (`bun run hearth:mcp`, stdio).
 *
 * A client of the running hearth and nothing more. Each `forge_*` tool is one
 * row of `FORGE_TOOLS` naming a route of the operator API; a call is one
 * request to that route, and the route's `{ ok, data, error }` envelope is the
 * result. Nothing here reads the ledger, runs `bd` or answers in the hearth's
 * place. The council's own tools are re-exported beside them.
 *
 * Every session is given the same tool list. What a session may do is decided
 * when a tool is called: a row whose route is an action is governed, and so
 * is every council tool but its read tools; a session started without
 * `--operator` is refused a governed tool before its arguments are looked at,
 * before any file is read and before anything is sent.
 */

import { readdirSync, realpathSync } from "node:fs";
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
import { isMain } from "../is-main";
import { resolveCheckout } from "../ledger/workspace";
import { hearthHome, lockPath, tokenPath } from "./home";
import { readHomeLock } from "./home-guard";
import { type HearthLock, isPidAlive, readLock, sameLock } from "./lock";
import {
  type Exchange,
  healthProblem,
  type LoopbackAnswer,
  loopbackExchange,
} from "./loopback";
import { API_PREFIX, OPERATOR_HEADER, SURFACE_HEADER } from "./paths";
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
  /**
   * The most the route reads of a body, when the route says: a larger one is
   * refused here. The hearth refuses it without reading it, and an answer
   * given to a request still being written can be lost on the way back.
   */
  maxBodyBytes?: number;
}

/**
 * The one value rule that is this server's own: what may fill a path segment.
 * Nothing that could turn one route into another.
 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const segment = z.string().regex(SEGMENT);
/** A filter of a GET. What the filters of one call come to together is bounded in bytes, where the request is built. */
const filter = z.string().max(1000);
/** The longest request target sent. A server answers a longer line with a bare status, not with a reason. */
const MAX_TARGET_BYTES = 8_000;
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
      "One forge run: summary, state and newest ledger events (events: how many, 0 for none).",
    input: z.strictObject({ slug: segment, events: whole.default(20) }),
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
    name: "forge_scoreboard_get",
    authority: "agent",
    scope: "workspace",
    description:
      "Per executor, from this workspace's ledger: sessions, gates, verdicts, reviews, council runs, usage. since: ISO 8601 time, only events at or after it.",
    input: z.strictObject({ since: filter.optional() }),
    method: "GET",
    path: "/scoreboard",
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
    description: `${OPERATOR_ONLY} Start a council review on the hearth, recorded as an operator action. sourceType: file, plan, pr, text or bead.`,
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
    maxBodyBytes: 2_100_000,
  },
  {
    name: "forge_council_preview",
    authority: "operator",
    scope: "checkout",
    // An action, though it starts nothing: a bead source is read through `bd`.
    // Only what changes a pack: a run's profile, ceiling and id are not read.
    description: `${OPERATOR_ONLY} Preview what a council run on a source would send, listed part by part. Starts nothing. sourceType: file, plan, pr, text or bead.`,
    input: z.strictObject({
      sourceType: z.string(),
      source: z.string(),
      maxBytes: z.number().optional(),
      redactSecrets: z.boolean().optional(),
      beadId: z.string().optional(),
    }),
    method: "POST",
    path: "/council/preview",
    maxBodyBytes: 2_100_000,
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
  // A home, or a lock file, that others can write lets them name a port of
  // their own and be sent the token (`home-guard.ts`): nothing in it is used.
  // The lock is read again as it is checked, and used only when that read is
  // the lock this server found: what was checked is what is used (`x1gs.3.38`).
  const read = readHomeLock(home, join(home, file));
  if (read.problem !== null) return read.problem;
  if (!sameLock(read.lock, lock)) return "it changed while it was read";
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
  return healthProblem(lock, { exchange, signal });
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
  const target = `${API_PREFIX}${path}${text ? `?${text}` : ""}`;
  if (Buffer.byteLength(target) > MAX_TARGET_BYTES)
    throw new Error(
      `the filters are too long for one request (${Buffer.byteLength(target)} bytes; at most ${MAX_TARGET_BYTES})`,
    );
  return { target };
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

/**
 * The council's tools an agent session may call: the ones that only read. A
 * tool answers an agent session only when it is named here and the council
 * marks it read-only; every other council tool, one added later included, is
 * an operator session's alone. A list of what is allowed, so that a new tool
 * is governed until someone decides otherwise.
 */
export const COUNCIL_READ_TOOLS: ReadonlySet<string> = new Set([
  "council_profiles",
  "council_readiness",
  "council_status",
  "council_replay",
  "council_list",
]);

interface CouncilBridge {
  /** The council's own `tools/list` entries; a governed one's description says it is the operator's. */
  tools: Tool[];
  has(name: string): boolean;
  /** Whether an agent session is refused this tool. */
  governed(name: string): boolean;
  /** Forward one call as it came; `signal` is the only thing that ends it early. */
  call(
    params: CallToolRequestParams,
    signal: AbortSignal,
  ): Promise<CallToolResult>;
  close(leaveCouncilOpen?: boolean): Promise<void>;
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
 * with whatever schemas, are the ones listed and called.
 *
 * Its names are checked, so that none can answer in a forge tool's place, and
 * each tool is judged once, here: one that is not a read tool (see
 * `COUNCIL_READ_TOOLS`) is governed, and its description is listed with the
 * same first words as a governed forge row's. A tool an agent session may
 * call needs no operator token and never reaches the hearth; a review an
 * operator session starts through one is that session's, as it is under
 * `bun run council:mcp`, not an operator action of the hearth's.
 */
async function bridgeCouncil(council: CouncilServer): Promise<CouncilBridge> {
  const client = new Client({ name: "agent-forge", version: SERVER_VERSION });
  const [near, far] = InMemoryTransport.createLinkedPair();
  await council.connect(far);
  await client.connect(near);
  /** Closing the client ends the calls it was forwarding. Closing the council as well ends everything it is doing. */
  const close = async (leaveCouncilOpen = false): Promise<void> => {
    await client.close();
    if (!leaveCouncilOpen) await council.close();
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
  const governed = new Set(
    tools
      .filter(
        (tool) =>
          !COUNCIL_READ_TOOLS.has(tool.name) ||
          tool.annotations?.readOnlyHint !== true,
      )
      .map((tool) => tool.name),
  );
  return {
    tools: tools.map((tool) =>
      governed.has(tool.name)
        ? {
            ...tool,
            description: tool.description
              ? `${OPERATOR_ONLY} ${tool.description}`
              : OPERATOR_ONLY,
          }
        : tool,
    ),
    has: (name) => names.has(name),
    governed: (name) => governed.has(name),
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
  /**
   * Leave the council's server open when this one closes. The stdio entry
   * sets it: there this server closes when its transport dies, and that must
   * not cancel a review the council began on its own account. The process
   * leaves when that work has ended.
   */
  keepCouncilOpen?: boolean;
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
    const bodyBytes = Buffer.byteLength(request.body ?? "");
    if (tool.maxBodyBytes !== undefined && bodyBytes > tool.maxBodyBytes)
      return refusal(
        `${tool.name}: the request is ${bodyBytes} bytes and its route reads at most ${tool.maxBodyBytes} bytes, so nothing was sent.`,
      );

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
    // Ends with the caller's own cancellation, or when the client has gone:
    // nobody is left to answer. The council itself is not closed for that; a
    // review it began on its own account runs to its end, as it does under
    // `bun run council:mcp`.
    const signal = options.gone
      ? AbortSignal.any([ctx.mcpReq.signal, options.gone])
      : ctx.mcpReq.signal;
    const tool = forge.get(name);
    if (!tool) {
      if (bridge?.has(name)) {
        // As for a governed forge row: refused before the council sees it.
        if (bridge.governed(name) && !options.operator)
          return result(needsOperator(name));
        return bridge.call(request.params, signal);
      }
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

  const close = server.close.bind(server);
  server.close = async () => {
    await bridge?.close(options.keepCouncilOpen === true);
    await close();
  };
  return server;
}

// ── Over stdio ──────────────────────────────────────────────────────────────

/**
 * Serve over this process's stdio. The one way the server is served: the
 * entry point below calls it with the real council, tests with a stand-in.
 *
 * Three things the SDK's stdio entry leaves undone are done here. The first
 * server is built at once, so a council registry this server will not serve
 * stops the process with one line and exit code 1, instead of answering every
 * message with an internal error. The end of input is noticed, which the
 * transport does not do: calls still waiting are ended, so that a call which
 * never settles cannot keep the process alive after its client has gone. And
 * what the SDK reports out of band is written to stderr, one line each.
 *
 * The council is never closed from here. When the client has gone, ending a
 * waiting call writes to a pipe nobody reads, the transport fails and the SDK
 * closes this server; a review the council began on its own account still
 * runs to its end, and the process leaves when it has.
 */
export function serveHearthMcp(
  options: Omit<HearthMcpOptions, "gone" | "keepCouncilOpen">,
): StdioServerHandle {
  const gone = new AbortController();
  // A client that has died reads this server's errors no more than its
  // answers. A line that cannot be written must not end the process: the
  // council's own work would end with it, unrecorded.
  process.stderr.on("error", () => {});
  const build = (): Promise<Server> =>
    createHearthMcpServer({
      ...options,
      gone: gone.signal,
      keepCouncilOpen: true,
    }).catch((error: unknown) => {
      process.stderr.write(
        `hearth:mcp cannot start: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    });
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
  return serveStdio(
    () => {
      const server = first ?? build();
      first = null;
      return server;
    },
    {
      // What it says comes from the message that could not be handled, never
      // from anything this server holds. One bounded line of printable ASCII:
      // the text may be the client's own. A schema failure reports every way
      // the message was wrong as JSON: its name is enough.
      onerror: (error) => {
        const text = error.message
          .replace(/\s+/g, " ")
          .replace(/[^\x20-\x7e]/g, "?");
        process.stderr.write(
          `hearth:mcp: ${error.name}: ${/^[[{]/.test(text) ? "a message that is not a valid request" : text.slice(0, 200)}\n`,
        );
      },
    },
  );
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

if (isMain(import.meta)) {
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
