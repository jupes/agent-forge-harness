import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { scratchDirs } from "../test-scratch";
import {
  launchWindowsConsole,
  windowsConsoleCommand,
  windowsEnvironmentBlock,
} from "./native-console";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());
test("console launch encoding refuses ambiguous environment and command data before any native effect", () => {
  expect(() => windowsConsoleCommand([])).toThrow();
  expect(() =>
    windowsConsoleCommand(["C:\\fixture\\vendor.cmd", "login"]),
  ).toThrow();
  expect(() =>
    windowsConsoleCommand(["C:\\fixture\\vendor.exe", "login\0extra"]),
  ).toThrow();
  expect(() =>
    windowsEnvironmentBlock({ PATH: "one", Path: "other" }),
  ).toThrow();
  expect(() => windowsEnvironmentBlock({ "BAD=KEY": "value" })).toThrow();
  expect(() =>
    windowsEnvironmentBlock({ PATH: "value\0INJECT=other" }),
  ).toThrow();
  expect(
    windowsEnvironmentBlock({ Z: "last", A: "first" }).toString("utf16le"),
  ).toBe("A=first\0Z=last\0\0");
});

test.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "native console preserves synthetic argv, explicit environment and cwd without terminal capture",
  async () => {
    const root = scratch.make("native-login-argv-");
    const record = join(root, "record.json");
    const args = [
      "space inside",
      'literal"quote',
      "C:\\trailing\\",
      "Unicode 🌱",
    ];
    const prior = process.env["NATIVE_FIXTURE_SECRET"];
    process.env["NATIVE_FIXTURE_SECRET"] =
      "synthetic-parent-value-must-not-inherit";
    try {
      const child = launchWindowsConsole({
        command: [
          process.execPath,
          join(import.meta.dir, "fixtures/console-cli.ts"),
          ...args,
        ],
        cwd: root,
        env: {
          SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows",
          CONSOLE_FIXTURE_RECORD: record,
        },
        timeoutMs: 5000,
      });
      const result = await child.done;
      expect(result.exitCode).toBe(0);
      expect(result.stopped).toBe(false);
      expect(result.timedOut).toBe(false);
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(record, "utf8"));
      } catch {
        throw Error("Synthetic native console record is missing");
      }
      expect(raw).toMatchObject({ args, marker: null, hasConsole: true });
      if (
        !raw ||
        typeof raw !== "object" ||
        !("cwd" in raw) ||
        typeof raw.cwd !== "string"
      )
        throw Error("Missing native cwd metadata");
      expect(realpathSync.native(raw.cwd).toLowerCase()).toBe(
        realpathSync.native(root).toLowerCase(),
      );
      expect(JSON.stringify(result)).not.toContain(
        "terminal-fixture-output-never-captured",
      );
    } finally {
      if (prior === undefined) delete process.env["NATIVE_FIXTURE_SECRET"];
      else process.env["NATIVE_FIXTURE_SECRET"] = prior;
    }
  },
);

test.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "a completed login CLI cannot leave an unowned helper running",
  async () => {
    const root = scratch.make("native-login-exit-tree-"),
      record = join(root, "tree.json");
    const child = launchWindowsConsole({
      command: [
        process.execPath,
        join(import.meta.dir, "fixtures/console-cli.ts"),
        "exit-with-child",
      ],
      cwd: root,
      env: { CONSOLE_FIXTURE_RECORD: record },
      timeoutMs: 5000,
      visible: false,
    });
    let descendant: number | undefined;
    try {
      expect((await child.done).exitCode).toBe(0);
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(record, "utf8"));
      } catch {
        throw Error("Missing synthetic descendant");
      }
      if (
        !raw ||
        typeof raw !== "object" ||
        !("childPid" in raw) ||
        typeof raw.childPid !== "number"
      )
        throw Error("Invalid synthetic PID");
      descendant = raw.childPid;
      let alive = true;
      for (let index = 0; index < 50 && alive; index++) {
        try {
          process.kill(descendant, 0);
          await Bun.sleep(20);
        } catch {
          alive = false;
        }
      }
      expect(alive).toBe(false);
    } finally {
      if (descendant !== undefined) {
        try {
          process.kill(descendant, "SIGKILL");
        } catch {
          /* already ended */
        }
      }
      await child.stop();
    }
  },
);

