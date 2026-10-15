import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { scratchDirs } from "../test-scratch";
import {
  BUILTIN_SHIFT_CONFIG,
  loadConfig,
  machineConfigFile,
  parseDuration,
} from "./load";
import { withProcessHomes } from "./testing";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());

function sandbox() {
  const root = scratch.make("forge-config-");
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
      // Under Bun on Linux the OS home does not follow a variable changed at
      // runtime, so the path is compared, and nothing is written there.
      const [file, osHome] = withProcessHomes(
        forgeHome,
        sandbox().home,
        () => [machineConfigFile({}), homedir()] as const,
      );
      expect(file).toBe(join(osHome, ".agent-forge", "config.toml"));
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

describe("loadConfig: [shift]", () => {
  const load = (s: ReturnType<typeof sandbox>) =>
    loadConfig({ harnessRoot: s.harness, home: s.home, env: {} });

  test("with no files it is the builtins, each key reported as shift.<key> from builtin, the duration as written", () => {
    const { config, provenance } = load(sandbox());
    expect(config.shift).toEqual({
      concurrency: 2,
      forMs: 2 * 3_600_000,
      maxBeads: 4,
      maxUsd: 10,
      repairs: 3,
      throttle: 0.85,
    });
    expect(BUILTIN_SHIFT_CONFIG).toEqual(config.shift);
    expect(
      Object.fromEntries(
        Object.entries(provenance).filter(([key]) => key.startsWith("shift.")),
      ),
    ).toEqual({
      "shift.concurrency": { value: 2, source: "builtin" },
      "shift.for": { value: "2h", source: "builtin" },
      "shift.max_beads": { value: 4, source: "builtin" },
      "shift.max_usd": { value: 10, source: "builtin" },
      "shift.repairs": { value: 3, source: "builtin" },
      "shift.throttle": { value: 0.85, source: "builtin" },
    });
  });

  test("the workspace file wins a key both files set; a key only the machine file sets, max_usd included, still applies with a workspace file; each names its file", () => {
    const s = sandbox();
    writeFileSync(s.userFile, "[shift]\nconcurrency = 3\nmax_usd = 25.5\n");
    writeFileSync(
      s.workspaceFile,
      '[shift]\nconcurrency = 1\nfor = "90m"\nthrottle = 0.5\n',
    );
    const { config, provenance } = load(s);
    expect(config.shift).toEqual({
      concurrency: 1,
      forMs: 90 * 60_000,
      maxBeads: 4,
      maxUsd: 25.5,
      repairs: 3,
      throttle: 0.5,
    });
    expect(provenance["shift.concurrency"]).toEqual({
      value: 1,
      source: s.workspaceFile,
    });
    expect(provenance["shift.for"]).toEqual({
      value: "90m",
      source: s.workspaceFile,
    });
    expect(provenance["shift.throttle"]?.source).toBe(s.workspaceFile);
    expect(provenance["shift.max_usd"]).toEqual({
      value: 25.5,
      source: s.userFile,
    });
    expect(provenance["shift.max_beads"]?.source).toBe("builtin");
  });

  test("a value outside the shift's own bounds, of another type, an unknown key or a [shift] that is not a table fails the load naming the file and the key", () => {
    const cases: Array<[string, string]> = [
      [
        "concurrency = 0",
        "shift.concurrency: expected a whole number from 1 to 8",
      ],
      [
        "concurrency = 9",
        "shift.concurrency: expected a whole number from 1 to 8",
      ],
      [
        "concurrency = 1.5",
        "shift.concurrency: expected a whole number from 1 to 8",
      ],
      [
        'concurrency = "2"',
        "shift.concurrency: expected a whole number from 1 to 8",
      ],
      [
        "max_beads = 101",
        "shift.max_beads: expected a whole number from 1 to 100",
      ],
      ["repairs = -1", "shift.repairs: expected a whole number from 0 to 10"],
      ["max_usd = 0", "shift.max_usd: expected dollars above 0, at most 1000"],
      [
        "max_usd = 1000.5",
        "shift.max_usd: expected dollars above 0, at most 1000",
      ],
      [
        'max_usd = "5"',
        "shift.max_usd: expected dollars above 0, at most 1000",
      ],
      ['for = "soon"', "shift.for: expected a duration such as 90s, 30m or 2h"],
      [
        "for = 7200000",
        "shift.for: expected a duration such as 90s, 30m or 2h",
      ],
      ['for = "25h"', "shift.for: expected a duration of at most 24h"],
      ["throttle = 0", "shift.throttle: expected a share above 0, at most 1"],
      [
        "throttle = 1.01",
        "shift.throttle: expected a share above 0, at most 1",
      ],
      [
        "max-usd = 5",
        "shift.max-usd: unknown key (expected concurrency | for | max_beads | max_usd | repairs | throttle)",
      ],
      ["constructor = 1", "shift.constructor: unknown key"],
    ];
    for (const [line, why] of cases) {
      const s = sandbox();
      writeFileSync(s.workspaceFile, `[shift]\n${line}\n`);
      expect(() => load(s)).toThrow(`${s.workspaceFile}: ${why}`);
    }
    const table = sandbox();
    writeFileSync(table.workspaceFile, "shift = 3\n");
    expect(() => load(table)).toThrow(
      `${table.workspaceFile}: shift: expected a table`,
    );
    // The machine file is checked as the workspace file is.
    const machine = sandbox();
    writeFileSync(machine.userFile, "[shift]\nmax_usd = 5000\n");
    expect(() => load(machine)).toThrow(
      `${machine.userFile}: shift.max_usd: expected dollars above 0, at most 1000`,
    );
  });

  test("the shipped example's commented [shift], uncommented, loads to the builtins", () => {
    const example = readFileSync(
      join(import.meta.dir, "..", "..", "agent-forge.toml.example"),
      "utf8",
    );
    const at = example.indexOf("# [shift]");
    expect(at).toBeGreaterThan(-1);
    const block = example
      .slice(at)
      .split(/\r?\n/)
      .map((line) => line.replace(/^# /, ""))
      .join("\n");
    const s = sandbox();
    writeFileSync(s.workspaceFile, block);
    const { config, provenance } = load(s);
    expect(config.shift).toEqual(BUILTIN_SHIFT_CONFIG);
    expect(provenance["shift.throttle"]?.source).toBe(s.workspaceFile);
  });

  test("the highest value of each bound loads", () => {
    const s = sandbox();
    writeFileSync(
      s.workspaceFile,
      '[shift]\nconcurrency = 8\nfor = "24h"\nmax_beads = 100\nmax_usd = 1000\nrepairs = 10\nthrottle = 1\n',
    );
    expect(load(s).config.shift).toEqual({
      concurrency: 8,
      forMs: 24 * 3_600_000,
      maxBeads: 100,
      maxUsd: 1000,
      repairs: 10,
      throttle: 1,
    });
  });
});

describe("parseDuration", () => {
  test("whole seconds, minutes and hours", () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("2h")).toBe(7_200_000);
  });

  test("anything else is no duration", () => {
    for (const text of ["soon", "0m", "-1h", "2 h", "1.5h", "2", "h", "2d", ""])
      expect(parseDuration(text)).toBeNull();
  });
});
