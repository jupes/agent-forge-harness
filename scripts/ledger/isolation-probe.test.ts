/**
 * The isolation probe's rules, called directly: which environments name no
 * home, where a spawn call's options are found, and how a function is
 * wrapped. Installing the probe is exercised by `test-isolation.test.ts`, in
 * the guard's re-run; it is never installed in this process.
 */

import { describe, expect, test } from "bun:test";
import { promisify } from "node:util";
import {
  homeVariable,
  namesNoHome,
  type Probe,
  probeBunSpawnArgs,
  probed,
  probeNodeArgs,
} from "./isolation-probe";

const HOME = "/scratch/.agent-forge";

describe("probed", () => {
  const tag: Probe = (args) => [...args, "probed"];

  test("the wrapper calls the function on the given this with the probe's arguments and returns its result", () => {
    const self = { name: "module" };
    const calls: unknown[] = [];
    function original(this: unknown, ...args: unknown[]): string {
      calls.push({ self: this, args });
      return "result";
    }
    const wrapper = probed(original, self, tag) as (...a: unknown[]) => unknown;
    expect(wrapper("a", 1)).toBe("result");
    expect(calls).toEqual([{ self, args: ["a", 1, "probed"] }]);
  });

  test("a promisify form the function carries is probed as well, and anything that is not a function is returned as it is", async () => {
    const seen: unknown[][] = [];
    const original = (): void => {};
    Object.defineProperty(original, promisify.custom, {
      value: async (...args: unknown[]) => {
        seen.push(args);
        return { stdout: "out", stderr: "" };
      },
    });
    const wrapper = probed(original, undefined, tag) as typeof original;
    expect(await promisify(wrapper)()).toEqual({ stdout: "out", stderr: "" });
    expect(seen).toEqual([["probed"]]);
    expect(probed("not a function", undefined, tag)).toBe("not a function");
  });
});

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
