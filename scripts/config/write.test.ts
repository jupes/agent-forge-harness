import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { scratchDirs } from "../test-scratch";
import { loadConfig } from "./load";
import { type ConfigTarget, setConfigValue } from "./write";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());

/** U+FEFF, built here so no editor turns it into an invisible character in this file. */
const BOM = String.fromCharCode(0xfeff);

function sandbox() {
  const root = scratch.make("forge-config-set-");
  const harness = join(root, "harness");
  const home = join(root, "home");
  mkdirSync(harness, { recursive: true });
  mkdirSync(home, { recursive: true });
  return {
    options: { harnessRoot: harness, home, env: {} },
    workspaceFile: join(harness, "agent-forge.toml"),
    userFile: join(home, ".agent-forge", "config.toml"),
    userDir: join(home, ".agent-forge"),
    harness,
  };
}

type Box = ReturnType<typeof sandbox>;

function set(
  box: Box,
  key: string,
  raw: string,
  target: ConfigTarget = "workspace",
) {
  return setConfigValue({ key, raw, target, options: box.options });
}

/** The file is as it was, and no temporary file was left beside it. */
function untouched(box: Box, file: string, before: string | null): void {
  expect(existsSync(file) ? readFileSync(file, "utf8") : null).toBe(before);
  const dir = file === box.workspaceFile ? box.harness : box.userDir;
  if (existsSync(dir))
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual(
      [],
    );
}

/** `set` is refused with `why` in its message; `file` (holding `text`, or absent) is left alone. */
function refused(
  box: Box,
  file: string,
  text: string | null,
  key: string,
  raw: string,
  why: string,
  target: ConfigTarget = "workspace",
): void {
  if (text !== null) {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
  }
  const outcome = set(box, key, raw, target);
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.error).toContain(why);
  untouched(box, file, text);
}

describe("set: replacing a value keeps the rest of the file", () => {
  test("the shipped example: comments, tables and order stay; only the value changes", () => {
    const box = sandbox();
    const example = readFileSync(
      join(import.meta.dir, "..", "..", "agent-forge.toml.example"),
      "utf8",
    );
    writeFileSync(box.workspaceFile, example);
    const outcome = set(box, "workflow.default_crew", "claude-master");
    expect(outcome).toMatchObject({
      ok: true,
      file: box.workspaceFile,
      created: false,
    });
    const after = readFileSync(box.workspaceFile, "utf8");
    expect(after).toBe(
      example.replace(
        'default_crew = "claude-journeyman"',
        'default_crew = "claude-master"',
      ),
    );
    untouched(box, box.workspaceFile, after);
  });

  test("a byte-order mark, CRLF line endings, indentation and a trailing comment are kept", () => {
    const box = sandbox();
    writeFileSync(
      box.workspaceFile,
      `${BOM}# mine\r\n[workflow]\r\n  default_crew = "claude-journeyman" # was [x] "y"\r\n`,
    );
    expect(set(box, "workflow.default_crew", "claude-master").ok).toBe(true);
    expect(readFileSync(box.workspaceFile, "utf8")).toBe(
      `${BOM}# mine\r\n[workflow]\r\n  default_crew = "claude-master" # was [x] "y"\r\n`,
    );
  });

  test("a value with escaped quotes, a # and a [ in it, and a literal string ending in a backslash, are read past", () => {
    const box = sandbox();
    writeFileSync(
      box.workspaceFile,
      '[smiths.claude-master]\nmodel = "a \\"b\\" # [c]"\neffort = \'C:\\\'\n',
    );
    expect(set(box, "smiths.claude-master.effort", "high").ok).toBe(true);
    expect(readFileSync(box.workspaceFile, "utf8")).toBe(
      '[smiths.claude-master]\nmodel = "a \\"b\\" # [c]"\neffort = "high"\n',
    );
  });

  test("an array written over several lines is replaced as a whole", () => {
    const box = sandbox();
    writeFileSync(
      box.workspaceFile,
      '[benches]\nlow = [\n  "claude-apprentice:70", # most\n  "codex-journeyman:30",\n]\n# next\n',
    );
    expect(set(box, "benches.low", "claude-master:1").ok).toBe(true);
    expect(readFileSync(box.workspaceFile, "utf8")).toBe(
      '[benches]\nlow = ["claude-master:1"]\n# next\n',
    );
  });

  test("quoted, spaced and commented headers name the same table", () => {
    const box = sandbox();
    writeFileSync(
      box.workspaceFile,
      '[ smiths . "claude-master" ] # the big one\nmodel = "m"\n',
    );
    expect(set(box, "smiths.claude-master.model", "n").ok).toBe(true);
    expect(readFileSync(box.workspaceFile, "utf8")).toBe(
      '[ smiths . "claude-master" ] # the big one\nmodel = "n"\n',
    );
  });
});

