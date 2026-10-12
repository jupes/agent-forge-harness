import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadConfig } from "./load";
import { type ConfigTarget, setConfigValue } from "./write";

/** U+FEFF, built here so no editor turns it into an invisible character in this file. */
const BOM = String.fromCharCode(0xfeff);

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "forge-config-set-"));
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

  test("a table that appears twice", () => {
    const box = sandbox();
    refused(
      box,
      box.workspaceFile,
      '[smiths.claude-master]\nmodel = "a"\n[smiths.claude-master]\neffort = "b"\n',
      "smiths.claude-master.tags",
      "x",
      "more than once",
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

describe("set: keys it does not write", () => {
  const cases: Array<[string, string]> = [
    ["smiths.my-codex.model", "unknown smith"],
    ["smiths.claude-master.colour", "unknown smith field"],
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
