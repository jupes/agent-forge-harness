/**
 * One behavioural contract every adapter must satisfy, run against fake
 * provider binaries. This proves our plumbing (env, stdin, stream parsing,
 * lifecycle, cleanup) — not that a real provider CLI emits these shapes.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isAdapterChild } from "../../.claude/hooks/utils/hook-input";
import { CLI_DEFAULT_MODEL, type LedgerEventInput } from "../../types/hearth";
import { BUILTIN_SMITHS } from "../config/defaults";
import { comparableCheckout } from "../forge/runs";
import { hashText } from "../hash-text";
import { validateLedgerEventInput } from "../hearth/validate";
import { type Attach, SESSION_MIRROR_FILE } from "../ledger/identity";
import { scratchDirs } from "../test-scratch";
import { claudeAdapter } from "./claude";
import { createCodexAdapter } from "./codex";
import { buildChildEnv } from "./env";
import { liveChildCount } from "./supervisor";
import type { ExecResult, ExecutorAdapter, SpawnRequest } from "./types";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());

const FAKE = join(import.meta.dir, "fixtures", "fake-cli.ts");
const adapters: Array<{
  name: string;
  adapter: ExecutorAdapter;
  smith: string;
  /** The usage the stand-in CLI's last line reports for this provider. */
  usage: Record<string, number>;
  /** The arguments that carry a smith's effort: the flag the provider documents. */
  effortArgs: (effort: string) => string[];
}> = [
  {
    name: "claude",
    adapter: claudeAdapter,
    smith: "claude-journeyman",
    usage: {
      inputTokens: 12,
      cacheCreationInputTokens: 300,
      cacheReadInputTokens: 4000,
      outputTokens: 56,
      costUsd: 0.0125,
    },
    effortArgs: (effort) => ["--effort", effort],
  },
  {
    name: "codex",
    adapter: createCodexAdapter({ prepare: () => undefined }),
    smith: "codex-journeyman",
    usage: {
      inputTokens: 2400,
      cachedInputTokens: 1800,
      cacheWriteInputTokens: 5,
      outputTokens: 90,
      reasoningOutputTokens: 40,
    },
    effortArgs: (effort) => ["-c", `model_reasoning_effort=${effort}`],
  },
];

type SessionEnded = Extract<LedgerEventInput, { kind: "session.ended" }>;

/** A ULID: 26 characters of Crockford base 32. */
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

interface RunOptions {
  /** More `--fake-*` flags for the stand-in CLI, given the run's temp root. */
  fakeFlags?: (root: string) => string[];
  /** Runs on the worktree before the child is spawned. */
  seed?: (worktree: string) => void;
}

async function run(
  adapter: ExecutorAdapter,
  provider: string,
  smithName: string,
  mode: string,
  extra: Partial<SpawnRequest> = {},
  options: RunOptions = {},
) {
  // Each directory is its own checkout: a bare temp directory would resolve to
  // whatever checkout the temp directory happens to sit in.
  const root = realpathSync.native(scratch.make("exec contract "));
  mkdirSync(join(root, ".git"));
  const worktree = join(root, "work tree with spaces");
  mkdirSync(join(worktree, ".git"), { recursive: true });
  options.seed?.(worktree);
  const dumpFile = join(root, "dump.json");
  const attachFile = join(root, "attach.json");
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
      ...(options.fakeFlags?.(root) ?? []),
    ],
    ...extra,
  });
  const events: LedgerEventInput[] = [];
  const collecting = (async () => {
    for await (const event of handle.events) events.push(event);
  })();
  const result = await handle.done;
  await collecting;
  const dump = readChildJson(dumpFile, result);
  // What a script run inside the child attached to (`--fake-attach`).
  const attached: Attach | undefined = readChildJson(attachFile, result);
  return { events, result, dump, attached, worktree, root, handle };
}

/**
 * A JSON file the stand-in CLI wrote, or undefined when it wrote none. A file
 * that is there but is not JSON fails with how the child ended and the file's
 * size (not its content: the dump holds the child's environment), so the
 * failure names its cause.
 */
