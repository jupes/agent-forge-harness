/** Isolated generic adapter double; no private capture or provider process. */
import { mock } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SuperviseOptions } from "../supervisor";
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
  supervise(options: SuperviseOptions) {
    const control = current;
    void control.done.promise.catch(() => undefined);
    options.onLine("fixture identity");
    control.ready.resolve();
    return {
      pid: 424241,
      done: control.done.promise,
      stop() {
        const stopping = control.done.promise.then(() => undefined);
        void stopping.catch(() => undefined);
        return stopping;
      },
    };
  },
}));
const { createCliAdapter } = await import("../cli-adapter");
const { runExec } = await import("../exec-runtime");
const { BUILTIN_SMITHS } = await import("../../config/defaults");
const root = process.argv[2];
if (!root || !existsSync(join(root, ".git")))
  throw Error("Missing isolated fixture root");
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
const handle = await adapter.spawn({
  beadId: "fixture-bead",
  worktree: root,
  workspace: root,
  smith,
  prompt: "private fixture prompt",
  env: { PATH: "" },
});
const result = handle.done.then(
  () => "completed",
  () => "unknown",
);
const events = (async () => {
  const observed = [];
  for await (const event of handle.events) observed.push(event);
  return observed;
})();
current.done.reject(
  Error("Owned process group cleanup could not be confirmed."),
);
const stopRejected = await handle.stop("The cleanup is still unconfirmed").then(
  () => false,
  () => true,
);
const observed = await Promise.race([events, Bun.sleep(200).then(() => null)]);
const first = {
  outcome: await result,
  stopRejected,
  iteratorClosed: observed !== null,
  falseCompletion:
    observed?.some((event) => event.kind === "session.ended") ?? false,
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
  },
).then(
  (value) => value,
  () => "unhandled cleanup rejection",
);
await current.ready.promise;
await Bun.sleep(0);
current.done.reject(
  Error("Owned process group cleanup could not be confirmed."),
);
const execution = await Promise.race([
  running,
  Bun.sleep(200).then(() => null),
]);
console.log(
  JSON.stringify({ ok: true, data: { first, execution }, error: null }),
);
