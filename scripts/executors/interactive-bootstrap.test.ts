import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { verifyKeeperReader } from "../keeper/verify-reader";
import { scratchDirs } from "../test-scratch";
import { buildChildEnv } from "./env";
import { INTERACTIVE_BOOTSTRAP_FLAG } from "./interactive-bootstrap";
import { killTree, supervise } from "./supervisor";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());
const fake = join(import.meta.dir, "fixtures/interactive-cli.ts");
const root = resolve(import.meta.dir, "../..");
function env(home: string) {
  return {
    ...buildChildEnv(process.env, []),
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home,
  };
}
function compile(source: string, folder: string, name: string) {
  const executable = join(
    folder,
    `${name}${process.platform === "win32" ? ".exe" : ""}`,
  );
  const result = Bun.spawnSync(
    [process.execPath, "build", "--compile", source, "--outfile", executable],
    {
      cwd: root,
      env: env(folder),
      windowsHide: true,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    },
  );
  if (result.exitCode !== 0)
    throw new Error(
      `Inert native fixture compilation failed: ${result.stderr.toString().slice(-2000)}`,
    );
  return executable;
}
async function until<T>(read: () => T | null): Promise<T> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await Bun.sleep(10);
  }
  throw new Error("Owned process fixture did not reach its bounded state.");
}
function alive(pid: number) {
  try {
    if (
      process.platform === "linux" &&
      /\) Z(?: |$)/.test(readFileSync(`/proc/${pid}/stat`, "utf8"))
    )
      return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function firstLine(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader(),
    decoder = new TextDecoder();
  let text = "";
  const timer = setTimeout(() => {
    void reader.cancel();
  }, 3000);
  try {
    while (!text.includes("\n")) {
      const next = await reader.read();
      if (next.done) throw new Error("Missing owned fixture announcement.");
      text += decoder.decode(next.value, { stream: true });
      if (text.length > 4096)
        throw new Error("Oversized fixture announcement.");
    }
    return text.split("\n")[0] ?? "";
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}
function pids(line: string): {
  ownerPid: number;
  wrapperPid: number;
  providerPid: number | null;
} {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("Malformed owned fixture announcement.");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("ownerPid" in value) ||
    typeof value.ownerPid !== "number" ||
    !("wrapperPid" in value) ||
    typeof value.wrapperPid !== "number" ||
    !("providerPid" in value) ||
    (value.providerPid !== null && typeof value.providerPid !== "number")
  )
    throw new Error("Invalid owned fixture announcement.");
  return {
    ownerPid: value.ownerPid,
    wrapperPid: value.wrapperPid,
    providerPid: value.providerPid,
  };
}

test("the private bootstrap forwards only a literal true window option", async () => {
  const home = scratch.make("interactive-window-option-"),
    command = [process.execPath],
    observer = join(import.meta.dir, "fixtures/interactive-spawn-options.ts"),
    observe = async (grant: Record<string, unknown>) => {
      const lines: string[] = [];
      const result = await supervise({
        command: [process.execPath, observer],
        cwd: home,
        env: env(home),
        stdin: `${JSON.stringify(grant)}\n`,
        timeoutMs: 3000,
        // Keep the observer root hidden without asserting a public option.
        spawn(rootCommand, rootOptions) {
          return Bun.spawn(rootCommand, {
            ...rootOptions,
            windowsHide: true,
          });
        },
        onLine: (line) => lines.push(line),
      }).done;
      return { lines, result };
    },
    base = {
      version: 1,
      command,
      cwd: home,
      env: {},
      timeoutMs: 3000,
    };

  const forwarded = await observe({ ...base, windowsHide: true });
  expect(forwarded.lines).toEqual([JSON.stringify({ hasOwn: true, value: true })]);
  expect(forwarded.result.exitCode).toBe(1);

  const omitted = await observe(base);
  expect(omitted.lines).toEqual([JSON.stringify({ hasOwn: false, value: null })]);
  expect(omitted.result.exitCode).toBe(1);

  for (const windowsHide of [false, null, "true", 1]) {
    const rejected = await observe({ ...base, windowsHide });
    expect(rejected.lines).toEqual([]);
    expect(rejected.result.exitCode).toBe(1);
  }
});

test("source bootstrap excludes hostile config/preload before its private ownership grant", async () => {
  const home = scratch.make("interactive-config-"),
    marker = join(home, "preload-ran"),
    evil = join(home, "preload.ts"),
    innocent = join(home, "innocent.ts");
  writeFileSync(
    evil,
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');`,
  );
  writeFileSync(innocent, "process.exit(0);");
  writeFileSync(
    join(home, "bunfig.toml"),
    `preload = [${JSON.stringify(evil)}]\n`,
  );
  writeFileSync(
    join(home, ".bunfig.toml"),
    `preload = [${JSON.stringify(evil)}]\n`,
  );
  const quotedPreload = JSON.stringify(evil.replaceAll("\\", "/"));
  const hostile = {
    ...env(home),
    BUN_OPTIONS: `--preload=${quotedPreload}`,
    NODE_OPTIONS: `--require=${quotedPreload}`,
  };
  const oracle = supervise({
    command: [process.execPath, "--no-env-file", innocent],
    cwd: home,
    env: env(home),
    windowsHide: true,
    timeoutMs: 2000,
    onLine: () => undefined,
  });
  const unsafeExit = await oracle.done;
  expect(unsafeExit.stderr).toBe("");
  expect(unsafeExit.exitCode).toBe(0);
  expect(existsSync(marker)).toBe(true);
  unlinkSync(marker);
  let entered = false;
  const handle = supervise({
    command: [process.execPath, fake],
    cwd: home,
    env: hostile,
    windowsHide: true,
    stdinMode: "interactive",
    timeoutMs: 3000,
    beforeStart: () => {
      entered = true;
      return new Promise(() => {});
    },
    onLine: () => {
      throw new Error("No provider may run before ownership grant.");
    },
  });
  try {
    await until(() => (entered ? true : null));
    await Bun.sleep(100);
    expect(alive(handle.pid)).toBe(true);
    expect(existsSync(marker)).toBe(false);
    await handle.stop("before grant");
    await expect(handle.providerPid).rejects.toThrow("closed");
    expect(existsSync(marker)).toBe(false);
  } finally {
    await handle.stop("fixture cleanup");
  }
});

test("abrupt owner death before grant launches no provider; after grant kills immediate native helpers", async () => {
  const home = scratch.make("interactive-owner-"),
    executable = compile(fake, home, "early-helper");
  for (const mode of ["before", "after"]) {
    const log = join(home, `${mode}.jsonl`);
    const owner = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--no-install",
        `--config=${join(import.meta.dir, "interactive-bootstrap.bunfig.toml")}`,
        join(import.meta.dir, "fixtures/interactive-owner.ts"),
        mode,
        log,
        executable,
      ],
      {
        cwd: home,
        env: env(home),
        windowsHide: true,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    let current: ReturnType<typeof pids> | null = null,
      helper: number | null = null;
    try {
      current = pids(await firstLine(owner.stdout));
      expect(current.ownerPid).toBe(owner.pid);
      if (mode === "after") {
        helper = await until(() => {
          try {
            const value: unknown = JSON.parse(readFileSync(log, "utf8"));
            return typeof value === "object" &&
              value !== null &&
              "childPid" in value &&
              typeof value.childPid === "number"
              ? value.childPid
              : null;
          } catch {
            return null;
          }
        });
        expect(current.providerPid).not.toBe(current.wrapperPid);
        expect(current.providerPid).not.toBeNull();
      } else {
        expect(current.providerPid).toBeNull();
        expect(existsSync(log)).toBe(false);
      }
      owner.kill("SIGKILL");
      await owner.exited;
      const known = [current.wrapperPid, current.providerPid, helper].filter(
        (value): value is number => value !== null,
      );
      expect(
        await until(() => (known.every((pid) => !alive(pid)) ? true : null)),
      ).toBe(true);
      if (mode === "before") expect(existsSync(log)).toBe(false);
    } finally {
      owner.kill("SIGKILL");
      await owner.exited;
      for (const pid of [current?.wrapperPid, current?.providerPid, helper])
        if (pid && alive(pid)) killTree(pid);
    }
  }
});

test("actual compiled hearth entry provides private bootstrap and preserves the sealed Keeper reader", async () => {
  const home = scratch.make("interactive-compiled-"),
    hearth = compile("scripts/hearth/compiled-entry.ts", home, "hearth");
  const lines: string[] = [];
  const handle = supervise({
    command: [process.execPath, fake],
    cwd: home,
    env: env(home),
    windowsHide: true,
    bootstrapCommand: [hearth, INTERACTIVE_BOOTSTRAP_FLAG],
    stdinMode: "interactive",
    timeoutMs: 5000,
    onLine: (line) => lines.push(line),
  });
  try {
    const actual = await handle.providerPid;
    expect(actual).not.toBe(handle.pid);
    await handle.write("private packaged frame\n");
    await handle.end();
    expect((await handle.done).exitCode).toBe(0);
    expect(lines).toEqual([
      '{"received":"private packaged frame"}',
      '{"ended":true}',
    ]);
  } finally {
    await handle.stop("fixture cleanup");
  }
  await verifyKeeperReader([hearth, "--keeper-reader"]);
});

test("normal native exit closes inherited helper pipes without losing buffered final frames", async () => {
  const home = scratch.make("interactive-inherited-pipe-"),
    executable = compile(fake, home, "inherited-pipe"),
    log = join(home, "tree.jsonl");
  const lines: string[] = [];
  const handle = supervise({
    command: [executable, "exit-inherited-tree"],
    cwd: home,
    env: { ...env(home), INTERACTIVE_TREE_LOG: log },
    windowsHide: true,
    stdinMode: "interactive",
    timeoutMs: 2000,
    onLine: (line) => lines.push(line),
  });
  let childPid: number | null = null;
  try {
    const result = await handle.done;
    let tree: unknown;
    try {
      tree = JSON.parse(readFileSync(log, "utf8"));
    } catch {
      throw new Error("Malformed inherited helper identity.");
    }
    if (
      typeof tree !== "object" ||
      tree === null ||
      !("childPid" in tree) ||
      typeof tree.childPid !== "number"
    )
      throw new Error("Missing inherited helper identity.");
    childPid = tree.childPid;
    expect(result).toEqual({
      exitCode: 0,
      timedOut: false,
      stopped: false,
      ownedTreeReleased: true,
      stderr: "buffered private diagnostic",
    });
    expect(lines).toEqual([
      JSON.stringify({ childPid }),
      '{"terminal":true}',
      '{"finalBuffered":true}',
    ]);
    expect(await until(() => (!alive(childPid ?? 0) ? true : null))).toBe(true);
  } finally {
    await handle.stop("fixture cleanup");
    if (childPid && alive(childPid)) killTree(childPid);
  }
});
