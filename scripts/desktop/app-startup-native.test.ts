import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { nativeStartupBackend } from "./app-startup-native";

const installedGeneration = "22222222-2222-4222-8222-222222222222";

test("startup generation binds Set to the exact installation reviewed before intent", async () => {
  const exe =
    "C:\\Users\\fixture\\AppData\\Local\\Agent Forge Harness\\agent-forge-desktop.exe";
  const generation = "11111111-1111-4111-8111-111111111111";
  const expectedCommand = `"${exe}" --from-login`;
  const key = createHash("sha256")
    .update(expectedCommand + "\0" + generation)
    .digest("hex");
  const argv: string[][] = [];
  const backend = nativeStartupBackend(exe, "C:\\checkout", {
    platform: "win32",
    run: async (command) => {
      argv.push([...command]);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          error: null,
          data: {
            version: 2,
            expectedCommand,
            coordinationParent: "C:\\Users\\fixture\\AppData\\Local",
            capability: "available",
            generation,
            outcome: command[2] === "read" ? "read" : "completed",
            registration: command[2] === "read" ? "disabled" : "enabled",
          },
        }),
      };
    },
  });
  const signal = new AbortController().signal;
  expect(await backend!.read(signal)).toMatchObject({
    installationKey: key,
    registration: "disabled",
  });
  await backend!.set(true, "disabled", signal, key);
  expect(argv[1]).toEqual([
    exe,
    "--startup-registration",
    "set",
    "enabled",
    "disabled",
    key,
  ]);
});

test("startup generation reports install-required without creating lifecycle state", async () => {
  const exe = "C:\\Portable\\agent-forge-desktop.exe";
  const argv: string[][] = [];
  const backend = nativeStartupBackend(exe, "C:\\checkout", {
    platform: "win32",
    run: async (command) => {
      argv.push([...command]);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          error: null,
          data: {
            version: 2,
            expectedCommand: `"${exe}" --from-login`,
            coordinationParent: "C:\\Users\\fixture\\AppData\\Local",
            capability: "install-required",
            generation: null,
            outcome: "read",
            registration: null,
          },
        }),
      };
    },
  });
  expect(await backend!.read(new AbortController().signal)).toEqual({
    capability: "unsupported",
    reason: "install-required",
  });
  expect(argv).toEqual([[exe, "--startup-registration", "read"]]);
});

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
            version: 2,
            capability: "available",
            generation: installedGeneration,
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
  if ("capability" in read)
    throw Error("Expected installed native observation");
  expect(read.coordinationHome).toBe(
    "C:\\Users\\fixture\\AppData\\Local\\.agent-forge-startup-v1",
  );
  await backend.set(true, "disabled", signal, read.installationKey);
  expect(argv).toEqual([
    [exe, "--startup-registration", "read"],
    [
      exe,
      "--startup-registration",
      "set",
      "enabled",
      "disabled",
      read.installationKey,
    ],
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
        version: 2,
        capability: "available",
        generation: installedGeneration,
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
      backend!.set(
        true,
        "disabled",
        new AbortController().signal,
        "a".repeat(64),
      ),
    ).rejects.toThrow();
  }
});
test("oversized valid JSON, unsettled exits and aborted helpers cannot confirm a write", async () => {
  const exe = "C:\\Agent Forge.exe";
  const good = JSON.stringify({
    ok: true,
    error: null,
    data: {
      version: 2,
      capability: "available",
      generation: installedGeneration,
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
      backend!.set(
        true,
        "disabled",
        new AbortController().signal,
        "a".repeat(64),
      ),
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
  await expect(
    backend!.set(true, "disabled", abort.signal, "a".repeat(64)),
  ).rejects.toThrow();
});