describe("set: adding a key or a table", () => {
  test("a key missing from its table goes after the table's last key, before the comments that introduce the next table", () => {
    const box = sandbox();
    writeFileSync(
      box.workspaceFile,
      '[benches]\nlow = ["claude-apprentice:70"]\n\n# The allowlist:\n[execution.env]\npass = []\n',
    );
    expect(set(box, "benches.high", "claude-master:1").ok).toBe(true);
    expect(readFileSync(box.workspaceFile, "utf8")).toBe(
      '[benches]\nlow = ["claude-apprentice:70"]\nhigh = ["claude-master:1"]\n\n# The allowlist:\n[execution.env]\npass = []\n',
    );
  });

  test("in a file with CRLF line endings, an added key and table use CRLF too", () => {
    const box = sandbox();
    writeFileSync(
      box.workspaceFile,
      '[benches]\r\nlow = ["claude-apprentice:1"]\r\n',
    );
    expect(set(box, "benches.high", "claude-master:1").ok).toBe(true);
    expect(set(box, "workflow.default_crew", "claude-master").ok).toBe(true);
    expect(readFileSync(box.workspaceFile, "utf8")).toBe(
      '[benches]\r\nlow = [\"claude-apprentice:1\"]\r\nhigh = ["claude-master:1"]\r\n\r\n[workflow]\r\ndefault_crew = "claude-master"\r\n',
    );
  });

  test("a table with no keys yet gets the key right under its header", () => {
    const box = sandbox();
    writeFileSync(box.workspaceFile, "[workflow]\n# nothing yet\n");
    expect(set(box, "workflow.default_crew", "claude-master").ok).toBe(true);
    expect(readFileSync(box.workspaceFile, "utf8")).toBe(
      '[workflow]\ndefault_crew = "claude-master"\n# nothing yet\n',
    );
  });

  test("a missing table is added at the end, after a blank line", () => {
    const box = sandbox();
    writeFileSync(
      box.workspaceFile,
      '[workflow]\ndefault_crew = "claude-master"\n',
    );
    expect(set(box, "smiths.codex-journeyman.enabled", "false").ok).toBe(true);
    expect(readFileSync(box.workspaceFile, "utf8")).toBe(
      '[workflow]\ndefault_crew = "claude-master"\n\n[smiths.codex-journeyman]\nenabled = false\n',
    );
  });

  test("the user file and its directory are created", () => {
    const box = sandbox();
    const outcome = set(box, "smiths.claude-master.tags", "fast, big", "user");
    expect(outcome).toMatchObject({
      ok: true,
      file: box.userFile,
      created: true,
      value: ["fast", "big"],
    });
    expect(readFileSync(box.userFile, "utf8")).toBe(
      '[smiths.claude-master]\ntags = ["fast", "big"]\n',
    );
    expect(
      loadConfig(box.options).config.smiths["claude-master"]?.tags,
    ).toEqual(["fast", "big"]);
  });
});

describe("set: a layout the editor does not own is refused, and the file is left alone", () => {
  const cases: Array<[string, string, string]> = [
    [
      "an inline table",
      'smiths = { my-codex = { provider = "codex", model = "m", effort = "high" } }\n',
      "an inline table",
    ],
    ["a dotted key", "[execution]\nenv.pass = []\n", "a dotted key"],
    [
      "a multi-line string",
      '[workflow]\nnote = """\n[smiths.claude-master]\n"""\n',
      "a multi-line string",
    ],
    ["an array of tables", '[[smiths]]\nname = "x"\n', "an array of tables"],
  ];
  for (const [what, text, why] of cases)
    test(what, () => {
      const box = sandbox();
      refused(
        box,
        box.workspaceFile,
        text,
        "smiths.claude-master.model",
        "x",
        why,
      );
    });

  test("a key that the file holds as a table, not as a value", () => {
    const box = sandbox();
    refused(
      box,
      box.workspaceFile,
      "[workflow.default_crew]\nname = 1\n",
      "workflow.default_crew",
      "claude-master",
      "cannot find",
    );
  });

  test("a table that appears twice, whether the key is added or replaced", () => {
    for (const key of [
      "smiths.claude-master.tags",
      "smiths.claude-master.model",
    ]) {
      const box = sandbox();
      refused(
        box,
        box.workspaceFile,
        '[smiths.claude-master]\nmodel = "a"\n[smiths.claude-master]\neffort = "b"\n',
        key,
        "x",
        // Bun >=1.4 rejects duplicate tables during parsing; older Bun
        // reaches the editor's duplicate-table check. Both must name it.
        "claude-master",
      );
    }
  });

  test("a key segment with an escape the editor does not decode", () => {
    const box = sandbox();
    refused(
      box,
      box.workspaceFile,
      '[smiths."claude\\U0001F600"]\nmodel = "a"\n',
      "workflow.default_crew",
      "claude-master",
      "a key forge:config set does not read",
    );
  });
});

