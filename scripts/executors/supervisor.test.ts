import { describe, expect, test } from "bun:test";
import { join } from "path";
import {
  killAllLive,
  liveChildCount,
  STDERR_TAIL_CHARS,
  supervise,
} from "./supervisor";

const FAKE = join(import.meta.dir, "fixtures", "fake-cli.ts");
const hang = [process.execPath, FAKE, "--fake-mode", "hang"];

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
