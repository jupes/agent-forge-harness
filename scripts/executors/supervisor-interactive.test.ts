import { expect, test } from "bun:test";
import { join } from "node:path";
import { buildChildEnv } from "./env";
import { killTree, liveChildCount, supervise } from "./supervisor";

const fake = join(import.meta.dir, "fixtures/interactive-cli.ts");

test("interactive supervision exchanges multiple private stdin frames before explicit EOF", async () => {
  const lines: string[] = [];
  const before = liveChildCount();
  const handle = supervise({
    command: [process.execPath, fake],
    cwd: import.meta.dir,
    env: buildChildEnv(process.env, []),
    stdinMode: "interactive",
    timeoutMs: 5000,
    onLine: (line) => lines.push(line),
  });
  try {
    await handle.write('private "quoted" frame\n');
    await handle.write("second 🌱 frame\n");
    await handle.end();
    expect(await handle.done).toEqual({
      exitCode: 0,
      timedOut: false,
      stopped: false,
      stderr: "",
    });
    expect(lines).toEqual([
      JSON.stringify({ received: 'private "quoted" frame' }),
      JSON.stringify({ received: "second 🌱 frame" }),
      JSON.stringify({ ended: true }),
    ]);
    await expect(handle.write("late")).rejects.toThrow("closed");
    expect(liveChildCount()).toBe(before);
  } finally {
    await handle.stop("fixture cleanup");
  }
});

function tree(
  mode: "blocked" | "exit-tree",
  stdinTimeoutMs = 2000,
  maxStdinBytes = 8 * 1024 * 1024,
) {
  let announce: (line: string) => void = () => undefined;
  const ready = new Promise<string>((resolve) => {
    announce = resolve;
  });
  const handle = supervise({
    command: [process.execPath, fake, mode],
    cwd: import.meta.dir,
    env: buildChildEnv(process.env, []),
    stdinMode: "interactive",
    maxStdinBytes,
    stdinTimeoutMs,
    timeoutMs: 5000,
    onLine: announce,
  });
  const childPid = async () => {
    const line = await ready;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error("Malformed interactive fixture announcement.");
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("childPid" in parsed) ||
      typeof parsed.childPid !== "number"
    )
      throw new Error("Interactive fixture did not announce its child.");
    return parsed.childPid;
  };
  return { handle, childPid };
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function gone(pid: number) {
  const deadline = Date.now() + 2000;
  while (alive(pid) && Date.now() < deadline) await Bun.sleep(20);
  return !alive(pid);
}

test("a non-reader cannot accept unlimited buffered input across settled writes", async () => {
  const f = tree("blocked", 2000, 1024);
  const child = await f.childPid();
  try {
    // Windows may acknowledge buffering before the child reads. The cap remains cumulative.
    await f.handle.write("x".repeat(512));
    await f.handle.write("x".repeat(512));
    await expect(f.handle.write("x")).rejects.toThrow("total byte bound");
    const exit = await f.handle.done;
    expect(exit.exitCode).not.toBe(0);
    expect(await gone(f.handle.pid)).toBe(true);
    expect(await gone(child)).toBe(true);
  } finally {
    await f.handle.stop("fixture cleanup");
    if (alive(child)) killTree(child);
  }
});

test("a saturated pipe has a deadline even when the host accepts earlier buffering", async () => {
  const f = tree("blocked", 200, 16 * 1024 * 1024);
  const child = await f.childPid();
  try {
    const result = await f.handle.write("x".repeat(16 * 1024 * 1024)).then(
      () => "accepted",
      (error: unknown) => (error instanceof Error ? error.message : "invalid"),
    );
    // Pipe capacity is an OS detail. Either the cumulative cap or the deadline stops growth.
    expect([
      "accepted",
      "Interactive stdin exceeded its write deadline.",
    ]).toContain(result);
    if (result === "accepted")
      await expect(f.handle.write("x")).rejects.toThrow("total byte bound");
    await f.handle.done;
    expect(await gone(child)).toBe(true);
  } finally {
    await f.handle.stop("fixture cleanup");
    if (alive(child)) killTree(child);
  }
});

test("Stop settles a backpressured write and EOF while confirming descendant cleanup", async () => {
  const f = tree("blocked");
  const child = await f.childPid();
  const writing = f.handle.write("x".repeat(4 * 1024 * 1024));
  const ending = f.handle.end();
  const settled = Promise.allSettled([writing, ending]);
  try {
    await f.handle.stop("explicit Stop");
    expect((await settled).map((entry) => entry.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    expect((await f.handle.done).stopped).toBe(true);
    expect(await gone(child)).toBe(true);
  } finally {
    await f.handle.stop("fixture cleanup");
    if (alive(child)) killTree(child);
  }
});

test("interactive normal parent exit closes the ownership job and cleans its helpers", async () => {
  const f = tree("exit-tree");
  const child = await f.childPid();
  try {
    expect((await f.handle.done).exitCode).toBe(0);
    expect(await gone(child)).toBe(true);
    await expect(f.handle.end()).rejects.toThrow("closed");
  } finally {
    await f.handle.stop("fixture cleanup");
    if (alive(child)) killTree(child);
  }
});

test("interactive queue bounds reject before buffering oversized input and preserve legacy stdin", async () => {
  const before = liveChildCount();
  const handle = supervise({
    command: [process.execPath, fake],
    cwd: import.meta.dir,
    env: buildChildEnv(process.env, []),
    stdinMode: "interactive",
    maxStdinBytes: 3,
    timeoutMs: 5000,
    onLine: () => undefined,
  });
  try {
    await expect(handle.write("🌱")).rejects.toThrow("queue bound");
    await expect(handle.write("x")).rejects.toThrow("closed");
    await handle.done;
    expect(liveChildCount()).toBe(before);
  } finally {
    await handle.stop("fixture cleanup");
  }
  const lines: string[] = [];
  const legacy = supervise({
    command: [process.execPath, fake],
    cwd: import.meta.dir,
    env: buildChildEnv(process.env, []),
    stdin: "one-shot\n",
    timeoutMs: 5000,
    onLine: (line) => lines.push(line),
  });
  expect((await legacy.done).exitCode).toBe(0);
  expect(lines).toEqual(['{"received":"one-shot"}', '{"ended":true}']);
});
