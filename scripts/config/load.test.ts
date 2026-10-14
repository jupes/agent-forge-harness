import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadConfig } from "./load";
import { withProcessHomes } from "./testing";

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

  test("a name every object has a key for is an unknown smith as the default crew, from AGENT_FORGE_SMITH, and in a bench", () => {
    const crew = sandbox();
    writeFileSync(
      crew.workspaceFile,
      '[workflow]\ndefault_crew = "constructor"\n',
    );
    expect(() =>
      loadConfig({ harnessRoot: crew.harness, home: crew.home, env: {} }),
    ).toThrow(
      `${crew.workspaceFile}: workflow.default_crew: unknown smith "constructor"`,
    );

    const env = sandbox();
    expect(() =>
      loadConfig({
        harnessRoot: env.harness,
        home: env.home,
        env: { AGENT_FORGE_SMITH: "toString" },
      }),
    ).toThrow('env: workflow.default_crew: unknown smith "toString"');

    const bench = sandbox();
    writeFileSync(bench.workspaceFile, '[benches]\nlow = ["__proto__:1"]\n');
    expect(() =>
      loadConfig({ harnessRoot: bench.harness, home: bench.home, env: {} }),
    ).toThrow(`${bench.workspaceFile}: benches.low: unknown smith "__proto__"`);
  });

  test("a smith table named after a key every object has is refused with that reason, naming the file", () => {
    for (const name of ["constructor", "__proto__", "toString"]) {
      const s = sandbox();
      writeFileSync(
        s.workspaceFile,
        `[smiths.${name}]\nprovider = "claude"\nmodel = "m"\neffort = "low"\n`,
      );
      expect(() =>
        loadConfig({ harnessRoot: s.harness, home: s.home, env: {} }),
      ).toThrow(
        `${s.workspaceFile}: smiths.${name}: "${name}" is a key every object has; name the smith something else`,
      );
    }
  });
});

/** A sandbox plus an Agent Forge home of its own, outside the OS home. */
function movedHome() {
  const s = sandbox();
  const forgeHome = join(s.harness, "..", "moved forge home");
  mkdirSync(forgeHome, { recursive: true });
  return { ...s, forgeHome, movedFile: join(forgeHome, "config.toml") };
}

describe("loadConfig: the machine file follows AGENT_FORGE_HOME", () => {
  test("with no home given, the machine file is config.toml in AGENT_FORGE_HOME, not the one under the OS home", () => {
    const s = movedHome();
    writeFileSync(s.movedFile, '[workflow]\ndefault_crew = "claude-master"\n');
    writeFileSync(
      s.userFile,
      '[workflow]\ndefault_crew = "codex-journeyman"\n',
    );
    const { config, provenance, files } = withProcessHomes(
      s.forgeHome,
      s.home,
      () => loadConfig({ harnessRoot: s.harness, env: {} }),
    );
    expect(config.workflow.defaultCrew).toBe("claude-master");
    expect(provenance["workflow.default_crew"]?.source).toBe(s.movedFile);
    expect(files).toEqual([s.movedFile]);
  });

  test("its execution.env.pass applies while no workspace file exists, and never once one does", () => {
    const s = movedHome();
    writeFileSync(s.movedFile, '[execution.env]\npass = ["HOME_SECRET"]\n');
    const load = () =>
      withProcessHomes(s.forgeHome, s.home, () =>
        loadConfig({ harnessRoot: s.harness, env: {} }),
      );

    const alone = load();
    expect(alone.config.execution.envPass).toEqual(["HOME_SECRET"]);
    expect(alone.provenance["execution.env.pass"]?.source).toBe(s.movedFile);

    writeFileSync(
      s.workspaceFile,
      '[workflow]\ndefault_crew = "claude-master"\n',
    );
    const silent = load();
    expect(silent.config.execution.envPass).toEqual([]);
    expect(silent.provenance["execution.env.pass"]?.source).toBe("builtin");

    writeFileSync(s.workspaceFile, '[execution.env]\npass = ["WS_ONLY"]\n');
    const own = load();
    expect(own.config.execution.envPass).toEqual(["WS_ONLY"]);
    expect(own.provenance["execution.env.pass"]?.source).toBe(s.workspaceFile);
  });

  test("an explicit home still names the machine file, whatever AGENT_FORGE_HOME says", () => {
    const s = movedHome();
    writeFileSync(s.movedFile, '[execution.env]\npass = ["HOME_SECRET"]\n');
    writeFileSync(s.userFile, '[workflow]\ndefault_crew = "claude-master"\n');
    const { config, files } = withProcessHomes(s.forgeHome, s.home, () =>
      loadConfig({ harnessRoot: s.harness, home: s.home, env: {} }),
    );
    expect(files).toEqual([s.userFile]);
    expect(config.workflow.defaultCrew).toBe("claude-master");
    expect(config.execution.envPass).toEqual([]);
  });

  test("the env option does not move the machine file: the process's AGENT_FORGE_HOME does", () => {
    const s = movedHome();
    const elsewhere = join(s.forgeHome, "..", "named in the env option");
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(
      join(elsewhere, "config.toml"),
      '[execution.env]\npass = ["CHILD_SECRET"]\n',
    );
    writeFileSync(s.movedFile, '[workflow]\ndefault_crew = "claude-master"\n');
    const { config, files } = withProcessHomes(s.forgeHome, s.home, () =>
      loadConfig({
        harnessRoot: s.harness,
        env: { AGENT_FORGE_HOME: elsewhere },
      }),
    );
    expect(files).toEqual([s.movedFile]);
    expect(config.workflow.defaultCrew).toBe("claude-master");
    expect(config.execution.envPass).toEqual([]);
  });

  test("with AGENT_FORGE_HOME unset or blank, the machine file is .agent-forge/config.toml under the OS home", () => {
    for (const forgeHome of [undefined, "  "]) {
      const s = sandbox();
      writeFileSync(s.userFile, '[workflow]\ndefault_crew = "claude-master"\n');
      const { files } = withProcessHomes(forgeHome, s.home, () =>
        loadConfig({ harnessRoot: s.harness, env: {} }),
      );
      expect(files).toEqual([s.userFile]);
    }
  });
});

