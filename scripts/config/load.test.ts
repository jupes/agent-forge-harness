import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadConfig } from "./load";

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "forge-config-"));
  const harness = join(root, "harness with space");
  const home = join(root, "home");
  mkdirSync(harness, { recursive: true });
  mkdirSync(join(home, ".agent-forge"), { recursive: true });
  return {
    harness,
    home,
    workspaceFile: join(harness, "agent-forge.toml"),
    userFile: join(home, ".agent-forge", "config.toml"),
  };
}

describe("loadConfig", () => {
  test("with no files returns the builtin smiths, default crew and benches", () => {
    const s = sandbox();
    const { config, provenance } = loadConfig({
      harnessRoot: s.harness,
      home: s.home,
      env: {},
    });
    expect(Object.keys(config.smiths).sort()).toEqual([
      "claude-apprentice",
      "claude-journeyman",
      "claude-master",
      "codex-journeyman",
    ]);
    expect(config.workflow.defaultCrew).toBe("claude-journeyman");
    expect(config.benches.low).toEqual([
      { smith: "claude-apprentice", weight: 70 },
      { smith: "codex-journeyman", weight: 30 },
    ]);
    for (const entry of Object.values(provenance)) {
      expect(entry.source).toBe("builtin");
    }
  });

  test("a workspace file overrides a smith field and provenance names that file", () => {
    const s = sandbox();
    writeFileSync(
      s.userFile,
      '[smiths.claude-journeyman]\nmodel = "user-model"\n',
    );
    writeFileSync(
      s.workspaceFile,
      '[smiths.claude-journeyman]\nmodel = "ws-model"\n',
    );
    const { config, provenance } = loadConfig({
      harnessRoot: s.harness,
      home: s.home,
      env: {},
    });
    expect(config.smiths["claude-journeyman"]?.model).toBe("ws-model");
    expect(provenance["smiths.claude-journeyman.model"]).toEqual({
      value: "ws-model",
      source: s.workspaceFile,
    });
    expect(provenance["smiths.claude-journeyman.effort"]?.source).toBe(
      "builtin",
    );
  });

  test("the user file applies when no workspace file overrides the key", () => {
    const s = sandbox();
    writeFileSync(s.userFile, '[workflow]\ndefault_crew = "claude-master"\n');
    const { config, provenance } = loadConfig({
      harnessRoot: s.harness,
      home: s.home,
      env: {},
    });
    expect(config.workflow.defaultCrew).toBe("claude-master");
    expect(provenance["workflow.default_crew"]?.source).toBe(s.userFile);
  });

  test("AGENT_FORGE_SMITH overrides the default crew with source env", () => {
    const s = sandbox();
    const { config, provenance } = loadConfig({
      harnessRoot: s.harness,
      home: s.home,
      env: { AGENT_FORGE_SMITH: "codex-journeyman" },
    });
    expect(config.workflow.defaultCrew).toBe("codex-journeyman");
    expect(provenance["workflow.default_crew"]).toEqual({
      value: "codex-journeyman",
      source: "env",
    });
  });

  test("user-level execution.env.pass is ignored once a workspace file exists", () => {
    const s = sandbox();
    writeFileSync(s.userFile, '[execution.env]\npass = ["USER_SECRET"]\n');
    const alone = loadConfig({
      harnessRoot: s.harness,
      home: s.home,
      env: {},
    });
    expect(alone.config.execution.envPass).toEqual(["USER_SECRET"]);

    writeFileSync(
      s.workspaceFile,
      '[workflow]\ndefault_crew = "claude-master"\n',
    );
    const withWorkspace = loadConfig({
      harnessRoot: s.harness,
      home: s.home,
      env: {},
    });
    expect(withWorkspace.config.execution.envPass).toEqual([]);
    expect(withWorkspace.provenance["execution.env.pass"]?.source).toBe(
      "builtin",
    );
  });

  test("invalid config names the file and key", () => {
    const s = sandbox();
    writeFileSync(s.workspaceFile, '[benches]\nlow = ["ghost-smith:70"]\n');
    expect(() =>
      loadConfig({ harnessRoot: s.harness, home: s.home, env: {} }),
    ).toThrow(/agent-forge\.toml.*benches\.low.*ghost-smith/);

    writeFileSync(s.workspaceFile, '[benches]\nlow = ["claude-master:abc"]\n');
    expect(() =>
      loadConfig({ harnessRoot: s.harness, home: s.home, env: {} }),
    ).toThrow(/benches\.low.*weight/);

    writeFileSync(s.workspaceFile, "default_crew = = 1");
    expect(() =>
      loadConfig({ harnessRoot: s.harness, home: s.home, env: {} }),
    ).toThrow(/agent-forge\.toml/);

    writeFileSync(s.workspaceFile, '[workflow]\ndefault_crew = "nobody"\n');
    expect(() =>
      loadConfig({ harnessRoot: s.harness, home: s.home, env: {} }),
    ).toThrow(/default_crew.*nobody/);
  });
});
