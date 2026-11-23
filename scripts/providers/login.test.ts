import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { scratchDirs } from "../test-scratch";
import { createProviderLoginService, providerLoginFile } from "./login";
import type { NativeConsoleChild, NativeConsoleExit } from "./native-console";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());
const uuid = "9886feb7-0172-4a08-a306-d5b8b98cc36d";
function fixture() {
  const root = scratch.make("provider-login-"),
    home = join(root, "home");
  mkdirSync(join(root, ".git"));
  let launches = 0,
    prepares = 0;
  let finish: (result: NativeConsoleExit) => void = () => {};
  const done = new Promise<NativeConsoleExit>((resolve) => {
    finish = resolve;
  });
  const child: NativeConsoleChild = {
    pid: 123,
    done,
    stop: async () => {
      finish({ exitCode: 1, stopped: true, timedOut: false });
      return done;
    },
  };
  const options = {
    root,
    home,
    prepare: async () => {
      prepares++;
      return {
        command: ["C:\\fixture\\vendor.exe", "login"],
        cwd: root,
        env: {},
        timeoutMs: 5000,
      };
    },
    launch: () => {
      let original: unknown;
      try {
        original = JSON.parse(
          readFileSync(providerLoginFile(home, root), "utf8"),
        );
      } catch {
        throw Error("No durable original before launch");
      }
      if (
        !original ||
        typeof original !== "object" ||
        !("records" in original) ||
        !Array.isArray(original.records) ||
        !original.records.some(
          (row: unknown) =>
            row &&
            typeof row === "object" &&
            "phase" in row &&
            row.phase === "opening",
        )
      )
        throw Error("Native launch preceded durable attempt marker");
      launches++;
      return child;
    },
  };
  return {
    root,
    home,
    options,
    finish,
    counts: () => ({ launches, prepares }),
  };
}

test("durable login UUID is written before native launch; exact retries and service recreation never replay it", async () => {
  const f = fixture(),
    service = createProviderLoginService(f.options);
  try {
    const started = await service.start("claude", uuid);
    expect(started.phase).toBe("running");
    expect(service.read("claude", uuid)).toEqual(started);
    expect(await service.start("claude", uuid)).toEqual(started);
    const second = createProviderLoginService(f.options);
    expect(second.read("claude", uuid).phase).toBe("unknown");
    expect((await second.start("claude", uuid)).phase).toBe("unknown");
    await expect(
      second.start("claude", "90941d52-8e19-4d57-a9e8-94c4db70a093"),
    ).rejects.toThrow("already open");
    expect(f.counts()).toEqual({ launches: 1, prepares: 1 });
    const stored = readFileSync(providerLoginFile(f.home, f.root), "utf8");
    expect(stored).toContain(uuid);
    expect(stored).not.toContain("vendor.exe");
    await expect(service.start("codex", uuid)).rejects.toThrow(
      "different provider",
    );
  } finally {
    await service.close();
  }
});

test("terminal exit is a closed flow, never authentication proof; Stop and timeout remain distinct", async () => {
  const f = fixture(),
    service = createProviderLoginService(f.options);
  await service.start("claude", uuid);
  f.finish({ exitCode: 0, stopped: false, timedOut: false });
  await service.close();
  expect(service.read("claude", uuid)).toMatchObject({
    phase: "closed",
    exitCode: 0,
    stopped: false,
    timedOut: false,
  });
  expect(JSON.stringify(service.list())).not.toContain("authenticated");
  expect(
    await createProviderLoginService(f.options).start("claude", uuid),
  ).toMatchObject({ phase: "closed" });
  expect(f.counts().launches).toBe(1);
});

