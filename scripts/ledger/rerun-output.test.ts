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

  /** What a test printed to stderr before bun reported its failure: more than one block holds. */
  const noise = Array.from(
    { length: 120 },
    (_, i) => `[hearth] request ${i} answered 200 in 3 ms`,
  );
  const excerpt = [
    "211 |     expect(comparablePath(dir)).toBe(comparablePath(top(dir)));",
    "                                     ^",
    "error: expect(received).toBe(expected)",
  ];

  test("a test that printed more than a block's worth before bun's report keeps the report: from the source excerpt, error and diff included", () => {
    expect(noise.join("\n").length).toBeGreaterThan(4_000);
    const output = [
      ...noise,
      ...excerpt,
      "",
      'Expected: "/tmp/wt abc/repo x"',
      'Received: "/home/runner/work/agent-forge-harness"',
      "(fail) a > noisy",
    ].join("\n");
    expect(failureBlocks(output)).toBe(
      [
        "[cut]",
        ...excerpt,
        "",
        'Expected: "/tmp/wt abc/repo x"',
        'Received: "/home/runner/work/agent-forge-harness"',
        "(fail) a > noisy",
      ].join("\n"),
    );
  });

  test("a long diff after a long stderr keeps the error and the diff's start, and the (fail) line", () => {
    const diff = Array.from({ length: 400 }, (_, i) => `+   "line ${i}",`);
    const block = failureBlocks(
      [...noise, ...excerpt, ...diff, "(fail) a > long"].join("\n"),
    );
    expect(block.length).toBeLessThan(4_200);
    expect(
      block.startsWith(`[cut]\n${excerpt.join("\n")}\n+   "line 0",`),
    ).toBe(true);
    expect(block).not.toContain("[hearth]");
    expect(block.endsWith("[cut]\n(fail) a > long")).toBe(true);
  });

  test("diff lines that look like source excerpts cannot displace the error report", () => {
    const diff = Array.from(
      { length: 200 },
      (_, i) => `  ${i} | looks like an excerpt`,
    );
    const block = failureBlocks(
      [...noise, ...excerpt, ...diff, "(fail) a > excerpt-like diff"].join(
        "\n",
      ),
    );
    expect(block.startsWith(`[cut]\n${excerpt.join("\n")}\n${diff[0]}`)).toBe(
      true,
    );
    expect(block.endsWith("[cut]\n(fail) a > excerpt-like diff")).toBe(true);
    expect(block.length).toBeLessThan(4_200);
  });

  /**
   * Bun 1.3.10's report of a test that threw `new TypeError(...)`: the
   * excerpt, then the error's name, with no `error:` line.
   */
  const typeErrorReport = [
    "2 | ",
    '3 | test("throws a type error", () => {',
    "6 |   const value = 1;",
    "7 |   throw new TypeError(`bad type here ${value}`);",
    "                                                  ^",
    "TypeError: bad type here 1",
    "      at <anonymous> (/home/runner/work/agent-forge-harness/scripts/sample.test.ts:7:47)",
    "(fail) throws a type error",
  ];

  test("a TypeError after a child's earlier error: line and a long stderr keeps its excerpt and its TypeError line", () => {
    const output = [
      "error: pathspec 'gone' did not match any file(s) known to git",
      ...noise,
      ...typeErrorReport,
    ].join("\n");
    expect(output.length).toBeGreaterThan(4_000);
    expect(failureBlocks(output)).toBe(
      ["[cut]", ...typeErrorReport].join("\n"),
    );
  });

  test("a TypeError after a long stderr with no error: line keeps its report, without the stderr", () => {
    const output = [...noise, ...typeErrorReport].join("\n");
    expect(output.length).toBeGreaterThan(4_000);
    expect(failureBlocks(output)).toBe(
      ["[cut]", ...typeErrorReport].join("\n"),
    );
  });

  test("an error whose name does not end in Error, after a long stderr, keeps its report from the excerpt", () => {
    const report = [
      "10 |   throw e;",
      "             ^",
      "Refusal: refused",
      "      at <anonymous> (/home/runner/work/agent-forge-harness/scripts/sample.test.ts:10:9)",
      "(fail) custom name",
    ];
    expect(failureBlocks([...noise, ...report].join("\n"))).toBe(
      ["[cut]", ...report].join("\n"),
    );
  });

  test("a timeout note is kept once, with its own test, not again with the next failure", () => {
    const output = [
      "(fail) a > slow [101.00ms]",
      "  ^ this test timed out after 100ms.",
      "error: boom",
      "(fail) a > broken [1.00ms]",
    ].join("\n");
    expect(failureBlocks(output)).toBe(
      [
        "(fail) a > slow [101.00ms]",
        "  ^ this test timed out after 100ms.",
        "",
        "error: boom",
        "(fail) a > broken [1.00ms]",
      ].join("\n"),
    );
  });

  test("a (fail) line longer than a block keeps none of the lines before it", () => {
    const name = `(fail) a > ${"very long name ".repeat(400)}`;
    expect(name.length).toBeGreaterThan(4_000);
    expect(failureBlocks([...noise.slice(0, 60), name].join("\n"))).toBe(
      `[cut]\n${name}`,
    );
  });

  test("a very long failure with no error line keeps its end, next to the (fail) line, and the whole is cut too, each saying so", () => {
    const diff = Array.from({ length: 400 }, (_, i) => `+   "line ${i}",`);
    const one = [...diff, "(fail) a > long"].join("\n");
    const block = failureBlocks(one);
    expect(block.length).toBeLessThan(4_200);
    expect(block.startsWith("[cut]\n")).toBe(true);
    expect(block.endsWith('+   "line 399",\n(fail) a > long')).toBe(true);

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
