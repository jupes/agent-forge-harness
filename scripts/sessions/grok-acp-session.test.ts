import { resolve } from "node:path";
import { expect, test, vi } from "bun:test";
import type { ChildExit } from "../executors/types";
import type { InteractiveSuperviseOptions } from "../executors/supervisor";
import { createGrokAcpSessionActor, type GrokActorSnapshot, type GrokStartResult } from "./grok-acp-session";
import { ACP_WIRE_LIMITS } from "./acp-wire";

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


type FakePlan = {
  initResult?: unknown;
  openResult?: unknown;
  initResponseId?: (id: number) => number | string;
  openResponseId?: (id: number) => number | string;
  initError?: boolean;
  openError?: boolean;
  initUpdate?: boolean;
  openUpdate?: boolean;
  skipResponse?: "initialize" | "session/new";
  failWrite?: boolean;
  spawnFailure?: boolean;
  holdStop?: boolean;
  malformedAt?: "initialize" | "session/new";
  permissionAt?: "initialize" | "session/new";
  duplicateAt?: "initialize" | "session/new";
  holdWriteAt?: "initialize" | "session/new";
  earlyResponse?: boolean;
  deferPid?: boolean;
  rejectStop?: boolean;
};

function actorFixture(plan: FakePlan = {}) {
  const writes: string[] = [];
  let stopCalls = 0;
  let spawnCalls = 0;
  let line: (value: string) => void = () => undefined;
  let outputError: () => void = () => undefined;
  let resolveDone: (exit: ChildExit) => void = () => undefined;
  let rejectDone: (error: Error) => void = () => undefined;
  const done = new Promise<ChildExit>((resolveDonePromise, rejectDonePromise) => { resolveDone = resolveDonePromise; rejectDone = rejectDonePromise; });
  let resolvePid: (pid: number) => void = () => undefined;
  const providerPid = plan.deferPid ? new Promise<number>((resolvePidPromise) => { resolvePid = resolvePidPromise; }) : Promise.resolve(52);
  let releaseWrite: () => void = () => undefined;
  let heldWrite: Promise<void> | null = null;
  let resolveHeld: () => void = () => undefined;
  const heldSignal = new Promise<void>((resolveSignal) => { resolveHeld = resolveSignal; });
  let resolveOwnerReady: () => void = () => undefined;
  const ownerReady = new Promise<void>((resolveSignal) => { resolveOwnerReady = resolveSignal; });
  let resolveInitEntry: () => void = () => undefined;
  let resolveOpenEntry: () => void = () => undefined;
  const initEntry = new Promise<void>((resolveSignal) => { resolveInitEntry = resolveSignal; });
  const openEntry = new Promise<void>((resolveSignal) => { resolveOpenEntry = resolveSignal; });
  let writeReleased = false;
  const actor = createGrokAcpSessionActor({
    executable: resolve("fixture", "grok.exe"),
    cwd: resolve("fixture", "repo"),
    env: { PATH: "inert-path", AGENT_FORGE_ADAPTER: "1" },
    supervise: (options) => {
      spawnCalls += 1;
      resolveOwnerReady();
      if (plan.spawnFailure) throw new Error("private spawn detail");
      line = options.onLine;
      outputError = options.onOutputError ?? (() => undefined);
      return {
        pid: 51,
        providerPid,
        done,
        stop: async () => {
          stopCalls += 1;
          if (plan.rejectStop) throw new Error("private stop failure");
          if (!plan.holdStop) resolveDone({ exitCode: 0, timedOut: false, stopped: true, ownedTreeReleased: true, stderr: "" });
        },
        write: async (wire) => {
          writes.push(wire);
          if (plan.failWrite) throw new Error("inert write rejection");
          let request: { id: number; method: string } | null = null;
          try {
            const parsed: unknown = JSON.parse(wire);
            if (typeof parsed === "object" && parsed !== null && "id" in parsed && typeof parsed.id === "number" && "method" in parsed && typeof parsed.method === "string")
              request = { id: parsed.id, method: parsed.method };
          } catch {
            return;
          }
          if (!request) return;
          if (request.method === "initialize") resolveInitEntry();
          if (request.method === "session/new") resolveOpenEntry();
          if (plan.skipResponse === request.method) return;
          const isInitialize = request.method === "initialize";
          if ((isInitialize && plan.initUpdate) || (!isInitialize && plan.openUpdate)) {
            options.onLine(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "foreign", update: { sessionUpdate: "agent_message_chunk" } } }));
            return;
          }
          const stage = isInitialize ? "initialize" : "session/new";
          const id = isInitialize
            ? (plan.initResponseId?.(request.id) ?? request.id)
            : (plan.openResponseId?.(request.id) ?? request.id);
          if (plan.malformedAt === stage) { options.onLine("{"); return; }
          if (plan.permissionAt === stage) { options.onLine(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "session/request_permission", params: {} })); return; }
          if ((isInitialize && plan.initError) || (!isInitialize && plan.openError)) {
            options.onLine(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "private error", data: { secret: "private" } } }));
            return;
          }
          const result = isInitialize
            ? (plan.initResult ?? { protocolVersion: 1 })
            : (plan.openResult ?? { sessionId: "inert-session-1" });
          const raw = JSON.stringify({ jsonrpc: "2.0", id, result });
          if (plan.holdWriteAt === stage) {
            if (plan.earlyResponse) options.onLine(raw);
            heldWrite = new Promise<void>((resolveWrite) => { releaseWrite = () => { if (writeReleased) throw new Error("write released twice"); writeReleased = true; resolveWrite(); }; });
            resolveHeld();
            return heldWrite;
          }
          options.onLine(raw);
          if (plan.duplicateAt === stage) options.onLine(raw);
        },
        end: async () => undefined,
      };
    },
  });
  return {
    actor,
    writes,
    stopCalls: () => stopCalls,
    spawnCalls: () => spawnCalls,
    waitForOwner: () => ownerReady,
    line: (value: string) => line(value),
    failOutput: () => outputError(),
    finish: (exit: ChildExit) => resolveDone(exit),
    resolvePid: () => resolvePid(52),
    releaseWrite: () => releaseWrite(),
    waitForHeldWrite: () => heldSignal,
    waitForWrite: (stage: "initialize" | "session/new") => stage === "initialize" ? initEntry : openEntry,
    writeHeld: () => heldWrite !== null,
    rejectDone: (error: Error) => rejectDone(error),
    done,
  };
}

