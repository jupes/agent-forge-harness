#!/usr/bin/env bun
/**
 * A stand-in `forge:shift run` process for the interrupt tests: the CLI's own
 * main (`shiftCliMain`: the interrupt owner, `runShiftCli`, the envelope on
 * stdout, the exit code), given hermetic dependencies.
 *
 *   bun interruptible-shift.ts <dir> <mode> <graceMs>
 *
 * Everything is made under `<dir>`, a scratch directory of the test's: the
 * checkout (`root`, a `.git` of its own), the harness home (`home`: ledger,
 * queue lock, shift records), the worktrees (plain directories under
 * `root/trees`). One bead, `int-1`, is queued. bd is the queue's in-memory
 * tracker; after every call it answers, each bead's labels are written to
 * `<dir>/labels.json`, which is how the test reads the tracker once this
 * process has gone. git answers as a repository whose origin has the base; gh
 * is never reached. The run is the Claude adapter on the fake binary in `hang`
 * mode (a real child process, under the real supervisor), which writes its
 * dump, with its pid, to `<dir>/dump.json` once it runs.
 *
 * Each line read on stdin that is `SIGINT` or `SIGTERM` is emitted in this
 * process (`process.emit`): on Windows no signal can be sent to a process
 * without ending it outright. Modes:
 *
 *   run     as above
 *   stuck   once a signal has been emitted, every bd `update` never answers,
 *           so the shift can never give its bead back: its stop hangs
 *   early   the fetch of the base emits SIGINT itself, before the shift has
 *           written anything, and then answers
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeAdapter } from "../../executors/claude";
import type { ExecutorAdapter } from "../../executors/types";
import type { BdResult, BdRunner } from "../../hearth/routes/dev-api";
import { answerQueueList, queueTracker } from "../queue-fixture";
import { shiftCliDeps, shiftCliMain } from "../shift-cli";
import type { ToolRun } from "../shift-pr";

const [dir, mode = "run", grace = "30000"] = process.argv.slice(2);
if (dir === undefined)
  throw new Error("usage: interruptible-shift.ts <dir> <mode> <graceMs>");

const root = join(dir, "root");
const home = join(dir, "home");
mkdirSync(join(root, ".git"), { recursive: true });
mkdirSync(home, { recursive: true });

let signalled = false;
function emit(signal: "SIGINT" | "SIGTERM"): void {
  signalled = true;
  process.emit(signal);
}

void (async () => {
  const decoder = new TextDecoder();
  const reader = Bun.stdin.stream().getReader();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    let end = text.indexOf("\n");
    while (end !== -1) {
      const line = text.slice(0, end).trim();
      text = text.slice(end + 1);
      if (line === "SIGINT" || line === "SIGTERM") emit(line);
      end = text.indexOf("\n");
    }
  }
})();

const tracker = queueTracker([
  {
    id: "int-1",
    title: "Work for int-1",
    labels: ["queue:queued"],
    metadata: { queue_state: "queued" },
    description: "Work.\n\n## Files\nsrc/int-1/**\n",
  },
]);
const saveLabels = (): void => {
  const labels: Record<string, string[]> = {};
  for (const [id, bead] of tracker.beads) labels[id] = bead.labels ?? [];
  writeFileSync(join(dir, "labels.json"), JSON.stringify(labels));
};
saveLabels();
const runBd: BdRunner = async (args) => {
  if (mode === "stuck" && signalled && args[0] === "update")
    return new Promise<BdResult>(() => undefined);
  const answer = tracker.answer(args) ??
    tracker.answerComment(args) ??
    answerQueueList(args, [...tracker.beads.values()]) ?? {
      status: 1,
      stdout: "",
      stderr: `Error: the stand-in tracker does not answer: ${args.join(" ")}\n`,
    };
  saveLabels();
  return answer;
};

const answered = (stdout: string) => ({ status: 0, stdout, stderr: "" });
const git: ToolRun = async (args) => {
  if (args[0] === "fetch") {
    if (mode === "early") emit("SIGINT");
    return answered("");
  }
  if (args[0] === "rev-parse") return answered(`${"b".repeat(40)}\n`);
  return {
    status: 1,
    stdout: "",
    stderr: `not answered: git ${args.join(" ")}`,
  };
};

/** The Claude adapter, refusing any spawn that would run the real binary. */
const guarded: ExecutorAdapter = {
  ...claudeAdapter,
  spawn: (request) => {
    if (request.command === undefined)
      throw new Error("the stand-in reached for the real claude binary");
    return claudeAdapter.spawn(request);
  },
};

const env = { PATH: process.env["PATH"] ?? "", AGENT_FORGE_HOME: home };
await shiftCliMain(
  ["run", "--for", "10m", "--concurrency", "1", "--repairs", "0"],
  {
    ...shiftCliDeps(root, env),
    runBd,
    git,
    gh: async () => ({ status: 1, stdout: "", stderr: "gh is not reached" }),
    sampleHost: async () => ({ busy: false }),
    makeWorktree: ({ id }) => {
      const path = join(root, "trees", id);
      mkdirSync(join(path, ".git"), { recursive: true });
      return { ok: true, path };
    },
    checkPrBody: async () => null,
    exec: {
      env,
      home: root,
      adapters: { claude: guarded },
      command: [
        process.execPath,
        join(
          import.meta.dir,
          "..",
          "..",
          "executors",
          "fixtures",
          "fake-cli.ts",
        ),
        "--fake-provider",
        "claude",
        "--fake-mode",
        "hang",
        "--fake-dump",
        join(dir, "dump.json"),
      ],
    },
  },
  { graceMs: Number(grace) },
);
