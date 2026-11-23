/** Isolated module double: no provider process, command hook or shared-test mock. */
import { mock } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  InteractiveSuperviseOptions,
  SuperviseOptions,
} from "../supervisor";
import type { ChildExit } from "../types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, refuse) => {
    resolve = done;
    reject = refuse;
  });
  return { promise, resolve, reject };
}
let current = { done: deferred<ChildExit>(), ready: deferred<void>() };
mock.module(join(import.meta.dir, "..", "supervisor.ts"), () => ({
  supervise(options: InteractiveSuperviseOptions | SuperviseOptions) {
    const control = current;
    void control.done.promise.catch(() => undefined);
    if (!("stdinMode" in options)) {
      options.onLine("fixture identity");
      control.ready.resolve();
    }
    return {
      pid: 424241,
      providerPid: Promise.resolve(424242),
      done: control.done.promise,
      write: async () => {},
      async end() {
        options.onLine("fixture identity");
        control.ready.resolve();
      },
      stop() {
        const stopped = control.done.promise.then(() => undefined);
        void stopped.catch(() => undefined);
        return stopped;
      },
    };
  },
}));
const { createCliAdapter } = await import("../cli-adapter");
const { runExec } = await import("../exec-runtime");
const { BUILTIN_SMITHS } = await import("../../config/defaults");
const [root, mode = "private", ...extra] = process.argv.slice(2);
if (
  !root ||
  !existsSync(join(root, ".git")) ||
  extra.length ||
  !["private", "generic"].includes(mode)
)
  throw Error("Missing fixture root");
const privateCapture = mode === "private";
const cleanupReason = privateCapture
  ? "fixture private kernel diagnostic"
  : "Owned process group cleanup could not be confirmed.";
const smith = BUILTIN_SMITHS["claude-journeyman"];
if (!smith) throw Error("Missing fixture smith");
const adapter = createCliAdapter({
  provider: "claude",
  binary: process.execPath,
  versionArgs: [],
  buildArgs: () => [],
  parseLine: () => ({ sessionId: "fixture-owned-session", tools: [] }),
  parseError: () => undefined,
});
const finishes: (ChildExit | null)[] = [];
const capture = {
  prepare: async () => ({
    holdTree() {},
    started() {},
    line() {},
    async finish(exit: ChildExit | null) {
      finishes.push(exit);
    },
  }),
};
const handle = await adapter.spawn({
  beadId: "fixture-bead",
  worktree: root,
  workspace: root,
  smith,
  prompt: "private fixture prompt",
  env: { PATH: "" },
  ...(privateCapture ? { privateCapture: capture } : {}),
});
const result = handle.done.then(
  () => "completed",
  (error: unknown) => (error instanceof Error ? error.message : "unknown"),
);
const events = (async () => {
  const observed = [];
  for await (const event of handle.events) observed.push(event);
  return observed;
})();
await current.ready.promise;
await Bun.sleep(0);
current.done.reject(Error(cleanupReason));
const rejected = await result;
const stopRejected = await handle.stop("Unknown cleanup").then(
  () => false,
  () => true,
);
const observed = await Promise.race([events, Bun.sleep(200).then(() => null)]);
const first = {
  rejected,
  stopRejected,
  iteratorClosed: observed !== null,
  falseCompletion:
    observed?.some((event) => event.kind === "session.ended") ?? false,
  finishes: [...finishes],
  mirrorRemoved: !existsSync(join(root, ".agent-forge-session")),
};

current = { done: deferred<ChildExit>(), ready: deferred<void>() };
const running = runExec(
  [
    "--bead",
    "fixture-bead",
    "--worktree",
    root,
    "--prompt",
    "private fixture prompt",
  ],
  {
    harnessRoot: root,
    home: root,
    cwd: root,
    env: { PATH: "" },
    adapters: { claude: adapter },
    sink() {},
    ...(privateCapture ? { privateCapture: capture } : {}),
  },
).then(
  (value) => value,
  () => null,
);
await current.ready.promise;
await Bun.sleep(0);
current.done.reject(Error(cleanupReason));
const execution = await Promise.race([
  running,
  Bun.sleep(200).then(() => null),
]);
console.log(
  JSON.stringify({ ok: true, data: { first, execution }, error: null }),
);