async function openedFixture(plan: FakePlan = {}) {
  const fixture = actorFixture(plan);
  const result = await fixture.actor.startAndOpen();
  return { ...fixture, result, snapshot: fixture.actor.snapshot() };
}

test("concurrent start is singleflight and opened calls reuse the same handle", async () => {
  const fixture = actorFixture({
    initResult: {
      protocolVersion: 1,
      agentInfo: { name: "Grok", version: "untrusted" },
      authMethods: [{ id: "grok.com", name: "Grok account" }],
      _meta: { authenticated: true },
    },
  });
  const first = fixture.actor.startAndOpen();
  const second = fixture.actor.startAndOpen();
  const [a, b] = await Promise.all([first, second]);
  expect(a).toBe(b);
  expect(fixture.spawnCalls()).toBe(1);
  const firstSnapshot = fixture.actor.snapshot();
  const secondSnapshot = fixture.actor.snapshot();
  expect(firstSnapshot).toEqual(secondSnapshot);
  expect(firstSnapshot).not.toBe(secondSnapshot);
  if (firstSnapshot.state === "opened" && secondSnapshot.state === "opened")
    expect(firstSnapshot.handle).toBe(secondSnapshot.handle);
  expect(Object.isFrozen(firstSnapshot)).toBe(true);
  try { Object.assign(firstSnapshot, { state: "cold" }); } catch { /* frozen snapshot */ }
  expect(fixture.actor.snapshot().state).toBe("opened");
  if (a.kind === "opened") {
    expect(a.handle.authentication).toBe("unknown");
    expect(a.handle.identity).toBe("unverified");
    expect(JSON.stringify({ result: a, snapshot: fixture.actor.snapshot() })).not.toContain("Grok");
  }
  expect(await fixture.actor.startAndOpen()).toBe(a);
  await fixture.actor.close();
  await fixture.done;
});

