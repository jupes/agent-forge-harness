import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createHearthMcpServer } from "./mcp";
import {
  createAgentMcpStdioOptions,
  type McpStdioContext,
  runMcpStdioEntry,
} from "./mcp-stdio-entry";

const root = resolve(".tmp/work/fake-mcp-root");
const home = resolve(".tmp/work/fake-mcp-home");

test("agent stdio mode refuses bad selectors and operator authority before invoking a producer", async () => {
  for (const args of [
    [],
    ["--root", root],
    ["--root", root, "--operator", "PRIVATE"],
    ["--root", root, "--root", root],
    ["--root", root, "--home", "relative-home"],
    ["--root", "relative-root", "--home", home],
    ["--root", root, "--home", ""],
    ["--root", `${root}\0PRIVATE`, "--home", home],
    ["--root", root, "--home", `${home}${"x".repeat(8192)}`],
    ["--root", root, "--home", `${home}\nPRIVATE`],
    ["--root", root, "--home", home, "--operator"],
    ["--root", root, "--home", home, "--unknown"],
  ]) {
    let starts = 0;
    const diagnostics: string[] = [];
    const code = await runMcpStdioEntry(args, {
      start() {
        starts++;
      },
      writeError(line) {
        diagnostics.push(line);
      },
    });
    expect(code).toBe(2);
    expect(starts).toBe(0);
    expect(diagnostics).toEqual(["hearth:mcp: invalid stdio arguments.\n"]);
  }
});

test("producer failure and unavailable diagnostics retain fixed failure outcomes without raw errors", async () => {
  const privateError = Error("PRIVATE_STARTUP_BODY");
  Object.defineProperty(privateError, "message", {
    get() {
      throw Error("raw startup getter evaluated");
    },
  });
  const diagnostics: string[] = [];
  let starts = 0;
  const deps = {
    start() {
      starts++;
      throw privateError;
    },
    writeError(line: string) {
      diagnostics.push(line);
      throw Error("unavailable stderr fixture");
    },
  };
  expect(await runMcpStdioEntry(["--root", root, "--home", home], deps)).toBe(
    1,
  );
  expect(await runMcpStdioEntry(["--operator"], deps)).toBe(2);
  expect(starts).toBe(1);
  expect(diagnostics).toEqual([
    "hearth:mcp: stdio startup failed.\n",
    "hearth:mcp: invalid stdio arguments.\n",
  ]);
});

test("the packaged producer remains agent-only across Forge and Council without bootstrapping its home", async () => {
  const place = mkdtempSync(join(tmpdir(), "forge-mcp-stdio-"));
  mkdirSync(join(place, ".git"));
  const stateHome = join(place, "absent-home");
  const contexts: McpStdioContext[] = [];
  let tokenReads = 0,
    exchanges = 0;
  try {
    await runMcpStdioEntry(["--root", place, "--home", stateHome], {
      start(context) {
        contexts.push(context);
      },
      writeError() {},
    });
    const context = contexts[0];
    if (!context) throw Error("Missing fixture context");
    const options = await createAgentMcpStdioOptions(context);
    expect(options.operator).toBe(false);
    expect(options.diagnosticMode).toBe("generic");
    const server = await createHearthMcpServer({
      ...options,
      readToken() {
        tokenReads++;
        return null;
      },
      exchange: async () => {
        exchanges++;
        throw Error("No fixture exchange admitted");
      },
    });
    const client = new Client(
      { name: "isolated-mcp-fixture", version: "1" },
      { capabilities: {} },
    );
    const [near, far] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(far);
      await client.connect(near);
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain("forge_runs_list");
      expect(names).toContain("council_profiles");
      for (const name of ["forge_council_start", "council_start"]) {
        const response = await client.callTool({
          name,
          arguments: { source: "PRIVATE_REQUEST_BODY" },
        });
        expect(response.isError).toBe(true);
        expect(JSON.stringify(response)).toMatch(/operator/i);
        expect(JSON.stringify(response)).not.toContain("PRIVATE_REQUEST_BODY");
      }
      expect(tokenReads).toBe(0);
      expect(exchanges).toBe(0);
      expect(existsSync(stateHome)).toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(place, { recursive: true, force: true });
  }
});

test("valid stdio selectors bind every namespace without ambient home or workspace fallback", async () => {
  let captured: unknown = null;
  const diagnostics: string[] = [];
  expect(
    await runMcpStdioEntry(["--home", home, "--root", root], {
      start(context) {
        captured = context;
      },
      writeError(line) {
        diagnostics.push(line);
      },
    }),
  ).toBe(0);
  expect(captured).toEqual({
    root,
    home,
    harnessRoot: root,
    workspaceRoot: root,
    runsRoot: join(root, "reports", "council-runs"),
    reviewHome: home,
    ledgerPath: join(home, "ledger.db"),
  });
  expect(Object.isFrozen(captured)).toBe(true);
  expect(diagnostics).toEqual([]);
});
