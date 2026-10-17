import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetSpawnClock } from "./spawn-clock";

const FIXTURE = join(import.meta.dir, "fixtures", "spawn-clock-compiled.ts");

const scratch = mkdtempSync(join(tmpdir(), "spawn-clock-"));
afterAll(() => {
  // The executable can stay locked for a moment on Windows after it exits.
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
});

describe("resetSpawnClock", () => {
  test("in an executable made by bun build --compile, it runs Bun and not the executable's own entrypoint, and still gives the next timed spawn its whole limit", async () => {
    const exe = join(
      scratch,
      process.platform === "win32" ? "compiled.exe" : "compiled",
    );
    const built = Bun.spawnSync(
      [process.execPath, "build", "--compile", FIXTURE, "--outfile", exe],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect({
      exitCode: built.exitCode,
      stderr: built.stderr.toString(),
    }).toEqual({ exitCode: 0, stderr: expect.any(String) });

    const marker = join(scratch, "entrypoint.txt");
    const run = Bun.spawn([exe], {
      env: { ...process.env, SPAWN_CLOCK_MARKER: marker },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(run.stdout).text(),
      run.exited,
    ]);
    expect({
      exitCode,
      entrypointRanAgain: existsSync(marker),
      timedChild: JSON.parse(stdout.trim()),
    }).toEqual({
      exitCode: 0,
      entrypointRanAgain: false,
      timedChild: { status: 0, error: null },
    });
  }, 60_000);

  test("with no executable at process.execPath, it returns instead of throwing", () => {
    const real = process.execPath;
    process.execPath = join(scratch, "no such bun.exe");
    try {
      expect(() => resetSpawnClock()).not.toThrow();
    } finally {
      process.execPath = real;
    }
  });
});