test("session ID applies the harness code-unit bound without trimming or UUID assumptions", async () => {
  const valid = await openedFixture({ openResult: { sessionId: " spaced id " } });
  expect(valid.result.kind).toBe("opened");
  await valid.actor.close();
  await valid.done;
  const boundary = await openedFixture({ openResult: { sessionId: "x".repeat(200) } });
  expect(boundary.result.kind).toBe("opened");
  await boundary.actor.close();
  await boundary.done;
  for (const sessionId of ["", "x".repeat(201), "bad\u0000id", "bad\uD800", "bad\uDC00"]) {
    const invalidId = await openedFixture({ openResult: { sessionId } });
    expect(invalidId.result).toMatchObject({ kind: "failed", reason: "session-open-rejected" });
    expect(invalidId.snapshot.state).not.toBe("opened");
    await invalidId.actor.close();
    await invalidId.done;
  }
});

test("initialize rejects errors, mismatched typed IDs, unsupported versions, malformed inventory, and updates", async () => {
  const plans: FakePlan[] = [
    { initError: true },
    { initResponseId: (id) => String(id) },
    { initResult: { protocolVersion: 2 } },
    { initResult: { protocolVersion: 1, authMethods: [{ id: "dup", name: "A" }, { id: "dup", name: "B" }] } },
    { initUpdate: true },
    { malformedAt: "initialize" },
    { permissionAt: "initialize" },
    { duplicateAt: "initialize" },
  ];
  for (const plan of plans) {
    const fixture = await openedFixture(plan);
    expect(fixture.result).toMatchObject({ kind: "failed" });
    expect(fixture.snapshot.state).not.toBe("opened");
    await fixture.actor.close();
    await fixture.done;
  }
});

test("session/new rejects errors, mismatched typed IDs, malformed results, and updates", async () => {
  const plans: FakePlan[] = [
    { openError: true },
    { openResponseId: (id) => String(id) },
    { openResult: {} },
    { openResult: { sessionId: 7 } },
    { openUpdate: true },
    { malformedAt: "session/new" },
    { permissionAt: "session/new" },
    { duplicateAt: "session/new" },
  ];
  for (const plan of plans) {
    const fixture = await openedFixture(plan);
    expect(fixture.result).toMatchObject({ kind: "failed" });
    expect(fixture.snapshot.state).not.toBe("opened");
    await fixture.actor.close();
    await fixture.done;
  }
});

test("late unsolicited frames and process exit invalidate an opened handle", async () => {
  const late = await openedFixture();
  expect(late.result.kind).toBe("opened");
  late.line(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "foreign", update: { sessionUpdate: "agent_message_chunk" } } }));
  expect(late.actor.snapshot().state).not.toBe("opened");
  late.line(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }));
  expect(late.actor.snapshot().state).not.toBe("opened");
  await late.actor.close();
  await late.done;

  const exited = await openedFixture();
  exited.finish({ exitCode: null, timedOut: true, stopped: false, stderr: "" });
  await exited.done;
  expect(exited.actor.snapshot().state).toBe("cleanup-pending");
  expect(await exited.actor.close()).toEqual({ kind: "pending" });
});

test("cleanup retains the same owner until its done result proves tree release", async () => {
  const fixture = actorFixture({ holdStop: true });
  const result = await fixture.actor.startAndOpen();
  expect(result.kind).toBe("opened");
  expect(await fixture.actor.close()).toEqual({ kind: "pending" });
  expect(await fixture.actor.dispose()).toEqual({ kind: "pending" });
  expect(fixture.stopCalls()).toBe(1);
  expect(fixture.actor.snapshot().state).toBe("cleanup-pending");
  expect((await fixture.actor.startAndOpen()).kind).toBe("failed");
  expect(fixture.spawnCalls()).toBe(1);
  fixture.finish({ exitCode: 0, timedOut: false, stopped: true, ownedTreeReleased: true, stderr: "" });
  await fixture.done;
  expect(fixture.actor.snapshot().state).toBe("closed");
  expect(await fixture.actor.close()).toEqual({ kind: "released" });
});

test("write failure and output overflow fail closed without provider details", async () => {
  const writeFailure = await openedFixture({ failWrite: true });
  expect(writeFailure.result.kind).toBe("failed");
  expect(JSON.stringify(writeFailure.result)).not.toContain("inert write rejection");
  await writeFailure.actor.close();
  await writeFailure.done;

  const rejectedDone = actorFixture({ holdStop: true });
  await rejectedDone.actor.startAndOpen();
  expect(await rejectedDone.actor.close()).toEqual({ kind: "pending" });
  rejectedDone.rejectDone(new Error("private teardown detail"));
  await rejectedDone.done.catch(() => undefined);
  expect(rejectedDone.actor.snapshot().state).toBe("cleanup-pending");
  expect(JSON.stringify(rejectedDone.actor.snapshot())).not.toContain("private teardown detail");

  const overflow = actorFixture({ skipResponse: "initialize" });
  const started = overflow.actor.startAndOpen();
  await overflow.waitForWrite("initialize");
  overflow.failOutput();
  const result = await started;
  expect(result.kind).toBe("failed");
  expect(JSON.stringify(result)).not.toContain("private");
  await overflow.actor.close();
  await overflow.done;
});