describe("loadConfig: what it reads", () => {
  test("a workspace file that starts with a byte-order mark is read for its values", () => {
    const s = sandbox();
    writeFileSync(
      s.workspaceFile,
      '\uFEFF[workflow]\ndefault_crew = "claude-master"\n',
    );
    const { config, provenance } = loadConfig({
      harnessRoot: s.harness,
      home: s.home,
      env: {},
    });
    expect(config.workflow.defaultCrew).toBe("claude-master");
    expect(provenance["workflow.default_crew"]?.source).toBe(s.workspaceFile);
  });

  test("content given for a layer stands in for the file on disk", () => {
    const s = sandbox();
    writeFileSync(s.userFile, '[execution.env]\npass = ["USER_SECRET"]\n');
    writeFileSync(s.workspaceFile, '[workflow]\ndefault_crew = "nobody"\n');
    const { config, provenance, files } = loadConfig({
      harnessRoot: s.harness,
      home: s.home,
      env: {},
      contents: {
        workspace: '[workflow]\ndefault_crew = "claude-master"\n',
      },
    });
    expect(config.workflow.defaultCrew).toBe("claude-master");
    expect(provenance["workflow.default_crew"]?.source).toBe(s.workspaceFile);
    expect(files).toEqual([s.userFile, s.workspaceFile]);
    // A workspace layer exists (here on disk too), so the user file's security key is not inherited.
    expect(config.execution.envPass).toEqual([]);
  });

  test("content for a layer whose file is absent makes that layer exist", () => {
    const s = sandbox();
    writeFileSync(s.userFile, '[execution.env]\npass = ["USER_SECRET"]\n');
    const { config } = loadConfig({
      harnessRoot: s.harness,
      home: s.home,
      env: {},
      contents: { workspace: "" },
    });
    expect(config.execution.envPass).toEqual([]);
  });

  test("a UTF-16 file is refused with a message naming it, not read as empty", () => {
    const s = sandbox();
    writeFileSync(
      s.workspaceFile,
      Buffer.from(
        `${String.fromCharCode(0xfeff)}[workflow]
default_crew = "claude-master"
`,
        "utf16le",
      ),
    );
    expect(() =>
      loadConfig({ harnessRoot: s.harness, home: s.home, env: {} }),
    ).toThrow(`${s.workspaceFile}: is saved as UTF-16`);
  });
});
