import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runConfigCli } from "./cli";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "forge-config-cli-"));
  return { harnessRoot: root, home: root, env: {} };
}

describe("forge:config", () => {
  test("show --json prints merged smiths and benches with sources", () => {
    const opts = setup();
    const file = join(opts.harnessRoot, "agent-forge.toml");
    writeFileSync(file, '[smiths.claude-master]\nmodel = "m-x"\n');
    const out = runConfigCli(["show", "--json"], opts);
    expect(out.code).toBe(0);
    const body = JSON.parse(out.stdout);
    expect(body.ok).toBe(true);
    expect(body.data.config.smiths["claude-master"].model).toBe("m-x");
    expect(body.data.provenance["smiths.claude-master.model"].source).toBe(
      file,
    );
    expect(body.data.config.benches.low.length).toBe(2);
  });

  test("show prints a line per key with its source", () => {
    const out = runConfigCli(["show"], setup());
    expect(out.stdout).toContain("workflow.default_crew");
    expect(out.stdout).toContain("(builtin)");
  });

  test("get prints one value; an unknown key exits 2", () => {
    const opts = setup();
    const ok = runConfigCli(["get", "workflow.default_crew"], opts);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("claude-journeyman");
    const bad = runConfigCli(["get", "nope.nothing"], opts);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("unknown key");
  });

  test("keys lists every settable key", () => {
    const out = runConfigCli(["keys", "--json"], setup());
    const { keys } = JSON.parse(out.stdout).data;
    expect(keys).toContain("execution.env.pass");
    expect(keys).toContain("benches.low");
  });

  test("a broken config exits 2 with the file in the message", () => {
    const opts = setup();
    writeFileSync(join(opts.harnessRoot, "agent-forge.toml"), "a = = 1");
    const out = runConfigCli(["show", "--json"], opts);
    expect(out.code).toBe(2);
    expect(JSON.parse(out.stdout).error).toContain("agent-forge.toml");
  });
});

describe("forge:config set", () => {
  test("set --workspace creates the workspace file, and get then reports the value from it", () => {
    const opts = setup();
    const file = join(opts.harnessRoot, "agent-forge.toml");
    const out = runConfigCli(
      ["set", "workflow.default_crew", "claude-master", "--workspace"],
      opts,
    );
    expect(out.code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(
      '[workflow]\ndefault_crew = "claude-master"\n',
    );
    const got = runConfigCli(["get", "workflow.default_crew", "--json"], opts);
    expect(JSON.parse(got.stdout).data).toMatchObject({
      key: "workflow.default_crew",
      value: "claude-master",
      source: file,
    });
  });

  test("needs exactly one of --user or --workspace, and writes nothing without it", () => {
    const opts = setup();
    for (const flags of [[], ["--user", "--workspace"]]) {
      const out = runConfigCli(
        ["set", "workflow.default_crew", "claude-master", ...flags],
        opts,
      );
      expect(out.code).toBe(2);
      expect(out.stderr).toContain("--user");
    }
    expect(existsSync(join(opts.harnessRoot, "agent-forge.toml"))).toBe(false);
    expect(existsSync(join(opts.home, ".agent-forge"))).toBe(false);
  });

  test("--user writes under the home it is given; --json answers the envelope", () => {
    const opts = setup();
    const out = runConfigCli(
      ["set", "smiths.claude-master.enabled", "false", "--user", "--json"],
      opts,
    );
    expect(out.code).toBe(0);
    const file = join(opts.home, ".agent-forge", "config.toml");
    expect(JSON.parse(out.stdout)).toMatchObject({
      ok: true,
      data: { key: "smiths.claude-master.enabled", value: false, file },
      error: null,
    });
    expect(readFileSync(file, "utf8")).toBe(
      "[smiths.claude-master]\nenabled = false\n",
    );
  });

  test("a refusal exits 2 with the reason", () => {
    const out = runConfigCli(
      ["set", "workflow.default_crew", "nobody", "--workspace", "--json"],
      setup(),
    );
    expect(out.code).toBe(2);
    expect(JSON.parse(out.stdout).error).toContain('unknown smith "nobody"');
  });

  test("a config that does not load today can be repaired by the set that fixes it", () => {
    const opts = setup();
    const file = join(opts.harnessRoot, "agent-forge.toml");
    writeFileSync(file, '[workflow]\ndefault_crew = "nobody"\n');
    expect(runConfigCli(["show"], opts).code).toBe(2);
    const out = runConfigCli(
      ["set", "workflow.default_crew", "claude-master", "--workspace"],
      opts,
    );
    expect(out.code).toBe(0);
    expect(runConfigCli(["show"], opts).code).toBe(0);
  });

  test("replacing the user file's execution.env.pass says so on stderr", () => {
    const opts = setup();
    mkdirSync(join(opts.home, ".agent-forge"), { recursive: true });
    writeFileSync(
      join(opts.home, ".agent-forge", "config.toml"),
      '[execution.env]\npass = ["A", "B"]\n',
    );
    const out = runConfigCli(
      ["set", "execution.env.pass", "A", "--workspace"],
      opts,
    );
    expect(out.code).toBe(0);
    expect(out.stderr).toContain("(A, B) no longer applies");
  });
});

describe("forge:config keys and set agree", () => {
  test("every key keys lists can be set with --workspace, a file-defined smith's enabled and tags included, and a foreign field is not listed", () => {
    const opts = setup();
    const file = join(opts.harnessRoot, "agent-forge.toml");
    writeFileSync(
      file,
      '[smiths.my-codex]\nprovider = "codex"\nmodel = "m"\neffort = "high"\ncolour = "blue"\n',
    );
    const { keys } = JSON.parse(runConfigCli(["keys", "--json"], opts).stdout)
      .data as { keys: string[] };
    expect(keys).toContain("smiths.my-codex.enabled");
    expect(keys).toContain("smiths.my-codex.tags");
    expect(keys).not.toContain("smiths.my-codex.colour");

    const sample = (key: string): string =>
      key.endsWith(".enabled")
        ? "true"
        : key.endsWith(".tags") || key === "execution.env.pass"
          ? "a,b"
          : key.startsWith("benches.")
            ? "claude-master:1"
            : key === "workflow.default_crew"
              ? "claude-master"
              : key.endsWith(".provider")
                ? "claude"
                : "value";
    for (const key of keys) {
      const out = runConfigCli(
        ["set", key, sample(key), "--workspace", "--json"],
        opts,
      );
      expect(`${key}: ${out.code} ${out.stdout}`).toStartWith(`${key}: 0`);
    }
  });
});
