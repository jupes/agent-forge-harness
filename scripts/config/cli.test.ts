import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { scratchDirs } from "../test-scratch";
import { runConfigCli as runConfigCliImpl } from "./cli";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());

function setup() {
  const root = scratch.make("forge-config-cli-");
  return { harnessRoot: root, home: root, env: {} };
}

function runConfigCli(
  argv: string[],
  options: Parameters<typeof runConfigCliImpl>[1],
) {
  return runConfigCliImpl(argv, options, {
    coordinationRoot: join(options.home ?? options.harnessRoot, "coordination"),
  });
}

describe("forge:config", () => {
  test("show --json prints merged smiths and benches with sources", async () => {
    const opts = setup();
    const file = join(opts.harnessRoot, "agent-forge.toml");
    writeFileSync(file, '[smiths.claude-master]\nmodel = "m-x"\n');
    const out = await runConfigCli(["show", "--json"], opts);
    expect(out.code).toBe(0);
    const body = JSON.parse(out.stdout);
    expect(body.ok).toBe(true);
    expect(body.data.config.smiths["claude-master"].model).toBe("m-x");
    expect(body.data.provenance["smiths.claude-master.model"].source).toBe(
      file,
    );
    expect(body.data.config.benches.low.length).toBe(2);
  });

  test("show prints a line per key with its source", async () => {
    const out = await runConfigCli(["show"], setup());
    expect(out.stdout).toContain("workflow.default_crew");
    expect(out.stdout).toContain("(builtin)");
  });

  test("get prints one value; an unknown key exits 2", async () => {
    const opts = setup();
    const ok = await runConfigCli(["get", "workflow.default_crew"], opts);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("claude-journeyman");
    const bad = await runConfigCli(["get", "nope.nothing"], opts);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("unknown key");
  });

  test("get of a key every object has exits 2 as an unknown key", async () => {
    const opts = setup();
    for (const key of ["constructor", "__proto__", "toString"]) {
      const out = await runConfigCli(["get", key], opts);
      expect(out).toEqual({
        code: 2,
        stdout: "",
        stderr: `unknown key "${key}" (see: forge:config keys)`,
      });
    }
  });

  test("keys lists every settable key", async () => {
    const out = await runConfigCli(["keys", "--json"], setup());
    const { keys } = JSON.parse(out.stdout).data;
    expect(keys).toContain("execution.env.pass");
    expect(keys).toContain("benches.low");
  });

  test("show and get print each [shift] key with where it came from, and keys lists them", async () => {
    const opts = setup();
    const file = join(opts.harnessRoot, "agent-forge.toml");
    writeFileSync(file, "[shift]\nmax_usd = 5\n");
    const shown = await runConfigCli(["show"], opts);
    expect(shown.code).toBe(0);
    expect(shown.stdout.split("\n")).toContain(`shift.max_usd = 5  (${file})`);
    expect(shown.stdout.split("\n")).toContain('shift.for = "2h"  (builtin)');
    expect((await runConfigCli(["get", "shift.for"], opts)).stdout).toBe(
      "2h  (from builtin)",
    );
    const got = await runConfigCli(["get", "shift.max_usd", "--json"], opts);
    expect(JSON.parse(got.stdout).data).toEqual({
      key: "shift.max_usd",
      value: 5,
      source: file,
    });
    const shownJson = JSON.parse(
      (await runConfigCli(["show", "--json"], opts)).stdout,
    );
    expect(shownJson.data.config.shift.maxUsd).toBe(5);
    const { keys } = JSON.parse(
      (await runConfigCli(["keys", "--json"], opts)).stdout,
    ).data as { keys: string[] };
    expect(keys.filter((key) => key.startsWith("shift."))).toEqual([
      "shift.concurrency",
      "shift.for",
      "shift.max_beads",
      "shift.max_usd",
      "shift.repairs",
      "shift.throttle",
    ]);
  });

  test("set shift.max_usd 5 --workspace writes it, and get then reports it from the workspace file", async () => {
    const opts = setup();
    const file = join(opts.harnessRoot, "agent-forge.toml");
    const out = await runConfigCli(
      ["set", "shift.max_usd", "5", "--workspace"],
      opts,
    );
    expect(out).toEqual({
      code: 0,
      stdout: `shift.max_usd = 5  (written to ${realpathSync.native(file)})`,
      stderr: "",
    });
    expect(readFileSync(file, "utf8")).toBe("[shift]\nmax_usd = 5\n");
    expect((await runConfigCli(["get", "shift.max_usd"], opts)).stdout).toBe(
      `5  (from ${file})`,
    );
  });

  test("a broken config exits 2 with the file in the message", async () => {
    const opts = setup();
    writeFileSync(join(opts.harnessRoot, "agent-forge.toml"), "a = = 1");
    const out = await runConfigCli(["show", "--json"], opts);
    expect(out.code).toBe(2);
    expect(JSON.parse(out.stdout).error).toContain("agent-forge.toml");
  });
});

