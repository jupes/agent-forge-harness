/**
 * The browser suite's `bd` stand-in state (`tests/e2e/bd-stand-in-state.ts`):
 * whole-file replacement and the retries that keep it working on Windows,
 * where a file another process holds open cannot always be replaced.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readState,
  type StandInState,
  withRetries,
  writeState,
} from "../../tests/e2e/bd-stand-in-state";

const dirs: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "af-stand-in-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs)
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const sharing = (code: string) =>
  Object.assign(new Error(`${code}: busy`), { code });

describe("withRetries", () => {
  test("tries again after a sharing error, and answers what the work answers once it succeeds", () => {
    let calls = 0;
    const value = withRetries(
      () => {
        calls++;
        if (calls < 3) throw sharing(calls === 1 ? "EPERM" : "EBUSY");
        return "done";
      },
      { waitMs: 1 },
    );
    expect({ value, calls }).toEqual({ value: "done", calls: 3 });
  });

  test("gives up after the bound, with the last error", () => {
    let calls = 0;
    expect(() =>
      withRetries(
        () => {
          calls++;
          throw sharing("EACCES");
        },
        { tries: 4, waitMs: 1 },
      ),
    ).toThrow("EACCES");
    expect(calls).toBe(4);
  });

  test("any other error is thrown at once", () => {
    let calls = 0;
    expect(() =>
      withRetries(() => {
        calls++;
        throw sharing("ENOENT");
      }),
    ).toThrow("ENOENT");
    expect(calls).toBe(1);
  });
});

describe("readState and writeState", () => {
  test("a state written is the state read, and no temporary file is left", () => {
    const dir = scratch();
    expect(readState(dir)).toEqual({});
    const state: StandInState = {
      "e2e-1": {
        id: "e2e-1",
        title: "one",
        issue_type: "task",
        priority: 2,
        status: "open",
        created_at: "2026-10-12T00:00:00Z",
        updated_at: "2026-10-12T00:00:00Z",
        labels: ["queue:proposed"],
        metadata: { queue_state: "proposed" },
      },
    };
    writeState(dir, state);
    expect(readState(dir)).toEqual(state);
    expect(readdirSync(dir)).toEqual(["issues.json"]);
  });

  test("200 replacements while another process reads the file in a loop all succeed, and every read parses", async () => {
    const dir = scratch();
    writeState(dir, {});
    // The reader parses what it reads, so a half-written file would fail it.
    const reader = spawn(
      "bun",
      [
        "-e",
        `const { readFileSync } = require("node:fs");
         const file = ${JSON.stringify(join(dir, "issues.json"))};
         const until = Date.now() + 4000;
         let reads = 0, sharingErrors = 0;
         while (Date.now() < until) {
           try { JSON.parse(readFileSync(file, "utf8")); reads++; }
           catch (error) {
             if (["EPERM", "EBUSY", "EACCES"].includes(error.code)) sharingErrors++;
             else { console.log(JSON.stringify({ failed: String(error) })); process.exit(1); }
           }
         }
         console.log(JSON.stringify({ reads, sharingErrors }));`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    reader.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    const exited = new Promise<number | null>((done) =>
      reader.on("close", done),
    );
    await new Promise((done) => setTimeout(done, 300));
    for (let i = 0; i < 200; i++)
      writeState(dir, {
        [`e2e-${i}`]: {
          id: `e2e-${i}`,
          title: "x".repeat(2000),
          issue_type: "task",
          priority: 2,
          status: "open",
          created_at: "",
          updated_at: "",
        },
      });
    expect(Object.keys(readState(dir))).toEqual(["e2e-199"]);
    expect(await exited).toBe(0);
    expect(JSON.parse(out.trim())).toMatchObject({ reads: expect.any(Number) });
  }, 30_000);
});