test("different workspace roots still share one provider sign-in owner in the same private home", async () => {
  const f = fixture(),
    first = createProviderLoginService(f.options),
    otherRoot = scratch.make("provider-login-other-root-"),
    second = createProviderLoginService({ ...f.options, root: otherRoot });
  try {
    await first.start("claude", uuid);
    await expect(
      second.start("claude", "90941d52-8e19-4d57-a9e8-94c4db70a093"),
    ).rejects.toThrow("already open");
    expect(f.counts()).toEqual({ prepares: 1, launches: 1 });
  } finally {
    await first.close();
    await second.close();
  }
});

test("corrupt private identity storage fails before another launch and preserves its bytes", async () => {
  const f = fixture(),
    service = createProviderLoginService(f.options);
  await service.start("claude", uuid);
  await service.stop("claude", uuid);
  const file = providerLoginFile(f.home, f.root);
  writeFileSync(file, '{"version":99,"records":[]}');
  await expect(
    service.start("codex", "90941d52-8e19-4d57-a9e8-94c4db70a093"),
  ).rejects.toThrow("kept");
  expect(readFileSync(file, "utf8")).toBe('{"version":99,"records":[]}');
  expect(f.counts().launches).toBe(1);
});

test("an intermediate linked sign-in folder is refused without changing its target", async () => {
  const f = fixture(),
    service = createProviderLoginService(f.options);
  await service.start("claude", uuid);
  await service.stop("claude", uuid);
  const parent = join(f.home, "provider-logins"),
    target = join(f.root, "relocated-logins"),
    file = providerLoginFile(f.home, f.root),
    tail = relative(parent, file),
    before = readFileSync(file, "utf8");
  renameSync(parent, target);
  symlinkSync(
    target,
    parent,
    process.platform === "win32" ? "junction" : "dir",
  );
  await expect(
    service.start("codex", "90941d52-8e19-4d57-a9e8-94c4db70a093"),
  ).rejects.toThrow("kept");
  expect(readFileSync(join(target, tail), "utf8")).toBe(before);
  expect(f.counts().launches).toBe(1);
});

test.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "an abruptly killed host releases its provider lease only with OS-owned native tree cleanup; original UUID never replays",
  async () => {
    const f = fixture(),
      record = join(f.root, "native-tree.json"),
      ready = join(f.root, "ready.json"),
      holder = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "fixtures/login-holder.ts"),
          f.root,
          f.home,
          record,
          ready,
          uuid,
        ],
        { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
      ),
      next = createProviderLoginService(f.options);
    try {
      for (
        let index = 0;
        index < 200 && (!existsSync(ready) || !existsSync(record));
        index++
      )
        await Bun.sleep(20);
      expect(existsSync(ready) && existsSync(record)).toBe(true);
      expect(next.read("claude", uuid).phase).toBe("unknown");
      holder.kill("SIGKILL");
      await holder.exited;
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(record, "utf8"));
      } catch {
        throw Error("Missing native fixture tree");
      }
      if (
        !raw ||
        typeof raw !== "object" ||
        !("pid" in raw) ||
        typeof raw.pid !== "number" ||
        !("childPid" in raw) ||
        typeof raw.childPid !== "number"
      )
        throw Error("Invalid native fixture tree");
      for (const pid of [raw.pid, raw.childPid]) {
        let alive = true;
        for (let index = 0; index < 150 && alive; index++) {
          try {
            process.kill(pid, 0);
            await Bun.sleep(20);
          } catch {
            alive = false;
          }
        }
        expect(alive).toBe(false);
      }
      expect(next.read("claude", uuid).phase).toBe("interrupted");
      expect((await next.start("claude", uuid)).phase).toBe("interrupted");
      expect(f.counts()).toEqual({ prepares: 0, launches: 0 });
      expect(
        (await next.start("claude", "90941d52-8e19-4d57-a9e8-94c4db70a093"))
          .phase,
      ).toBe("running");
      expect(f.counts().launches).toBe(1);
    } finally {
      if (holder.exitCode === null) holder.kill("SIGKILL");
      await holder.exited;
      await next.close();
    }
  },
);
