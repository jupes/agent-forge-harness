import { describe, expect, test } from "bun:test";
import { join } from "path";
import { buildChildEnv } from "./env";
import {
  killAllLive,
  killTree,
  liveChildCount,
  ownInterrupts,
  STDERR_TAIL_CHARS,
  supervise,
} from "./supervisor";

const FAKE = join(import.meta.dir, "fixtures", "fake-cli.ts");
const hang = [process.execPath, FAKE, "--fake-mode", "hang"];
const PARENT = join(import.meta.dir, "fixtures", "supervising-parent.ts");

test("supervise forwards Windows console hiding only when explicitly requested", () => {
  const before = liveChildCount();
  const launches: { windowsHide: boolean | undefined }[] = [];
  const spawn: NonNullable<Parameters<typeof supervise>[0]["spawn"]> = (
    _command,
    options,
  ) => {
    launches.push({ windowsHide: options.windowsHide });
    throw new Error("intercepted before spawning");
  };
  const base = {
    command: ["synthetic-provider"],
    cwd: process.cwd(),
    env: {},
    onLine: () => {},
    spawn,
  };

  expect(() => supervise({ ...base, windowsHide: true })).toThrow(
    "intercepted before spawning",
  );
  expect(() => supervise(base)).toThrow("intercepted before spawning");
  expect(launches).toEqual([{ windowsHide: true }, { windowsHide: undefined }]);
  expect(liveChildCount()).toBe(before);
});

test("a parent with an empty PATH can stop the provider and its descendant", async () => {
  const env = Object.fromEntries(
    Object.entries(buildChildEnv(process.env, [])).filter(
      ([name]) => name.toLowerCase() !== "path",
    ),
  );
  const parent = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "fixtures", "minimal-path-stop.ts"),
    ],
    { env: { ...env, PATH: "" }, stdout: "pipe", stderr: "pipe" },
  );
  const deadline = setTimeout(() => parent.kill(), 8_000);
  let pids: { pid?: number; childPid?: number } = {};
  try {
    const stdout = await new Response(parent.stdout).text();
    await new Response(parent.stderr).text();
    let rows: unknown[];
    try {
      rows = stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    } catch {
      throw new Error("Malformed minimal-path stop fixture reply");
    }
    const first = rows[0];
    if (
      typeof first !== "object" ||
      first === null ||
      !("pid" in first) ||
      !("childPid" in first) ||
      typeof first.pid !== "number" ||
      typeof first.childPid !== "number"
    )
      throw new Error("The minimal-path fixture did not announce its tree.");
    pids = { pid: first.pid, childPid: first.childPid };
    expect(await parent.exited).toBe(0);
    expect(rows[1]).toMatchObject({ ok: true, error: null });
    expect(await goneWithin(first.pid, 3_000)).toBe(true);
    expect(await goneWithin(first.childPid, 3_000)).toBe(true);
  } finally {
    clearTimeout(deadline);
    if (parent.exitCode === null) parent.kill();
    for (const pid of [pids.pid, pids.childPid])
      if (pid !== undefined && running(pid)) killTree(pid);
  }
}, 20_000);

/** Whether a process with this pid is running. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Whether the process is gone within `ms` (it is not reaped at once on every platform). */
async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (running(pid)) {
    if (Date.now() > deadline) return false;
    await Bun.sleep(25);
  }
  return true;
}

/** The pids the stand-in harness prints: its supervised provider's, and that provider's child's. */
async function treePids(
  stdout: ReadableStream<Uint8Array>,
): Promise<{ pid: number; childPid: number }> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n")) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
  return JSON.parse(text.split(/\r?\n/)[0] ?? "");
}

/**
 * Starts the stand-in harness (`fixtures/supervising-parent.ts`), lets `end`
 * end it while the provider it supervises and that provider's own child run,
 * and reports how it exited and whether either outlived it. A process left
 * running is killed afterwards, by its pid.
 */