describe("forge:config set", () => {
  test.each([
    "absent",
    "present",
  ])("publication through an owned parent alias keeps the exact %s leaf bytes and physical path", async (presence) => {
    const root = scratch.make("forge-config-cli-alias-");
    const physical = join(root, "physical workspace"),
      alias = join(root, "workspace alias");
    mkdirSync(physical);
    symlinkSync(
      physical,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const file = join(alias, "agent-forge.toml"),
      present = presence === "present";
    if (present)
      writeFileSync(
        file,
        "# keep this exact comment\r\n[shift]\r\nmax_usd = 3\r\n",
      );
    expect(existsSync(file)).toBe(present);
    const opts = { harnessRoot: alias, home: root, env: {} };
    const out = await runConfigCli(
      ["set", "shift.max_usd", "5", "--workspace", "--json"],
      opts,
    );
    expect(out.code).toBe(0);
    let body: unknown;
    try {
      body = JSON.parse(out.stdout);
    } catch {
      throw Error("Invalid scalar alias fixture envelope");
    }
    const published = realpathSync.native(file);
    expect(published).not.toBe(file);
    expect(published).toBe(
      join(realpathSync.native(physical), "agent-forge.toml"),
    );
    expect(body).toEqual({
      ok: true,
      data: {
        ok: true,
        key: "shift.max_usd",
        value: 5,
        file: published,
        created: !present,
      },
      error: null,
    });
    expect(readFileSync(file, "utf8")).toBe(
      present
        ? "# keep this exact comment\r\n[shift]\r\nmax_usd = 5\r\n"
        : "[shift]\nmax_usd = 5\n",
    );
    expect((await runConfigCli(["get", "shift.max_usd"], opts)).stdout).toBe(
      `5  (from ${file})`,
    );
  });

  test("set --workspace creates the workspace file, and get then reports the value from it", async () => {
    const opts = setup();
    const file = join(opts.harnessRoot, "agent-forge.toml");
    const out = await runConfigCli(
      ["set", "workflow.default_crew", "claude-master", "--workspace"],
      opts,
    );
    expect(out.code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(
      '[workflow]\ndefault_crew = "claude-master"\n',
    );
    const got = await runConfigCli(
      ["get", "workflow.default_crew", "--json"],
      opts,
    );
    expect(JSON.parse(got.stdout).data).toMatchObject({
      key: "workflow.default_crew",
      value: "claude-master",
      source: file,
    });
  });

  test("needs exactly one of --user or --workspace, and writes nothing without it", async () => {
    const opts = setup();
    for (const flags of [[], ["--user", "--workspace"]]) {
      const out = await runConfigCli(
        ["set", "workflow.default_crew", "claude-master", ...flags],
        opts,
      );
      expect(out.code).toBe(2);
      expect(out.stderr).toContain("--user");
    }
    expect(existsSync(join(opts.harnessRoot, "agent-forge.toml"))).toBe(false);
    expect(existsSync(join(opts.home, ".agent-forge"))).toBe(false);
  });

  test("--user writes under the home it is given; --json answers the envelope", async () => {
    const opts = setup();
    const out = await runConfigCli(
      ["set", "smiths.claude-master.enabled", "false", "--user", "--json"],
      opts,
    );
    expect(out.code).toBe(0);
    const file = join(opts.home, ".agent-forge", "config.toml");
    expect(JSON.parse(out.stdout)).toMatchObject({
      ok: true,
      data: {
        key: "smiths.claude-master.enabled",
        value: false,
        file: realpathSync.native(file),
      },
      error: null,
    });
    expect(readFileSync(file, "utf8")).toBe(
      "[smiths.claude-master]\nenabled = false\n",
    );
  });

  test("a refusal exits 2 with the reason", async () => {
    const out = await runConfigCli(
      ["set", "workflow.default_crew", "nobody", "--workspace", "--json"],
      setup(),
    );
    expect(out.code).toBe(2);
    expect(JSON.parse(out.stdout).error).toContain('unknown smith "nobody"');
  });

  test("a config that does not load today can be repaired by the set that fixes it", async () => {
    const opts = setup();
    const file = join(opts.harnessRoot, "agent-forge.toml");
    writeFileSync(file, '[workflow]\ndefault_crew = "nobody"\n');
    expect((await runConfigCli(["show"], opts)).code).toBe(2);
    const out = await runConfigCli(
      ["set", "workflow.default_crew", "claude-master", "--workspace"],
      opts,
    );
    expect(out.code).toBe(0);
    expect((await runConfigCli(["show"], opts)).code).toBe(0);
  });

  test("replacing the user file's execution.env.pass says so on stderr", async () => {
    const opts = setup();
    mkdirSync(join(opts.home, ".agent-forge"), { recursive: true });
    writeFileSync(
      join(opts.home, ".agent-forge", "config.toml"),
      '[execution.env]\npass = ["A", "B"]\n',
    );
    const out = await runConfigCli(
      ["set", "execution.env.pass", "A", "--workspace"],
      opts,
    );
    expect(out.code).toBe(0);
    expect(out.stderr).toContain("(A, B) no longer applies");
  });
});

describe("forge:config keys and set agree", () => {
  test("every key keys lists can be set with --workspace, a file-defined smith's enabled and tags included, and a foreign field is not listed", async () => {
    const opts = setup();
    const file = join(opts.harnessRoot, "agent-forge.toml");
    writeFileSync(
      file,
      '[smiths.my-codex]\nprovider = "codex"\nmodel = "m"\neffort = "high"\ncolour = "blue"\n',
    );
    const { keys } = JSON.parse(
      (await runConfigCli(["keys", "--json"], opts)).stdout,
    ).data as { keys: string[] };
    expect(keys).toContain("smiths.my-codex.enabled");
    expect(keys).toContain("smiths.my-codex.tags");
    expect(keys).not.toContain("smiths.my-codex.colour");

    const sample = (key: string): string =>
      key === "shift.for"
        ? "90m"
        : key === "shift.throttle"
          ? "0.5"
          : key.startsWith("shift.")
            ? "1"
            : key.endsWith(".enabled")
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
      const out = await runConfigCli(
        ["set", key, sample(key), "--workspace", "--json"],
        opts,
      );
      expect(`${key}: ${out.code} ${out.stdout}`).toStartWith(`${key}: 0`);
    }
  });
});
