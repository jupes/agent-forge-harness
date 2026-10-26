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
  let settled = false,
    finishOriginal = () => {};
  const original = new Promise<void>((resolve) => {
      finishOriginal = resolve;
    }),
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
    publishGeminiTaskHelp(log, process.pid, "hold-help");
    expect(await waiting).toEqual({ pid: process.pid });
    let rows: unknown[];
    try {
      rows = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    } catch {
      throw Error("The completed Gemini task recording was invalid");
    }
    expect(rows).toEqual([{ kind: "help" }]);
  } finally {
    finishOriginal();
    await waiting.catch(() => undefined);
  }
});

test("repeated ordinary Gemini help probes do not publish the held-test witness", () => {
  const log = join(
    scratch.make("gemini-task-recording-normal-help-"),
    "recordings.jsonl",
  );
  publishGeminiTaskHelp(log, 123, "normal");
  publishGeminiTaskHelp(log, 456, "normal");
  expect(existsSync(`${log}.help-ready`)).toBe(false);
  publishGeminiTaskHelp(log, 789, "hold-help");
  expect(readFileSync(`${log}.help-ready`, "utf8")).toBe(
    JSON.stringify({ kind: "help", pid: 789 }),
  );
});