async function endParent(
  end: (parent: Bun.Subprocess<"pipe", "pipe", "pipe">) => void,
): Promise<{
  exitCode: number | null;
  providerGone: boolean;
  providerChildGone: boolean;
}> {
  const parent = Bun.spawn([process.execPath, PARENT], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  let pids: { pid: number; childPid: number } | undefined;
  try {
    pids = await treePids(parent.stdout);
    expect(running(pids.pid)).toBe(true);
    expect(running(pids.childPid)).toBe(true);
    end(parent);
    const exitCode = await parent.exited;
    return {
      exitCode,
      providerGone: await goneWithin(pids.pid, 3000),
      providerChildGone: await goneWithin(pids.childPid, 3000),
    };
  } finally {
    for (const pid of [pids?.pid, pids?.childPid]) {
      if (pid !== undefined && running(pid)) killTree(pid);
    }
    if (parent.exitCode === null) parent.kill();
  }
}

describe("supervise: the harness process ends while it supervises a provider (run in a process of its own)", () => {
  test("a harness process that calls process.exit while it supervises a provider leaves neither the provider nor the provider's own child running", async () => {
    const ended = await endParent((parent) => {
      parent.stdin.write("exit");
      parent.stdin.end();
    });
    expect(ended).toEqual({
      exitCode: 0,
      providerGone: true,
      providerChildGone: true,
    });
  });

  test("a harness process that dies of an uncaught error while it supervises a provider leaves neither the provider nor the provider's own child running", async () => {
    const ended = await endParent((parent) => {
      parent.stdin.write("crash");
      parent.stdin.end();
    });
    expect(ended).toEqual({
      exitCode: 1,
      providerGone: true,
      providerChildGone: true,
    });
  });

  // No exit hook of the harness runs here: the tree is ended by what
  // `supervise` set up when it started the provider (`tree-guard.ts`).
  test("a harness process killed outright (SIGKILL; TerminateProcess on Windows) while it supervises a provider leaves neither the provider nor the provider's own child running", async () => {
    const ended = await endParent((parent) => parent.kill("SIGKILL"));
    expect({
      providerGone: ended.providerGone,
      providerChildGone: ended.providerChildGone,
    }).toEqual({ providerGone: true, providerChildGone: true });
  });

  // On Windows a signal sent to another process ends it outright: no handler
  // of it runs, so this case is checked on the other platforms only.
  test.skipIf(process.platform === "win32")(
    "a harness process sent SIGTERM while it supervises a provider exits 130 and leaves neither the provider nor the provider's own child running",
    async () => {
      const ended = await endParent((parent) => parent.kill("SIGTERM"));
      expect(ended).toEqual({
        exitCode: 130,
        providerGone: true,
        providerChildGone: true,
      });
    },
  );
});

/**
 * The stand-in harness, driven a line at a time: `send` writes one line to
 * its stdin, and `next` reads the next line it prints on stdout.
 */
async function drivenParent() {
  const parent = Bun.spawn([process.execPath, PARENT], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = parent.stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const next = async (): Promise<Record<string, unknown>> => {
    while (!text.includes("\n")) {
      const { done, value } = await reader.read();
      if (done) throw new Error(`the stand-in printed no more lines: ${text}`);
      text += decoder.decode(value, { stream: true });
    }
    const end = text.indexOf("\n");
    const line = text.slice(0, end).trim();
    text = text.slice(end + 1);
    return JSON.parse(line) as Record<string, unknown>;
  };
  const pids = (await next()) as { pid: number; childPid: number };
  return {
    parent,
    pids,
    next,
    send(line: string): void {
      parent.stdin.write(`${line}\n`);
      parent.stdin.flush();
    },
    /** End what a failed test left running. */
    cleanup(): void {
      for (const pid of [pids.pid, pids.childPid])
        if (running(pid)) killTree(pid);
      if (parent.exitCode === null) parent.kill();
    },
  };
}

describe("supervise: SIGINT and SIGTERM, with and without an interrupt owner (run in a process of its own)", () => {
  // forge:exec registers no owner: this is its Ctrl-C. The signal is emitted
  // in the harness (`process.emit`), which on Windows is the only way to run
  // its handler from a test; a real SIGTERM is checked above, elsewhere.
  for (const signal of ["SIGINT", "SIGTERM"])
    test(`with no interrupt owner (forge:exec), ${signal} kills the provider's tree and exits 130 at once`, async () => {
      const driven = await drivenParent();
      try {
        driven.send(signal);
        expect(await driven.parent.exited).toBe(130);
        expect(await goneWithin(driven.pids.pid, 3000)).toBe(true);
        expect(await goneWithin(driven.pids.childPid, 3000)).toBe(true);
      } finally {
        driven.cleanup();
      }
    });

  test("an owner that answers handled is given the signal, and nothing is killed and nothing exits; once it is released, the next signal kills the tree and exits 130", async () => {
    const driven = await drivenParent();
    try {
      driven.send("own");
      expect(await driven.next()).toEqual({ done: "own" });
      driven.send("SIGTERM");
      expect(await driven.next()).toEqual({ handled: "SIGTERM" });
      expect(await driven.next()).toEqual({ done: "SIGTERM" });
      driven.send("SIGINT");
      expect(await driven.next()).toEqual({ handled: "SIGINT" });
      expect(await driven.next()).toEqual({ done: "SIGINT" });
      expect(driven.parent.exitCode).toBeNull();
      expect(running(driven.pids.pid)).toBe(true);
      expect(running(driven.pids.childPid)).toBe(true);
      driven.send("release");
      expect(await driven.next()).toEqual({ done: "release" });
      driven.send("SIGINT");
      expect(await driven.parent.exited).toBe(130);
      expect(await goneWithin(driven.pids.pid, 3000)).toBe(true);
      expect(await goneWithin(driven.pids.childPid, 3000)).toBe(true);
    } finally {
      driven.cleanup();
    }
  });

  test("an owner that answers not handled leaves the signal to the supervisor: the tree is killed and the process exits 130", async () => {
    const driven = await drivenParent();
    try {
      driven.send("decline");
      expect(await driven.next()).toEqual({ done: "decline" });
      driven.send("SIGINT");
      expect(await driven.parent.exited).toBe(130);
      expect(await goneWithin(driven.pids.pid, 3000)).toBe(true);
      expect(await goneWithin(driven.pids.childPid, 3000)).toBe(true);
    } finally {
      driven.cleanup();
    }
  });
});

describe("ownInterrupts", () => {
  test("one owner at a time: a second registration is refused until the first is released, and a release is its own owner's only, once", () => {
    const first = ownInterrupts(() => true);
    try {
      expect(() => ownInterrupts(() => true)).toThrow(
        "an interrupt owner is registered already",
      );
    } finally {
      first();
    }
    const second = ownInterrupts(() => true);
    try {
      // The first owner's release, again: it must not drop the second.
      first();
      expect(() => ownInterrupts(() => true)).toThrow(
        "an interrupt owner is registered already",
      );
    } finally {
      second();
    }
    // Released: a new owner can register, and is released at once.
    ownInterrupts(() => true)();
  });
});

describe("supervise", () => {
  test("killAllLive (the parent-exit hook) kills every running child", async () => {
    const a = supervise({
      command: hang,
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      onLine: () => undefined,
    });
    const b = supervise({
      command: hang,
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      onLine: () => undefined,
    });
    expect(liveChildCount()).toBeGreaterThanOrEqual(2);
    killAllLive();
    const [ra, rb] = await Promise.all([a.done, b.done]);
    expect(ra.exitCode).not.toBe(0);
    expect(rb.exitCode).not.toBe(0);
    expect(liveChildCount()).toBe(0);
  });

  test("a provider that exits on its own leaves the child it started running: its tree guard is stood down without ending anything", async () => {
    let childPid: number | undefined;
    const provider = supervise({
      command: [process.execPath, FAKE, "--fake-mode", "orphan"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      onLine: (line) => {
        childPid = (JSON.parse(line) as { childPid: number }).childPid;
      },
    });
    try {
      expect((await provider.done).exitCode).toBe(0);
      if (childPid === undefined) throw new Error("the fake printed no pid");
      // Time for anything set off by the provider's exit to have ended it.
      await Bun.sleep(500);
      expect(running(childPid)).toBe(true);
    } finally {
      if (childPid !== undefined && running(childPid)) killTree(childPid);
    }
  });

  test("stop() marks the result stopped", async () => {
    const child = supervise({
      command: hang,
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      onLine: () => undefined,
    });
    await child.stop("test");
    expect((await child.done).stopped).toBe(true);
  });

  test("Windows Stop stays pending until its owned-job settlement finishes", async () => {
    if (process.platform !== "win32") return;
    let releaseSettlement!: () => void,
      enterSettlement!: () => void,
      stopSettled = false,
      guardReleased = false;
    const settlement = new Promise<void>((resolve) => {
      releaseSettlement = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      enterSettlement = resolve;
    });
    let childPid = 0;
    const child = supervise({
      command: hang,
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      onLine: () => undefined,
      windowsStoppedGuard: () => ({
        release() {
          guardReleased = true;
        },
        async settleStopped() {
          killTree(childPid);
          enterSettlement();
          await settlement;
        },
      }),
    });
    childPid = child.pid;
    const stopping = child.stop("test").then(() => {
      stopSettled = true;
    });
    try {
      const first = await Promise.race([
        entered.then(() => "settlement" as const),
        stopping.then(() => "stop-settled" as const),
        Bun.sleep(5000).then(() => "deadline" as const),
      ]);
      expect(first).toBe("settlement");
      expect(stopSettled).toBe(false);
    } finally {
      releaseSettlement();
    }
    await stopping;
    expect(stopSettled).toBe(true);
    expect(guardReleased).toBe(true);
  });

  test("Windows Stop refuses when its guard cannot prove descendant settlement", async () => {
    if (process.platform !== "win32") return;
    let guardTerminated = false,
      guardReleased = false;
    const child = supervise({
      command: hang,
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      onLine: () => undefined,
      windowsStoppedGuard: () => ({
        release() {
          guardReleased = true;
        },
        terminate() {
          guardTerminated = true;
        },
      }),
    });
    await expect(child.stop("test")).rejects.toThrow(
      "Windows owned process cleanup could not be confirmed.",
    );
    expect(guardTerminated).toBe(true);
    expect(guardReleased).toBe(false);
  });

  test("Windows Stop surfaces settlement refusal while the root is still pending", async () => {
    if (process.platform !== "win32") return;
    const child = supervise({
      command: hang,
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      onLine: () => undefined,
      windowsStoppedGuard: () => ({
        release() {},
        terminate() {},
        async settleStopped() {
          await Bun.sleep(50);
          throw new Error("unconfirmed");
        },
      }),
    });
    try {
      await expect(child.stop("test")).rejects.toThrow(
        "Windows owned process cleanup could not be confirmed.",
      );
      expect(running(child.pid)).toBe(true);
    } finally {
      killTree(child.pid);
      await child.done.catch(() => undefined);
    }
  });

  test("delivers stdout one line at a time, including a final unterminated line", async () => {
    const lines: string[] = [];
    const child = supervise({
      command: [
        process.execPath,
        "-e",
        'process.stdout.write("one\\ntwo\\nthree")',
      ],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      onLine: (l) => lines.push(l),
    });
    await child.done;
    expect(lines).toEqual(["one", "two", "three"]);
  });

  test("keeps the end of the child's stderr, STDERR_TAIL_CHARS characters at most", async () => {
    const child = supervise({
      command: [
        process.execPath,
        "-e",
        'process.stderr.write("a".repeat(9000) + "the end")',
      ],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      onLine: () => undefined,
    });
    const { stderr } = await child.done;
    expect(stderr).toHaveLength(STDERR_TAIL_CHARS);
    expect(stderr).toEndWith("aaathe end");
  });
});
