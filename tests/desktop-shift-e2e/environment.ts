import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { projectCatalogFixture } from "../../scripts/projects/testing";

process.env["PORT"] ??= "8989";
process.env["E2E_HEARTH_PORT"] ??= "8988";
export const FIXTURE_ROOT = (process.env["AGENT_FORGE_SHIFT_FIXTURE_ROOT"] ||=
  realpathSync.native(
    mkdtempSync(join(tmpdir(), "agent-forge-desktop-shift-")),
  ));
export const REPOSITORY = join(FIXTURE_ROOT, "checkout");
export const HOME = join(REPOSITORY, "home");
process.env["AGENT_FORGE_E2E_HOME"] = HOME;
export const BIN = join(HOME, "bd-stand-in/bin"),
  STATE = join(REPOSITORY, "fixture"),
  EMPTY_HOME = join(FIXTURE_ROOT, "os-home");
export function checkedFixtureRoot() {
  const canonical = realpathSync.native(FIXTURE_ROOT);
  if (
    lstatSync(FIXTURE_ROOT).isSymbolicLink() ||
    realpathSync.native(dirname(canonical)) !== realpathSync.native(tmpdir()) ||
    !/^agent-forge-desktop-shift-[a-zA-Z0-9]+$/.test(basename(canonical))
  )
    throw Error(
      "The attended browser fixture is outside its owned temporary directory.",
    );
  return canonical;
}
export function resetTracker() {
  checkedFixtureRoot();
  writeFileSync(
    join(STATE, "tracker.json"),
    JSON.stringify([
      {
        id: "alpha-epic",
        title: "Selected fixture epic",
        issueType: "epic",
        labels: ["project:alpha"],
      },
      {
        id: "alpha-work",
        title: "Bounded fixture work",
        issueType: "task",
        parent: { id: "alpha-epic" },
        labels: ["queue:queued", "project:alpha"],
        metadata: { queue_state: "queued" },
        description: "Planted work.\n\n## Files\nsrc/planted/**\n",
      },
      {
        id: "foreign-work",
        title: "Foreign fixture work",
        issueType: "task",
        labels: ["queue:queued", "project:foreign"],
        metadata: { queue_state: "queued" },
      },
    ]),
  );
}
export function prepareFixture(bun: string) {
  checkedFixtureRoot();
  if (existsSync(join(STATE, "ready"))) return;
  mkdirSync(REPOSITORY, { recursive: true });
  const privateHome = spawnSync(
    bun,
    [
      "-e",
      `import {ensurePrivateHome} from ${JSON.stringify(resolve("scripts/hearth/home-guard.ts").replaceAll("\\", "/"))};ensurePrivateHome(process.argv[1]);`,
      HOME,
    ],
    { encoding: "utf8", timeout: 10000, windowsHide: true },
  );
  if (privateHome.status !== 0)
    throw Error(
      `The isolated attended home could not be made private: ${privateHome.stderr}`,
    );
  for (const path of [
    BIN,
    STATE,
    EMPTY_HOME,
    join(REPOSITORY, ".git"),
    join(REPOSITORY, "scripts/hearth"),
    join(REPOSITORY, ".claude/skills/one"),
    join(REPOSITORY, ".claude/commands"),
    join(REPOSITORY, ".claude/agents"),
    join(HOME, "projects"),
  ])
    mkdirSync(path, { recursive: true });
  writeFileSync(
    join(REPOSITORY, "attended-native-fixture.marker"),
    "agent-forge-attended-native-fixture-v1",
  );
  writeFileSync(join(REPOSITORY, ".gitignore"), "trees/\n");
  writeFileSync(
    join(REPOSITORY, "scripts/hearth/server.ts"),
    "// isolated attended checkout marker\n",
  );
  writeFileSync(
    join(REPOSITORY, ".claude/skills/one/SKILL.md"),
    "# Planted attended skill\n",
  );
  writeFileSync(
    join(REPOSITORY, "agent-forge.toml"),
    '[execution.env]\npass=["CODING_FIXTURE_RECORD","CODEX_RUNTIME_LOG"]\n[shift]\nfor="1m"\nconcurrency=1\nmax_beads=1\nmax_usd=5\nrepairs=0\nthrottle=1.0\n',
  );
  writeFileSync(join(STATE, "trees.json"), "[]");
  resetTracker();
  writeFileSync(join(STATE, "mode.json"), JSON.stringify("rich"));
  writeFileSync(
    join(HOME, "projects/catalog.json"),
    JSON.stringify(projectCatalogFixture(REPOSITORY)),
  );
  const build = (source: string, name: string) => {
    const path = join(BIN, process.platform === "win32" ? `${name}.exe` : name);
    const result = spawnSync(
      bun,
      ["build", "--compile", source, "--outfile", path],
      { encoding: "utf8", timeout: 60000, windowsHide: true },
    );
    if (result.status !== 0)
      throw Error(
        `The attended ${name} fixture did not compile: ${result.stderr}`,
      );
    return path;
  };
  const toolsSource = join(STATE, "tools.ts");
  writeFileSync(
    toolsSource,
    `import {runAttendedNativeToolFixture} from ${JSON.stringify(resolve("scripts/shifts/fixtures/native-tools.ts").replaceAll("\\", "/"))};await runAttendedNativeToolFixture(${JSON.stringify(REPOSITORY)});`,
  );
  const tools = build(toolsSource, "bd");
  for (const name of ["git", "gh"])
    copyFileSync(
      tools,
      join(BIN, process.platform === "win32" ? `${name}.exe` : name),
    );
  const providerSource = join(STATE, "provider.ts");
  writeFileSync(
    providerSource,
    `import {readFileSync} from "node:fs";import {basename} from "node:path";import {isConsoleWindowVisible} from ${JSON.stringify(resolve("scripts/providers/fixtures/console-visibility.ts").replaceAll("\\", "/"))};import {runCodingCliFixture} from ${JSON.stringify(resolve("scripts/sessions/fixtures/coding-cli-fixture.ts").replaceAll("\\", "/"))};import {runCodexTaskRuntimeFixture} from ${JSON.stringify(resolve("scripts/sessions/fixtures/codex-task-runtime-fixture.ts").replaceAll("\\", "/"))};
    const args=process.argv.slice(2);
    if(JSON.stringify(args)===JSON.stringify(["auth","status"])){console.log(JSON.stringify({loggedIn:false,authMethod:"none",consoleWindowVisible:isConsoleWindowVisible()}));process.exitCode=1;}
    else if(JSON.stringify(args)===JSON.stringify(["login","status"])){console.error("Not logged in");process.exitCode=1;}
    else if(args[0]==="-e"){if(args.length!==2||args[1]!=="setInterval(() => {}, 1000)")throw Error("Inert helper refused");await new Promise(()=>setInterval(()=>{},1000));}
    else{let mode;try{mode=JSON.parse(readFileSync(${JSON.stringify(join(STATE, "mode.json"))},"utf8"));}catch{throw Error("Invalid fixture mode");}if(!["rich","hang-tree"].includes(mode))throw Error("Unsupported fixture mode");process.env.CODING_FIXTURE_MODE=mode;process.env.CODEX_RUNTIME_MODE=mode;process.env.CODING_FIXTURE_RECORD=${JSON.stringify(join(STATE, "claude.json"))};process.env.CODEX_RUNTIME_LOG=${JSON.stringify(join(STATE, "codex.jsonl"))};if(basename(process.execPath).startsWith("codex"))await runCodexTaskRuntimeFixture();else await runCodingCliFixture();}`,
  );
  const provider = build(providerSource, "claude");
  copyFileSync(
    provider,
    join(BIN, process.platform === "win32" ? "codex.exe" : "codex"),
  );
  for (const [name, args] of [
    ["claude", ["auth", "status"]],
    ["codex", ["login", "status"]],
  ] as const) {
    const result = spawnSync(
      join(BIN, process.platform === "win32" ? `${name}.exe` : name),
      [...args],
      { encoding: "utf8", timeout: 10000, windowsHide: true },
    );
    if (
      result.status !== 1 ||
      existsSync(join(STATE, "claude.json")) ||
      existsSync(join(STATE, "codex.jsonl"))
    )
      throw Error(
        "A fixed non-generating status fixture created a provider turn.",
      );
    if (process.platform === "win32" && name === "claude") {
      let status: unknown;
      try {
        status = JSON.parse(result.stdout);
      } catch {
        throw Error(
          "The synthetic auth status did not report console visibility.",
        );
      }
      if (
        typeof status !== "object" ||
        status === null ||
        !("consoleWindowVisible" in status) ||
        status.consoleWindowVisible !== false
      )
        throw Error(
          "The synthetic auth check opened a visible console window.",
        );
    }
  }
  const refused = spawnSync(tools, ["export"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
  });
  if (refused.status === 0)
    throw Error("The attended fixture did not refuse the actual checkout.");
  writeFileSync(
    join(STATE, "ready"),
    "agent-forge-attended-browser-fixture-v1",
  );
}
export function fixtureMode(mode: "rich" | "hang-tree") {
  checkedFixtureRoot();
  writeFileSync(join(STATE, "mode.json"), JSON.stringify(mode));
}
/** Held Git preflight is always disposable; cleanup refuses the fetch if an assertion failed before Stop. */
export function holdStartup(hold: boolean) {
  checkedFixtureRoot();
  const flag = join(STATE, "hold-startup"),
    abandoned = join(STATE, "abandon-startup");
  if (hold) {
    rmSync(abandoned, { force: true });
    rmSync(join(STATE, "startup-tree.json"), { force: true });
    writeFileSync(flag, "held-before-shift-record");
  } else {
    writeFileSync(abandoned, "refuse-after-test-cleanup");
    rmSync(flag, { force: true });
  }
}
export function fixtureCalls() {
  const file = join(STATE, "calls.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line): unknown => {
      try {
        return JSON.parse(line);
      } catch {
        throw Error("Invalid fixture calls");
      }
    });
}
export function cleanupFixture() {
  const path = checkedFixtureRoot();
  try {
    rmSync(path, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      !["EBUSY", "EPERM", "ENOTEMPTY"].includes(String(error.code))
    )
      throw error; /* Playwright still owns its hearth here. Its checked OS-temp home can remain until those handles close. */
  }
}
