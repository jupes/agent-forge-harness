/**
 * The spawn probe the isolation guard's re-run installs (`test-isolation.test.ts`).
 *
 * The guard re-runs every test file that can start a process with the OS home
 * pointed at a scratch directory, and fails if `<scratch>/.agent-forge`
 * appears. A child whose environment names neither `AGENT_FORGE_HOME` nor the
 * variable the OS home is read from (`USERPROFILE` on Windows, `HOME`
 * elsewhere) takes the home of the user's account instead, so it would write
 * under the real home and the scratch directory would never see it. Bun's
 * spawn on Windows fills a missing `USERPROFILE` from the spawning process,
 * which is the scratch directory in the re-run; a POSIX spawn fills nothing.
 *
 * In the re-run the guard sets `ISOLATION_HOME` to `<scratch>/.agent-forge`
 * and the test preload installs this probe in the test process. A call to
 * `Bun.spawn`, `Bun.spawnSync` or a `node:child_process` function (which the
 * MCP stdio client reaches) whose options carry such an environment starts the
 * child with `AGENT_FORGE_HOME` added, set to that directory: the home the
 * child would have had had it kept the OS home variable. What the child writes
 * there, the guard sees. Nothing else about the call changes, and an ordinary
 * test run installs nothing.
 *
 * Not probed: the Bun shell (`Bun.$`), and a process started by a child,
 * which runs without the preload.
 */

import { mock } from "bun:test";
import * as childProcess from "node:child_process";
import { promisify } from "node:util";

/** Set by the guard for its re-run: the Agent Forge home a child that names no home is given. */
export const ISOLATION_HOME = "AGENT_FORGE_ISOLATION_HOME";

type Env = Readonly<Record<string, string | undefined>>;

/** The variable the OS home is read from on a platform. */
export function homeVariable(
  platform: NodeJS.Platform = process.platform,
): "USERPROFILE" | "HOME" {
  return platform === "win32" ? "USERPROFILE" : "HOME";
}

/**
 * Whether a child started with this environment takes its Agent Forge home
 * from the user's account: no `AGENT_FORGE_HOME` beyond whitespace (the rule
 * in `scripts/agent-forge-home.ts`) and no OS home variable at all. A blank
 * home variable is not the account's home: the OS home then fails or is
 * empty.
 */
export function namesNoHome(
  env: Env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const override = env.AGENT_FORGE_HOME;
  if (override !== undefined && override.trim().length > 0) return false;
  return env[homeVariable(platform)] === undefined;
}

function isOptions(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The arguments with the options at `at` given `AGENT_FORGE_HOME = home` when their env names no home. */
function probeAt(
  args: readonly unknown[],
  at: number,
  home: string,
  platform: NodeJS.Platform,
): unknown[] {
  const options = args[at];
  if (!isOptions(options) || !isOptions(options.env)) return [...args];
  const env = options.env as Env;
  if (!namesNoHome(env, platform)) return [...args];
  const probed = [...args];
  probed[at] = { ...options, env: { ...env, AGENT_FORGE_HOME: home } };
  return probed;
}

/** `Bun.spawn` / `Bun.spawnSync` arguments: the options are `(cmd, options)`'s second or `({ cmd, ... })`'s only one. */
export function probeBunSpawnArgs(
  args: readonly unknown[],
  home: string,
  platform: NodeJS.Platform = process.platform,
): unknown[] {
  return probeAt(args, Array.isArray(args[0]) ? 1 : 0, home, platform);
}

/** `node:child_process` arguments: the options are the first plain object after the command. */
export function probeNodeArgs(
  args: readonly unknown[],
  home: string,
  platform: NodeJS.Platform = process.platform,
): unknown[] {
  const at = args.findIndex((arg, index) => index > 0 && isOptions(arg));
  return at === -1 ? [...args] : probeAt(args, at, home, platform);
}

export type Probe = (args: readonly unknown[]) => unknown[];
type Callable = (...args: unknown[]) => unknown;

/**
 * `fn`, called on `self` with its arguments passed through `probe`; the
 * `promisify` form it carries (`exec`, `execFile`) is probed too. Anything
 * that is not a function is returned as it is.
 */
export function probed(fn: unknown, self: unknown, probe: Probe): unknown {
  if (typeof fn !== "function") return fn;
  const wrap =
    (target: Callable): Callable =>
    (...args) =>
      Reflect.apply(target, self, probe(args));
  const wrapper = wrap(fn as Callable);
  const custom: unknown = Reflect.get(fn, promisify.custom);
  if (typeof custom === "function")
    Object.defineProperty(wrapper, promisify.custom, {
      value: wrap(custom as Callable),
    });
  return wrapper;
}

const NODE_SPAWNS = [
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
] as const;

/** Wraps the spawn primitives of this process so a child that names no home is given `home`. */
export function installIsolationProbe(home: string): void {
  const bunProbe: Probe = (args) => probeBunSpawnArgs(args, home);
  Object.assign(Bun, {
    spawn: probed(Bun.spawn, Bun, bunProbe),
    spawnSync: probed(Bun.spawnSync, Bun, bunProbe),
  });
  const nodeProbe: Probe = (args) => probeNodeArgs(args, home);
  const real: Record<string, unknown> = { ...childProcess };
  const wrapped = Object.fromEntries(
    NODE_SPAWNS.map((name) => [name, probed(real[name], undefined, nodeProbe)]),
  );
  mock.module("node:child_process", () => ({ ...real, ...wrapped }));
}
