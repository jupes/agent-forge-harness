import { resolve } from "node:path";
import { expect, test } from "bun:test";
import type { ChildExit } from "../executors/types";
import { createGrokAcpSessionActor, type GrokActorSnapshot, type GrokStartResult } from "./grok-acp-session";

function isOpened(snapshot: GrokActorSnapshot, result: GrokStartResult): boolean {
  return result.kind === "opened" && snapshot.state === "opened" && snapshot.handle === result.handle;
}

test("valid raw initialize and session/new frames admit the current owned handle", async () => {
  const writes: string[] = [];
  const fakeExecutable = resolve("inert-fixture", "grok.exe");
  const fakeCwd = resolve("workspace-fixture", "repo");
  let launchCommand: string[] = [];
  let launchCwd = "";
  let launchEnv: Record<string, string> = {};
  let stopCalls = 0;
  let resolveDone: (exit: ChildExit) => void = () => undefined;
  const done = new Promise<ChildExit>((resolveDonePromise) => { resolveDone = resolveDonePromise; });
  const actor = createGrokAcpSessionActor({
    executable: fakeExecutable,
    cwd: fakeCwd,
    env: { PATH: "C:/safe/bin", AGENT_FORGE_ADAPTER: "1" },
    supervise: (options) => {
      launchCommand = options.command;
      launchCwd = options.cwd;
      launchEnv = options.env;
      return {
        pid: 41,
        providerPid: Promise.resolve(42),
        done,
        stop: async () => {
          stopCalls += 1;
          resolveDone({ exitCode: 0, timedOut: false, stopped: true, ownedTreeReleased: true, stderr: "" });
        },
        write: async (wire) => {
          writes.push(wire);
          let request: { id: number; method: string };
          try { request = JSON.parse(wire) as { id: number; method: string }; }
          catch { return; }
          const result = request.method === "initialize" ? { protocolVersion: 1 } : { sessionId: "inert-session-1" };
          options.onLine(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
        },
        end: async () => undefined,
      };
    },
  });
  const parse = (wire: string | undefined): unknown => {
    try { return JSON.parse(wire ?? "null"); } catch { return null; }
  };
  let result: GrokStartResult | null = null;
  let snapshot: GrokActorSnapshot | null = null;
  try {
    result = await actor.startAndOpen();
    snapshot = actor.snapshot();
    const exactRequests = writes.length === 2 &&
      JSON.stringify(parse(writes[0])) === JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "agent-forge-harness", version: "1" } },
      }) &&
      JSON.stringify(parse(writes[1])) === JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "session/new",
        params: { cwd: fakeCwd, mcpServers: [] },
      });
    const launchContract = JSON.stringify(launchCommand) === JSON.stringify([
      fakeExecutable, "--no-auto-update", "agent", "stdio",
    ]) && launchCwd === fakeCwd && launchEnv.PATH === "C:/safe/bin" && launchEnv.AGENT_FORGE_ADAPTER === "1";
    expect(exactRequests).toBe(true);
    expect(launchContract).toBe(true);
  } finally {
    await actor.close();
    await done;
  }
  expect(stopCalls).toBe(1);
  expect(result !== null && snapshot !== null && isOpened(snapshot, result)).toBe(true);
});
