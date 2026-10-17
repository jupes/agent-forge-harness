import { describe, expect, test } from "bun:test";
import { failureBlocks, rerunReport } from "./rerun-output";

/** Passing tests' lines, as bun prints them on a CI runner. */
const passes = (n: number, from = 0): string[] =>
  Array.from(
    { length: n },
    (_, i) => `(pass) some suite > test number ${from + i} passes [12.00ms]`,
  );

/** A failing `bun test` of one file on a CI runner: the failure comes early, then many passes, then the summary. */
const ciOutput = [
  "bun test v1.3.10 (30e609e0)",
  "##[group]scripts/scheduler/worktrees.test.ts:",
  ...passes(3),
  '207 | describe("comparablePath", () => {',
  '208 |   test("an 8.3 short path ...", () => {',
  "209 |     const dir = repo();",
  "211 |     expect(comparablePath(dir)).toBe(comparablePath(top(dir)));",
  "                                     ^",
  "error: expect(received).toBe(expected)",
  "",
  'Expected: "/tmp/wt abc/repo x"',
  'Received: "/home/runner/work/agent-forge-harness"',
  "",
  "      at <anonymous> (/home/runner/work/scripts/scheduler/worktrees.test.ts:211:33)",
  "(fail) comparablePath > an 8.3 short path, backslashes and drive case all meet git's spelling; a gone path still compares [25.00ms]",
  ...passes(60, 3),
  "::endgroup::",
  "",
  "1 tests skipped:",
  "(skip) a gone path whose only existing parent is a drive root is spelled with single slashes",
  "",
  "",
  "1 tests failed:",
  "(fail) comparablePath > an 8.3 short path, backslashes and drive case all meet git's spelling; a gone path still compares [25.00ms]",
  "",
  " 62 pass",
  " 1 skip",
  " 1 fail",
  "Ran 64 tests across 1 file. [794.00ms]",
  "",
].join("\n");

describe("failureBlocks", () => {
  test("keeps an early failure's error and diff, which the end of a long output no longer holds", () => {
    expect(ciOutput.slice(-1500)).not.toContain("Received:");
    expect(failureBlocks(ciOutput)).toBe(
      [
        '207 | describe("comparablePath", () => {',
        '208 |   test("an 8.3 short path ...", () => {',
        "209 |     const dir = repo();",
        "211 |     expect(comparablePath(dir)).toBe(comparablePath(top(dir)));",
        "                                     ^",
        "error: expect(received).toBe(expected)",
        "",
        'Expected: "/tmp/wt abc/repo x"',
        'Received: "/home/runner/work/agent-forge-harness"',
        "",
        "      at <anonymous> (/home/runner/work/scripts/scheduler/worktrees.test.ts:211:33)",
        "(fail) comparablePath > an 8.3 short path, backslashes and drive case all meet git's spelling; a gone path still compares [25.00ms]",
      ].join("\n"),
    );
  });

  test("keeps each failure once, its timeout note included, and reads output bun coloured", () => {
    const output = [
      "\u001b[0m\u001b[2m(pass)\u001b[0m a > first [1.00ms]",
      'error: Expected "a" to be "b"',
      "\u001b[0m\u001b[31m(fail)\u001b[0m a > second [2.00ms]",
      "(fail) a > third [15001.00ms]",
      "  ^ this test timed out after 15000ms.",
      ...passes(2),
      "2 tests failed:",
      "(fail) a > second [2.00ms]",
      "(fail) a > third [15001.00ms]",
    ].join("\n");
    expect(failureBlocks(output)).toBe(
      [
        'error: Expected "a" to be "b"',
        "(fail) a > second [2.00ms]",
        "",
        "(fail) a > third [15001.00ms]",
        "  ^ this test timed out after 15000ms.",
      ].join("\n"),
    );
  });

  test("a run with no failing test, or that failed outside any test, has no blocks", () => {
    expect(failureBlocks(passes(4).join("\n"))).toBe("");
    expect(
      failureBlocks(
        "error: Cannot find module './gone'\nRan 0 tests across 1 file.",
      ),
    ).toBe("");
  });

  test("a very long failure is cut, and so is the whole, each saying so", () => {
    const diff = Array.from({ length: 400 }, (_, i) => `+   "line ${i}",`);
    const one = [...diff, "(fail) a > long"].join("\n");
    const block = failureBlocks(one);
    expect(block.length).toBeLessThan(4_200);
    expect(block.startsWith('+   "line 0",')).toBe(true);
    expect(block.endsWith("(fail) a > long")).toBe(true);
    expect(block).toContain("[cut]");

    const many = Array.from({ length: 10 }, (_, i) =>
      [...diff, `(fail) a > long ${i}`].join("\n"),
    ).join("\n");
    const all = failureBlocks(many);
    expect(all.length).toBeLessThan(12_200);
    expect(all).toContain("(fail) a > long 0");
    expect(all.endsWith("[more failures cut]")).toBe(true);
  });
});

describe("rerunReport", () => {
  test("is the failing tests' blocks and the end of the output, so a failure outside any test still shows", () => {
    expect(rerunReport(ciOutput)).toEqual({
      failures: failureBlocks(ciOutput),
      tail: ciOutput.slice(-1500),
    });
  });
});