describe("set: strings in values are read past, not decoded", () => {
  test("a tab and a \\U escape in another value do not stop an edit", () => {
    const box = sandbox();
    const text =
      '[smiths.claude-master]\nmodel = "a\tb \\U0001F600"\neffort = "low"\n';
    writeFileSync(box.workspaceFile, text);
    const outcome = set(box, "smiths.claude-master.effort", "high");
    expect(outcome.ok).toBe(true);
    expect(readFileSync(box.workspaceFile, "utf8")).toBe(
      text.replace('effort = "low"', 'effort = "high"'),
    );
  });

  test("a # and a [ inside the replaced value's old string; its trailing comment is kept", () => {
    const box = sandbox();
    writeFileSync(
      box.workspaceFile,
      '[smiths.claude-master]\nmodel = "a # [b]" # keep\n',
    );
    expect(set(box, "smiths.claude-master.model", "c").ok).toBe(true);
    expect(readFileSync(box.workspaceFile, "utf8")).toBe(
      '[smiths.claude-master]\nmodel = "c" # keep\n',
    );
  });

  test("a key added after a last key line that has no line ending", () => {
    const box = sandbox();
    writeFileSync(box.workspaceFile, '[smiths.claude-master]\nmodel = "a"');
    expect(set(box, "smiths.claude-master.effort", "high").ok).toBe(true);
    expect(readFileSync(box.workspaceFile, "utf8")).toBe(
      '[smiths.claude-master]\nmodel = "a"\neffort = "high"\n',
    );
  });
});

describe("set: values are typed by key, and the result must load", () => {
  const cases: Array<[string, string, string]> = [
    ["smiths.claude-master.enabled", "maybe", "expected true or false"],
    ["benches.low", "", "at least one"],
    ["benches.low", "claude-master:x", "bad weight"],
    ["benches.low", "ghost:1", 'unknown smith "ghost"'],
    ["workflow.default_crew", "nobody", 'unknown smith "nobody"'],
    ["smiths.claude-master.tags", "a,,b", "empty item"],
  ];
  for (const [key, raw, why] of cases)
    test(`${key} = "${raw}" is refused`, () => {
      const box = sandbox();
      refused(box, box.workspaceFile, null, key, raw, why);
    });

  test("an empty list is a valid value for a list", () => {
    const box = sandbox();
    expect(set(box, "smiths.claude-master.tags", "")).toMatchObject({
      ok: true,
      value: [],
    });
  });
});

describe("set: [shift] keys", () => {
  test("a number is written bare and the duration quoted, under one [shift] table, and the loader reads them back from that file", () => {
    const box = sandbox();
    expect(set(box, "shift.max_usd", "5")).toMatchObject({
      ok: true,
      value: 5,
      created: true,
    });
    expect(set(box, "shift.for", "90m")).toMatchObject({
      ok: true,
      value: "90m",
    });
    expect(set(box, "shift.throttle", "0.5")).toMatchObject({
      ok: true,
      value: 0.5,
    });
    expect(set(box, "shift.max_usd", "7.25")).toMatchObject({
      ok: true,
      value: 7.25,
    });
    expect(readFileSync(box.workspaceFile, "utf8")).toBe(
      '[shift]\nmax_usd = 7.25\nfor = "90m"\nthrottle = 0.5\n',
    );
    const { config, provenance } = loadConfig(box.options);
    expect(config.shift).toMatchObject({
      maxUsd: 7.25,
      forMs: 90 * 60_000,
      throttle: 0.5,
    });
    expect(provenance["shift.max_usd"]).toEqual({
      value: 7.25,
      source: box.workspaceFile,
    });
  });

  test("the user file takes [shift] keys too", () => {
    const box = sandbox();
    expect(set(box, "shift.concurrency", "3", "user")).toMatchObject({
      ok: true,
      file: box.userFile,
    });
    expect(readFileSync(box.userFile, "utf8")).toBe(
      "[shift]\nconcurrency = 3\n",
    );
  });

  const cases: Array<[string, string, string]> = [
    [
      "shift.max_usd",
      "lots",
      'expected a number such as 3 or 0.85, got "lots"',
    ],
    ["shift.max_usd", "1e3", 'expected a number such as 3 or 0.85, got "1e3"'],
    [
      "shift.max_usd",
      "5000",
      "shift.max_usd: expected dollars above 0, at most 1000",
    ],
    [
      "shift.concurrency",
      "0",
      "shift.concurrency: expected a whole number from 1 to 8",
    ],
    [
      "shift.repairs",
      "2.5",
      "shift.repairs: expected a whole number from 0 to 10",
    ],
    [
      "shift.for",
      "soon",
      "shift.for: expected a duration such as 90s, 30m or 2h",
    ],
    ["shift.throttle", "85", "shift.throttle: expected a share from 0.1 to 1"],
    [
      "shift.throttle",
      "0.000000001",
      "shift.throttle: expected a share from 0.1 to 1",
    ],
    ["shift.nothing", "1", 'unknown shift key "nothing"'],
    ["shift.constructor", "1", 'unknown shift key "constructor"'],
  ];
  for (const [key, raw, why] of cases)
    test(`${key} = "${raw}" is refused, and nothing is written`, () => {
      const box = sandbox();
      refused(box, box.workspaceFile, null, key, raw, why);
    });
});

