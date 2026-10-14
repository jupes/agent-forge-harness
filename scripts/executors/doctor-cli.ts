#!/usr/bin/env bun
/**
 * doctor-cli.ts — which provider CLIs can this machine drive?
 *
 *   bun run forge:doctor                   # does each CLI answer --version?
 *   bun run forge:doctor --task            # ... and can it run a task?
 *   bun run forge:doctor [--task] --json   # { ok, data: { adapters: [...] }, error }
 *
 * Answering `--version` says only that the binary starts: a CLI that is not
 * signed in, or that is missing the helper it runs tools with, still answers
 * it. `--task` also runs one small task through each adapter whose CLI
 * answered, the way forge:exec runs one (the adapter's flags and preparation,
 * the configured environment allowlist), with the smith `taskSmiths` picks.
 * The task asks for one shell command, `git status`, in a new git repository
 * under the OS temp directory, which is left in place. It passes when the
 * provider exits 0 on its own, reports no error and calls at least one tool.
 * Against a real provider it spends a request. Nothing goes to the ledger.
 *
 * A missing CLI, or one that cannot run a task, is data, not failure: exit 0
 * unless the doctor itself breaks.
 */

import { mkdtempSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Smith } from "../../types/hearth";
import { type ForgeConfig, loadConfig } from "../config/load";
import { buildChildEnv } from "./env";
import { runFailure } from "./outcome";
import { ADAPTERS } from "./registry";
import type { DoctorResult, ExecutorAdapter } from "./types";

/** What the task check asks of the provider: one tool call, no change. */
export const TASK_PROMPT =
  "Run the shell command `git status` in the current directory, then reply with the single word done. Do not create, change or delete any file.";

/** The bead id the task check's child is given; nothing is recorded under it. */
const TASK_BEAD = "forge-doctor";

/** A real provider answers a one-command task well inside this. */
const TASK_TIMEOUT_MS = 5 * 60 * 1000;

export interface TaskCheckOptions {
  /** The smith each provider's task asks for, by provider. */
  smiths: Readonly<Record<string, Smith>>;
  /**
   * The harness checkout, given to the adapter as the workspace, as
   * forge:exec gives it. A task's directory is a repository of its own, so
   * Codex's `codex:sync` does not run for a task (`codexSyncDirectory`).
   */
  harnessRoot: string;
  /** Already allowlisted (`buildChildEnv`). */
  env: Record<string, string>;
  timeoutMs: number;
  /** Makes the directory a task runs in. Default: `makeTaskDirectory`. */
  makeDirectory?: () => string;
}

interface TaskRun {
  /** The smith whose model the task asked for. */
  smith?: string;
  /** Where the task ran; left in place. */
  directory?: string;
  /** Tool calls seen in the provider's stream. */
  tools: number;
}

/**
 * One small task run through an adapter: can the CLI do work, not only start?
 * `ok` when the provider exited 0 on its own, reported no error, and called at
 * least one tool; otherwise `reason` says why, in the provider's words when it
 * gave any.
 */
export type TaskCheck =
  | (TaskRun & { ok: true })
  | (TaskRun & { ok: false; reason: string });

/** One adapter's doctor result; `task` is null when no task was run. */
export interface DoctorReport extends DoctorResult {
  task: TaskCheck | null;
}

/**
 * The smith each provider's task runs with: the default crew for its own
 * provider, and for every other provider its first enabled smith in config
 * order.
 */
export function taskSmiths(config: ForgeConfig): Record<string, Smith> {
  const picked: Record<string, Smith> = {};
  const crew = config.smiths[config.workflow.defaultCrew];
  if (crew?.enabled) picked[crew.provider] = crew;
  for (const smith of Object.values(config.smiths)) {
    if (smith.enabled && !picked[smith.provider]) {
      picked[smith.provider] = smith;
    }
  }
  return picked;
}

/**
 * A new git repository under the OS temp directory: the task runs in a
 * checkout of its own, as a forge:exec worktree is one, and nowhere near the
 * harness.
 */