test("spawn refusal remains fixed and does not invent an owner", async () => {
  const fixture = actorFixture({ spawnFailure: true });
  const result = await fixture.actor.startAndOpen();
  expect(result).toMatchObject({ kind: "failed", reason: "spawn-failed", cleanup: { kind: "released" } });
  expect(JSON.stringify(result)).not.toContain("private spawn detail");
  expect(fixture.spawnCalls()).toBe(1);
  expect(fixture.stopCalls()).toBe(0);
  expect(fixture.actor.snapshot().state).toBe("closed");
});


test("factory captures mutable owner options once before start", async () => {
  const originalExecutable = resolve("captured-fixture", "grok.exe");
  const originalCwd = resolve("captured-fixture", "repo");
  const originalPath = "captured-path";
  let ownerOptions: Parameters<typeof createGrokAcpSessionActor>[0];
  const launchHolder: { current: InteractiveSuperviseOptions | null } = { current: null };
  const writes: string[] = [];
  let doneResolve: (exit: ChildExit) => void = () => undefined;
  const done = new Promise<ChildExit>((resolveDone) => { doneResolve = resolveDone; });
  const originalSupervisor = (options: InteractiveSuperviseOptions) => {
    launchHolder.current = options;
    return {
      pid: 71, providerPid: Promise.resolve(72), done,
      stop: async () => doneResolve({ exitCode: 0, timedOut: false, stopped: true, ownedTreeReleased: true, stderr: "" }),
      write: async (wire: string) => {
        writes.push(wire);
        const request = JSON.parse(wire) as { id: number; method: string };
        const result = request.method === "initialize" ? { protocolVersion: 1 } : { sessionId: "captured-session" };
        if (request.method === "initialize") {
          ownerOptions.executable = resolve("handshake-mutated", "other.exe");
          ownerOptions.cwd = resolve("handshake-mutated", "other-repo");
          ownerOptions.env.PATH = "handshake-mutated";
          ownerOptions.env.AGENT_FORGE_ADAPTER = "handshake-mutated";
          ownerOptions.supervise = () => { throw new Error("replacement supervisor must not run"); };
        }
        options.onLine(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
      },
      end: async () => undefined,
    };
  };
  ownerOptions = {
    executable: originalExecutable,
    cwd: originalCwd,
    env: { PATH: originalPath, AGENT_FORGE_ADAPTER: "captured" },
    supervise: originalSupervisor,
  };
  const actor = createGrokAcpSessionActor(ownerOptions);
  ownerOptions.executable = resolve("prestart-mutated", "other.exe");
  ownerOptions.cwd = resolve("prestart-mutated", "other-repo");
  ownerOptions.env.PATH = "prestart-mutated";
  ownerOptions.env.AGENT_FORGE_ADAPTER = "prestart-mutated";
  ownerOptions.supervise = () => { throw new Error("replacement supervisor must not run"); };

  const result = await actor.startAndOpen();
  expect(result.kind).toBe("opened");
  const launch = launchHolder.current;
  if (launch === null) throw new Error("captured supervisor did not run");
  expect(launch.command).toEqual([originalExecutable, "--no-auto-update", "agent", "stdio"]);
  expect(launch.cwd).toBe(originalCwd);
  expect(launch.env.PATH).toBe(originalPath);
  expect(launch.env.AGENT_FORGE_ADAPTER).toBe("captured");
  expect(launch.timeoutMs).toBe(30 * 60_000);
  expect(launch.maxStdinBytes).toBe(1_048_576);
  expect(launch.stdinTimeoutMs).toBe(5_000);
  expect(launch.maxLineBytes).toBe(ACP_WIRE_LIMITS.lineBytes);
  expect((JSON.parse(writes[1]!) as { params: { cwd: string } }).params.cwd).toBe(originalCwd);
  await actor.close();
  await done;
});

test("held writes cannot be bypassed or hang after invalidation at either protocol phase", async () => {
  for (const phase of ["initialize", "session/new"] as const) {
    const early = actorFixture({ holdWriteAt: phase, earlyResponse: true });
    const earlyStart = early.actor.startAndOpen();
    await early.waitForHeldWrite();
    expect(early.writeHeld()).toBe(true);
    expect(early.writes.length).toBe(phase === "initialize" ? 1 : 2);
    expect(early.actor.snapshot().state).not.toBe("opened");
    early.releaseWrite();
    const earlyResult = await earlyStart;
    expect(earlyResult.kind).toBe("opened");
    expect(early.actor.snapshot().state).toBe("opened");
    expect(early.writes.length).toBe(2);
    await early.actor.close();
    await early.done;

    for (const event of ["wrong-frame", "close", "done"] as const) {
      const held = actorFixture({ holdWriteAt: phase, earlyResponse: event !== "wrong-frame" });
      const started = held.actor.startAndOpen();
      await held.waitForHeldWrite();
      expect(held.writeHeld()).toBe(true);
      expect(held.actor.snapshot().state).not.toBe("opened");
      if (event === "wrong-frame") held.line(JSON.stringify({ jsonrpc: "2.0", id: 999, result: {} }));
      if (event === "close") await held.actor.close();
      if (event === "done") held.finish({ exitCode: null, timedOut: false, stopped: false, stderr: "" });
      const failed = await started;
      expect(failed.kind).toBe("failed");
      held.releaseWrite();
      if (event !== "done") await held.actor.close();
      expect(held.actor.snapshot().state).not.toBe("opened");
      expect(held.writes.length).toBe(phase === "initialize" ? 1 : 2);
      await held.done.catch(() => undefined);
      expect(held.spawnCalls()).toBe(1);
    }
  }
});

test("deferred provider PID races close and premature exit without spawning a replacement", async () => {
  const closed = actorFixture({ deferPid: true, holdStop: true });
  const starting = closed.actor.startAndOpen();
  await closed.waitForOwner();
  expect(closed.spawnCalls()).toBe(1);
  expect(await closed.actor.close()).toEqual({ kind: "pending" });
  expect((await starting).kind).toBe("failed");
  closed.resolvePid();
  expect(closed.spawnCalls()).toBe(1);
  expect(closed.actor.snapshot().state).toBe("cleanup-pending");
  closed.finish({ exitCode: 0, timedOut: false, stopped: true, ownedTreeReleased: true, stderr: "" });
  await closed.done;
  expect(closed.actor.snapshot().state).toBe("closed");

  const exited = actorFixture({ deferPid: true });
  const exitStarting = exited.actor.startAndOpen();
  await exited.waitForOwner();
  exited.finish({ exitCode: 2, timedOut: false, stopped: false, stderr: "" });
  const failed = await exitStarting;
  expect(failed.kind).toBe("failed");
  expect(exited.stopCalls()).toBe(1);
  exited.resolvePid();
  expect(exited.writes.length).toBe(0);
  expect(exited.spawnCalls()).toBe(1);
  expect(exited.actor.snapshot().state).toBe("cleanup-pending");
});

test("one monotonic deadline preserves only the remaining time for session/new", async () => {
  vi.useFakeTimers();
  let monotonic = 400;
  let wallClock = 2_000_000;
  const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => monotonic);
  const wallSpy = vi.spyOn(Date, "now").mockImplementation(() => wallClock);
  try {
    const fixture = actorFixture({
      holdWriteAt: "initialize",
      earlyResponse: true,
      skipResponse: "session/new",
    });
    const started = fixture.actor.startAndOpen();
    await fixture.waitForHeldWrite();
    expect(fixture.actor.snapshot().state).toBe("initializing");

    monotonic += 29_999;
    wallClock -= 10_000_000;
    vi.advanceTimersByTime(29_999);
    fixture.releaseWrite();
    await fixture.waitForWrite("session/new");
    expect(fixture.writes.length).toBe(2);
    expect(fixture.actor.snapshot().state).toBe("opening");
    expect(vi.getTimerCount()).toBe(1);

    monotonic += 1;
    wallClock -= 10_000_000;
    vi.advanceTimersByTime(1);
    expect(await started).toMatchObject({ kind: "failed", reason: "handshake-timeout" });
    expect(fixture.actor.snapshot().state).not.toBe("opened");
    expect(fixture.writes.length).toBe(2);
    await fixture.actor.close();
    await fixture.done;
  } finally {
    wallSpy.mockRestore();
    nowSpy.mockRestore();
    vi.useRealTimers();
  }
});

