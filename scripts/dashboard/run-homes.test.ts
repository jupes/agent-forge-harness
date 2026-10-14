/**
 * The browser suite's sweep of the hearth homes earlier runs left in the OS
 * temp directory (`tests/e2e/run-homes.ts`, agent-forge-harness-x1gs.3.9). On
 * Windows a run's own teardown cannot remove its home while the hearth holds
 * the ledger open, so the next run removes it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepFinishedRunHomes } from "../../tests/e2e/run-homes";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "af-run-homes-"));
  dirs.push(dir);
  return dir;
}

/** A run home as a run leaves it: a hearth lock naming `hearthPid`, a ledger, a nested directory. */
function home(temp: string, name: string, hearthPid: number): string {
  const path = join(temp, name);
  mkdirSync(join(path, "council-runs", "run-1"), { recursive: true });
  writeFileSync(
    join(path, "hearth-0123456789ab.lock"),
    JSON.stringify({
      pid: hearthPid,
      port: 8798,
      root: "C:/checkout",
      startedAt: "2026-10-14T00:00:00.000Z",
      tokenFile: join(path, "hearth-token"),
    }),
  );
  writeFileSync(join(path, "ledger.db"), "");
  writeFileSync(join(path, "council-runs", "run-1", "report.md"), "# r\n");
  return path;
}

describe("sweepFinishedRunHomes", () => {
  test("removes a home whose runner and hearth are both gone, and keeps the current home, a home with a live runner or a live hearth, and every other name", () => {
    const temp = tempDir();
    const current = home(temp, "agent-forge-e2e-100-1000", 101);
    const finished = home(temp, "agent-forge-e2e-200-2000", 201);
    const liveRunner = home(temp, "agent-forge-e2e-300-3000", 301);
    const liveHearth = home(temp, "agent-forge-e2e-400-4000", 401);
    const otherShapes = [
      home(temp, "agent-forge-e2e-500", 501),
      home(temp, "agent-forge-e2e-600-6000-x", 601),
      home(temp, "something else", 701),
    ];
    writeFileSync(join(temp, "agent-forge-e2e-800-8000"), "a file, not a home");
    const alive = (pid: number) => pid === 300 || pid === 401;

    const removed = sweepFinishedRunHomes(current, temp, { alive });

    expect(removed).toEqual([finished]);
    expect(existsSync(finished)).toBe(false);
    for (const kept of [current, liveRunner, liveHearth, ...otherShapes])
      expect({ kept, exists: existsSync(kept) }).toEqual({
        kept,
        exists: true,
      });
    expect(existsSync(join(temp, "agent-forge-e2e-800-8000"))).toBe(true);
  });

  test("a home with no readable lock is finished once its runner is gone", () => {
    const temp = tempDir();
    const bare = join(temp, "agent-forge-e2e-200-2000");
    mkdirSync(bare);
    const garbled = home(temp, "agent-forge-e2e-201-2001", 0);
    writeFileSync(join(garbled, "hearth-0123456789ab.lock"), "{not json");

    const removed = sweepFinishedRunHomes(
      join(temp, "agent-forge-e2e-1-1"),
      temp,
      {
        alive: () => false,
      },
    );

    expect(removed.sort()).toEqual([bare, garbled].sort());
  });

  test("a home that cannot be removed is left, and the others still are", () => {
    const temp = tempDir();
    const stuck = home(temp, "agent-forge-e2e-200-2000", 201);
    const next = home(temp, "agent-forge-e2e-300-3000", 301);

    const removed = sweepFinishedRunHomes(
      join(temp, "agent-forge-e2e-1-1"),
      temp,
      {
        alive: () => false,
        remove: (path) => {
          if (path === stuck) throw new Error("EBUSY: held open");
          rmSync(path, { recursive: true, force: true });
        },
      },
    );

    expect(removed).toEqual([next]);
    expect(existsSync(stuck)).toBe(true);
    expect(existsSync(next)).toBe(false);
  });

  test("a temp directory that cannot be read sweeps nothing and does not throw", () => {
    const temp = join(tempDir(), "not there");
    expect(
      sweepFinishedRunHomes(join(temp, "agent-forge-e2e-1-1"), temp),
    ).toEqual([]);
  });
});
