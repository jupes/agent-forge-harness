/**
 * The hearth's MCP server: the tool table, who may call what, and what leaves
 * the process.
 *
 * Every hearth here is hermetic (a temp home, a temp root with a planted
 * `.git`, a recorder for `bd`, no council ledger). A session is the server
 * built in this process with a client on an in-memory pair; its requests to
 * the hearth go through the real socket exchange, wrapped to record them, so a
 * test can say what was sent and that nothing was.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { OperatorEnvelope } from "../../types/hearth";
import type { ApiRoute } from "./api";
import {
  type CouncilServer,
  createHearthMcpServer,
  type Exchange,
  FORGE_TOOLS,
  type ForgeTool,
  loopbackExchange,
} from "./mcp";
import { startTestHearth, type TestHearth } from "./testing";
import { readToken } from "./token";
import { validateOperatorEnvelope } from "./validate";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** Everything a tool call answered in this suite, and every token a hearth minted: searched at the end. */
const outputs: string[] = [];
const tokens = new Set<string>();

async function startHearth(): Promise<TestHearth> {
  const hearth = await startTestHearth();
  tokens.add(hearth.hearth.token);
  cleanup.push(() => hearth.close());
  return hearth;
}

/** A home and a root nobody is serving. */
function emptyPlace(): { home: string; root: string } {
  const home = mkdtempSync(join(tmpdir(), "af-mcp-home-"));
  const root = mkdtempSync(join(tmpdir(), "af-mcp-root-"));
  mkdirSync(join(root, ".git"));
  cleanup.push(() => {
    for (const dir of [home, root])
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  return { home, root };
}

/** A council registry of one harmless tool, standing in for the real one. */
function standInCouncil(): McpServer {
  const server = new McpServer({ name: "stand-in-council", version: "0" });
  server.registerTool(
    "council_echo",
    {
      description: "Answers what it was given.",
      inputSchema: z.object({ value: z.string().optional() }),
    },
    async (input) => ({
      content: [{ type: "text" as const, text: JSON.stringify(input) }],
    }),
  );
  return server;
}

/** One request the server made. */
interface Sent {
  port: number;
  method: string;
  target: string;
  headers: Record<string, string>;
  body?: string;
}

/** What a tool call answered. */
interface Answer {
  isError: boolean;
  /** The text of each content item. */
  texts: string[];
  /** The first item, as the envelope it must be. */
  envelope: OperatorEnvelope;
}

interface Session {
  client: Client;
  /** Every request the server made, in order. */
  sent: Sent[];
  /** Every token file the server read, in order. */
  tokenReads: string[];
  call(name: string, args?: Record<string, unknown>): Promise<Answer>;
}

interface SessionOptions {
  operator?: boolean;
  council?: (() => CouncilServer) | null;
}

async function session(
  place: { home: string; root: string },
  options: SessionOptions = {},
): Promise<Session> {
  const sent: Sent[] = [];
  const tokenReads: string[] = [];
  const exchange: Exchange = (request) => {
    sent.push({
      port: request.port,
      method: request.method,
      target: request.target,
      headers: { ...request.headers },
      ...(request.body !== undefined ? { body: request.body } : {}),
    });
    return loopbackExchange(request);
  };
  const server = await createHearthMcpServer({
    root: place.root,
    home: place.home,
    operator: options.operator ?? false,
    council: options.council === undefined ? standInCouncil : options.council,
    exchange,
    readToken: (file) => {
      tokenReads.push(file);
      return readToken(file);
    },
  });
  const client = new Client({ name: "mcp-test", version: "0" });
  const [near, far] = InMemoryTransport.createLinkedPair();
  await server.connect(far);
  await client.connect(near);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  return {
    client,
    sent,
    tokenReads,
    async call(name, args) {
      const result = await client.callTool({
        name,
        ...(args !== undefined ? { arguments: args } : {}),
      });
      const texts = (result.content as Array<{ type: string; text?: string }>)
        .filter((item) => item.type === "text")
        .map((item) => item.text ?? "");
      outputs.push(JSON.stringify(result));
      const checked = validateOperatorEnvelope(JSON.parse(texts[0] ?? "null"));
      if (!checked.ok)
        throw new Error(`${name} did not answer an envelope: ${checked.error}`);
      return {
        isError: result.isError === true,
        texts,
        envelope: checked.value,
      };
    },
  };
}

const place = (hearth: TestHearth): { home: string; root: string } => ({
  home: hearth.home,
  root: hearth.root,
});

/** The governed rows. An empty table must fail a test that iterates it, not pass it. */
function governedRows(): ForgeTool[] {
  const rows = FORGE_TOOLS.filter((tool) => tool.authority === "operator");
  if (rows.length === 0) throw new Error("the table has no governed row");
  return rows;
}

/** A route's path with its parameter names removed: `/runs/:slug` and `/runs/:id` are one shape. */
const shape = (method: string, path: string): string =>
  `${method} ${path.replace(/:[^/]+/g, ":")}`;

describe("tools/list", () => {
  test("is the same for an agent session and an operator session, with a hearth and without one", async () => {
    const hearth = await startHearth();
    const nowhere = emptyPlace();
    const listings: unknown[] = [];
    const greetings: unknown[] = [];
    for (const where of [place(hearth), nowhere]) {
      for (const operator of [false, true]) {
        const { client } = await session(where, { operator });
        listings.push(await client.listTools());
        greetings.push({
          server: client.getServerVersion(),
          capabilities: client.getServerCapabilities(),
          instructions: client.getInstructions(),
        });
      }
    }
    expect(listings[0]).toEqual({ tools: expect.any(Array) });
    for (const listing of listings.slice(1))
      expect(listing).toEqual(listings[0]);
    for (const greeting of greetings.slice(1))
      expect(greeting).toEqual(greetings[0]);
  });

  test("is the forge rows in table order, then the council's own listing unchanged", async () => {
    const { client } = await session(emptyPlace());
    const { tools } = await client.listTools();

    const direct = new Client({ name: "direct", version: "0" });
    const council = standInCouncil();
    const [near, far] = InMemoryTransport.createLinkedPair();
    await council.connect(far);
    await direct.connect(near);
    cleanup.push(async () => {
      await direct.close();
      await council.close();
    });
    const own = (await direct.listTools()).tools;

    expect(tools.map((tool) => tool.name)).toEqual([
      ...FORGE_TOOLS.map((tool) => tool.name),
      "council_echo",
    ]);
    expect(tools.slice(FORGE_TOOLS.length)).toEqual(own);
    for (const [index, row] of FORGE_TOOLS.entries()) {
      const listed = tools[index];
      expect(listed?.description).toBe(row.description);
      expect(listed?.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
    }
  });

  test("the forge half stays small: a byte budget for the listing, and short descriptions", async () => {
    const { client } = await session(emptyPlace(), { council: null });
    const { tools } = await client.listTools();
    expect(tools.length).toBe(FORGE_TOOLS.length);
    for (const row of FORGE_TOOLS) {
      expect(row.name).toMatch(/^forge_[a-z]+(_[a-z]+)+$/);
      expect(row.description.length).toBeLessThanOrEqual(200);
    }
    expect(JSON.stringify(tools).length).toBeLessThanOrEqual(LISTING_BUDGET);
  });
});

/** The most the ten rows may cost in `tools/list`. Raise it on purpose, not by accident. */
const LISTING_BUDGET = 3500;

describe("the tool table", () => {
  test("every row names a route mounted on a hearth, and is governed exactly when that route is an action", async () => {
    const hearth = await startHearth();
    const mounted = new Map<string, ApiRoute["kind"]>();
    for (const route of hearth.hearth.routes)
      mounted.set(shape(route.method, route.path), route.kind);

    expect(FORGE_TOOLS.length).toBeGreaterThan(0);
    for (const tool of FORGE_TOOLS) {
      const kind = mounted.get(shape(tool.method, tool.path));
      expect({ tool: tool.name, mounted: kind !== undefined }).toEqual({
        tool: tool.name,
        mounted: true,
      });
      expect({
        tool: tool.name,
        governed: tool.authority === "operator",
      }).toEqual({ tool: tool.name, governed: kind === "action" });
    }
  });
});

describe("a governed tool in an agent session (iterating the table, no input per tool)", () => {
  const forged = "f".repeat(64);
  /** What an agent might send. The SDK itself refuses arguments that are not an object. */
  const attempts: Array<[string, Record<string, unknown> | undefined]> = [
    ["no arguments", undefined],
    ["an empty object", {}],
    [
      "arguments that look valid",
      {
        id: "run-1",
        runId: "run-1",
        sourceType: "text",
        source: "review this",
      },
    ],
    ["arguments of the wrong types", { id: 7, sourceType: [], source: null }],
    ["a forged token argument", { operatorToken: forged, token: forged }],
    [
      "a forged token under the header's name",
      { "x-agent-forge-operator": forged, "X-Agent-Forge-Operator": forged },
    ],
    ["a claim to be the operator", { operator: true, "--operator": true }],
  ];

  test("is refused the same way whatever is sent: nothing is sent, no token file is read, nothing is recorded", async () => {
    const hearth = await startHearth();
    const agent = await session(place(hearth));
    for (const tool of governedRows()) {
      for (const [label, args] of attempts) {
        const answer = await agent.call(tool.name, args);
        expect({ tool: tool.name, label, answer }).toEqual({
          tool: tool.name,
          label,
          answer: {
            isError: true,
            texts: [expect.any(String)],
            envelope: {
              ok: false,
              data: null,
              error: `${tool.name} needs an operator session: this server was started without --operator and holds no operator token.`,
            },
          },
        });
      }
    }
    expect(agent.sent).toEqual([]);
    expect(agent.tokenReads).toEqual([]);
    expect(hearth.events(["operator.action"])).toEqual([]);
  });
});

describe("a tool nobody registered", () => {
  test("is a protocol error, as the SDK's own server answers it, and nothing is sent", async () => {
    const hearth = await startHearth();
    for (const operator of [false, true]) {
      const s = await session(place(hearth), { operator });
      for (const name of [
        "forge_nope",
        "council_nope",
        "forge_queue_approve",
        "__proto__",
        "constructor",
        "toString",
        "",
      ]) {
        const outcome = await s.client.callTool({ name, arguments: {} }).then(
          () => "answered",
          (error: { code?: number }) => error.code,
        );
        expect({ name, outcome }).toEqual({ name, outcome: -32602 });
      }
      expect(s.sent).toEqual([]);
      expect(s.tokenReads).toEqual([]);
    }
  });
});
