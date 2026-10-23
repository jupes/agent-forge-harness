import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { scratchDirs } from "../test-scratch";
import { syncCodexSkills } from "./codex-sync";
import { buildChildEnv } from "./env";
import { liveChildCount } from "./supervisor";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());
const recorded = z.object({
  pid: z.number(),
  cwd: z.string(),
  childPid: z.number().nullable(),
});
function readRecord(log: string) {
  try {
    return recorded.parse(JSON.parse(readFileSync(log, "utf8")));
  } catch {
    throw new Error("Missing bounded sync fixture record");
  }
}
function running(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Sync fixture did not settle");
    await Bun.sleep(10);
  }
}
function canonical(path: string) {
  const real = realpathSync.native(path);
  return process.platform === "win32" ? real.toLowerCase() : real;
}

function fixture(mode = "ok") {
  const root = scratch.make("codex-sync-process-");
  mkdirSync(join(root, ".git"));
  const log = join(root, "sync.json");
  const script = join(root, "sync.ts");
  writeFileSync(
    script,
    `
import { writeFileSync } from "node:fs";
const mode = process.argv[2];
const record = { pid: process.pid, cwd: process.cwd(), childPid: null };
if (mode === "hang") {
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    stdin: "ignore", stdout: "ignore", stderr: "ignore",
    ...(process.platform === "win32" ? { detached: true } : {}),
  });
  record.childPid = child.pid;
}
writeFileSync(${JSON.stringify(log)}, JSON.stringify(record));
if (mode === "failure") { console.error("private diagnostic"); process.exit(2); }
if (mode === "flood") console.log(("🌱".repeat(8000) + "\\n").repeat(6));
if (mode === "long-line") console.log("a".repeat(70_000));
if (mode === "hang") setInterval(() => {}, 1000);
`,
  );
  const options = {
    workspace: root,
    worktree: root,
    command: [process.execPath, script, mode],
    env: buildChildEnv(process.env, []),
    timeoutMs: 3000,
  };
  return { root, log, options };
}

test("supervised sync uses only its canonical harness checkout and skips foreign repositories", async () => {
  const f = fixture();
  await syncCodexSkills(f.options);
  expect(canonical(readRecord(f.log).cwd)).toBe(canonical(f.root));
  const foreign = fixture();
  await syncCodexSkills({ ...foreign.options, workspace: f.root });
  expect(existsSync(foreign.log)).toBe(false);
  expect(liveChildCount()).toBe(0);
});

test("failed or unbounded sync output is refused without returning private diagnostics", async () => {
  for (const mode of ["failure", "flood", "long-line"]) {
    const f = fixture(mode);
    await expect(syncCodexSkills(f.options)).rejects.toThrow(
      /^Codex skill sync did not complete successfully\.$/,
    );
    expect(running(readRecord(f.log).pid)).toBe(false);
    expect(liveChildCount()).toBe(0);
  }
});

test("Stop and timeout settle only after the actual sync process and its descendant exit", async () => {
  for (const action of ["stop", "timeout"]) {
    const f = fixture("hang");
    const controller = new AbortController();
    const job = syncCodexSkills({
      ...f.options,
      signal: controller.signal,
      timeoutMs: action === "timeout" ? 1000 : 5000,
    });
    const settled = expect(job).rejects.toThrow("Codex skill sync");
    try {
      await until(() => existsSync(f.log));
      if (action === "stop") controller.abort();
      await settled;
      const record = readRecord(f.log);
      if (record.childPid === null) throw new Error("Missing descendant");
      await until(() => !running(record.pid) && !running(record.childPid ?? 0));
      expect(running(record.pid)).toBe(false);
      expect(running(record.childPid)).toBe(false);
      expect(liveChildCount()).toBe(0);
    } finally {
      controller.abort();
      await settled;
    }
  }
}, 15000);

test("a stopped or invalid sync cannot spawn and a caller cannot mutate the trusted prefix after admission", async () => {
  const f = fixture();
  const stopped = new AbortController();
  stopped.abort();
  for (const options of [
    { ...f.options, signal: stopped.signal },
    { ...f.options, timeoutMs: 0 },
    { ...f.options, command: [""] },
    { ...f.options, command: [process.execPath, "bad\0argument"] },
  ]) {
    await expect(syncCodexSkills(options)).rejects.toThrow("Codex skill sync");
    expect(existsSync(f.log)).toBe(false);
  }
  const job = syncCodexSkills(f.options);
  f.options.command.splice(0, f.options.command.length, "changed-after-start");
  await job;
  expect(existsSync(f.log)).toBe(true);
});
