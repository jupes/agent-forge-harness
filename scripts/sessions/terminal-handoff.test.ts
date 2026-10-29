import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SessionTurnSnapshot } from "../../types/session-turn";
import {
  NativeConsoleNotStartedError,
  type NativeConsoleChild,
  type NativeConsoleExit,
  type NativeConsoleLaunchOptions,
  launchWindowsConsole,
} from "../providers/native-console";
import { ConversationError } from "../conversations/error";
import { scratchDirs } from "../test-scratch";
import { createSessionTerminalHandoff } from "./terminal-handoff";

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
function fixture(launch?: typeof launchWindowsConsole) {
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
      prompt: "private original input must never be persisted in the handoff journal",
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
  });
  services.push(service);
  return { root, home, projectId, sessionId, turnRequestId, nativeSessionId, service };
}

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
  const f = fixture(launcher), requestId = randomUUID();
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
  expect((await recovered.read(f.projectId, f.sessionId)).attempt).toMatchObject({
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
    if ((await recovered.read(f.projectId, f.sessionId)).attempt?.phase === "closed") break;
    await Bun.sleep(10);
  }
  expect((await recovered.read(f.projectId, f.sessionId)).attempt?.phase).toBe("closed");
  expect(stopCalls).toBe(0);
});

test("only a source-proven CreateProcess refusal allows a separately reviewed request", async () => {
  let attempts = 0;
  const launcher: typeof launchWindowsConsole = () => {
    attempts++;
    throw new NativeConsoleNotStartedError();
  };
  const f = fixture(launcher), firstId = randomUUID();
  await expect(f.service.open(f.projectId, f.sessionId, firstId, 7)).rejects.toMatchObject({
    status: 409,
    message: expect.stringContaining("No CLI was started"),
  });
  expect((await f.service.read(f.projectId, f.sessionId)).attempt).toMatchObject({
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
  const f = fixture(launcher), requestId = randomUUID();
  await expect(f.service.open(f.projectId, f.sessionId, requestId, 9)).rejects.toMatchObject({
    status: 503,
    message: expect.stringContaining("outcome could not be confirmed"),
  });
  expect((await f.service.read(f.projectId, f.sessionId)).attempt).toMatchObject({
    requestId,
    phase: "unknown",
  });
  await expect(
    f.service.open(f.projectId, f.sessionId, randomUUID(), 10),
  ).rejects.toThrow("already has an original terminal handoff");
  expect(attempts).toBe(1);
});
