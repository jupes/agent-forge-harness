import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
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
