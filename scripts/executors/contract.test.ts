/**
 * One behavioural contract every adapter must satisfy, run against fake
 * provider binaries. This proves our plumbing (env, stdin, stream parsing,
 * lifecycle, cleanup) — not that a real provider CLI emits these shapes.
 */

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { LedgerEventInput } from "../../types/hearth";
import { BUILTIN_SMITHS } from "../config/defaults";
import { comparableCheckout } from "../forge/runs";
import { validateLedgerEventInput } from "../hearth/validate";
import { claudeAdapter } from "./claude";
import { createCodexAdapter } from "./codex";
import { buildChildEnv } from "./env";
import { liveChildCount } from "./supervisor";
import type { ExecutorAdapter, SpawnRequest } from "./types";

const FAKE = join(import.meta.dir, "fixtures", "fake-cli.ts");
const adapters: Array<{
  name: string;
  adapter: ExecutorAdapter;
  smith: string;
}> = [
  { name: "claude", adapter: claudeAdapter, smith: "claude-journeyman" },
  {
    name: "codex",
    adapter: createCodexAdapter({ prepare: () => undefined }),
    smith: "codex-journeyman",
  },
];

async function run(
  adapter: ExecutorAdapter,
  provider: string,
  smithName: string,
  mode: string,
  extra: Partial<SpawnRequest> = {},
) {
  // Each directory is its own checkout: a bare temp directory would resolve to
  // whatever checkout the temp directory happens to sit in.
  const root = realpathSync.native(
    mkdtempSync(join(tmpdir(), "exec contract ")),
  );
  mkdirSync(join(root, ".git"));
  const worktree = join(root, "work tree with spaces");
  mkdirSync(join(worktree, ".git"), { recursive: true });
  const dumpFile = join(root, "dump.json");
  const handle = await adapter.spawn({
    beadId: "bead-1",
    worktree,
    workspace: root,
    runId: "run-1",
    smith: BUILTIN_SMITHS[smithName] as SpawnRequest["smith"],
    prompt: "do the thing & echo %PATH%",
    env: buildChildEnv(
      { ...process.env, DATABASE_URL: "postgres://planted" },
      [],
    ),
    command: [
      process.execPath,
      FAKE,
      "--fake-provider",
      provider,
      "--fake-mode",
      mode,
      "--fake-dump",
      dumpFile,
    ],
    ...extra,
  });
  const events: LedgerEventInput[] = [];
  const collecting = (async () => {
    for await (const event of handle.events) events.push(event);
  })();
  const result = await handle.done;
  await collecting;
  const dump = existsSync(dumpFile)
    ? JSON.parse(readFileSync(dumpFile, "utf8"))
    : undefined;
  return { events, result, dump, worktree, root, handle };
}

