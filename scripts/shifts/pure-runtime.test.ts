import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildChildEnv } from "../executors/env";
import { scratchDirs } from "../test-scratch";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());

test("packaged shift and executor implementations import without dispatch, source scripts or ambient Bun", () => {
  const root = scratch.make("pure shift runtime "),
    entry = join(root, "entry.ts"),
    home = join(root, "private-home");
  mkdirSync(join(root, ".git"));
  const modules = {
    exec: join(import.meta.dir, "../executors/exec-runtime.ts").replaceAll(
      "\\",
      "/",
    ),
    shift: join(
      import.meta.dir,
      "../scheduler/shift-cli-runtime.ts",
    ).replaceAll("\\", "/"),
  };
  writeFileSync(
    entry,
    `if(process.argv[2] === "exec") await import(${JSON.stringify(modules.exec)}); else if(process.argv[2] === "shift") await import(${JSON.stringify(modules.shift)}); else throw Error("closed fixture mode"); process.stdout.write(JSON.stringify({ok:true,data:{imported:process.argv[2]},error:null})+"\\n");`,
  );
  const executable = join(
    root,
    `pure${process.platform === "win32" ? ".exe" : ""}`,
  );
  const env = {
    ...buildChildEnv(process.env, []),
    PATH: "",
    HOME: root,
    USERPROFILE: root,
    AGENT_FORGE_HOME: home,
  };
  const built = Bun.spawnSync(
    [process.execPath, "build", "--compile", entry, "--outfile", executable],
    {
      cwd: root,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30000,
    },
  );
  expect(built.exitCode, built.stderr.toString()).toBe(0);
  for (const mode of ["exec", "shift"]) {
    const result = Bun.spawnSync([executable, mode], {
      cwd: root,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toBe(
      `${JSON.stringify({ ok: true, data: { imported: mode }, error: null })}\n`,
    );
    expect(result.stderr.toString()).toBe("");
    expect(existsSync(home)).toBe(false);
  }
}, 45000);
