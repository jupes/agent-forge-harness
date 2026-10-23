import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { SHIFT_LIMITS } from "../config/defaults";
import { buildChildEnv } from "../executors/env";
import {
  interactiveLifetimeMs,
  SHIFT_ENGINE_GRACE_MS,
} from "../executors/interactive-lifetime";
import { killTree, liveChildCount } from "../executors/supervisor";
import { FIXTURE_PROJECT_ID } from "../projects/testing";
import { processAlive } from "../scheduler/shift-store";
import { scratchDirs } from "../test-scratch";
import { createOwnedProjectShiftLauncher } from "./owned-launcher";
import { createProjectShiftRegistry } from "./registry";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());
const treeSchema = z.object({ pid: z.number(), childPid: z.number() });
const holderSchema = z.object({
  holderPid: z.number(),
  wrapperPid: z.number(),
  enginePid: z.number(),
});
function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw Error("Invalid owned fixture announcement");
  }
}
async function until<T>(read: () => T | null) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await Bun.sleep(10);
  }
  throw Error("Owned shift fixture did not settle within its bound");
}
const alive = (pid: number) => {
  if (process.platform === "linux") {
    try {
      if (/\) Z(?: |$)/.test(readFileSync(`/proc/${pid}/stat`, "utf8")))
        return false;
    } catch {
      return false;
    }
  }
  return processAlive(pid);
};
async function fixture(mode = "startup-tree") {
  const root = realpathSync.native(scratch.make("owned shift launch ")),
    home = join(root, "home"),
    log = join(root, "tree.jsonl");
  mkdirSync(join(root, ".git"));
  const originals = createProjectShiftRegistry({ root, home });
  const saved = await originals.reserve(
    FIXTURE_PROJECT_ID,
    {
      requestId: "2230bb02-1119-4c69-adad-c44116b375c1",
      expectedCatalogRevision: 1,
      options: {
        for: "2h",
        concurrency: 1,
        maxBeads: 1,
        maxUsd: 5,
        repairs: 0,
        base: "main",
      },
    },
    async () => ({ shiftId: "shift-20261023-180000-1234" }),
  );
  const { intent } = await originals.markAttempted(
    FIXTURE_PROJECT_ID,
    saved.intent.request.requestId,
    saved.intent.requestHash,
  );
  const command = [
      process.execPath,
      join(import.meta.dir, "../executors/fixtures/interactive-cli.ts"),
      mode,
    ],
    spec = {
      argv: [...command, intent.projectId, intent.request.requestId],
      cwd: root,
      env: {
        ...buildChildEnv(process.env, []),
        AGENT_FORGE_HOME: home,
        INTERACTIVE_TREE_LOG: log,
      },
    };
  const tree = () =>
    existsSync(log)
      ? treeSchema.parse(parsed(readFileSync(log, "utf8").trim()))
      : null;
  return { root, home, log, intent, originals, command, spec, tree };
}

test("the mandatory project launch holds engine code before its grant and fences a late continuation after Stop", async () => {
  const f = await fixture();
  let release = () => {},
    entered = false;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const launch = createOwnedProjectShiftLauncher({
    ...f,
    ownership: {
      beforeStart: () => {
        entered = true;
        return held;
      },
    },
  });
  const child = launch(f.spec, f.intent);
  try {
    await until(() => (entered ? true : null));
    expect(existsSync(f.log)).toBe(false);
    await child.stop();
    release();
    await expect(child.enginePid).rejects.toThrow();
    await child.done;
    expect(existsSync(f.log)).toBe(false);
    expect(liveChildCount()).toBe(0);
  } finally {
    release();
    await child.stop();
  }
  const refused = createOwnedProjectShiftLauncher({
    ...f,
    ownership: { interactiveGuard: () => null },
  });
  expect(() => refused(f.spec, f.intent)).toThrow("ownership");
  expect(existsSync(f.log)).toBe(false);
});

