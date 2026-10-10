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

import { Client } from "@modelcontextprotocol/client";
import {
  type CallToolResult,
  InMemoryTransport,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type Tool,
  type Transport,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { type OperatorEnvelope, QUEUE_STATES } from "../../types/hearth";

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
      "Ledger events of this workspace, oldest first. Filter by bead, run, session, kind (comma list) or since (ISO time); page with after (an event id).",
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

export const loopbackExchange: Exchange = () =>
  Promise.reject(new Error("not built yet"));

// ── The council's tools ─────────────────────────────────────────────────────

/** A server whose tools are re-exported: the council's `McpServer`, or a stand-in. */
export interface CouncilServer {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

interface CouncilBridge {
  tools: Tool[];
  close(): Promise<void>;
}

async function bridgeCouncil(council: CouncilServer): Promise<CouncilBridge> {
  const client = new Client({ name: "agent-forge", version: SERVER_VERSION });
  const [near, far] = InMemoryTransport.createLinkedPair();
  await council.connect(far);
  await client.connect(near);
  const { tools } = await client.listTools();
  return {
    tools,
    async close() {
      await client.close();
      await council.close();
    },
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

export async function createHearthMcpServer(
  options: HearthMcpOptions,
): Promise<Server> {
  const forge = new Map(FORGE_TOOLS.map((tool) => [tool.name, tool]));
  const bridge = options.council
    ? await bridgeCouncil(options.council())
    : null;
  const tools = [...FORGE_TOOLS.map(listed), ...(bridge?.tools ?? [])];

  const server = new Server(
    { name: "agent-forge", version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler("tools/list", async () => ({ tools }));
  server.setRequestHandler("tools/call", async (request) => {
    const { name } = request.params;
    const tool = forge.get(name);
    // What the SDK's own server answers for a name it does not know.
    if (!tool)
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Tool ${name} not found`,
      );
    // First, before the arguments are looked at: an agent session gets this
    // and nothing else from a governed tool, whatever it sent.
    if (tool.authority === "operator" && !options.operator)
      return result(
        refusal(
          `${name} needs an operator session: this server was started without --operator and holds no operator token.`,
        ),
      );
    return result(refusal(`No hearth is running for ${options.root}.`));
  });

  const close = server.close.bind(server);
  server.close = async () => {
    await bridge?.close();
    await close();
  };
  return server;
}
