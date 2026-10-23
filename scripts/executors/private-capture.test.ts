import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_SMITHS } from "../config/defaults";
import { comparableCheckout } from "../forge/runs";
import { hashText } from "../hash-text";
import { scratchDirs } from "../test-scratch";
import { claudeAdapter } from "./claude";
import { runExec } from "./exec-cli";
import type { ChildExit, SpawnRequest } from "./types";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());
const fake = join(import.meta.dir, "fixtures", "fake-cli.ts");
const fixedFailure =
  "The private provider transcript could not be verified. The shift must stop before another attempt.";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function setup(mode = "ok") {
  const root = realpathSync.native(scratch.make("owned exec capture "));
  mkdirSync(join(root, ".git"));
  const dump = join(root, "child.json");
  const smith = BUILTIN_SMITHS["claude-journeyman"];
  if (!smith) throw Error("Fixture smith missing");
  const request: SpawnRequest = {
    beadId: "capture-bead",
    worktree: root,
    workspace: root,
    smith: structuredClone(smith),
    prompt: "  exact private prompt\nsecond line  ",
    env: {
      PATH: process.env.PATH ?? "",
      ANTHROPIC_API_KEY: "private-env-value",
    },
    timeoutMs: 5000,
    command: [
      process.execPath,
      fake,
      "--fake-provider",
      "claude",
      "--fake-mode",
      mode,
      "--fake-dump",
      dump,
    ],
  };
  return { root, dump, request };
}

test("private capture retains the actual canonical input before spawn, then settles after ordered output and tree exit", async () => {
  const f = setup(),
    entered = deferred<void>(),
    release = deferred<void>(),
    finish = deferred<void>();
  const order: string[] = [],
    lines: string[] = [];
  let actual: unknown,
    exit: ChildExit | null = null;
  const pending = claudeAdapter.spawn({
    ...f.request,
    privateCapture: {
      async prepare(prepared) {
        actual = structuredClone(prepared);
        order.push("prepared");
        entered.resolve();
        await release.promise;
        return {
          started(pid) {
            expect(pid).toBeGreaterThan(0);
            order.push("process");
          },
          line(line) {
            lines.push(line);
            order.push("line");
          },
          async finish(result) {
            exit = result;
            order.push("exit");
            await finish.promise;
          },
        };
      },
    },
  });
  try {
    expect(
      await Promise.race([
        entered.promise.then(() => "prepared"),
        pending.then(() => "spawned"),
      ]),
    ).toBe("prepared");
    expect(existsSync(f.dump)).toBe(false);
    expect(JSON.stringify(actual)).not.toContain("private-env-value");
    expect(actual).toMatchObject({
      provider: "claude",
      workspace: comparableCheckout(f.root),
      cwd: f.root,
      beadId: "capture-bead",
      smith: f.request.smith,
      stdin: f.request.prompt,
      timeoutMs: 5000,
    });
    release.resolve();
    const handle = await pending;
    let settled = false;
    const done = handle.done.then((result) => {
      settled = true;
      return result;
    });
    for (let retry = 0; !exit && retry < 100; retry++) await Bun.sleep(10);
    expect(exit).toMatchObject({
      exitCode: 0,
      stopped: false,
      timedOut: false,
    });
    expect(settled).toBe(false);
    expect(order[0]).toBe("prepared");
    expect(order[1]).toBe("process");
    expect(lines.length).toBeGreaterThan(0);
    const child = JSON.parse(readFileSync(f.dump, "utf8"));
    expect(actual).toMatchObject({
      command: [process.execPath, fake, ...child.argv],
      stdin: child.stdin,
      cwd: child.cwd,
    });
    finish.resolve();
    expect((await done).privateCaptureFailed).toBeUndefined();
  } finally {
    release.resolve();
    finish.resolve();
    const handle = await pending;
    await handle.stop("fixture cleanup");
    await handle.done;
  }
}, 10000);

test("a refused private prepare starts no child and does not expose storage diagnostics", async () => {
  const f = setup();
  const pending = claudeAdapter.spawn({
    ...f.request,
    privateCapture: {
      prepare: async () => {
        throw Error("private storage path and provider body");
      },
    },
  });
  try {
    await expect(pending).rejects.toThrow(fixedFailure);
    expect(existsSync(f.dump)).toBe(false);
    expect(existsSync(join(f.root, ".agent-forge-session"))).toBe(false);
  } finally {
    await pending.then(
      async (handle) => {
        await handle.stop("fixture cleanup");
        await handle.done;
      },
      () => {},
    );
  }
});