for (const { name, adapter, smith } of adapters) {
  describe(`${name} adapter contract`, () => {
    test("streams session.started, tool.called per tool, session.ended — all valid", async () => {
      const { events, result } = await run(adapter, name, smith, "ok");
      expect(events.map((e) => e.kind)).toEqual([
        "session.started",
        "tool.called",
        "tool.called",
        "session.ended",
      ]);
      expect(result.exitCode).toBe(0);
      for (const event of events) {
        const checked = validateLedgerEventInput(event);
        expect(checked.ok).toBe(true);
        expect(event.workspace.length).toBeGreaterThan(0);
        expect(event.beadId).toBe("bead-1");
        expect(event.runId).toBe("run-1");
        expect(event.executor?.smith).toBe(smith);
      }
      const ended = events[3] as Extract<
        LedgerEventInput,
        { kind: "session.ended" }
      >;
      expect(ended.payload.reason).toBe("completed");
    });

    test("session.started says it is a headless session and names the checkout it runs in; events carry the harness checkout as workspace", async () => {
      const { events, root, worktree } = await run(adapter, name, smith, "ok");
      const started = events[0] as Extract<
        LedgerEventInput,
        { kind: "session.started" }
      >;
      expect(started.payload).toEqual({
        source: `headless:${name}`,
        kind: "headless",
        worktree: comparableCheckout(worktree),
      });
      for (const event of events)
        expect(event.workspace).toBe(comparableCheckout(root));
    });

    test("tool events carry a hash, never the tool input", async () => {
      const { events } = await run(adapter, name, smith, "ok");
      expect(JSON.stringify(events)).not.toContain("SECRET_BODY_MUST_NOT_LEAK");
      const tool = events[1] as Extract<
        LedgerEventInput,
        { kind: "tool.called" }
      >;
      expect(tool.payload.argsHash).toMatch(/^[0-9a-f]{16}$/);
    });

    test("the child runs in the worktree (path with spaces), gets the prompt on stdin, and never sees DATABASE_URL", async () => {
      const { dump, worktree } = await run(adapter, name, smith, "ok");
      expect(dump.cwd.toLowerCase()).toBe(worktree.toLowerCase());
      expect(dump.stdin).toBe("do the thing & echo %PATH%");
      expect(dump.argv.join(" ")).not.toContain("do the thing");
      expect(dump.env.DATABASE_URL).toBeUndefined();
      expect(
        Object.keys(dump.env).some((k) => k.toLowerCase() === "path"),
      ).toBe(true);
    });

    test("never asks for dangerously-skip-permissions", async () => {
      const { dump } = await run(adapter, name, smith, "ok");
      expect(dump.argv.join(" ")).not.toContain("dangerously");
    });

    test("ignores unparseable and unknown lines without throwing", async () => {
      const { events } = await run(adapter, name, smith, "garbage");
      expect(events.map((e) => e.kind)).toEqual([
        "session.started",
        "tool.called",
        "session.ended",
      ]);
    });

    test("a crashing child ends the session with a failure reason", async () => {
      const { events, result } = await run(adapter, name, smith, "crash");
      expect(result.exitCode).toBe(3);
      const ended = events[events.length - 1] as Extract<
        LedgerEventInput,
        { kind: "session.ended" }
      >;
      expect(ended.kind).toBe("session.ended");
      expect(ended.payload.reason).toBe("failed: exit 3");
    });

    test("a hung child is killed at the timeout and nothing is left running", async () => {
      const before = liveChildCount();
      const { events, result } = await run(adapter, name, smith, "hang", {
        timeoutMs: 400,
      });
      expect(result.timedOut).toBe(true);
      const ended = events[events.length - 1] as Extract<
        LedgerEventInput,
        { kind: "session.ended" }
      >;
      expect(ended.payload.reason).toBe("timeout");
      expect(liveChildCount()).toBe(before);
    });

    test("stop() kills the child and records why", async () => {
      const root = mkdtempSync(join(tmpdir(), "exec stop "));
      mkdirSync(join(root, ".git"));
      const handle = await adapter.spawn({
        beadId: "b",
        worktree: root,
        workspace: root,
        smith: BUILTIN_SMITHS[smith] as SpawnRequest["smith"],
        prompt: "x",
        env: buildChildEnv(process.env, []),
        command: [
          process.execPath,
          FAKE,
          "--fake-provider",
          name,
          "--fake-mode",
          "hang",
        ],
      });
      const events: LedgerEventInput[] = [];
      const collecting = (async () => {
        for await (const e of handle.events) events.push(e);
      })();
      await Bun.sleep(150);
      await handle.stop("operator pause");
      await collecting;
      const ended = events[events.length - 1] as Extract<
        LedgerEventInput,
        { kind: "session.ended" }
      >;
      expect(ended.payload.reason).toBe("stopped: operator pause");
    });

    test("doctor reports the version of an installed binary", async () => {
      const report = await adapter.doctor([
        process.execPath,
        FAKE,
        "--fake-provider",
        name,
      ]);
      expect(report).toMatchObject({ provider: name, found: true, ok: true });
      expect(report.version).toBe(`fake-${name} 0.0.1`);
    });
  });
}
