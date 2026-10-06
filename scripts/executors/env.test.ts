import { describe, expect, test } from "bun:test";
import { buildChildEnv } from "./env";

describe("buildChildEnv", () => {
  test("passes the base set and configured names, drops everything else", () => {
    const child = buildChildEnv(
      {
        PATH: "/bin",
        SystemRoot: "C:\\Windows",
        ANTHROPIC_API_KEY: "k",
        DATABASE_URL: "postgres://x",
        AWS_SECRET_ACCESS_KEY: "s",
      },
      ["ANTHROPIC_API_KEY"],
    );
    expect(Object.keys(child).sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "PATH",
      "SystemRoot",
    ]);
  });

  test("matches names case-insensitively and keeps the parent's casing", () => {
    const child = buildChildEnv({ Path: "C:\\bin", Anthropic_Api_Key: "k" }, [
      "ANTHROPIC_API_KEY",
    ]);
    expect(child).toEqual({ Path: "C:\\bin", Anthropic_Api_Key: "k" });
  });

  test("skips undefined values", () => {
    expect(buildChildEnv({ PATH: undefined, HOME: "h" }, [])).toEqual({
      HOME: "h",
    });
  });
});
