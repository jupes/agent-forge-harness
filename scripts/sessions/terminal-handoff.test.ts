import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import type { TerminalHandoffAttempt } from "../../types/session-terminal-handoff";
import type { SessionTurnSnapshot } from "../../types/session-turn";
import { ConversationError } from "../conversations/error";
import { writeOwnerOnly } from "../hearth/token";
import {
  type launchWindowsConsole,
  type NativeConsoleChild,
  type NativeConsoleExit,
  type NativeConsoleLaunchOptions,
  NativeConsoleNotStartedError,
} from "../providers/native-console";
import { scratchDirs } from "../test-scratch";
import {
  createSessionTerminalHandoff,
  readTerminalHandoffInventory,
} from "./terminal-handoff";

const scratch = scratchDirs();
const services: Array<ReturnType<typeof createSessionTerminalHandoff>> = [];
afterEach(async () => {
  for (const service of services.splice(0).reverse()) await service.close();
  scratch.cleanup();
});

const finish = (exitCode = 0): NativeConsoleExit => ({
  exitCode,
  stopped: false,
  timedOut: false,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
function fixture(
  launch?: typeof launchWindowsConsole,
  admit?: Parameters<typeof createSessionTerminalHandoff>[0]["admit"],
) {
  const root = scratch.make("terminal-handoff-"),
    home = join(root, "home"),
    projectId = "project-fixture",
    sessionId = randomUUID(),
    turnRequestId = randomUUID(),
    nativeSessionId = randomUUID();
  mkdirSync(join(root, ".git"));
  const snapshot: SessionTurnSnapshot = {
    version: 1,
    provider: "claude",
    smith: "fixture",
    cwd: root,
    launch: {
      mode: "chat",
      model: "claude-sonnet-4-5",
      prompt:
        "private original input must never be persisted in the handoff journal",
      permissionMode: "plan",
    },
    capabilities: {
      version: "2.1.42",
      flags: ["--resume", "--model", "--permission-mode", "--allowedTools"],
    },
  };
  const service = createSessionTerminalHandoff({
    home,
    root,
    async candidate(selectedProject, selectedSession) {
      return {
        projectId: selectedProject,
        sessionId: selectedSession,
        turnRequestId,
        nativeSessionId,
        executable: "C:\\fixture\\claude.exe",
        cwd: root,
        snapshot,
        env: { SystemRoot: "C:\\Windows" },
      };
    },
    ...(launch ? { launch } : {}),
    ...(admit ? { admit } : {}),
  });
  services.push(service);
  return {
    root,
    home,
    projectId,
    sessionId,
    turnRequestId,
    nativeSessionId,
    service,
  };
}

test("terminal inventory accepts a protected initialized namespace without a journal and preserves malformed or active evidence", async () => {
  const f = fixture(() => {
    throw Error("No native launcher is permitted in this inventory case");
  });
  expect(await f.service.read(f.projectId, f.sessionId)).toEqual({
    attempt: null,
  });
  expect(
    await f.service.send(f.projectId, f.sessionId, async () => "sent"),
  ).toBe("sent");
  const parent = join(f.home, "session-terminal-handoffs"),
    name = readdirSync(parent)[0];
  if (!name || !/^[a-f0-9]{32}$/.test(name))
    throw Error("Expected one protected fixture namespace");
  const namespace = join(parent, name),
    file = join(namespace, "attempts.json"),
    before = readdirSync(namespace).sort();
  expect(existsSync(file)).toBe(false);
  expect(before.length).toBeGreaterThan(0);
  expect(readTerminalHandoffInventory(f.home, [namespace])).toEqual([]);
  expect(readdirSync(namespace).sort()).toEqual(before);
  writeOwnerOnly(file, "{malformed");
  expect(() => readTerminalHandoffInventory(f.home, [namespace])).toThrow();
  const attempt: TerminalHandoffAttempt = {
    projectId: f.projectId,
    sessionId: f.sessionId,
    turnRequestId: f.turnRequestId,
    requestId: randomUUID(),
    phase: "opening",
    startedAt: new Date().toISOString(),
    endedAt: null,
    auditEventId: 1,
  };
  writeOwnerOnly(file, JSON.stringify({ version: 1, attempts: [attempt] }));
  expect(readTerminalHandoffInventory(f.home, [namespace])).toEqual([attempt]);
  linkSync(file, join(namespace, "linked-copy.json"));
  expect(() => readTerminalHandoffInventory(f.home, [namespace])).toThrow();
});

test("an opened terminal is not replayed after service restart and holds app sends", async () => {
  const invoked: NativeConsoleLaunchOptions[] = [];
  const completion = deferred<NativeConsoleExit>();
  let stopCalls = 0;
  const launcher: typeof launchWindowsConsole = (options) => {
    invoked.push(options);
    const child: NativeConsoleChild = {
      pid: 71,
      done: completion.promise,
      async stop() {
        stopCalls++;
        return completion.promise;
      },
    };
    return child;
  };
  const f = fixture(launcher),
    requestId = randomUUID();
  try {
    const first = await f.service.open(f.projectId, f.sessionId, requestId, 4);
    expect(first.phase).toBe("opened");
    expect(invoked).toHaveLength(1);
    expect(invoked[0]?.command).toEqual([
      "C:\\fixture\\claude.exe",
      "--resume",
      f.nativeSessionId,
      "--model",
      "claude-sonnet-4-5",
      "--permission-mode",
      "plan",
      "--allowedTools",
      expect.any(String),
    ]);
    expect(JSON.stringify(invoked)).not.toContain("private original input");
    expect(invoked[0]?.lifetime).toEqual({ kind: "managed" });
    const handoffRoot = join(f.home, "session-terminal-handoffs"),
      journal = readFileSync(
        join(handoffRoot, readdirSync(handoffRoot)[0] ?? "", "attempts.json"),
        "utf8",
      );
    expect(journal).toContain('"auditEventId":4');
    expect(journal).not.toContain("private original input");
    expect(journal).not.toContain(f.nativeSessionId);
    expect(journal).not.toContain("claude.exe");

    const recovered = await createSessionTerminalHandoff({
      home: f.home,
      root: f.root,
      async candidate() {
        throw new Error("Recovery GET must not prepare a provider");
      },
      launch: launcher,
    });
    services.push(recovered);
    expect(
      (await recovered.read(f.projectId, f.sessionId)).attempt,
    ).toMatchObject({
      requestId,
      phase: "unknown",
    });
    await expect(
      recovered.open(f.projectId, f.sessionId, randomUUID(), 5),
    ).rejects.toThrow("already has an original terminal handoff");
    await expect(
      recovered.send(f.projectId, f.sessionId, async () => "sent"),
    ).rejects.toThrow("app sends are held");
    await expect(
      recovered.open(f.projectId, f.sessionId, requestId, 5),
    ).resolves.toMatchObject({ phase: "unknown", auditEventId: 4 });
    expect(invoked).toHaveLength(1);

    completion.resolve(finish());
    for (let index = 0; index < 50; index++) {
      if (
        (await recovered.read(f.projectId, f.sessionId)).attempt?.phase ===
        "closed"
      )
        break;
      await Bun.sleep(10);
    }
    expect(
      (await recovered.read(f.projectId, f.sessionId)).attempt?.phase,
    ).toBe("closed");
    expect(stopCalls).toBe(0);
  } finally {
    completion.resolve(finish());
  }
});

test("shutdown fences a saved terminal opening while admission is pending without waiting for its release", async () => {
  const entered = deferred<void>(),
    release = deferred<void>();
  let launches = 0;
  const f = fixture(
    () => {
      launches++;
      return {
        pid: 72,
        done: Promise.resolve(finish()),
        stop: async () => finish(),
      };
    },
    async (_projectId, publish) => {
      const result = await publish();
      entered.resolve();
      await release.promise;
      return result;
    },
  );
  const requestId = randomUUID();
  const opening = f.service.open(f.projectId, f.sessionId, requestId, 11).then(
    (value) => ({ kind: "opened" as const, value }),
    (error: unknown) => ({ kind: "rejected" as const, error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await entered.promise;
    const parent = join(f.home, "session-terminal-handoffs"),
      namespaces = readdirSync(parent).map((name) => join(parent, name));
    expect(readTerminalHandoffInventory(f.home, namespaces)).toEqual([
      expect.objectContaining({ requestId, phase: "opening", endedAt: null }),
    ]);
    const closed = await Promise.race([
      f.service.close().then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 1000);
      }),
    ]);
    expect(closed).toBe(true);
    release.resolve();
    const outcome = await opening;
    expect(launches).toBe(0);
    expect(outcome).toMatchObject({ kind: "rejected", error: { status: 503 } });
    expect(
      (await f.service.read(f.projectId, f.sessionId)).attempt,
    ).toMatchObject({
      requestId,
      phase: "refused",
      endedAt: expect.any(String),
    });
    await expect(
      f.service.open(f.projectId, f.sessionId, requestId, 12),
    ).resolves.toMatchObject({ phase: "refused", auditEventId: 11 });
    expect(launches).toBe(0);
  } finally {
    clearTimeout(timer);
    release.resolve();
    await opening;
  }
});

test("reentrant and repeated close share one shutdown promise and stop an owned child once", async () => {
  const completion = deferred<NativeConsoleExit>();
  let stops = 0,
    reentrant: Promise<void> | undefined;
  const f = fixture(() => ({
    pid: 73,
    done: completion.promise,
    async stop() {
      stops++;
      if (stops === 1) reentrant = f.service.close();
      completion.resolve(finish());
      return completion.promise;
    },
  }));
  try {
    await f.service.open(f.projectId, f.sessionId, randomUUID(), 13);
    const closing = f.service.close();
    await closing;
    expect(stops).toBe(1);
    expect(reentrant).toBe(closing);
    expect(f.service.close()).toBe(closing);
  } finally {
    completion.resolve(finish());
  }
});

test("only a source-proven CreateProcess refusal allows a separately reviewed request", async () => {
  let attempts = 0;
  const launcher: typeof launchWindowsConsole = () => {
    attempts++;
    throw new NativeConsoleNotStartedError();
  };
  const f = fixture(launcher),
    firstId = randomUUID();
  await expect(
    f.service.open(f.projectId, f.sessionId, firstId, 7),
  ).rejects.toMatchObject({
    status: 409,
    message: expect.stringContaining("No CLI was started"),
  });
  expect(
    (await f.service.read(f.projectId, f.sessionId)).attempt,
  ).toMatchObject({
    requestId: firstId,
    phase: "refused",
    auditEventId: 7,
  });
  await expect(
    f.service.open(f.projectId, f.sessionId, randomUUID(), 8),
  ).rejects.toBeInstanceOf(ConversationError);
  expect(attempts).toBe(2);
});

test("a launcher error after the native call boundary is unknown and never replayed", async () => {
  let attempts = 0;
  const launcher: typeof launchWindowsConsole = () => {
    attempts++;
    throw new Error("synthetic ambiguous handoff failure");
  };
  const f = fixture(launcher),
    requestId = randomUUID();
  await expect(
    f.service.open(f.projectId, f.sessionId, requestId, 9),
  ).rejects.toMatchObject({
    status: 503,
    message: expect.stringContaining("outcome could not be confirmed"),
  });
  expect(
    (await f.service.read(f.projectId, f.sessionId)).attempt,
  ).toMatchObject({
    requestId,
    phase: "unknown",
  });
  await expect(
    f.service.open(f.projectId, f.sessionId, randomUUID(), 10),
  ).rejects.toThrow("already has an original terminal handoff");
  expect(attempts).toBe(1);
});
