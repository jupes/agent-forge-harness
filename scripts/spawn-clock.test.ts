import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetSpawnClock } from "./spawn-clock";

const FIXTURE = join(import.meta.dir, "fixtures", "spawn-clock-compiled.ts");

const scratch = mkdtempSync(join(tmpdir(), "spawn-clock-"));
afterAll(async () => {
  // The executable can stay locked for a moment on Windows after it exits.
  // Yield between bounded retries so process handles and scanner locks can close.
  await rm(scratch, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
});

describe("resetSpawnClock", () => {
  test.skipIf(!Bun.semver.satisfies(Bun.version, ">=1.4.2"))(
    "timed Bun and Node spawns complete after an idle gap without a reset",
    async () => {
      // Separate process: background tests cannot refresh its cached loop clock.
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `
        const { spawnSync, execFileSync } = require("node:child_process");
        const args = ["-e", 'process.stdout.write("completed")'];
        for (const api of ["bun", "spawn", "exec"]) {
          Bun.spawnSync([process.execPath, "--version"]);
          await Bun.sleep(2_200);
          let text;
          if (api === "bun") {
            const r = Bun.spawnSync([process.execPath, ...args], {timeout: 2_000});
            if (r.exitCode !== 0) throw new Error(api + ": " + r.exitCode);
            text = r.stdout.toString();
          } else if (api === "spawn") {
            const r = spawnSync(process.execPath, args, {timeout: 2_000});
            if (r.status !== 0) throw new Error(api + ": " + r.status);
            text = r.stdout.toString();
          } else {
            text = execFileSync(process.execPath, args, {timeout: 2_000}).toString();
          }
          if (text !== "completed") throw new Error(api + ": missing output");
        }
        process.stdout.write("all three completed");
      `,
        ],
        { stdout: "pipe", stderr: "pipe", timeout: 15_000 },
      );
      const [stdout, stderr, status] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ status, stdout, stderr }).toEqual({
        status: 0,
        stdout: "all three completed",
        stderr: "",
      });
    },
    20_000,
  );

  test.skipIf(!Bun.semver.satisfies(Bun.version, ">=1.4.2"))(
    "on a fixed runtime, starts no compatibility child",
    () => {
      const spawn = spyOn(Bun, "spawnSync");
      try {
        resetSpawnClock();
        expect(spawn).not.toHaveBeenCalled();
      } finally {
        spawn.mockRestore();
      }
    },
  );

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