test("a rejected unreleased owner remains unknown after late PID resolution", async () => {
  const fixture = actorFixture({ deferPid: true, holdStop: true });
  const started = fixture.actor.startAndOpen();
  await fixture.waitForOwner();
  fixture.rejectDone(new Error("private done failure"));
  expect((await started).kind).toBe("failed");
  expect(fixture.actor.snapshot().state).toBe("cleanup-pending");
  fixture.resolvePid();
  expect(fixture.writes.length).toBe(0);
  expect(fixture.actor.snapshot().state).toBe("cleanup-pending");
  expect(fixture.stopCalls()).toBe(1);
  await fixture.actor.close();
  expect(fixture.stopCalls()).toBe(1);
});


test("done settles ownership proof once and never upgrades an unreleased result", async () => {
  const pending = actorFixture({ holdStop: true });
  expect((await pending.actor.startAndOpen()).kind).toBe("opened");
  expect(await pending.actor.close()).toEqual({ kind: "pending" });
  const releasedExit: ChildExit = {
    exitCode: 0, timedOut: false, stopped: true, ownedTreeReleased: true, stderr: "",
  };
  pending.finish(releasedExit);
  await pending.done;
  expect(pending.actor.snapshot().state).toBe("closed");

  const unknown = actorFixture({ holdStop: true });
  expect((await unknown.actor.startAndOpen()).kind).toBe("opened");
  const unreleasedExit: ChildExit = {
    exitCode: 0, timedOut: false, stopped: true, stderr: "",
  };
  unknown.finish(unreleasedExit);
  await unknown.done;
  expect(unknown.actor.snapshot().state).toBe("cleanup-pending");
  Object.assign(unreleasedExit, { ownedTreeReleased: true });
  expect(unknown.actor.snapshot().state).toBe("cleanup-pending");
  expect(await unknown.actor.close()).toEqual({ kind: "pending" });
  expect(unknown.stopCalls()).toBe(1);
});