test.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "a failed mandatory job assignment never resumes the native CLI",
  () => {
    const root = scratch.make("native-login-refusal-");
    const record = join(root, "must-not-exist.json");
    expect(() =>
      launchWindowsConsole(
        {
          command: [
            process.execPath,
            join(import.meta.dir, "fixtures/console-cli.ts"),
          ],
          cwd: root,
          env: {
            SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows",
            CONSOLE_FIXTURE_RECORD: record,
          },
          timeoutMs: 5000,
          visible: false,
        },
        { guard: () => null },
      ),
    ).toThrow("could not be supervised");
    expect(existsSync(record)).toBe(false);
  },
);

test.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "native login timeout terminates its guarded process and descendants",
  async () => {
    const root = scratch.make("native-login-timeout-");
    const record = join(root, "record.json");
    const child = launchWindowsConsole({
      command: [
        process.execPath,
        join(import.meta.dir, "fixtures/console-cli.ts"),
        "hang-tree",
      ],
      cwd: root,
      env: {
        SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows",
        CONSOLE_FIXTURE_RECORD: record,
      },
      timeoutMs: 3000,
      visible: false,
    });
    const result = await child.done;
    expect(result.timedOut).toBe(true);
    expect(result.stopped).toBe(false);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(record, "utf8"));
    } catch {
      throw Error("Synthetic native process tree record is missing");
    }
    if (
      !raw ||
      typeof raw !== "object" ||
      !("childPid" in raw) ||
      typeof raw.childPid !== "number"
    )
      throw Error("Invalid native child metadata");
    for (const pid of [child.pid, raw.childPid]) {
      let alive = true;
      for (let index = 0; index < 100 && alive; index++) {
        try {
          process.kill(pid, 0);
          await Bun.sleep(20);
        } catch {
          alive = false;
        }
      }
      expect(alive).toBe(false);
    }
  },
);

test.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "managed native consoles have no login timeout and settle only on explicit close",
  async () => {
    const root = scratch.make("native-managed-terminal-"),
      record = join(root, "managed.json");
    const child = launchWindowsConsole({
      command: [
        process.execPath,
        join(import.meta.dir, "fixtures/console-cli.ts"),
        "hang-tree",
      ],
      cwd: root,
      env: {
        SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows",
        CONSOLE_FIXTURE_RECORD: record,
      },
      lifetime: { kind: "managed" },
      visible: false,
    });
    try {
      let settled = false;
      void child.done.then(() => (settled = true), () => (settled = true));
      await Bun.sleep(250);
      expect(settled).toBe(false);
      const result = await child.stop();
      expect(result).toEqual({ exitCode: expect.any(Number), stopped: true, timedOut: false });
      expect(settled).toBe(true);
    } finally {
      await child.stop();
    }
  },
);

test.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "abrupt loss of the native console owner ends the CLI and its descendants without cleanup code",
  async () => {
    const root = scratch.make("native-login-owner-death-"),
      record = join(root, "tree.json");
    const holder = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "fixtures/console-holder.ts"),
        root,
        record,
      ],
      {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    let childPid: number | undefined;
    try {
      for (let index = 0; index < 150 && !existsSync(record); index++)
        await Bun.sleep(20);
      expect(existsSync(record)).toBe(true);
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(record, "utf8"));
      } catch {
        throw Error("Missing synthetic tree record");
      }
      if (
        !raw ||
        typeof raw !== "object" ||
        !("childPid" in raw) ||
        typeof raw.childPid !== "number"
      )
        throw Error("Invalid synthetic child PID");
      childPid = raw.childPid;
      holder.kill("SIGKILL");
      await holder.exited;
      let alive = true;
      for (let index = 0; index < 150 && alive; index++) {
        try {
          process.kill(childPid, 0);
          await Bun.sleep(20);
        } catch {
          alive = false;
        }
      }
      expect(alive).toBe(false);
    } finally {
      if (holder.exitCode === null) holder.kill("SIGKILL");
      await holder.exited;
      if (childPid !== undefined) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          /* already ended */
        }
      }
    }
  },
);

test.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "explicit terminal cancellation is distinct from timeout and settles the owned tree",
  async () => {
    const root = scratch.make("native-login-stop-");
    const record = join(root, "record.json");
    const child = launchWindowsConsole({
      command: [
        process.execPath,
        join(import.meta.dir, "fixtures/console-cli.ts"),
        "hang-tree",
      ],
      cwd: root,
      env: {
        SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows",
        CONSOLE_FIXTURE_RECORD: record,
      },
      timeoutMs: 5000,
      visible: false,
    });
    try {
      for (let index = 0; index < 150 && !existsSync(record); index++)
        await Bun.sleep(20);
      expect(existsSync(record)).toBe(true);
      const result = await child.stop();
      expect(result.stopped).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(await child.stop()).toEqual(result);
    } finally {
      await child.stop();
    }
  },
);
