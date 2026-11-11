import { writeSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { HearthMcpOptions } from "./mcp";

export const MCP_STDIO_FLAG = "--mcp-stdio";
export interface McpStdioContext {
  readonly root: string;
  readonly home: string;
  readonly harnessRoot: string;
  readonly workspaceRoot: string;
  readonly runsRoot: string;
  readonly reviewHome: string;
  readonly ledgerPath: string;
}
export interface McpStdioEntryDeps {
  start(context: McpStdioContext): void | Promise<void>;
  writeError(line: string): void;
}

type AgentStdioOptions = Omit<
  HearthMcpOptions,
  "operator" | "gone" | "keepCouncilOpen"
> & {
  readonly operator: false;
  readonly diagnosticMode: "generic";
};

/** No ambient namespace or actor identity enters the packaged agent bridge. */
export async function createAgentMcpStdioOptions(
  context: McpStdioContext,
): Promise<AgentStdioOptions> {
  const bound = selectors(["--root", context.root, "--home", context.home]);
  if (!bound) throw Error("Invalid agent stdio context.");
  const [{ createCouncilMcpServer }, { operatorCouncilLedger }] =
    await Promise.all([
      import("../council/mcp"),
      import("../council/ledger-wiring"),
    ]);
  return Object.freeze({
    root: bound.root,
    home: bound.home,
    operator: false as const,
    diagnosticMode: "generic" as const,
    council: () =>
      createCouncilMcpServer({
        harnessRoot: bound.harnessRoot,
        workspaceRoot: bound.workspaceRoot,
        runsRoot: bound.runsRoot,
        reviewHome: bound.reviewHome,
        environment: { AGENT_FORGE_HOME: bound.home },
        ...operatorCouncilLedger({ path: bound.ledgerPath }),
      }),
  });
}

/** Closed agent-only grammar, checked before any service/council/ledger import. */
function selectors(args: readonly string[]): McpStdioContext | null {
  if (args.length !== 4) return null;
  let root: string | null = null;
  let home: string | null = null;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      !value ||
      value.length > 8192 ||
      /[\0\r\n]/.test(value) ||
      !isAbsolute(value)
    )
      return null;
    if (flag === "--root" && root === null) root = value;
    else if (flag === "--home" && home === null) home = value;
    else return null;
  }
  if (root === null || home === null) return null;
  const servedRoot = resolve(root),
    stateHome = resolve(home);
  return Object.freeze({
    root: servedRoot,
    home: stateHome,
    harnessRoot: servedRoot,
    workspaceRoot: servedRoot,
    runsRoot: join(servedRoot, "reports", "council-runs"),
    reviewHome: stateHome,
    ledgerPath: join(stateHome, "ledger.db"),
  });
}

const production: McpStdioEntryDeps = {
  async start(context) {
    const options = await createAgentMcpStdioOptions(context);
    const { serveHearthMcp } = await import("./mcp");
    serveHearthMcp(options);
  },
  writeError(line) {
    writeSync(2, line);
  },
};

export async function runMcpStdioEntry(
  args: readonly string[],
  deps: McpStdioEntryDeps = production,
): Promise<number> {
  const report = (line: string) => {
    try {
      deps.writeError(line);
    } catch {
      /* Diagnostic failure cannot authorize startup. */
    }
  };
  const context = selectors(args);
  if (!context) {
    report("hearth:mcp: invalid stdio arguments.\n");
    return 2;
  }
  try {
    await deps.start(context);
    return 0;
  } catch {
    report("hearth:mcp: stdio startup failed.\n");
    return 1;
  }
}