test("private output failure stops and awaits the supervised tree and cannot become provider success", async () => {
  const f = setup("hang-tree");
  let descendant: number | null = null;
  const handle = await claudeAdapter.spawn({
    ...f.request,
    privateCapture: {
      prepare: async () => ({
        started() {},
        line(line) {
          try {
            const packet = JSON.parse(line);
            descendant = packet.childPid;
          } catch {
            /* only the fixed fixture PID is needed */
          }
          throw Error("private parse diagnostic");
        },
        async finish() {},
      }),
    },
  });
  try {
    const result = await Promise.race([
      handle.done,
      Bun.sleep(1500).then(() => null),
    ]);
    expect(result).not.toBeNull();
    expect(result).toMatchObject({ privateCaptureFailed: true, stopped: true });
    expect(JSON.stringify(result)).not.toContain("private parse diagnostic");
    expect(descendant).toBeNumber();
    const descendantPid = descendant;
    if (descendantPid !== null)
      expect(() => process.kill(descendantPid, 0)).toThrow();
  } finally {
    await handle.stop("fixture cleanup");
    await handle.done;
  }
}, 10000);

test("private preparation cannot change the executed input or its metadata hash while it waits", async () => {
  const f = setup(),
    original = f.request.prompt;
  const request = {
    ...f.request,
    privateCapture: {
      async prepare(input) {
        input.stdin = "mutated callback copy";
        input.command.length = 0;
        request.prompt = "mutated original";
        request.smith.model = "mutated-model";
        return { started() {}, line() {}, async finish() {} };
      },
    },
  } satisfies SpawnRequest;
  const handle = await claudeAdapter.spawn(request);
  try {
    const events = [];
    for await (const event of handle.events) events.push(event);
    expect((await handle.done).exitCode).toBe(0);
    const child = JSON.parse(readFileSync(f.dump, "utf8"));
    expect(child.stdin).toBe(original);
    expect(child.argv).not.toContain("mutated-model");
    expect(
      events.find((event) => event.kind === "prompt.submitted")?.payload,
    ).toMatchObject({ hash: hashText(original), length: original.length });
  } finally {
    await handle.stop("fixture cleanup");
    await handle.done;
  }
});

test("a late private write failure stays fatal through runExec while the metadata sink remains separate", async () => {
  const f = setup(),
    events: unknown[] = [];
  const result = await runExec(
    [
      "--bead",
      "capture-bead",
      "--worktree",
      f.root,
      "--prompt",
      f.request.prompt,
    ],
    {
      harnessRoot: f.root,
      home: f.root,
      cwd: f.root,
      ...(f.request.command ? { command: f.request.command } : {}),
      env: { PATH: process.env.PATH },
      adapters: { claude: claudeAdapter },
      sink: (event) => {
        events.push(event);
      },
      privateCapture: {
        prepare: async () => ({
          started() {},
          line() {},
          async finish() {
            throw Error("private write diagnostic");
          },
        }),
      },
    },
  );
  expect(result.privateCaptureFailed).toBe(true);
  expect(result.code).toBe(2);
  expect(result.body.error).toBe(fixedFailure);
  expect(JSON.stringify(events)).not.toContain(f.request.prompt);
  expect(JSON.stringify(events)).not.toContain("private write diagnostic");
  expect(events.at(-1)).toMatchObject({
    kind: "session.ended",
    payload: { reason: "failed: private transcript unavailable" },
  });
});

test("prepare failure remains a fatal runExec signal before any provider or metadata event", async () => {
  const f = setup(),
    events: unknown[] = [];
  const result = await runExec(
    [
      "--bead",
      "capture-bead",
      "--worktree",
      f.root,
      "--prompt",
      "private prompt",
    ],
    {
      harnessRoot: f.root,
      home: f.root,
      cwd: f.root,
      ...(f.request.command ? { command: f.request.command } : {}),
      env: { PATH: process.env.PATH },
      adapters: { claude: claudeAdapter },
      sink: (event) => {
        events.push(event);
      },
      privateCapture: {
        prepare: async () => {
          throw Error("unavailable private storage");
        },
      },
    },
  );
  expect(result.privateCaptureFailed).toBe(true);
  expect(result.body).toEqual({ ok: false, data: null, error: fixedFailure });
  expect(events).toEqual([]);
  expect(existsSync(f.dump)).toBe(false);
});

test("Stop during private preparation prevents provider spawn after the preparation barrier opens", async () => {
  const f = setup(),
    entered = deferred<void>(),
    release = deferred<void>(),
    controller = new AbortController();
  let abandoned = false;
  const pending = runExec(
    [
      "--bead",
      "capture-bead",
      "--worktree",
      f.root,
      "--prompt",
      "private prompt",
    ],
    {
      harnessRoot: f.root,
      home: f.root,
      cwd: f.root,
      ...(f.request.command ? { command: f.request.command } : {}),
      env: { PATH: process.env.PATH },
      adapters: { claude: claudeAdapter },
      sink: () => {},
      signal: controller.signal,
      privateCapture: {
        async prepare() {
          entered.resolve();
          await release.promise;
          return {
            started() {},
            line() {},
            async finish(exit) {
              abandoned = exit === null;
            },
          };
        },
      },
    },
  );
  await entered.promise;
  controller.abort("operator stopped shift");
  release.resolve();
  const result = await pending;
  expect(result.code).toBe(2);
  expect(abandoned).toBe(true);
  expect(existsSync(f.dump)).toBe(false);
});