export function makeTaskDirectory(): string {
  const directory = realpathSync.native(
    mkdtempSync(join(tmpdir(), "forge-doctor-task-")),
  );
  const init = Bun.spawnSync(["git", "init", "--quiet"], {
    cwd: directory,
    stdout: "ignore",
    stderr: "pipe",
  });
  if (init.exitCode !== 0) {
    throw new Error(
      `git init failed in ${directory}: ${init.stderr.toString().trim()}`,
    );
  }
  return directory;
}

async function checkTask(
  adapter: ExecutorAdapter,
  command: string[] | undefined,
  options: TaskCheckOptions,
): Promise<TaskCheck> {
  const smith = options.smiths[adapter.provider];
  if (!smith) {
    return {
      ok: false,
      tools: 0,
      reason: `no enabled smith uses ${adapter.provider}`,
    };
  }
  let directory: string | undefined;
  let tools = 0;
  try {
    directory = (options.makeDirectory ?? makeTaskDirectory)();
    const handle = await adapter.spawn({
      beadId: TASK_BEAD,
      worktree: directory,
      workspace: options.harnessRoot,
      smith,
      prompt: TASK_PROMPT,
      env: options.env,
      timeoutMs: options.timeoutMs,
      command,
    });
    for await (const event of handle.events) {
      if (event.kind === "tool.called") tools++;
    }
    const reason =
      runFailure(await handle.done) ??
      (tools === 0 ? "the provider exited 0 without calling a tool" : null);
    const run = { smith: smith.name, directory, tools };
    return reason === null
      ? { ok: true, ...run }
      : { ok: false, ...run, reason };
  } catch (error) {
    return {
      ok: false,
      smith: smith.name,
      ...(directory === undefined ? {} : { directory }),
      tools,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Every adapter's `--version` check, and with `task` a task check for each
 * adapter whose CLI answered it.
 */
export async function runDoctor(
  adapters: Readonly<Record<string, ExecutorAdapter>> = ADAPTERS,
  commands: Record<string, string[]> = {},
  task?: TaskCheckOptions,
): Promise<DoctorReport[]> {
  return Promise.all(
    Object.entries(adapters).map(async ([provider, adapter]) => {
      const version = await adapter.doctor(commands[provider]);
      const checked =
        task && version.found && version.ok
          ? await checkTask(adapter, commands[provider], task)
          : null;
      return { ...version, task: checked };
    }),
  );
}

function taskPart(task: TaskCheck | null): string {
  if (task === null) {
    return "can it run a task? not checked (bun run forge:doctor --task)";
  }
  const smith = task.smith ? ` with ${task.smith}` : "";
  return task.ok
    ? `ran a task${smith} (tool calls: ${task.tools})`
    : `cannot run a task${smith}: ${task.reason}`;
}

/** One adapter's report as one line of text. */
export function doctorLine(r: DoctorReport): string {
  if (!r.found) return `${r.provider}: not found (${r.reason ?? "no binary"})`;
  const path = r.path ? ` ${r.path}` : "";
  if (!r.ok) {
    return `${r.provider}: does not answer --version${r.reason ? ` (${r.reason})` : ""}${path}`;
  }
  const version = r.version ? ` (${r.version})` : "";
  return `${r.provider}: answers --version${version}${path}; ${taskPart(r.task)}`;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  try {
    let task: TaskCheckOptions | undefined;
    if (argv.includes("--task")) {
      const harnessRoot = join(import.meta.dir, "..", "..");
      const { config } = loadConfig({ harnessRoot });
      task = {
        smiths: taskSmiths(config),
        harnessRoot,
        env: buildChildEnv(process.env, config.execution.envPass),
        timeoutMs: TASK_TIMEOUT_MS,
      };
    }
    const adapters = await runDoctor(ADAPTERS, {}, task);
    if (json) {
      console.log(
        JSON.stringify({ ok: true, data: { adapters }, error: null }, null, 2),
      );
    } else {
      for (const r of adapters) console.log(doctorLine(r));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json)
      console.log(JSON.stringify({ ok: false, data: null, error: message }));
    else console.error(message);
    process.exit(2);
  }
}
