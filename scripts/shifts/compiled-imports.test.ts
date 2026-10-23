import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildChildEnv } from "../executors/env";
import { lockPath } from "../hearth/home";
import { readLock } from "../hearth/lock";
import { loopbackExchange } from "../hearth/loopback";
import { HEALTH_ROUTE } from "../hearth/paths";
import { importGraph } from "../import-graph";
import { scratchDirs } from "../test-scratch";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());

test("every implementation reachable from the packaged entry excludes source CLI dispatchers", () => {
  const graph = importGraph(
    join(import.meta.dir, "../hearth/compiled-entry.ts"),
  );
  const dispatchers = graph.files.filter((file) =>
    /^\s*if\s*\(isMain\(import\.meta\)\)/m.test(readFileSync(file, "utf8")),
  );
  expect(dispatchers).toEqual([]);
});

test("the actual packaged normal server boots once, and its source entry reuses that exact live server without command dispatch", async () => {
  const root = scratch.make("pure compiled hearth "),
    home = join(root, "home"),
    executable = join(
      root,
      process.platform === "win32" ? "hearth.exe" : "hearth",
    );
  mkdirSync(join(root, ".git"));
  const env = {
    ...buildChildEnv(process.env, []),
    PATH: "",
    HOME: root,
    USERPROFILE: root,
    APPDATA: root,
    LOCALAPPDATA: root,
    XDG_CONFIG_HOME: root,
    AGENT_FORGE_HOME: home,
    HEARTH_PORT: "",
  };
  const built = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "--compile",
      join(import.meta.dir, "../hearth/compiled-entry.ts"),
      "--outfile",
      executable,
    ],
    {
      cwd: root,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30000,
    },
  );
  expect(built.exitCode, built.stderr.toString().slice(-4000)).toBe(0);
  const child = Bun.spawn([executable, "--root", root], {
    cwd: root,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text(),
    stderr = new Response(child.stderr).text();
  const timer = setTimeout(() => child.kill(), 15000);
  try {
    const deadline = Date.now() + 10000;
    let lock = readLock(lockPath(home, root));
    while (
      (!lock || lock.pid !== child.pid) &&
      child.exitCode === null &&
      Date.now() < deadline
    ) {
      await Bun.sleep(10);
      lock = readLock(lockPath(home, root));
    }
    if (!lock || lock.pid !== child.pid)
      throw Error(
        `Compiled normal hearth did not own its lock; exit=${child.exitCode}`,
      );
    const answer = await loopbackExchange({
      port: lock.port,
      method: "GET",
      target: HEALTH_ROUTE,
      headers: {},
      timeoutMs: 5000,
      maxBytes: 4096,
    });
    expect(answer.status).toBe(200);
    let health: unknown;
    try {
      health = JSON.parse(answer.body);
    } catch {
      throw Error("Invalid compiled health reply");
    }
    expect(health).toMatchObject({
      ok: true,
      data: { pid: child.pid },
      error: null,
    });
    const source = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "../hearth/server.ts"),
        "--root",
        root,
      ],
      {
        cwd: root,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10000,
      },
    );
    expect(source.exitCode, source.stderr.toString().slice(-4000)).toBe(0);
    expect(source.stdout.toString()).toBe(
      `hearth already running on http://127.0.0.1:${lock.port}\n`,
    );
    expect(readLock(lockPath(home, root))?.pid).toBe(child.pid);
  } finally {
    child.kill();
    await child.exited;
    clearTimeout(timer);
  }
  expect(await stdout).toMatch(
    /^hearth listening on http:\/\/127\.0\.0\.1:\d+\r?\n$/,
  );
  expect(await stderr).toBe("");
}, 60000);

test("the bundle source wrapper retains its closed usage refusal without reading a tracker", () => {
  const root = scratch.make("pure bundle source ");
  const result = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "../beads/convoy-bundles.ts")],
    {
      cwd: root,
      env: {
        ...buildChildEnv(process.env, []),
        PATH: "",
        HOME: root,
        USERPROFILE: root,
        AGENT_FORGE_HOME: join(root, "home"),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    },
  );
  expect(result.exitCode).toBe(1);
  let body: unknown;
  try {
    body = JSON.parse(result.stdout.toString());
  } catch {
    throw Error("Invalid source bundle envelope");
  }
  expect(body).toEqual({
    ok: false,
    data: null,
    error: "usage: bun run beads:bundles <EPIC-ID>",
  });
  expect(result.stderr.toString()).toBe("");
});
