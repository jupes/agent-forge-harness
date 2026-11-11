import { expect, test } from "bun:test";
import { nativeStartupBackend } from "./app-startup-native";

test("native startup uses only the trusted executable and closed arguments, and the OS-provided profile independent of Forge home", async () => {
  const argv: string[][] = [];
  const exe = "C:\\Program Files\\Agent Forge.exe",
    expectedCommand = `"${exe}" --from-login`;
  const backend = nativeStartupBackend(exe, "C:\\checkout", {
    platform: "win32",
    run: async (command, cwd, signal) => {
      expect(cwd).toBe("C:\\checkout");
      expect(signal.aborted).toBe(false);
      argv.push([...command]);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          error: null,
          data: {
            version: 1,
            expectedCommand,
            coordinationParent: "C:\\Users\\fixture\\AppData\\Local",
            outcome: command[2] === "read" ? "read" : "completed",
            registration: command[3] === "enabled" ? "enabled" : "disabled",
          },
        }),
      };
    },
  });
  if (!backend) throw Error("Expected fake native backend");
  const signal = new AbortController().signal;
  const read = await backend.read(signal);
  expect(read.coordinationHome).toBe(
    "C:\\Users\\fixture\\AppData\\Local\\.agent-forge-startup-v1",
  );
  await backend.set(true, "disabled", signal);
  expect(argv).toEqual([
    [exe, "--startup-registration", "read"],
    [exe, "--startup-registration", "set", "enabled", "disabled"],
  ]);
  expect(
    nativeStartupBackend(exe, "cwd", { platform: "linux" }),
  ).toBeUndefined();
  expect(
    nativeStartupBackend("relative.exe", "cwd", { platform: "win32" }),
  ).toBeUndefined();
});
test("malformed or foreign-target native replies cannot confirm a write", async () => {
  const exe = "C:\\Agent Forge.exe";
  for (const stdout of [
    "{broken",
    JSON.stringify({
      ok: true,
      error: null,
      data: {
        version: 1,
        expectedCommand: '"C:\\other.exe" --from-login',
        coordinationParent: "C:\\profile",
        outcome: "completed",
        registration: "enabled",
      },
    }),
  ]) {
    const backend = nativeStartupBackend(exe, "cwd", {
      platform: "win32",
      run: async () => ({ exitCode: 0, stdout }),
    });
    await expect(
      backend!.set(true, "disabled", new AbortController().signal),
    ).rejects.toThrow();
  }
});
test("oversized valid JSON, unsettled exits and aborted helpers cannot confirm a write", async () => {
  const exe = "C:\\Agent Forge.exe";
  const good = JSON.stringify({
    ok: true,
    error: null,
    data: {
      version: 1,
      expectedCommand: `"${exe}" --from-login`,
      coordinationParent: "C:\\profile",
      outcome: "completed",
      registration: "enabled",
    },
  });
  for (const run of [
    async () => ({ exitCode: 0, stdout: " ".repeat(4097) + good }),
    async () => {
      throw Error("PRIVATE_UNSETTLED");
    },
    async () => ({ exitCode: 1, stdout: good }),
  ]) {
    const backend = nativeStartupBackend(exe, "cwd", {
      platform: "win32",
      run,
    });
    await expect(
      backend!.set(true, "disabled", new AbortController().signal),
    ).rejects.toThrow();
  }
  const abort = new AbortController();
  const backend = nativeStartupBackend(exe, "cwd", {
    platform: "win32",
    run: async () => {
      abort.abort();
      return { exitCode: 0, stdout: good };
    },
  });
  await expect(backend!.set(true, "disabled", abort.signal)).rejects.toThrow();
});
