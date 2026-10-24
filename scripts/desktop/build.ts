import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isMain } from "../is-main";

const root = resolve(import.meta.dir, "../..");
const app = join(root, "apps", "desktop");
const tauri = join(app, "src-tauri");
const triple = "x86_64-pc-windows-msvc";
const sidecars = join(tauri, "binaries");
const target = resolve(process.env.CARGO_TARGET_DIR ?? join(tauri, "target"));
const stage = resolve(app, "build", "windows-x64");

async function run(
  label: string,
  command: string[],
  env: Record<string, string | undefined> = process.env,
  timeoutMs = 300_000,
): Promise<void> {
  const child = Bun.spawn({
    cmd: command,
    cwd: label === "Tauri release build" ? app : root,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  const code = await child.exited;
  clearTimeout(timer);
  if (timedOut) throw new Error(`${label} exceeded ${timeoutMs / 1000}s`);
  if (code !== 0) throw new Error(`${label} failed with exit code ${code}`);
}

function assertWindowsX64(): void {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("The first desktop build supports Windows x64 only.");
  }
}

async function main(): Promise<void> {
  assertWindowsX64();
  assertSafeStage();
  mkdirSync(sidecars, { recursive: true });
  const env = { ...process.env, DASHBOARD_NO_BUILD: "1" };
  await run(
    "desktop dashboard build",
    [process.execPath, "run", "dashboard:build", "--mode", "desktop"],
    env,
    120_000,
  );
  await run("desktop host compile", [
    process.execPath,
    "build",
    "--compile",
    "scripts/desktop/compiled-host-entry.ts",
    "--outfile",
    join(sidecars, `desktop-host-${triple}.exe`),
  ]);
  await run("hearth compile", [
    process.execPath,
    "build",
    "--compile",
    "scripts/hearth/compiled-entry.ts",
    "--outfile",
    join(sidecars, `hearth-${triple}.exe`),
  ]);
  await run(
    "Tauri release build",
    [process.execPath, "tauri", "build", "--no-bundle"],
    process.env,
    900_000,
  );

  const exe = join(target, "release", "agent-forge-desktop.exe");
  if (!existsSync(exe))
    throw new Error("Tauri release executable was not produced");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  copyFileSync(exe, join(stage, "agent-forge-desktop.exe"));
  cpSync(join(root, "docs", "dist"), join(stage, "dashboard"), {
    recursive: true,
  });
  for (const name of ["desktop-host", "hearth"]) {
    copyFileSync(
      join(sidecars, `${name}-${triple}.exe`),
      join(stage, `${name}.exe`),
    );
  }
  console.log(
    JSON.stringify({
      ok: true,
      data: {
        platform: "windows-x64",
        executable: join(stage, "agent-forge-desktop.exe"),
        staged: true,
      },
      error: null,
    }),
  );
}

function assertSafeStage(): void {
  const buildRoot = resolve(app, "build");
  const stageRelative = relative(buildRoot, stage);
  if (
    stageRelative === "" ||
    stageRelative === ".." ||
    stageRelative.startsWith(`..${sep}`) ||
    isAbsolute(stageRelative)
  ) {
    throw new Error(
      "Refusing to clean a stage path outside apps/desktop/build",
    );
  }
}

if (isMain(import.meta)) {
  main().catch((error: unknown) => {
    console.log(
      JSON.stringify({
        ok: false,
        data: null,
        error: error instanceof Error ? error.message : "Desktop build failed",
      }),
    );
    process.exitCode = 1;
  });
}