test("initialize timeout, raw line cap, and rejected stop preserve bounded ownership", async () => {
  vi.useFakeTimers();
  let monotonic = 900;
  const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => monotonic);
  try {
    const initTimeout = actorFixture({ skipResponse: "initialize", holdStop: true });
    const starting = initTimeout.actor.startAndOpen();
    await initTimeout.waitForWrite("initialize");
    monotonic += 30_000;
    vi.advanceTimersByTime(30_000);
    expect(await starting).toMatchObject({ kind: "failed", reason: "handshake-timeout", cleanup: { kind: "pending" } });
    expect(initTimeout.stopCalls()).toBe(1);
    expect(initTimeout.actor.snapshot().state).toBe("cleanup-pending");
    await initTimeout.actor.close();
    expect(initTimeout.stopCalls()).toBe(1);
    initTimeout.finish({ exitCode: null, timedOut: true, stopped: true, stderr: "" });
    await initTimeout.done;

    const oversize = actorFixture({ skipResponse: "initialize" });
    const oversizeStart = oversize.actor.startAndOpen();
    await oversize.waitForWrite("initialize");
    oversize.line("x".repeat(ACP_WIRE_LIMITS.lineBytes + 1));
    expect((await oversizeStart).kind).toBe("failed");
    expect(oversize.actor.snapshot().state).not.toBe("opened");
    await oversize.actor.close();
    await oversize.done;

    const stopRejected = actorFixture({ rejectStop: true, holdStop: true });
    expect((await stopRejected.actor.startAndOpen()).kind).toBe("opened");
    expect(await stopRejected.actor.close()).toEqual({ kind: "pending" });
    expect(await stopRejected.actor.dispose()).toEqual({ kind: "pending" });
    expect(stopRejected.stopCalls()).toBe(1);
    expect(stopRejected.actor.snapshot().state).toBe("cleanup-pending");
    stopRejected.finish({ exitCode: 0, timedOut: false, stopped: true, stderr: "" });
    await stopRejected.done;
    expect(stopRejected.actor.snapshot().state).toBe("cleanup-pending");
  } finally {
    nowSpy.mockRestore();
    vi.useRealTimers();
  }
});