test("an actual owned engine PID differs from its wrapper, EOF is delivered, and Stop/normal exit drain inherited descendants", async () => {
  const eof = await fixture("eof"),
    ended = createOwnedProjectShiftLauncher(eof)(eof.spec, eof.intent);
  expect((await ended.done).stdout).toContain('"ended":true');
  for (const mode of ["startup-tree", "exit-inherited-tree"]) {
    const f = await fixture(mode),
      child = createOwnedProjectShiftLauncher(f)(f.spec, f.intent);
    let tree: z.infer<typeof treeSchema> | null = null;
    try {
      const engine = await child.enginePid;
      expect(engine).not.toBe(child.pid);
      tree = await until(f.tree);
      expect(tree.pid).toBe(engine);
      if (mode === "startup-tree") await child.stop();
      const done = await child.done;
      if (mode === "exit-inherited-tree") {
        expect(done.exitCode).toBe(0);
        expect(done.stdout).toContain('"finalBuffered":true');
        expect(done.stderr).toContain("buffered private diagnostic");
      }
      await until(() =>
        !alive(tree?.childPid ?? 0) && !alive(tree?.pid ?? 0) ? true : null,
      );
      expect(liveChildCount()).toBe(0);
    } finally {
      await child.stop();
      if (tree && alive(tree.childPid)) killTree(tree.childPid);
    }
  }
});

test("the private original is checked again immediately before the grant, not trusted across an awaited host barrier", async () => {
  const f = await fixture();
  let release = () => {},
    entered = false;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const child = createOwnedProjectShiftLauncher({
    ...f,
    ownership: {
      beforeStart: () => {
        entered = true;
        return held;
      },
    },
  })(f.spec, f.intent);
  try {
    await until(() => (entered ? true : null));
    await f.originals.claimExecution(
      f.intent.projectId,
      f.intent.request.requestId,
      f.intent.requestHash,
    );
    release();
    await child.done;
    await expect(child.enginePid).rejects.toThrow();
    expect(existsSync(f.log)).toBe(false);
  } finally {
    release();
    await child.stop();
  }
});

test("abrupt outer owner death ends the engine and its independently guarded nested provider/helper", async () => {
  const f = await fixture(),
    holder = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "fixtures/owned-launch-holder.ts"),
        f.root,
        f.home,
        f.intent.projectId,
        f.intent.request.requestId,
        f.log,
      ],
      {
        env: buildChildEnv(process.env, []),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
  let tree: z.infer<typeof treeSchema> | null = null;
  let identity: z.infer<typeof holderSchema> | null = null;
  try {
    const reader = holder.stdout.getReader();
    const read = await Promise.race([
      reader.read(),
      Bun.sleep(5000).then(() => {
        throw Error("Missing holder identity");
      }),
    ]);
    if (read.done) throw Error("Missing holder identity");
    identity = holderSchema.parse(
      parsed(new TextDecoder().decode(read.value).trim()),
    );
    reader.releaseLock();
    tree = await until(f.tree);
    holder.kill("SIGKILL");
    await holder.exited;
    await until(() =>
      [
        identity?.wrapperPid,
        identity?.enginePid,
        tree?.pid,
        tree?.childPid,
      ].every((pid) => pid !== undefined && !alive(pid))
        ? true
        : null,
    );
  } finally {
    holder.kill("SIGKILL");
    await holder.exited;
    for (const pid of [
      identity?.wrapperPid,
      identity?.enginePid,
      tree?.pid,
      tree?.childPid,
    ])
      if (pid && alive(pid)) killTree(pid);
    await holder.stdout.cancel().catch(() => {});
    await new Response(holder.stderr).text();
  }
});

test("shift lifetime policy is explicit, exact and bounded by the canonical work limit plus engine cleanup grace", () => {
  expect(interactiveLifetimeMs(7_200_000, "shift-attempt")).toBe(7_200_000);
  expect(() => interactiveLifetimeMs(7_200_000)).toThrow("bounds");
  expect(() =>
    interactiveLifetimeMs(SHIFT_LIMITS.forMs[1] + 1, "shift-attempt"),
  ).toThrow("bounds");
  expect(
    interactiveLifetimeMs(
      SHIFT_LIMITS.forMs[1] + SHIFT_ENGINE_GRACE_MS,
      "shift-engine",
    ),
  ).toBe(SHIFT_LIMITS.forMs[1] + SHIFT_ENGINE_GRACE_MS);
});