function readChildJson(
  file: string,
  exit: ExecResult,
): ReturnType<typeof JSON.parse> {
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${file} is not JSON (${text.length} characters: ${(error as Error).message}); the child ended with ${JSON.stringify(
        {
          exitCode: exit.exitCode,
          timedOut: exit.timedOut,
          stopped: exit.stopped,
          stderr: exit.stderr,
        },
      )}`,
    );
  }
}

/** The flags that make the stand-in CLI report `id` and record what a script inside it attaches to. */
const attachAs = (id: string) => (root: string) => [
  "--fake-session-id",
  id,
  "--fake-attach",
  join(root, "attach.json"),
];

/** Whether `args` holds `items` next to each other, in order. */
function holdsInOrder(args: readonly string[], items: readonly string[]) {
  return args.some((_, at) => items.every((item, i) => args[at + i] === item));
}

for (const { name, adapter, smith, usage, effortArgs } of adapters) {
  describe(`${name} adapter contract`, () => {
    test("streams session.started, prompt.submitted, tool.called per tool, session.ended — all valid", async () => {
      const { events, result } = await run(adapter, name, smith, "ok");
      expect(events.map((e) => e.kind)).toEqual([
        "session.started",
        "prompt.submitted",
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
      const ended = events[4] as Extract<
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

    test("right after session.started comes prompt.submitted: the hash and length of the prompt sent on stdin, under the same session, never the text", async () => {
      const { events } = await run(adapter, name, smith, "ok");
      const [started, submitted] = events;
      expect(started?.kind).toBe("session.started");
      expect(submitted).toMatchObject({
        kind: "prompt.submitted",
        sessionId: started?.sessionId,
        payload: {
          hash: hashText("do the thing & echo %PATH%"),
          length: "do the thing & echo %PATH%".length,
        },
      });
      expect(validateLedgerEventInput(submitted).ok).toBe(true);
      expect(JSON.stringify(events)).not.toContain("do the thing");
    });

    test("every event, and the handle, carry the session id the provider's stream reports", async () => {
      const { events, handle } = await run(
        adapter,
        name,
        smith,
        "ok",
        {},
        {
          fakeFlags: () => ["--fake-session-id", "provider-session-7"],
        },
      );
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        expect(event.sessionId).toBe("provider-session-7");
        expect(event.executor?.sessionId).toBe("provider-session-7");
      }
      expect(handle.sessionId).toBe("provider-session-7");
    });

    test("a stream that reports no session id: every event, and the handle, carry one ULID the adapter minted", async () => {
      const { events, handle } = await run(
        adapter,
        name,
        smith,
        "ok",
        {},
        {
          fakeFlags: () => ["--fake-no-id"],
        },
      );
      expect(events.map((e) => e.kind)).toEqual([
        "session.started",
        "prompt.submitted",
        "tool.called",
        "tool.called",
        "session.ended",
      ]);
      expect(handle.sessionId).toMatch(ULID);
      for (const event of events) {
        expect(event.sessionId).toBe(handle.sessionId);
        expect(event.executor?.sessionId).toBe(handle.sessionId);
      }
    });

    test("while the child runs, a script inside it attaches through the mirror to the child's session, with the request's bead and run; when the child ends the mirror is gone", async () => {
      const { attached, worktree } = await run(
        adapter,
        name,
        smith,
        "ok",
        {},
        {
          fakeFlags: attachAs("provider-session-8"),
        },
      );
      expect(attached).toMatchObject({
        sessionId: "provider-session-8",
        beadId: "bead-1",
        runId: "run-1",
      });
      expect(existsSync(join(worktree, SESSION_MIRROR_FILE))).toBe(false);
    });

    test("a mirror the checkout held before the run is in place again when the child ends; during the run a script attaches to the child's session", async () => {
      const { attached, worktree } = await run(
        adapter,
        name,
        smith,
        "ok",
        {},
        {
          seed: (worktree) =>
            writeFileSync(
              join(worktree, SESSION_MIRROR_FILE),
              "launching-session\n",
            ),
          fakeFlags: attachAs("provider-session-9"),
        },
      );
      expect(attached?.sessionId).toBe("provider-session-9");
      expect(readFileSync(join(worktree, SESSION_MIRROR_FILE), "utf8")).toBe(
        "launching-session\n",
      );
    });

    test("tool events carry a hash, never the tool input", async () => {
      const { events } = await run(adapter, name, smith, "ok");
      expect(JSON.stringify(events)).not.toContain("SECRET_BODY_MUST_NOT_LEAK");
      const tool = events.find((e) => e.kind === "tool.called") as Extract<
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

    test("the child is marked as an adapter child and carries the bead, smith and run; values planted under those names do not reach it", async () => {
      const { dump } = await run(adapter, name, smith, "ok", {
        env: {
          ...buildChildEnv(process.env, []),
          AGENT_FORGE_ADAPTER: "0",
          agent_forge_bead_id: "planted-bead",
          Forge_Slug: "planted-run",
          Agent_Forge_Parent_Session: "planted-parent",
        },
      });
      const seen = dump.env as Record<string, string>;
      const owned = Object.keys(seen).filter((key) =>
        /^(agent_forge_(adapter|bead_id|smith|parent_session)|forge_slug)$/i.test(
          key,
        ),
      );
      expect(
        Object.fromEntries(owned.sort().map((key) => [key, seen[key]])),
      ).toEqual({
        AGENT_FORGE_ADAPTER: "1",
        AGENT_FORGE_BEAD_ID: "bead-1",
        AGENT_FORGE_SMITH: smith,
        FORGE_SLUG: "run-1",
      });
      // The predicate the harness hooks use to stand down inside such a child.
      expect(isAdapterChild(seen)).toBe(true);
    });

    test(`the smith's model and effort reach the child's command line, the effort as ${effortArgs("<effort>").join(" ")}`, async () => {
      const builtin = BUILTIN_SMITHS[smith] as SpawnRequest["smith"];
      for (const effort of [builtin.effort, "xhigh"]) {
        const { dump } = await run(adapter, name, smith, "ok", {
          smith: { ...builtin, effort },
        });
        expect(holdsInOrder(dump.argv as string[], effortArgs(effort))).toBe(
          true,
        );
      }
    });

    test(`a named model is passed as --model; ${CLI_DEFAULT_MODEL} passes none, so the CLI runs the model it is configured with (x1gs.4.9)`, async () => {
      const builtin = BUILTIN_SMITHS[smith] as SpawnRequest["smith"];
      const named = await run(adapter, name, smith, "ok", {
        smith: { ...builtin, model: "named-model-1" },
      });
      expect(
        holdsInOrder(named.dump.argv as string[], ["--model", "named-model-1"]),
      ).toBe(true);
      const configured = await run(adapter, name, smith, "ok", {
        smith: { ...builtin, model: CLI_DEFAULT_MODEL },
      });
      expect(configured.dump.argv as string[]).not.toContain("--model");
      expect(configured.dump.argv as string[]).not.toContain(CLI_DEFAULT_MODEL);
    });

    test("never asks for dangerously-skip-permissions", async () => {
      const { dump } = await run(adapter, name, smith, "ok");
      expect(dump.argv.join(" ")).not.toContain("dangerously");
    });

    test("ignores unparseable and unknown lines without throwing", async () => {
      const { events } = await run(adapter, name, smith, "garbage");
      expect(events.map((e) => e.kind)).toEqual([
        "session.started",
        "prompt.submitted",
        "tool.called",
        "session.ended",
      ]);
    });

    test("session.ended carries the usage the provider's stream reported, and is still a valid event", async () => {
      const { events } = await run(adapter, name, smith, "ok");
      const ended = events[events.length - 1] as SessionEnded;
      expect(ended.kind).toBe("session.ended");
      expect(ended.payload.usage).toEqual(usage);
      expect(validateLedgerEventInput(ended).ok).toBe(true);
    });

    test("a child that exits before its stream reported usage: session.ended carries none", async () => {
      const { events } = await run(adapter, name, smith, "crash");
      const ended = events[events.length - 1] as SessionEnded;
      expect(ended.kind).toBe("session.ended");
      expect(ended.payload).not.toHaveProperty("usage");
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
      const root = scratch.make("exec stop ");
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

    test("doctor: an override whose program does not exist is found:false, ok:false, with a reason naming it — data, not a throw", async () => {
      const missing = join(tmpdir(), "definitely-not-a-real-binary-xyz");
      const report = await adapter.doctor([missing, "--some-flag"]);
      expect(report).toEqual({
        provider: name,
        found: false,
        ok: false,
        reason: `${missing} not found`,
      });
    });

    test("doctor: an override that is found but cannot run (its program starts, the command fails) is found:true, ok:false with a reason, not a throw", async () => {
      const override = [
        process.execPath,
        join(tmpdir(), "no such script for forge doctor.ts"),
      ];
      const report = await adapter.doctor(override);
      expect(report.provider).toBe(name);
      expect(report.found).toBe(true);
      expect(report.ok).toBe(false);
      expect(report.reason).toMatch(/^version check exited [1-9]\d*$/);
      expect(report.path).toBe(override.join(" "));
    });
  });
}
