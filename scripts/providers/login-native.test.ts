import { expect, test } from "bun:test";
import { createProviderInspector } from "./inspect";
import { createNativeLoginPreparation } from "./login-native";

test.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "native sign-in preparation fixes vendor argv and excludes credentials, configured pass-through and operator token values",
  async () => {
    const inspector = createProviderInspector({
      root: "C:\\fixture",
      home: "C:\\private-fixture",
      which: () => "C:\\fixture\\claude.exe",
      environment: {},
      run: async (command) =>
        command.includes("--version")
          ? { exitCode: 0, valid: true, stdout: "2.1.293" }
          : {
              exitCode: 1,
              valid: true,
              stdout: '{"loggedIn":false,"authMethod":"none"}',
            },
    });
    const prepare = createNativeLoginPreparation({
      root: "C:\\fixture",
      inspector,
      environment: {
        PATH: "synthetic-operator-value",
        SystemRoot: "C:\\Windows",
        ANTHROPIC_API_KEY: "never-forward",
        OPENAI_API_KEY: "never-forward",
        AGENT_FORGE_HOME: "private-home",
        UNRELATED: "never-forward",
      },
      operatorToken: () => "synthetic-operator",
    });
    const spec = await prepare("claude");
    expect(spec.command).toEqual(["C:\\fixture\\claude.exe", "auth", "login"]);
    expect(spec.cwd).toBe("C:\\fixture");
    expect(spec.timeoutMs).toBe(900000);
    expect(spec.env).toEqual({
      SystemRoot: "C:\\Windows",
      AGENT_FORGE_ADAPTER: "1",
    });
  },
);

test("a script shim or unsupported provider cannot become an arbitrary native sign-in command", async () => {
  const inspector = createProviderInspector({
    root: "/fixture",
    home: "/private-fixture",
    environment: {},
    which: () => "C:\\fixture\\vendor.cmd",
    run: async () => ({ exitCode: 0, valid: true, stdout: "2.1.293" }),
  });
  const prepare = createNativeLoginPreparation({
    root: "/fixture",
    inspector,
    environment: {},
  });
  await expect(prepare("claude")).rejects.toThrow("native vendor executable");
  await expect(prepare("codex")).rejects.toThrow("native vendor executable");
});
