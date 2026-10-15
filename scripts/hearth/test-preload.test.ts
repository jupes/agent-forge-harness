import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loopbackProxyVariable } from "./loopback";
import { deadProxyEnvironment } from "./testing";

const REPO = join(import.meta.dir, "..", "..");
const PROXY = "http://127.0.0.1:9";

describe("loopbackProxyVariable", () => {
  test("under Bun: HTTP_PROXY or http_proxy, unless a NO_PROXY or no_proxy entry is 127.0.0.1 or *", () => {
    const cases: Array<[Record<string, string>, string | null]> = [
      [{}, null],
      [{ HTTP_PROXY: "" }, null],
      [{ HTTPS_PROXY: PROXY, ALL_PROXY: PROXY }, null],
      [{ HTTP_PROXY: PROXY }, "HTTP_PROXY"],
      [{ http_proxy: PROXY }, "http_proxy"],
      [{ HTTP_PROXY: PROXY, NO_PROXY: "127.0.0.1" }, null],
      [{ HTTP_PROXY: PROXY, no_proxy: "127.0.0.1" }, null],
      [{ HTTP_PROXY: PROXY, NO_PROXY: "localhost, 127.0.0.1" }, null],
      [{ HTTP_PROXY: PROXY, NO_PROXY: "*" }, null],
      [{ HTTP_PROXY: PROXY, NO_PROXY: "" }, "HTTP_PROXY"],
      [{ HTTP_PROXY: PROXY, NO_PROXY: "localhost" }, "HTTP_PROXY"],
      [{ HTTP_PROXY: PROXY, NO_PROXY: "127.0.0.0/8" }, "HTTP_PROXY"],
      // Two spellings that disagree: the one that does not exempt it counts.
      [
        { HTTP_PROXY: PROXY, NO_PROXY: "127.0.0.1", no_proxy: "localhost" },
        "HTTP_PROXY",
      ],
    ];
    expect(
      cases.map(([env]) => [env, loopbackProxyVariable(env, "bun")]),
    ).toEqual(cases);
  });

  test("under Node: only when NODE_USE_ENV_PROXY is set to something other than 0, and then as under Bun", () => {
    const cases: Array<[Record<string, string>, string | null]> = [
      [{ HTTP_PROXY: PROXY }, null],
      [{ HTTP_PROXY: PROXY, NODE_USE_ENV_PROXY: "" }, null],
      [{ HTTP_PROXY: PROXY, NODE_USE_ENV_PROXY: "0" }, null],
      [{ HTTP_PROXY: PROXY, NODE_USE_ENV_PROXY: "1" }, "HTTP_PROXY"],
      [{ http_proxy: PROXY, NODE_USE_ENV_PROXY: "1" }, "http_proxy"],
      [
        { HTTP_PROXY: PROXY, NODE_USE_ENV_PROXY: "1", NO_PROXY: "127.0.0.1" },
        null,
      ],
      [
        { HTTP_PROXY: PROXY, NODE_USE_ENV_PROXY: "1", NO_PROXY: "localhost" },
        "HTTP_PROXY",
      ],
    ];
    expect(
      cases.map(([env]) => [env, loopbackProxyVariable(env, "node")]),
    ).toEqual(cases);
  });
});

/** `bun test` on one small test file of this suite, in `env`. */
async function bunTest(
  env: Record<string, string>,
): Promise<{ exitCode: number; stderr: string }> {
  const child = Bun.spawn(
    [process.execPath, "test", join("scripts", "hearth", "token.test.ts")],
    { cwd: REPO, env, stdout: "pipe", stderr: "pipe" },
  );
  const [stderr] = await Promise.all([
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { exitCode: await child.exited, stderr };
}

describe("bun test in an environment whose proxy would carry loopback requests", () => {
  test("with HTTP_PROXY set and no NO_PROXY, refuses to start, naming the variable and what to set; with NO_PROXY=127.0.0.1 added, runs", async () => {
    const proxied = await deadProxyEnvironment();
    const refused = await bunTest(proxied);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("HTTP_PROXY");
    expect(refused.stderr).toContain("NO_PROXY=127.0.0.1");
    // The proxy's address is not repeated: such a value can carry a password.
    expect(refused.stderr).not.toContain(proxied["HTTP_PROXY"] ?? "");

    const exempted = await bunTest({ ...proxied, NO_PROXY: "127.0.0.1" });
    expect(exempted).toEqual({ exitCode: 0, stderr: expect.any(String) });
  }, 60_000);
});
