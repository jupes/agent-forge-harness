/**
 * The isolation probe's rules, called directly: which environments name no
 * home, and where a spawn call's options are found. Installing the probe is
 * exercised by `test-isolation.test.ts`, in the guard's re-run; it is never
 * installed in this process.
 */

import { describe, expect, test } from "bun:test";
import {
  homeVariable,
  namesNoHome,
  probeBunSpawnArgs,
  probeNodeArgs,
} from "./isolation-probe";

const HOME = "/scratch/.agent-forge";

describe("namesNoHome", () => {
  test("the OS home variable is USERPROFILE on Windows and HOME elsewhere", () => {
    expect(homeVariable("win32")).toBe("USERPROFILE");
    expect(homeVariable("linux")).toBe("HOME");
    expect(homeVariable("darwin")).toBe("HOME");
  });

  test("an environment with no AGENT_FORGE_HOME and no OS home variable names no home, on either platform", () => {
    expect(namesNoHome({ PATH: "/bin" }, "win32")).toBe(true);
    expect(namesNoHome({ PATH: "/bin" }, "linux")).toBe(true);
    expect(namesNoHome({}, "linux")).toBe(true);
  });

  test("AGENT_FORGE_HOME names a home unless it is whitespace", () => {
    expect(namesNoHome({ AGENT_FORGE_HOME: "/forge" }, "linux")).toBe(false);
    expect(namesNoHome({ AGENT_FORGE_HOME: "C:\\forge" }, "win32")).toBe(false);
    expect(namesNoHome({ AGENT_FORGE_HOME: "  " }, "linux")).toBe(true);
    expect(namesNoHome({ AGENT_FORGE_HOME: "" }, "win32")).toBe(true);
  });

  test("only the platform's own home variable counts, and a blank one is not a missing one", () => {
    expect(namesNoHome({ USERPROFILE: "C:\\Users\\a" }, "win32")).toBe(false);
    expect(namesNoHome({ HOME: "C:\\Users\\a" }, "win32")).toBe(true);
    expect(namesNoHome({ HOME: "/home/a" }, "linux")).toBe(false);
    expect(namesNoHome({ USERPROFILE: "/home/a" }, "linux")).toBe(true);
    expect(namesNoHome({ USERPROFILE: "" }, "win32")).toBe(false);
    expect(namesNoHome({ HOME: "" }, "linux")).toBe(false);
  });
});

describe("probeBunSpawnArgs", () => {
  test("Bun.spawn(cmd, options) with an env that names no home gets AGENT_FORGE_HOME added; the other options and the caller's objects are untouched", () => {
    const options = { env: { PATH: "/bin" }, stdout: "pipe" };
    expect(
      probeBunSpawnArgs([["bun", "x.ts"], options], HOME, "linux"),
    ).toEqual([
      ["bun", "x.ts"],
      { env: { PATH: "/bin", AGENT_FORGE_HOME: HOME }, stdout: "pipe" },
    ]);
    expect(options).toEqual({ env: { PATH: "/bin" }, stdout: "pipe" });
  });

  test("Bun.spawn({ cmd, env }) is probed in its one argument", () => {
    expect(
      probeBunSpawnArgs(
        [{ cmd: ["bun"], env: { PATH: "/bin" } }],
        HOME,
        "win32",
      ),
    ).toEqual([
      { cmd: ["bun"], env: { PATH: "/bin", AGENT_FORGE_HOME: HOME } },
    ]);
  });

  test("a call with no env (the child inherits this process's) or an env that names a home is passed on as it is", () => {
    const calls: unknown[][] = [
      [["bun"]],
      [["bun"], { stdout: "pipe" }],
      [{ cmd: ["bun"] }],
      [["bun"], { env: { PATH: "/bin", HOME: "/home/a" } }],
      [["bun"], { env: { PATH: "/bin", AGENT_FORGE_HOME: "/forge" } }],
    ];
    for (const args of calls)
      expect(probeBunSpawnArgs(args, HOME, "linux")).toEqual(args);
  });
});

describe("probeNodeArgs", () => {
  test("the options are found after the command, with or without an argument list, and a callback after them is kept", () => {
    const callback = (): void => {};
    const probedEnv = { PATH: "/bin", AGENT_FORGE_HOME: HOME };
    expect(
      probeNodeArgs(
        ["bun", ["x.ts"], { env: { PATH: "/bin" } }],
        HOME,
        "linux",
      ),
    ).toEqual(["bun", ["x.ts"], { env: probedEnv }]);
    expect(
      probeNodeArgs(["bun", { env: { PATH: "/bin" } }], HOME, "linux"),
    ).toEqual(["bun", { env: probedEnv }]);
    expect(
      probeNodeArgs(
        ["bun x.ts", { env: { PATH: "/bin" } }, callback],
        HOME,
        "win32",
      ),
    ).toEqual(["bun x.ts", { env: probedEnv }, callback]);
  });

  test("a call with no options, or options with no env, is passed on as it is", () => {
    const callback = (): void => {};
    const calls: unknown[][] = [
      ["bun"],
      ["bun", ["x.ts"]],
      ["bun", ["x.ts"], callback],
      ["bun", ["x.ts"], { cwd: "/tmp" }],
    ];
    for (const args of calls)
      expect(probeNodeArgs(args, HOME, "linux")).toEqual(args);
  });
});
