import { describe, expect, test } from "bun:test";
import { join } from "path";
import {
  killAllLive,
  killTree,
  liveChildCount,
  STDERR_TAIL_CHARS,
  supervise,
} from "./supervisor";

const FAKE = join(import.meta.dir, "fixtures", "fake-cli.ts");
const hang = [process.execPath, FAKE, "--fake-mode", "hang"];
const PARENT = join(import.meta.dir, "fixtures", "supervising-parent.ts");

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

describe("supervise: the parent-exit hook, run in a process of its own", () => {
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