describe("set: keys it does not write", () => {
  const cases: Array<[string, string]> = [
    ["smiths.my-codex.model", "unknown smith"],
    ["smiths.claude-master.colour", "unknown smith field"],
    ["smiths.claude-master.constructor", 'unknown smith field "constructor"'],
    ["smiths.claude-master.__proto__", 'unknown smith field "__proto__"'],
    ["smiths.claude-master.toString", 'unknown smith field "toString"'],
    ["benches.huge", "unknown bench"],
    ["workflow.other", "not a key"],
    ["nothing", "not a key"],
  ];
  for (const [key, why] of cases)
    test(key, () => {
      const box = sandbox();
      refused(box, box.workspaceFile, null, key, "x", why);
    });

  test("a smith defined only in the workspace file is refused for --user, and settable with --workspace", () => {
    const box = sandbox();
    writeFileSync(
      box.workspaceFile,
      '[smiths.my-codex]\nprovider = "codex"\nmodel = "m"\neffort = "high"\n',
    );
    refused(
      box,
      box.userFile,
      null,
      "smiths.my-codex.model",
      "n",
      "set it with --workspace",
      "user",
    );
    expect(set(box, "smiths.my-codex.model", "n").ok).toBe(true);
  });

  test("a smith the user file names after a key every object has is refused for --workspace with that reason; the file is left alone and Object.prototype gains no field", () => {
    for (const name of ["constructor", "__proto__", "toString"]) {
      const box = sandbox();
      mkdirSync(box.userDir, { recursive: true });
      writeFileSync(
        box.userFile,
        `[smiths.${name}]\nprovider = "claude"\nmodel = "m"\neffort = "low"\n`,
      );
      // A [smiths] table of its own, so the edit walks into it by the smith's name.
      const before = '[smiths.claude-master]\nmodel = "x"\n';
      writeFileSync(box.workspaceFile, before);
      try {
        const outcome = set(box, `smiths.${name}.model`, "n");
        expect(Object.hasOwn(Object.prototype, "model")).toBe(false);
        expect(outcome.ok).toBe(false);
        if (!outcome.ok)
          expect(outcome.error).toContain(
            `smiths.${name}: "${name}" is a key every object has`,
          );
        untouched(box, box.workspaceFile, before);
      } finally {
        // A regression would leave the field on every object for the rest of the run.
        Reflect.deleteProperty(Object.prototype, "model");
      }
    }
  });
});

describe("set: a workspace file never inherits execution.env.pass", () => {
  test("creating the workspace file for another key is refused while the user file has a pass list", () => {
    const box = sandbox();
    mkdirSync(box.userDir, { recursive: true });
    writeFileSync(box.userFile, '[execution.env]\npass = ["A", "B"]\n');
    refused(
      box,
      box.workspaceFile,
      null,
      "workflow.default_crew",
      "claude-master",
      'execution.env.pass "A,B" --workspace',
    );
  });

  test("setting execution.env.pass there is allowed, and says which user values it replaces", () => {
    const box = sandbox();
    mkdirSync(box.userDir, { recursive: true });
    writeFileSync(box.userFile, '[execution.env]\npass = ["A", "B"]\n');
    expect(set(box, "execution.env.pass", "A")).toMatchObject({
      ok: true,
      created: true,
      replacedUserPass: ["A", "B"],
    });
    expect(loadConfig(box.options).config.execution.envPass).toEqual(["A"]);
  });

  test("execution.env.pass --user is refused while a workspace file exists", () => {
    const box = sandbox();
    writeFileSync(box.workspaceFile, "");
    refused(
      box,
      box.userFile,
      null,
      "execution.env.pass",
      "A",
      "would not take effect",
      "user",
    );
  });
});

describe("set: a file saved as UTF-16", () => {
  test("is refused, and left alone", () => {
    const box = sandbox();
    const bytes = Buffer.from(
      `${BOM}[workflow]
default_crew = "claude-journeyman"
`,
      "utf16le",
    );
    writeFileSync(box.workspaceFile, bytes);
    const outcome = set(box, "workflow.default_crew", "claude-master");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("is saved as UTF-16");
    expect(readFileSync(box.workspaceFile).equals(bytes)).toBe(true);
  });
});
