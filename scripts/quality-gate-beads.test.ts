import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  type ExecFile,
  execFileNoShell,
  readBeadsIssue,
} from "./quality-gate-beads";
import { type BeadsIssueId, parseBeadsIssueId } from "./run-correlation";

function bead(id: string): BeadsIssueId {
  const parsed = parseBeadsIssueId(id);
  if (parsed === null) throw new Error(`${id} is not a Beads id`);
  return parsed;
}

/** An `ExecFile` that records every call and answers from a script. */
function recorder(
  answers: Record<string, { ok: boolean; output: string }> = {},
): { exec: ExecFile; calls: Array<{ file: string; args: string[] }> } {
  const calls: Array<{ file: string; args: string[] }> = [];
  return {
    calls,
    exec: (file, args) => {
      calls.push({ file, args: [...args] });
      return answers[args.join(" ")] ?? { ok: false, output: "" };
    },
  };
}

describe("readBeadsIssue", () => {
  test("asks bd three questions, each as an argument array holding the id as one whole argument", () => {
    const { exec, calls } = recorder();
    readBeadsIssue(bead("agent-forge-harness-0xxt"), exec);
    expect(calls).toEqual([
      { file: "bd", args: ["show", "agent-forge-harness-0xxt", "--json"] },
      { file: "bd", args: ["show", "agent-forge-harness-0xxt"] },
      { file: "bd", args: ["comments", "agent-forge-harness-0xxt", "--json"] },
    ]);
  });

  test("reads the issue type, whether acceptance criteria are listed, and the comment bodies", () => {
    const { exec } = recorder({
      "show b-1 --json": {
        ok: true,
        output: JSON.stringify([{ issue_type: "Feature" }]),
      },
      "show b-1": { ok: true, output: "title\n  ac: it works\n" },
      "comments b-1 --json": {
        ok: true,
        output: JSON.stringify([
          { text: "testing: ran the suite" },
          { text: "   " },
          { author: "x" },
          "not a row",
        ]),
      },
    });
    expect(readBeadsIssue(bead("b-1"), exec)).toEqual({
      shown: true,
      issueType: "feature",
      acceptanceListed: true,
      commentBodies: ["testing: ran the suite"],
    });
  });

  test("an issue bd cannot show is reported as not shown, with nothing listed", () => {
    const { exec } = recorder({
      "comments b-1 --json": { ok: true, output: "{}" },
    });
    expect(readBeadsIssue(bead("b-1"), exec)).toEqual({
      shown: false,
      issueType: "unknown",
      acceptanceListed: false,
      commentBodies: [],
    });
  });

  test("only a validated Beads id type-checks as its argument", () => {
    const { exec, calls } = recorder();
    // @ts-expect-error a plain string — a host task id, say — is not a BeadsIssueId
    readBeadsIssue("7; echo pwned", exec);
    // The compiler is the guard here; this call exists only to hold the directive.
    expect(calls).toHaveLength(3);
  });
});

describe("execFileNoShell (the runner bd is called through)", () => {
  const temporary: string[] = [];
  afterEach(() => {
    for (const dir of temporary.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  test("hands each argument to the program verbatim: nothing is run by a shell", () => {
    const cwd = mkdtempSync(join(tmpdir(), "gate beads test "));
    temporary.push(cwd);
    const hostile = [
      "x; echo pwned > pwned-semicolon.txt",
      "x && echo pwned > pwned-and.txt",
      "x | echo pwned > pwned-pipe.txt",
      "$(echo pwned > pwned-subshell.txt)",
      "`echo pwned > pwned-backtick.txt`",
      "x > pwned-redirect.txt",
      '" & echo pwned > pwned-quote.txt & "',
      "%COMSPEC% /c echo pwned > pwned-percent.txt",
      "--json",
    ];
    // The echo program lives outside `cwd`, so `cwd` stays empty unless a
    // shell ran one of the redirections above.
    const tools = mkdtempSync(join(tmpdir(), "gate beads tools "));
    temporary.push(tools);
    const echo = join(tools, "echo-argv.ts");
    writeFileSync(echo, "console.log(JSON.stringify(process.argv.slice(2)));");
    const echoed = execFileNoShell(process.execPath, [echo, ...hostile], {
      cwd,
    });
    expect(echoed.ok).toBe(true);
    expect(JSON.parse(echoed.output)).toEqual(hostile);
    expect(readdirSync(cwd)).toEqual([]);
  });

  test("a program that is not there is a failed call, not a crash", () => {
    const missing = execFileNoShell("agent-forge-no-such-program", ["x"]);
    expect(missing.ok).toBe(false);
    expect(existsSync("agent-forge-no-such-program")).toBe(false);
  });
});
