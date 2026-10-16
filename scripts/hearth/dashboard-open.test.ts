import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { main } from "./dashboard-open";
import { dashboardRecordPath, tokenPath } from "./home";
import type { DashboardRecord } from "./launch";
import { exchangeLaunch, startTestHearth, type TestHearth } from "./testing";
import { writeOwnerOnly } from "./token";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function hearth(): Promise<TestHearth> {
  const h = await startTestHearth();
  cleanup.push(() => h.close());
  return h;
}

/** No process has an id this large on the platforms the harness runs on. */
const ENDED_PID = 2_000_000_000;

function record(
  h: { home: string; root: string },
  fields: Partial<DashboardRecord> = {},
): void {
  const written: DashboardRecord = {
    pid: process.pid,
    root: resolve(h.root),
    url: "http://localhost:4321/",
    ...fields,
  };
  writeOwnerOnly(
    dashboardRecordPath(h.home, h.root),
    `${JSON.stringify(written)}\n`,
  );
}

/** `main` with `argv` against `home`: its exit code and what it wrote to each stream. */
async function run(
  argv: string[],
  home: string,
): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await main(argv, {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    env: { AGENT_FORGE_HOME: home },
  });
  return { code, out, err };
}

const LINK = /^http:\/\/localhost:4321\/#launch=([0-9a-f]{64})\n$/;

describe("bun run dashboard:open", () => {
  test("prints a fresh launch link on the address the running dashboard recorded, and nothing else; its secret is exchanged once, and each run mints another", async () => {
    const h = await hearth();
    record(h);
    const first = await run(["--root", h.root], h.home);
    expect({ code: first.code, err: first.err }).toEqual({ code: 0, err: "" });
    const secret = LINK.exec(first.out)?.[1] ?? "";
    expect(secret).not.toBe("");
    const second = await run(["--root", h.root], h.home);
    expect(second.out).toMatch(LINK);
    expect(second.out).not.toBe(first.out);
    expect((await exchangeLaunch(h.hearth.url, secret)).status).toBe(200);
    expect((await exchangeLaunch(h.hearth.url, secret)).status).toBe(403);
    expect(`${first.out}${second.out}`).not.toContain(h.hearth.token);
  });

  test("with no dashboard record, or one naming a process that has ended, it says no dashboard is running and exits 1, with nothing on stdout", async () => {
    const h = await hearth();
    const none = await run(["--root", h.root], h.home);
    record(h, { pid: ENDED_PID });
    const ended = await run(["--root", h.root], h.home);
    for (const answer of [none, ended]) {
      expect({ code: answer.code, out: answer.out }).toEqual({
        code: 1,
        out: "",
      });
      expect(answer.err).toContain("No dashboard is running for");
      expect(answer.err).toContain("bun run dashboard");
    }
  });

  test("--url names the base on this machine; an address off this machine, or not http, is refused", async () => {
    const h = await hearth();
    const named = await run(
      ["--root", h.root, "--url", "http://127.0.0.1:9999/somewhere"],
      h.home,
    );
    expect(named.code).toBe(0);
    expect(named.out).toMatch(
      /^http:\/\/127\.0\.0\.1:9999\/#launch=[0-9a-f]{64}\n$/,
    );
    for (const url of [
      "http://evil.example:4321/",
      "https://localhost:4321/",
      "localhost:4321",
    ]) {
      const refused = await run(["--root", h.root, "--url", url], h.home);
      expect({ url, code: refused.code, out: refused.out }).toEqual({
        url,
        code: 1,
        out: "",
      });
    }
  });

  test("with no control plane answering for the root it says so and exits 1", async () => {
    const home = mkdtempSync(join(tmpdir(), "af-open-home-"));
    const root = mkdtempSync(join(tmpdir(), "af-open-root-"));
    cleanup.push(() => {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    });
    record({ home, root });
    const answer = await run(["--root", root], home);
    expect({ code: answer.code, out: answer.out }).toEqual({
      code: 1,
      out: "",
    });
    expect(answer.err).toContain("No control plane answers for");
  });

  test("when the hearth refuses to mint, it exits 1 with the hearth's reason and never the token it sent", async () => {
    const h = await hearth();
    record(h);
    const wrong = "e".repeat(64);
    writeFileSync(tokenPath(h.home, h.root), `${wrong}\n`);
    const answer = await run(["--root", h.root], h.home);
    expect({ code: answer.code, out: answer.out }).toEqual({
      code: 1,
      out: "",
    });
    expect(answer.err).toContain("did not mint a launch link (HTTP 403");
    expect(answer.err).not.toContain(wrong);
  });

  test("run as a command, it prints the link and exits 0", async () => {
    const h = await hearth();
    record(h);
    const child = spawn(
      process.execPath,
      [join(import.meta.dir, "dashboard-open.ts"), "--root", h.root],
      {
        env: { ...process.env, AGENT_FORGE_HOME: h.home },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      err += String(chunk);
    });
    const code = await new Promise<number | null>((done) =>
      child.once("close", done),
    );
    expect({ code, err }).toEqual({ code: 0, err: "" });
    expect(out).toMatch(LINK);
  }, 30_000);
});
