import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { scratchDirs } from "../test-scratch";
import { loadConfig, loadConfigFromContents } from "./load";
import { buildSmithCreateCandidate } from "./write";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());

test("captured absent and present-empty layers match disk loading, including env and env-pass security", () => {
  for (const [user, workspace] of [
    [null, null],
    [null, ""],
    ['[execution.env]\npass = ["EXPLICIT_PASS"]\n', null],
    ['[execution.env]\npass = ["EXPLICIT_PASS"]\n', ""],
    ['[execution.env]\npass = ["EXPLICIT_PASS"]\n', "[shift]\nmax_beads = 7\n"],
  ]) {
    const root = scratch.make("config-contents-");
    const userFile = join(root, ".agent-forge", "config.toml");
    const workspaceFile = join(root, "agent-forge.toml");
    mkdirSync(join(root, ".agent-forge"));
    if (user != null) writeFileSync(userFile, user);
    if (workspace != null) writeFileSync(workspaceFile, workspace);
    const env = { AGENT_FORGE_SMITH: "codex-journeyman" };
    const captured = loadConfigFromContents({
      sources: {
        user: { file: userFile, text: user ?? null },
        workspace: { file: workspaceFile, text: workspace ?? null },
      },
      env,
    });
    expect(captured).toEqual(
      loadConfig({ harnessRoot: root, home: root, env }),
    );
    expect(captured.config.execution.envPass).toEqual(
      user != null && workspace === null ? ["EXPLICIT_PASS"] : [],
    );
    expect(captured.provenance["workflow.default_crew"]?.source).toBe("env");
  }
});

test("candidate uses only captured snapshots with absent parents and never reads or changes files by their labels", () => {
  const root = scratch.make("config-candidate-");
  const parent = join(root, "absent-parent");
  const userFile = join(parent, "config.toml");
  const workspaceFile = join(root, "agent-forge.toml");
  const unreviewedDisk = "[[[invalid disk document\n";
  writeFileSync(workspaceFile, unreviewedDisk);
  const result = buildSmithCreateCandidate({
    target: "user",
    smith: {
      name: "new-craft",
      provider: "future-provider",
      model: "model",
      effort: "native-effort",
      enabled: false,
      tags: [],
    },
    sources: {
      user: { file: userFile, bytes: null },
      workspace: { file: workspaceFile, bytes: null },
    },
    env: {},
  });
  expect(result.ok ? null : result.error).toBeNull();
  if (!result.ok) throw new Error(result.error);
  expect(result.value.created).toBe(true);
  expect(result.value.effective.files).toEqual([userFile]);
  expect(result.value.effective.config.smiths["new-craft"]?.provider).toBe(
    "future-provider",
  );
  expect(result.value.effective.config.smiths["new-craft"]?.enabled).toBe(
    false,
  );
  expect(existsSync(parent)).toBe(false);
  expect(readFileSync(workspaceFile, "utf8")).toBe(unreviewedDisk);
});

test("captured absence never falls back to existing files and errors retain layer order and labels", () => {
  const root = scratch.make("config-contents-");
  const workspaceFile = join(root, "agent-forge.toml");
  writeFileSync(workspaceFile, '[workflow]\ndefault_crew = "ghost"\n');
  const sources = {
    user: { file: join(root, "absent-parent", "config.toml"), text: null },
    workspace: { file: workspaceFile, text: null },
  };
  expect(loadConfigFromContents({ sources, env: {} }).files).toEqual([]);
  expect(() =>
    loadConfigFromContents({
      sources: {
        user: { ...sources.user, text: "[shift]\nrepairs = -1\n" },
        workspace: { ...sources.workspace, text: "[[[" },
      },
      env: {},
    }),
  ).toThrow(`${sources.user.file}: shift.repairs`);
});

test("legacy contents overrides count as present even with absent files, and report the user error first", () => {
  const root = scratch.make("config-contents-");
  const userFile = join(root, ".agent-forge", "config.toml");
  const workspaceFile = join(root, "agent-forge.toml");
  const user = '[execution.env]\npass = ["EXPLICIT_PASS"]\n';
  const options = { harnessRoot: root, home: root, env: {} };
  const pure = loadConfigFromContents({
    sources: {
      user: { file: userFile, text: user },
      workspace: { file: workspaceFile, text: "" },
    },
    env: {},
  });
  expect(loadConfig({ ...options, contents: { user, workspace: "" } })).toEqual(
    pure,
  );
  expect(pure.config.execution.envPass).toEqual([]);
  expect(pure.files).toEqual([userFile, workspaceFile]);
  expect(existsSync(join(root, ".agent-forge"))).toBe(false);
  expect(existsSync(workspaceFile)).toBe(false);
  expect(() =>
    loadConfig({
      ...options,
      contents: { user: "[shift]\nrepairs = -1\n", workspace: "[[[" },
    }),
  ).toThrow(`${userFile}: shift.repairs`);
});
