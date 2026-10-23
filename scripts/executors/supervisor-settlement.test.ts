import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { scratchDirs } from "../test-scratch";
import { buildChildEnv } from "./env";
import { PRIVATE_CAPTURE_FAILURE } from "./private-capture";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());

test("an actually settled handle cannot signal or terminate ownership after its guard is released", async () => {
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "fixtures/settled-supervisor.ts")],
    { env: buildChildEnv(process.env, []), stdout: "pipe", stderr: "pipe" },
  );
  const deadline = setTimeout(() => child.kill(), 5000);
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    let reply: unknown;
    try {
      reply = JSON.parse(stdout);
    } catch {
      throw Error("Invalid settled ownership fixture reply");
    }
    expect(reply).toEqual({
      ok: true,
      data: { released: true, lateTermination: 0, lateSignal: 0 },
      error: null,
    });
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
});

test("a rejected owned cleanup closes the real adapter iterator, preserves unknown capture and blocks runExec", async () => {
  const root = scratch.make("rejected supervisor ");
  mkdirSync(join(root, ".git"));
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "fixtures/rejected-supervisor.ts"),
      root,
    ],
    { env: buildChildEnv(process.env, []), stdout: "pipe", stderr: "pipe" },
  );
  const deadline = setTimeout(() => child.kill(), 5000);
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    let reply: unknown;
    try {
      reply = JSON.parse(stdout);
    } catch {
      throw Error("Invalid isolated cleanup fixture reply");
    }
    expect(reply).toMatchObject({
      ok: true,
      data: {
        first: {
          rejected: PRIVATE_CAPTURE_FAILURE,
          stopRejected: true,
          iteratorClosed: true,
          falseCompletion: false,
          finishes: [null],
          mirrorRemoved: true,
        },
        execution: {
          code: 2,
          privateCaptureFailed: true,
          body: { ok: false, error: PRIVATE_CAPTURE_FAILURE },
        },
      },
      error: null,
    });
    expect(stdout).not.toContain("fixture private kernel diagnostic");
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
});
