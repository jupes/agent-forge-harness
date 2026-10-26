import { afterEach, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { scratchDirs } from "../test-scratch";
import {
  heldGeminiTaskHelp,
  publishGeminiTaskHelp,
} from "./fixtures/gemini-task-recording-witness";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());

test("Gemini task readiness waits out an incomplete JSONL append before strict parsing", async () => {
  const log = join(
      scratch.make("gemini-task-recording-publication-"),
      "recordings.jsonl",
    ),
    readyPath = `${log}.help-ready`,
    reads: string[] = [];
  writeFileSync(log, '{"kind":"help"');
  let settled = false;
  const original = new Promise<void>(() => {}),
    waiting = heldGeminiTaskHelp(log, original, (path) => {
      reads.push(path);
      return existsSync(path) ? readFileSync(path, "utf8") : undefined;
    }).then((entry) => {
      settled = true;
      return entry;
    });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((path) => path === readyPath)).toBe(true);
    expect(readFileSync(log, "utf8")).toBe('{"kind":"help"');

    appendFileSync(log, "}\n");
    publishGeminiTaskHelp(log, process.pid);
    expect(await waiting).toEqual({ pid: process.pid });
    expect(
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([{ kind: "help" }]);
  } finally {
    await waiting.catch(() => undefined);
  }
});
