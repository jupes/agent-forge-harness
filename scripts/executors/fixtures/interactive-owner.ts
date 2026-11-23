import { join } from "node:path";
import { buildChildEnv } from "../env";
import { supervise } from "../supervisor";

const mode = process.argv[2],
  log = process.argv[3],
  executable = process.argv[4];
if (!log) throw new Error("Missing private inert fixture path.");
const handle = supervise({
  command: executable
    ? [executable, "startup-tree"]
    : [
        process.execPath,
        join(import.meta.dir, "interactive-cli.ts"),
        "startup-tree",
      ],
  cwd: import.meta.dir,
  env: { ...buildChildEnv(process.env, []), INTERACTIVE_TREE_LOG: log },
  stdinMode: "interactive",
  ...(mode === "before"
    ? { beforeStart: () => new Promise<void>(() => {}) }
    : {}),
  timeoutMs: 10_000,
  onLine: () => undefined,
});
const providerPid = mode === "before" ? null : await handle.providerPid;
await Bun.stdout.write(
  `${JSON.stringify({ ownerPid: process.pid, wrapperPid: handle.pid, providerPid })}\n`,
);
await new Promise(() => setInterval(() => {}, 1000));
