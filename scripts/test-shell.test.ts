import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { findUsableShell } from "./test-shell";

describe("usable shell discovery", () => {
  const gitBash = join("installed", "Git", "bin", "bash.exe");
  const options = {
    platform: "win32" as const,
    env: { ProgramFiles: "installed" },
    which: () => "WSL-launcher",
  };

  test("rejects the unusable PATH launcher and executes the installed Git Bash probe", () => {
    const tried: string[] = [];
    expect(
      findUsableShell("bash", {
        ...options,
        probe: (shell, input) => {
          tried.push(shell);
          expect(input).toBe("printf '%s' 'forge-shell-probe-ok'\n");
          return shell === gitBash
            ? { exitCode: 0, stdout: "forge-shell-probe-ok" }
            : { exitCode: 1, stdout: "" };
        },
      }),
    ).toBe(gitBash);
    expect(tried).toEqual(["WSL-launcher", gitBash]);
  });

  for (const failure of [
    "empty success",
    "wrong output",
    "nonzero",
    "timeout",
  ]) {
    test(`does not accept ${failure} as a working shell`, () => {
      expect(
        findUsableShell("bash", {
          ...options,
          probe: (shell) => {
            if (shell === gitBash)
              return { exitCode: 0, stdout: "forge-shell-probe-ok" };
            if (failure === "timeout") throw new Error("timed out");
            return {
              exitCode: failure === "nonzero" ? 1 : 0,
              stdout:
                failure === "empty success"
                  ? ""
                  : failure === "wrong output"
                    ? "forge-shell-probe-ok\nnoise"
                    : "forge-shell-probe-ok",
            };
          },
        }),
      ).toBe(gitBash);
    });
  }

  test("reports unavailable when no candidate executes the probe", () => {
    expect(
      findUsableShell("sh", {
        platform: "linux",
        env: {},
        which: () => null,
        probe: () => {
          throw new Error("must not run without a candidate");
        },
      }),
    ).toBeNull();
  });
});
